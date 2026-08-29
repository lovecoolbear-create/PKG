import type {
  AgentResult,
  AnalysisInput,
  AnalysisReport,
  ClientSectionKey,
  CostDriver,
  MaterialPriceFetchResult,
  OptimizationHint,
  ProductTypeConfig,
  SmallBatchNote,
  ValidationIssue,
} from "@/types";
import {
  materialAgent,
  processAgent,
  laborAgent,
  designAgent,
  financeAgent,
} from "./specialists";
import { getLaborRegion, DEFAULT_LABOR_REGION } from "@/lib/cost-rules/labor-regions";
import { calculateCompleteness, getConfidencePenalty } from "@/lib/completeness";
import { getMaterialPrices } from "@/lib/material-prices/search-agent";
import { generateSqeDiagnosis, generateRoleReports } from "@/lib/agents/llm-analyst";
import { generateMultiViewReport } from "@/lib/vave/multi-view";
import { generateJudgeExplanation } from "@/lib/agents/judge-explain";
import {
  reconcileCrossLayer,
  type RoleReportLike,
  type ConsistencyWarning,
} from "@/lib/agents/consistency-gate";
import type { AiSettings } from "@/lib/config/ai-settings";
import {
  loadKnowledgeBase,
  resetKbUsageTracker,
  takeKbUsageMinConfidence,
} from "@/lib/knowledge-base";
import { loadRecipes } from "@/lib/cost-formula/loader";
import { applyRecipeOverrides } from "@/lib/cost-formula/engine-bridge";
import {
  SECTION_ORDER,
  CTA_COPY,
  getSmallBatchMessage,
  DISCLAIMER,
} from "@/lib/report-copy";
import { assessBaseline } from "@/lib/physics/feasibility";
import {
  applyDefaults,
  getDefaultPenaltyForDimension,
} from "@/lib/agents/question-engine";
import { deriveAnalysisContext, type AnalysisContext, suggestInnerGrammage, validateFlatBinding } from "./analysis-context";
import { reviewAnalysis } from "./reviewer";

/**
 * ════════════════════════════════════════════════════════════════════
 * 协同契约（架构护栏 · 修改前请先读完，违反会破坏成本引擎的可信度）
 * ════════════════════════════════════════════════════════════════════
 *
 * 本编排器采用「一次性 fan-out + 共享派生上下文（dataflow）」：
 *   deriveAnalysisContext() 算一次全部共享派生量（净展开面积 / 拼版后面积 /
 *   印刷有效面积 / 表面有效面积 / 数量 / 损耗率 / 盒型系数等），
 *   以**只读**方式传给各 specialist；每个 specialist 各自算完即返回，
 *   **全程没有第二轮，也没有 agent 之间的互相调用**。
 *
 * 硬性禁止（不要"优化"成下面这些形态）：
 *   ✗ 让 specialist A 的输出喂给 B 触发重算（message-passing / 自由迭代 loop）
 *      → 数值正反馈振荡、无收敛判据、可能死循环；
 *   ✗ specialist 之间互相 import 或互相调用；
 *   ✗ specialist 内部调用 LLM。
 *
 * 为什么：这 5 个 specialist 是**确定性纯函数**——同样的输入必须永远得到
 * 同样的数。这是「可复现、可审计」这一核心价值的地基（用户的首要前提）。
 * 引入自由迭代对上述目标零增益，却会一次性毁掉可追溯性与收敛性。
 *
 * AI 的合法位置（只在这四处，且不碰最终数值）：
 *   1. 输入层：自然语言 / 图纸 / 扫描件解析成结构化参数；
 *   2. 数据层：联网查价（读不到时优雅回退本地基准）；
 *   3. 审阅层：结果**合理性**审阅——只生成提示，**绝不回写 amount**；
 *   4. 解读层：SQE 诊断、角色视角报告等文字生成。
 * 一句话：**数值对不对归公式，合不合理才问 AI。**
 *
 * 相关回归保护：scripts/golden-regression.ts（改任何系数/公式前必跑）。
 * ════════════════════════════════════════════════════════════════════
 */

const MAX_RETRIES = 2;

function num(input: AnalysisInput, key: string, fallback = 0): number {
  const v = input[key];
  return typeof v === "number" ? v : Number(v) || fallback;
}
function str(input: AnalysisInput, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : String(v || fallback);
}

