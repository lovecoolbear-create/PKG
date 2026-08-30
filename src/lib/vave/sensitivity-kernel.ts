// ========== VAVE 敏感性确定性内核（建议 #3） ==========
// 所有 VAVE 敏感性 / 谈判数字均由本模块确定性计算，AI 只解读、绝不重算。
// 与 input-guardrail / feasibility 同源：数值计算永不交 AI（铁律）。
//
// 设计：
// - 纸价冲击（材料单价线性近似）此前散落在 React 组件内联，本模块将其收口为唯一真相源；
// - buildVaveKernelFacts 聚合全部确定性数字，供 AI 上下文只读注入（禁止 AI 重算/编造）。

import type { AnalysisReport } from "@/types";
import {
  computeConcession,
  computeTargetNegotiation,
  type ConcessionResult,
  type TargetNegotiationResult,
} from "./negotiation";
import { unitLabel } from "@/lib/units";

/**
 * 纸价冲击：材料单价变化对总成本的影响（确定性线性近似，未含克重替代等非线性效应）。
 * @param report 成本报告
 * @param paperPct 纸价变动百分比（如 +20 表示涨 20%，-20 表示跌 20%）
 * @param quantity 批量（用于摊算每单位成本）
 */
export function computePaperPriceImpact(
  report: AnalysisReport,
  paperPct: number,
  quantity: number
): {
  newMaterial: number;
  newTotal: number;
  newMaterialRatio: number;
  perUnit: number;
  quantity: number;
} {
  const material = report.dimensions.find((d) => d.dimension === "material");
  const otherTotal = report.dimensions
    .filter((d) => d.dimension !== "material")
    .reduce((s, d) => s + d.estimatedAmount, 0);
  const baseTotal =
    Math.round(
      report.dimensions.reduce((s, d) => s + d.estimatedAmount, 0) * 100
    ) / 100;
  const newMaterial = material
    ? Math.round(material.estimatedAmount * (1 + paperPct / 100) * 100) / 100
    : 0;
  const newTotal = Math.round((otherTotal + newMaterial) * 100) / 100;
  const newMaterialRatio =
    material && baseTotal > 0
      ? Math.round((newMaterial / baseTotal) * 1000) / 10
      : 0;
  const q = Number(quantity) || 0;
  const perUnit = q > 0 ? Math.round((newTotal / q) * 10000) / 10000 : 0;
  return { newMaterial, newTotal, newMaterialRatio, perUnit, quantity: q };
}

export interface VaveKernelFacts {
  unit: string;
  /** 让利空间（保本价 / 报价 / 最大可让利） */
  concession: ConcessionResult;
  /** 目标价反推（默认目标 = 报价 × 0.9） */
  target: TargetNegotiationResult;
  /** 纸价 +20% 冲击 */
  paperImpactPlus20: ReturnType<typeof computePaperPriceImpact>;
  /** 纸价 -20% 冲击 */
  paperImpactMinus20: ReturnType<typeof computePaperPriceImpact>;
}

/** 聚合所有确定性 VAVE 数字，供 AI 只读注入（禁止 AI 重算/编造）。 */
export function buildVaveKernelFacts(
  report: AnalysisReport,
  quantity: number,
  targetPerUnit?: number
): VaveKernelFacts {
  const t =
    typeof targetPerUnit === "number"
      ? targetPerUnit
      : Math.round(report.totalCost.perUnit.max * 0.9 * 100) / 100;
  return {
    unit: unitLabel(report.productType),
    concession: computeConcession(report),
    target: computeTargetNegotiation(report, t),
    paperImpactPlus20: computePaperPriceImpact(report, 20, quantity),
    paperImpactMinus20: computePaperPriceImpact(report, -20, quantity),
  };
}
