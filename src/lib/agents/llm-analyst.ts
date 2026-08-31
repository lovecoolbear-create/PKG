// ========== 入口三：AI 包装 SQE 专家诊断 + 多角色表达（P1） ==========
// P1 升级（2026-08-26）：在原有单一 SQE 诊断基础上，新增「多角色表达层」——
// 以采购 / 供应 / 成本 / 客户四种视角综合引擎结果生成报告，并带 Data Pointer 可溯源。
//
// 铁律落地：
// - 数字守恒：points 文本由 AI 生成「说法」，但所有涉及金额/占比的 Data Pointer 由确定性后处理
//   从引擎 report 填充（fieldPath + value 来自真实计算，绝不编造）。
// - 事实守恒：AI 只决定「引用哪些维度」（citedDimensions），数字来自引擎。
// - 可溯源：每条指针可高亮回溯引擎原始 JSON（见 DataPointer.fieldPath）。

import type { AnalysisReport } from "@/types";
import { chatCompletion, isLlmConfigured } from "@/lib/llm/client";
import {
  runGated,
  detectNumberDrift,
  auditLLMCall,
  modelLabel,
  type DriftFinding,
} from "@/lib/agents/consistency-gate";
import { MATERIAL_PRICES_META } from "@/lib/cost-rules";
import { getBenchmarkContextNote } from "@/lib/material-prices/context-layer";
import type { AiSettings } from "@/lib/config/ai-settings";
import { unitLabel } from "@/lib/units";

// ---------- 向后兼容：原单一 SQE 诊断 ----------

export interface SqeDiagnosis {
  text: string;
  source: "llm" | "template";
  generatedAt: string;
}

const SYSTEM_PROMPT = `你是一名拥有 20 年经验的 B2B 包装供应链与 SQE（供应商质量管理）专家，长期服务快消、食品、电子行业的包装采购与质量团队。

现在拿到一份彩印纸盒的成本拆解明细（JSON），请用专业、简洁、可执行的中文，写一段 150-200 字的诊断报告。必须覆盖以下要点：
1. 起步价/制版等固定成本在总成本的占比与合理性；
2. 批次规模效应（当前数量下的单位成本是否处在最优区间）；
3. 工艺（表面处理/专色/盒型复杂度）的性价比评估；
4. 1-2 条具体、可落地的降本建议（优先 VAVE 视角）。

不要使用 Markdown 标题或列表符号，直接连续成段输出，语气专业、客观、有顾问感。`;

/** 提取简明成本摘要，避免把整份报告大对象塞给模型 */
function buildBrief(report: AnalysisReport): string {
  const dims = report.dimensions
    .map(
      (d) =>
        `${d.dimensionLabel}: ¥${d.estimatedAmount}（${d.ratio}%）${d.breakdown?.length ? " [" + d.breakdown.map((b) => `${b.label}¥${b.amount}`).join("、") + "]" : ""}`
    )
    .join("；");
  return JSON.stringify({
    productType: report.productTypeName,
    totalCost: report.totalCost,
    overallConfidence: report.overallConfidence,
    dimensions: dims,
    defaultAssumptions: (report.defaultAssumptions || []).map(
      (a) => `${a.label}=${a.assumedValue}`
    ),
  });
}