interface OrchestratorOptions {
  sessionId: string;
  config: ProductTypeConfig;
  input: AnalysisInput;
  /** 用户主动跳过的字段（使用默认值），用于报告标注 */
  skippedKeys?: string[];
  /** 前端 AI 配置中心下发的运行时模型配置（未传则回退服务端环境变量） */
  aiSettings?: AiSettings;
}

function runAllAgents(
  ctx: AnalysisContext,
  materialPrices: MaterialPriceFetchResult,
  regionDefaulted: boolean
): AgentResult[] {
  // C2：逐 agent 记录「本维度实际命中的知识库条目最低置信度」。
  // 追踪器是进程内的，take 后即清空，因此按 agent 顺序逐个取即为该维度的取值。
  resetKbUsageTracker();
  const material = materialAgent(ctx, materialPrices);
  const materialKb = takeKbUsageMinConfidence();

  const labor = laborAgent(ctx);
  const laborKb = takeKbUsageMinConfidence();

  const process = processAgent(ctx);
  const processKb = takeKbUsageMinConfidence();

  const design = designAgent(ctx);
  const designKb = takeKbUsageMinConfidence();

  const manufacturingSubtotal =
    material.estimatedAmount + labor.estimatedAmount + process.estimatedAmount;

  const finance = financeAgent(ctx, manufacturingSubtotal + design.estimatedAmount);
  const financeKb = takeKbUsageMinConfidence();

  const attach = (r: AgentResult, kb: number | null): AgentResult =>
    kb == null ? r : { ...r, kbConfidence: kb };

  const base: AgentResult[] = [
    attach(material, materialKb),
    attach(labor, laborKb),
    attach(process, processKb),
    attach(design, designKb),
    attach(finance, financeKb),
  ];

  // C3：配方优先、硬编码回退。
  // 无生效配方时 applyRecipeOverrides 为 no-op，行为与改造前完全一致
  // （由 scripts/golden-regression.ts 的黄金基线保证零漂移）。
  return applyRecipeOverrides(base, ctx, ctx.productType);
}

/** C2：知识库条目置信度下限。低于此值 → 说明所用参数来源存疑，降置信度并提示核实。
 *  注：当前库内成本类条目（import 来源）置信度均为 70，故默认不触发。 */
const KB_CONFIDENCE_FLOOR = 60;
/** 惩罚系数与上限：每低于下限 1 分扣 0.2 分置信度，最多扣 8 分，避免过度惩罚。 */
const KB_CONFIDENCE_PENALTY_CAP = 8;

function kbConfidencePenalty(kbConfidence?: number): number {
  if (kbConfidence == null || kbConfidence >= KB_CONFIDENCE_FLOOR) return 0;
  return Math.min(
    KB_CONFIDENCE_PENALTY_CAP,
    Math.round((KB_CONFIDENCE_FLOOR - kbConfidence) * 0.2)
  );
}

function calculateRatios(results: AgentResult[]): AgentResult[] {
  const total = results.reduce((sum, r) => sum + r.estimatedAmount, 0);
  return results.map((r) => ({
    ...r,
    ratio: total > 0 ? Math.round((r.estimatedAmount / total) * 1000) / 10 : 0,
  }));
}

function validate(
  results: AgentResult[],
  config: ProductTypeConfig,
  completeness: number,
  quantity: number
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 小批量放宽占比容差：固定成本(制版)摊薄不足，结构本就不同于大批量，避免误报
  const isSmallBatch = quantity > 0 && quantity < 5000;
  const ratioTolerance = isSmallBatch ? 15 : 5;

  // 占比区间校验
  for (const result of results) {
    const dimConfig = config.dimensions.find((d) => d.key === result.dimension);
    if (!dimConfig) continue;
    const [minR, maxR] = dimConfig.expectedRatioRange;
    if (result.ratio < minR - ratioTolerance || result.ratio > maxR + ratioTolerance) {
      const note = isSmallBatch
        ? "（小批量下固定成本占比偏高属正常现象，可结合批量弹性评估）"
        : "";
      issues.push({
        type: "ratio_out_of_range",
        severity: "warning",
        message: `${result.dimensionLabel}占比 ${result.ratio}% 偏离预期区间 ${minR}%-${maxR}%${note}`,
        suggestion: isSmallBatch
          ? "若计划提升批量，制版费摊薄后该占比将回归正常区间"
          : "请核实输入参数是否准确，或该产品是否有特殊工艺",
      });
    }
  }

  // 信息完整度
  if (completeness < 60) {
    issues.push({
      type: "low_completeness",
      severity: "warning",
      message: `信息完整度仅 ${completeness}%，估算误差可能较大`,
      suggestion: "建议补充关键字段以提高精度",
    });
  }

  // 各 Agent 置信度检查
  const lowConfAgents = results.filter((r) => r.confidence < 60);
  if (lowConfAgents.length > 0) {
    issues.push({
      type: "missing_info",
      severity: "warning",
      message: `${lowConfAgents.map((a) => a.dimensionLabel).join("、")} 置信度偏低`,
      suggestion: "补充相关参数可改善估算精度",
    });
  }

  return issues;
}

