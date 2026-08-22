import type {
  AgentResult,
  AnalysisInput,
  AnalysisReport,
  MaterialPriceFetchResult,
  OptimizationHint,
  ProductTypeConfig,
  ValidationIssue,
} from "@/types";
import {
  materialAgent,
  processAgent,
  laborAgent,
  equipmentAgent,
  designAgent,
  financeAgent,
} from "./specialists";
import { calculateCompleteness, getConfidencePenalty } from "@/lib/completeness";
import { fetchMaterialPrices } from "@/lib/material-prices/fetcher";
import {
  applyDefaults,
  getDefaultPenaltyForDimension,
} from "@/lib/agents/question-engine";

const MAX_RETRIES = 2;
const SUM_TOLERANCE = 0.02; // 2% 容差

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
}

function runAllAgents(
  input: AnalysisInput,
  materialPrices: MaterialPriceFetchResult,
  regionDefaulted: boolean
): AgentResult[] {
  const material = materialAgent(input, materialPrices);
  const process = processAgent(input);
  const labor = laborAgent(input, regionDefaulted);
  const equipment = equipmentAgent(input);
  const design = designAgent(input);

  const manufacturingSubtotal =
    material.estimatedAmount +
    process.estimatedAmount +
    labor.estimatedAmount +
    equipment.estimatedAmount;

  const finance = financeAgent(input, manufacturingSubtotal + design.estimatedAmount);

  return [material, process, labor, equipment, design, finance];
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
  completeness: number
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const total = results.reduce((sum, r) => sum + r.estimatedAmount, 0);

  // 占比区间校验
  for (const result of results) {
    const dimConfig = config.dimensions.find((d) => d.key === result.dimension);
    if (!dimConfig) continue;
    const [minR, maxR] = dimConfig.expectedRatioRange;
    if (result.ratio < minR - 5 || result.ratio > maxR + 5) {
      issues.push({
        type: "ratio_out_of_range",
        severity: "warning",
        message: `${result.dimensionLabel}占比 ${result.ratio}% 偏离预期区间 ${minR}%-${maxR}%`,
        suggestion: "请核实输入参数是否准确，或该产品是否有特殊工艺",
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
  const process = results.find((r) => r.dimension === "process");

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

  return hints.slice(0, 2);
}

/**
 * 主控 Agent（Orchestrator）
 * 负责调度专业 Agent、汇总结果、执行校验与有限重试
 */
export async function runOrchestrator(
  options: OrchestratorOptions
): Promise<AnalysisReport> {
  const { sessionId, config, input, skippedKeys = [] } = options;

  // 1. 应用默认值（未填写或用户跳过的字段），并收集默认假设
  const { input: resolvedInput, assumptions } = applyDefaults(
    input,
    new Set(skippedKeys)
  );

  // 信息完整度基于「用户实际填写」反映，默认假设另以独立区块透明标注
  const completenessResult = calculateCompleteness(config, input);
  const penalty = getConfidencePenalty(completenessResult.score);

  // 2. 实时获取材料价格（失败回退本地知识库/默认区间）
  const material = str(resolvedInput, "material", "white_card");
  const grammage = str(resolvedInput, "grammage", "350");
  const surface = str(resolvedInput, "surfaceTreatment", "none");
  const materialPrices = await fetchMaterialPrices({
    material,
    grammage,
    surfaceTreatment: surface,
  });

  // 3. 运行各 Agent（含重试校验）
  let results: AgentResult[] = [];
  let validationIssues: ValidationIssue[] = [];
  let retries = 0;

  // 地域是否为默认假设：用户未选或主动跳过
  const regionDefaulted =
    !input.laborRegion || skippedKeys.includes("laborRegion");

  while (retries <= MAX_RETRIES) {
    results = calculateRatios(
      runAllAgents(resolvedInput, materialPrices, regionDefaulted)
    );
    validationIssues = validate(results, config, completenessResult.score);

    const hasErrors = validationIssues.some((i) => i.severity === "error");
    if (!hasErrors) break;
    retries++;
  }

  // 4. 默认假设 -> 降低相关维度置信度
  results = results.map((r) => ({
    ...r,
    confidence: Math.max(
      0,
      Math.round(
        r.confidence - getDefaultPenaltyForDimension(r.dimension, assumptions)
      )
    ),
  }));

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

  const laborResult = results.find((r) => r.dimension === "labor");

  return {
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
    disclaimer: "本结果仅为行业基准参考，不构成正式报价。",
    // ===== 新增：透明化呈现 =====
    materialPriceSources: materialPrices,
    laborRegion: laborResult?.laborRegion,
    defaultAssumptions: assumptions,
    defaultConfidencePenalty,
  };
}