/** 无 API Key 时的模板诊断（基于真实数据动态生成，比例严谨） */
function templateDiagnosis(report: AnalysisReport): string {
  const process = report.dimensions.find((d) => d.dimension === "process");
  const material = report.dimensions.find((d) => d.dimension === "material");
  const design = report.dimensions.find((d) => d.dimension === "design_plate");
  const quantity = Math.round(
    (report.totalCost.min + report.totalCost.max) / 2 /
      ((report.totalCost.perUnit.min + report.totalCost.perUnit.max) / 2 || 1)
  );

  const processRatio = process?.ratio ?? 0;
  const materialRatio = material?.ratio ?? 0;
  const designAmt = design?.estimatedAmount ?? 0;

  const scaleTip =
    quantity < 5000
      ? `当前订单约 ${quantity} 个，处于小批量区间，开机/制版等固定成本分摊偏高，单位成本尚未进入最优规模区间；建议评估合并批次或提升至 1 万+ 以摊薄固定费用。`
      : `当前订单约 ${quantity} 个，规模效应已较充分，固定成本分摊合理；后续可通过年度框架协议进一步锁定材料单价。`;

  const processTip =
    processRatio > 25
      ? "工艺加工占比偏高，建议复核表面处理与专色是否必要，局部烫金或减色可显著降本。"
      : "工艺结构占比健康，性价比尚可。";

  const designTip =
    designAmt > 800
      ? `设计与制版约 ¥${designAmt}，若后期有翻单，首单后制版费可摊薄，建议建立稿件资产复用机制。`
      : "设计制版费用可控。";

  return `作为包装供应链与 SQE 视角，本方案材料占比约 ${materialRatio}%、工艺占比约 ${processRatio}%，整体结构基本合理（置信度 ${report.overallConfidence}%）。${scaleTip}${processTip}${designTip}综合建议优先从盒型简化、工艺必要性与批次规模三处切入做 VAVE 降本。`;
}

/** 生成 AI 包装 SQE 专家诊断（保留向后兼容） */
export async function generateSqeDiagnosis(
  report: AnalysisReport,
  aiSettings?: AiSettings
): Promise<SqeDiagnosis> {
  const generatedAt = new Date().toISOString();

  const emit = (text: string, source: "llm" | "template"): SqeDiagnosis => {
    auditLLMCall({
      ts: new Date().toISOString(),
      layer: "sqe_diagnosis",
      source,
      model: modelLabel(aiSettings),
      inputSummary: buildBrief(report),
      engineKeyValues: buildEngineKV(report),
      outputText: text,
      warnings: [],
    });
    return { text, source, generatedAt };
  };

  if (!isLlmConfigured(aiSettings)) {
    return emit(templateDiagnosis(report), "template");
  }

  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `请基于以下成本拆解明细撰写诊断报告：\n${buildBrief(report)}`,
        },
      ],
      { temperature: 0.4, timeoutMs: 20000, settings: aiSettings }
    );
    const text = raw.trim();
    if (text.length >= 30) {
      return emit(text, "llm");
    }
  } catch {
    // 失败回退模板
  }
  return emit(templateDiagnosis(report), "template");
}

// ---------- P1 多角色表达层 ----------

export type VaveRole = "procurement" | "supplier" | "cost" | "client";

/** 可溯源锚点：引用引擎原始 JSON 字段，前端可高亮回溯 */
export interface DataPointer {
  /** 引擎原始 JSON 路径，如 dimensions.material.estimatedAmount */
  fieldPath: string;
  /** 展示锚文本 */
  label: string;
  /** 数值快照（来自引擎真实计算） */
  value: string;
}

/** 多角色表达输出（最终交付给 UI） */
export interface RoleReport {
  role: VaveRole;
  roleLabel: string;
  headline: string;
  points: string[];
  pointers: DataPointer[];
  source: "llm" | "template";
  /** 时效戳：基于本地基准价（P0.5） */
  asOf: string;
  generatedAt: string;
  /** P8 一致性闸门：文本数字 vs Pointer 真实数字的漂移发现 */
  driftWarnings?: DriftFinding[];
}

/** 模型原始输出（pointers 由确定性后处理填充，AI 不产出数字） */
interface RawRole {
  role: VaveRole;
  roleLabel: string;
  headline: string;
  points: string[];
  /** AI 只决定引用哪些维度，数字由后处理从引擎填充 */
  citedDimensions: string[];
}
interface RawRoleOutput {
  roles: RawRole[];
}

const ROLE_LABELS: Record<VaveRole, string> = {
  procurement: "采购方视角",
  supplier: "供应方视角",
  cost: "成本专家视角",
  client: "客户决策视角",
};