function generateOptimizationHints(
  input: AnalysisInput,
  results: AgentResult[]
): OptimizationHint[] {
  const hints: OptimizationHint[] = [];
  const quantity = Number(input.quantity) || 0;
  const material = results.find((r) => r.dimension === "material");

  if (quantity > 0 && quantity < 5000) {
    hints.push({
      id: "qty_scale",
      title: "提升订单量级可显著降低单位成本",
      summary: "当前数量偏少，材料采购与开机成本分摊较高",
      detail:
        "建议评估是否可合并批次或增加安全库存。通常数量提升至 10000+ 时，单位材料成本可下降 8-15%，制版费分摊也可大幅降低。",
      potentialSaving: "8-15%",
      category: "material",
    });
  }

  if (input.surfaceTreatment === "foil") {
    hints.push({
      id: "surface_opt",
      title: "评估烫金面积与替代方案",
      summary: "烫金工艺成本较高，局部烫金可节约成本",
      detail:
        "如果烫金仅用于 Logo 或小面积装饰，可考虑局部烫金替代满版烫金，或使用烫金贴纸方案，成本可降低 30-50%。",
      potentialSaving: "30-50%",
      category: "process",
    });
  }

  if (!hints.length && material && material.ratio > 50) {
    hints.push({
      id: "material_alt",
      title: "评估材质替代方案",
      summary: "材料成本占比较高，可考虑同等效果的替代材质",
      detail:
        "在保证挺度与印刷效果前提下，评估灰底白板替代白卡纸、或适当降低克重是否可行。建议与工厂确认样品效果。",
      potentialSaving: "5-12%",
      category: "material",
    });
  }

  // 兜底：现有规则均未命中（如 5000pcs 标准批量）时，依据最高成本驱动维度生成针对性建议，确保稳定产出
  if (!hints.length) {
    const drivers = [...results]
      .sort((a, b) => b.estimatedAmount - a.estimatedAmount)
      .slice(0, 2);
    for (const d of drivers) {
      const hint = buildDriverHint(d);
      if (hint) hints.push(hint);
      if (hints.length >= 2) break;
    }
  }

  return hints.slice(0, 3);
}

/** 按最高成本驱动维度生成针对性优化建议（兜底，保证 optimizationHints 稳定产出） */
function buildDriverHint(d: AgentResult): OptimizationHint | null {
  const map: Record<
    string,
    { saving: string; title: string; detail: string; category: OptimizationHint["category"] }
  > = {
    material: {
      saving: "5-12%",
      title: "评估材质替代与克重优化",
      detail:
        "材料为最大成本项，可在保证挺度与印刷效果前提下评估灰底白板替代白卡、或适度降低克重；建议与工厂确认样品效果。",
      category: "material",
    },
    ink: {
      saving: "3-8%",
      title: "优化印刷色数与油墨用量",
      detail:
        "油墨为主要成本项，可评估精简专色改用四色叠印，或降低满版印刷面积以减少油墨克重。",
      category: "process",
    },
    process: {
      saving: "5-15%",
      title: "精简加工工艺",
      detail:
        "加工费为关键成本项，可评估合并工序（如模切糊盒连线）、取消非必要表面处理以压缩加工费。",
      category: "process",
    },
    design_plate: {
      saving: "依批量",
      title: "合并批次摊薄制版费",
      detail:
        "制版/设计费占比偏高，属固定成本，可通过合并订单或提升批量将制版费摊薄至更低单位成本。",
      category: "design",
    },
    labor: {
      saving: "3-10%",
      title: "优化人工与排产",
      detail:
        "人工成本占比偏高，可评估自动化设备替代、提升单班产量或优化工序衔接以降低单位人工。",
      category: "logistics",
    },
    finance: {
      saving: "2-5%",
      title: "优化管理费率与结算",
      detail:
        "财务/管理费用占比偏高，可评估付款账期、包装系数与最小起订量约定以降低综合费率。",
      category: "logistics",
    },
  };
  const m = map[d.dimension];
  if (!m) return null;
  return {
    id: `driver_${d.dimension}`,
    title: m.title,
    summary: `${d.dimensionLabel}为当前最大成本驱动（占比 ${d.ratio}%）`,
    detail: m.detail,
    potentialSaving: m.saving,
    category: m.category,
  };
}