/** 确定性维度→指针映射（满足数字守恒 + 可溯源） */
function toPointer(key: string, report: AnalysisReport): DataPointer | null {
  if (key === "total") {
    return {
      fieldPath: "totalCost.max",
      label: "总成本",
      value: `¥${report.totalCost.max.toFixed(2)}`,
    };
  }
  if (key === "perUnit") {
    return {
      fieldPath: "totalCost.perUnit.max",
      label: `单${unitLabel(report.productType)}成本`,
      value: `¥${report.totalCost.perUnit.max.toFixed(4)}`,
    };
  }
  const dim = report.dimensions.find((d) => d.dimension === key);
  if (dim) {
    return {
      fieldPath: `dimensions.${dim.dimension}.estimatedAmount`,
      label: dim.dimensionLabel,
      value: `¥${dim.estimatedAmount.toFixed(2)}（${dim.ratio}%）`,
    };
  }
  return null;
}

const DEFAULT_CITED = ["total", "material", "process", "design_plate"];

/** 把原始角色（无论 LLM 还是模板）后处理成最终 RoleReport（填指针 + 时效 + 漂移校验） */
function finalizeRole(raw: RawRole, report: AnalysisReport, source: "llm" | "template"): RoleReport {
  const cited = raw.citedDimensions?.length ? raw.citedDimensions : DEFAULT_CITED;
  const pointers = cited
    .map((k) => toPointer(k, report))
    .filter((p): p is DataPointer => p !== null);
  // P8 漂移检测：扫描该角色文本中的金额/百分比 vs Pointer 真实数字
  const driftText = [raw.headline, ...(raw.points || [])].join(" ");
  const driftWarnings = detectNumberDrift(driftText, pointers);
  return {
    role: raw.role,
    roleLabel: raw.roleLabel || ROLE_LABELS[raw.role],
    headline: raw.headline,
    points: raw.points || [],
    pointers,
    source,
    asOf: MATERIAL_PRICES_META.asOf,
    generatedAt: new Date().toISOString(),
    driftWarnings: driftWarnings.length ? driftWarnings : undefined,
  };
}

/** 确定性模板多角色报告（无 LLM 时的兜底，仍带真实数字指针） */
function templateRoleReports(report: AnalysisReport): RawRoleOutput {
  const material = report.dimensions.find((d) => d.dimension === "material");
  const process = report.dimensions.find((d) => d.dimension === "process");
  const design = report.dimensions.find((d) => d.dimension === "design_plate");
  const quantity = Math.round(
    (report.totalCost.min + report.totalCost.max) / 2 /
      ((report.totalCost.perUnit.min + report.totalCost.perUnit.max) / 2 || 1)
  );
  const unit = unitLabel(report.productType);
  const roles: RawRole[] = [
    {
      role: "procurement",
      roleLabel: ROLE_LABELS.procurement,
      headline: `单${unit} ¥${report.totalCost.perUnit.max.toFixed(4)}，材料占 ${material?.ratio ?? 0}%，存在明确压价空间`,
      points: [
        `当前单${unit}成本 ¥${report.totalCost.perUnit.max.toFixed(4)}，其中材料 ¥${material?.estimatedAmount.toFixed(2)}（${material?.ratio ?? 0}%）为主要压价对象。`,
        quantity < 5000
          ? `批量仅 ${quantity}，固定费用分摊偏高，建议合并订单或年框锁定以摊薄。`
          : `批量 ${quantity} 规模效应充分，可作为年框议价基准。`,
        `工艺加工 ¥${process?.estimatedAmount.toFixed(2)}（${process?.ratio ?? 0}%），优先谈表面处理/专色减项。`,
      ],
      citedDimensions: ["perUnit", "material", "process"],
    },
    {
      role: "supplier",
      roleLabel: ROLE_LABELS.supplier,
      headline: `结构合理、良率可控，可承接但需在交期与 MOQ 上设边界`,
      points: [
        `材料 ${material?.ratio ?? 0}%/加工 ${process?.ratio ?? 0}% 属行业常规结构，工艺无超额难度。`,
        `制版及设计费 ¥${design?.estimatedAmount.toFixed(2)}，首单需明确稿件冻结与翻单摊薄规则。`,
        `建议以「材料随行就市 + 加工一口价」报价，规避纸价波动风险。`,
      ],
      citedDimensions: ["material", "process", "design_plate"],
    },
    {
      role: "cost",
      roleLabel: ROLE_LABELS.cost,
      headline: `置信度 ${report.overallConfidence}%，VAVE 优先从克重/批量/工艺三处切入`,
      points: [
        `整体置信度 ${report.overallConfidence}%，数字源于确定性引擎，可追溯。`,
        `VAVE 杠杆排序建议：克重降档＞批量提升＞工艺精简（需结合可实施性过滤，见 P3）。`,
        `基于本地基准价（asOf ${MATERIAL_PRICES_META.asOf}，${MATERIAL_PRICES_META.note}）。`,
      ],
      citedDimensions: ["total", "material", "process"],
    },
    {
      role: "client",
      roleLabel: ROLE_LABELS.client,
      headline: `在不牺牲功能与外观前提下，单${unit} ¥${report.totalCost.perUnit.max.toFixed(4)}，风险可控`,
      points: [
        `本方案单${unit}成本 ¥${report.totalCost.perUnit.max.toFixed(4)}，结构透明、每维可点开看算法。`,
        `若做 VAVE，须显式声明「不影响承重/外观/交期」，并先 3 样品验证再小批。`,
        `价格基于本地基准（asOf ${MATERIAL_PRICES_META.asOf}），实际以工厂当期报价为准。`,
      ],
      citedDimensions: ["perUnit", "total"],
    },
  ];
  return { roles };
}

const ROLE_SYSTEM_PROMPT = `你是一名资深的包装供应链 B2B 专家，需站在四种不同利益方的视角，对同一份成本拆解报告做表达。
必须严格输出如下 JSON（不要多余文字）：
{
  "roles": [
    {
      "role": "procurement|supplier|cost|client",
      "roleLabel": "采购方视角|供应方视角|成本专家视角|客户决策视角",
      "headline": "一句话结论（含关键判断，不写具体金额数字）",
      "points": ["要点1","要点2","要点3"],
      "citedDimensions": ["material","process","design_plate","total","perUnit"]
    }
  ]
}
四个角色必须都出现（procurement/supplier/cost/client 各一个）。

铁律（不可违反）：
- 不得编造任何金额、占比、工期；所有数字必须出现在提供的成本 JSON 中。
- points 是「对数字的说法与策略」，不是数字本身；金额只通过 citedDimensions 引用维度 key。
- citedDimensions 只能从 ["material","process","design_plate","total","perUnit"] 中选，对应材料/工艺/设计制版/总成本/单只成本。
- 视角差异要真实：采购方重压价与批量议价、供应方重良率与报价边界、成本专家重置信度与 VAVE 杠杆、客户重功能不牺牲与风险可控。`;

/** 引擎关键数字快照（供审计可追溯） */
function buildEngineKV(report: AnalysisReport): Record<string, string | number> {
  const kv: Record<string, string | number> = {
    totalCostMax: report.totalCost.max,
    perUnitMax: report.totalCost.perUnit.max,
  };
  for (const d of report.dimensions) {
    kv[`dim_${d.dimension}`] = `${d.estimatedAmount}(${d.ratio}%)`;
  }
  return kv;
}

/**
 * 生成多角色表达报告（P1 核心）。
 * 一次 LLM 调用产出 4 角色；失败/未配置时返回确定性模板（仍带真实数字指针）。
 * 经 runGated 统一管道（自动审计）；finalizeRole 内部做漂移检测。
 */
export async function generateRoleReports(
  report: AnalysisReport,
  aiSettings?: AiSettings
): Promise<RoleReport[]> {
  const user = `请基于以下成本拆解明细，站在四种视角写表达报告：\n${buildBrief(report)}\n\n时效背景：${getBenchmarkContextNote()}请在 points 中体现此时效边界，不要暗示实时行情。`;

  const fallback = templateRoleReports(report);
  const { result } = await runGated<RawRoleOutput>({
    layer: "role_reports",
    system: ROLE_SYSTEM_PROMPT,
    user,
    fallback,
    settings: aiSettings,
    temperature: 0.3,
    timeoutMs: 20000,
    engineKV: buildEngineKV(report),
  });

  // 后处理：填充真实指针 + 时效 + 漂移校验
  const source: "llm" | "template" = result === fallback ? "template" : "llm";
  return result.roles.map((r) => finalizeRole(r, report, source));
}