/** 主要成本驱动点：按估算金额降序取前 3，reason 取该维度最贵分项的说明 */
function generateCostDrivers(results: AgentResult[]): CostDriver[] {
  return [...results]
    .sort((a, b) => b.estimatedAmount - a.estimatedAmount)
    .slice(0, 3)
    .map((r) => {
      const topBreakdown = r.breakdown
        ? [...r.breakdown].sort((x, y) => y.amount - x.amount)[0]
        : undefined;
      return {
        dimension: r.dimension,
        dimensionLabel: r.dimensionLabel,
        amount: r.estimatedAmount,
        ratio: r.ratio,
        reason: topBreakdown?.note ?? r.basis[0] ?? "",
      };
    });
}

/** 小批量特殊提示：设计/制版占比超出预期上限时触发，按「真实成本特征」展示 */
function buildSmallBatchNote(
  results: AgentResult[],
  config: ProductTypeConfig,
  quantity: number
): SmallBatchNote {
  const dim = results.find((r) => r.dimension === "design_plate");
  const cfg = config.dimensions.find((d) => d.key === "design_plate");
  const expectedMin = cfg?.expectedRatioRange[0] ?? 3;
  const expectedMax = cfg?.expectedRatioRange[1] ?? 10;
  if (!dim) {
    return {
      visible: false,
      dimension: "design_plate",
      ratio: 0,
      expectedMin,
      expectedMax,
      fixedFee: 0,
      currentPerPiece: 0,
      suggestions: [],
      message: "",
    };
  }
  const fixedFee = dim.estimatedAmount;
  const currentPerPiece =
    quantity > 0 ? Math.round((fixedFee / quantity) * 10000) / 10000 : 0;
  // 数量提升提示：给出 2× 与 5× 当前批量的摊薄参考（固定费不变，仅分摊基数变大）
  const suggestions: { quantity: number; perPiece: number }[] =
    quantity > 0
      ? [2, 5].map((mult) => {
          const q = Math.round(quantity * mult);
          return {
            quantity: q,
            perPiece: Math.round((fixedFee / q) * 10000) / 10000,
          };
        })
      : [];
  if (dim.ratio > expectedMax) {
    return {
      visible: true,
      dimension: "design_plate",
      ratio: dim.ratio,
      expectedMin,
      expectedMax,
      fixedFee,
      currentPerPiece,
      suggestions,
      message: getSmallBatchMessage(config.code),
    };
  }
  return {
    visible: false,
    dimension: "design_plate",
    ratio: dim.ratio,
    expectedMin,
    expectedMax,
    fixedFee,
    currentPerPiece,
    suggestions,
    message: "",
  };
}

/**
 * 主控 Agent（Orchestrator）
 * 负责调度专业 Agent、汇总结果、执行校验与有限重试
 */
export async function runOrchestrator(
  options: OrchestratorOptions
): Promise<AnalysisReport> {
  const { sessionId, config, input, skippedKeys = [] } = options;

  // 0. 预热知识库（材料价/工艺费率/地域费率）；失败则静默回退常量，不影响分析
  await loadKnowledgeBase();
  // 0.1 预热成本配方（C3）；库为空时 getRecipeItems 返回空数组 → 走硬编码回退
  await loadRecipes();

  // 1. 应用默认值（未填写或用户跳过的字段），并收集默认假设
  const { input: resolvedInput, assumptions } = applyDefaults(
    input,
    new Set(skippedKeys),
    config
  );

  // 信息完整度基于「用户实际填写」反映，默认假设另以独立区块透明标注
  const completenessResult = calculateCompleteness(config, input);
  const penalty = getConfidencePenalty(completenessResult.score);

  // 2. 实时获取材料价格（失败回退本地知识库/默认区间）
  const material = str(resolvedInput, "material", "white_card");
  const grammage = str(resolvedInput, "grammage", "350");
  const surface = str(resolvedInput, "surfaceTreatment", "none");
  const materialPrices = await getMaterialPrices({
    material,
    grammage,
    surfaceTreatment: surface,
    aiSettings: options.aiSettings,
  });

  // 1.5 平面彩印：内页克重随页数自动派生默认（仅当用户未显式填写时覆盖默认值）
  if (config.code === "flat_print") {
    const userGrammageRaw = input.grammage;
    const userProvided = userGrammageRaw != null && String(userGrammageRaw).trim() !== "";
    if (!userProvided) {
      resolvedInput.grammage = suggestInnerGrammage(Number(resolvedInput.pages) || 1);
    }
  }

  // 2.5 共享派生上下文（dataflow 非零通信：一次计算，供各 agent 只读消费；productType 决定派生量与公式分支）
  const ctx = deriveAnalysisContext(resolvedInput, config.code);

  // 3. 运行各 Agent（含重试校验）
  let results: AgentResult[] = [];
  let validationIssues: ValidationIssue[] = [];
  let retries = 0;

  // 地域是否默认为基准（华东）：只有当用户既未显式选人工地域、也未选非默认交付地时
  const regionDefaulted =
    !input.laborRegion &&
    !(input.deliveryLocation && input.deliveryLocation !== "east_china");

  while (retries <= MAX_RETRIES) {
    results = calculateRatios(
      runAllAgents(ctx, materialPrices, regionDefaulted)
    );
    validationIssues = validate(
      results,
      config,
      completenessResult.score,
      Number(input.quantity) || 0
    );

    const hasErrors = validationIssues.some((i) => i.severity === "error");
    if (!hasErrors) break;
    retries++;
  }

  // 2.6 平面彩印装订可行性校验（骑马钉页数上限告警，允许覆盖）
  if (config.code === "flat_print") {
    validationIssues = [...validationIssues, ...validateFlatBinding(resolvedInput, config)];
  }

  // 3.5 跨维度一致性审阅（只读，不改数字）
  const review = reviewAnalysis(ctx, results, config);

  // 4. 默认假设 + 低置信知识库条目 -> 降低相关维度置信度（C2）
  results = results.map((r) => {
    const kbPenalty = kbConfidencePenalty(r.kbConfidence);
    const lowKb = r.kbConfidence != null && r.kbConfidence < KB_CONFIDENCE_FLOOR;
    return {
      ...r,
      confidence: Math.max(
        0,
        Math.round(
          r.confidence -
            getDefaultPenaltyForDimension(r.dimension, assumptions) -
            kbPenalty
        )
      ),
      // 只提示、绝不改数：低置信参数如实暴露，由用户决定是否核实
      risks: lowKb
        ? [
            ...r.risks,
            `本维度部分参数来自低置信知识库条目（条目置信度 ${r.kbConfidence}），建议核实后再对外报价`,
          ]
        : r.risks,
    };
  });

  // 因默认假设导致的整体置信度下调（各维度默认惩罚均值，便于报告中透明展示）
  const defaultPenalties = results.map((r) =>
    getDefaultPenaltyForDimension(r.dimension, assumptions)
  );
  const defaultConfidencePenalty =
    defaultPenalties.length > 0
      ? Math.round(
          defaultPenalties.reduce((a, b) => a + b, 0) / defaultPenalties.length
        )
      : 0;

  const totalMin = results.reduce((s, r) => s + r.amountRange[0], 0);
  const totalMax = results.reduce((s, r) => s + r.amountRange[1], 0);
  const totalEst = results.reduce((s, r) => s + r.estimatedAmount, 0);
  const quantity = Number(input.quantity) || num(resolvedInput, "quantity", 1);

  const mfgDims = config.dimensions.filter((d) => d.group === "manufacturing");
  const comDims = config.dimensions.filter((d) => d.group === "commercial");

  const mfgTotal = results
    .filter((r) => mfgDims.some((d) => d.key === r.dimension))
    .reduce((s, r) => s + r.estimatedAmount, 0);
  const comTotal = results
    .filter((r) => comDims.some((d) => d.key === r.dimension))
    .reduce((s, r) => s + r.estimatedAmount, 0);

  const avgConfidence =
    results.reduce((s, r) => s + r.confidence, 0) / results.length;
  const overallConfidence = Math.max(
    0,
    Math.round(avgConfidence - penalty)
  );

  const report: AnalysisReport = {
    sessionId,
    productType: config.code,
    productTypeName: config.name,
    generatedAt: new Date().toISOString(),
    completeness: completenessResult.score,
    missingFields: completenessResult.missing.map((m) => ({
      key: m.key,
      label: m.label,
      impact: m.impact,
    })),
    totalCost: {
      min: Math.round(totalMin * 100) / 100,
      max: Math.round(totalMax * 100) / 100,
      unit: "元",
      perUnit: {
        min: Math.round((totalMin / quantity) * 10000) / 10000,
        max: Math.round((totalMax / quantity) * 10000) / 10000,
      },
    },
    overallConfidence,
    dimensions: results,
    manufacturingCost: {
      total: Math.round(mfgTotal * 100) / 100,
      ratio: totalEst > 0 ? Math.round((mfgTotal / totalEst) * 1000) / 10 : 0,
    },
    commercialCost: {
      total: Math.round(comTotal * 100) / 100,
      ratio: totalEst > 0 ? Math.round((comTotal / totalEst) * 1000) / 10 : 0,
    },
    validationIssues,
    optimizationHints: generateOptimizationHints(input, results),
    disclaimer: DISCLAIMER,
    // ===== 新增：透明化呈现 =====
    materialPriceSources: materialPrices,
    laborRegion: {
      code: ctx.laborRegion ?? DEFAULT_LABOR_REGION,
      label: getLaborRegion(ctx.laborRegion).label,
      isDefault: regionDefaulted,
    },
    defaultAssumptions: assumptions,
    defaultConfidencePenalty,
    review,
    // ===== 客户报告优化结构（固定 9 模块派生字段）=====
    costDrivers: generateCostDrivers(results),
    smallBatchNote: buildSmallBatchNote(results, config, quantity),
    ctaCopy: CTA_COPY,
    sectionOrder: SECTION_ORDER,
  };

  // AI 包装 SQE 专家诊断（无 LLM Key 时回退模板段落）
  const sqeDiagnosis = await generateSqeDiagnosis(report, options.aiSettings);
  // P1 多角色表达（无 LLM Key 时回退确定性模板，仍带真实数字指针）
  const roleReports = await generateRoleReports(report, options.aiSettings);
  // P2 判定解释（确定性校验证据 → AI 专业叙述；无 Key 时回退模板）
  const judgeExplanation = await generateJudgeExplanation(report, options.aiSettings);

  // P8 一致性闸门（编排层）：跨层对账 + 告警聚合
  const judgeHasError =
    (judgeExplanation.findings ?? []).some((f) => f.severity === "error") ||
    (report.validationIssues ?? []).some((i) => i.severity === "error");
  const cross = reconcileCrossLayer({
    judgeHasError,
    roleReports: (roleReports ?? []) as RoleReportLike[],
  });
  const finalRoleReports = cross.reports as typeof roleReports;

  const consistencyWarnings: ConsistencyWarning[] = [
    ...(cross.warnings ?? []),
    ...(judgeExplanation.consistencyWarnings ?? []),
    ...(roleReports ?? []).flatMap((r) =>
      (r.driftWarnings ?? []).map((d) => ({
        layer: "role_reports",
        code: "drift" as const,
        severity: (d.severity === "error" ? "error" : "warning") as "warning" | "error",
        message: d.message,
      }))
    ),
  ];

  // 成本估算阶段：强制调用确定性物理公式（BCT/ECT/湿敏）做可行性评估；
  // 非否决型——仅把结果挂到报告，供 UI 告警与下游 VAVE 硬过滤复用同一公式。
  const physicalFeasibility = assessBaseline(input);

  return {
    ...report,
    sqeDiagnosis,
    roleReports: finalRoleReports,
    judgeExplanation,
    consistencyWarnings: consistencyWarnings.length ? consistencyWarnings : undefined,
    physicalFeasibility,
    multiView: generateMultiViewReport({ ...report, physicalFeasibility }),
  };
}
