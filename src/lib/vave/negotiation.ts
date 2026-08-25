// VAVE 谈判辅助（模板层，纯确定性，不依赖 LLM）
import type { AnalysisReport } from "@/types";

export interface TargetNegotiationRow {
  dimension: string;
  label: string;
  current: number;
  /** 按该维占比分摊的目标降本金额 */
  suggestedCut: number;
  /** 压缩后剩余金额 */
  remaining: number;
}

export interface TargetNegotiationResult {
  targetPerUnit: number;
  currentPerUnit: number;
  /** 单只需要下降的金额（>0 表示需降本） */
  gapPerUnit: number;
  /** gap 落在 [0, current] 视为可达成 */
  feasible: boolean;
  perDimension: TargetNegotiationRow[];
}

/** 目标价反推：给定客户目标价，按各维金额占比拆解可压缩空间 */
export function computeTargetNegotiation(
  report: AnalysisReport,
  targetPerUnit: number
): TargetNegotiationResult {
  const current = report.totalCost.perUnit.max;
  const gap = Math.round((current - targetPerUnit) * 10000) / 10000;
  const totalEst = report.dimensions.reduce((s, d) => s + d.estimatedAmount, 0);
  const perDimension: TargetNegotiationRow[] = report.dimensions.map((d) => {
    const share = totalEst > 0 ? d.estimatedAmount / totalEst : 0;
    const suggestedCut = Math.round(gap * share * 10000) / 10000;
    return {
      dimension: d.dimension,
      label: d.dimensionLabel,
      current: d.estimatedAmount,
      suggestedCut,
      remaining: Math.round((d.estimatedAmount - suggestedCut) * 10000) / 10000,
    };
  });
  return {
    targetPerUnit,
    currentPerUnit: current,
    gapPerUnit: gap,
    feasible: gap >= 0 && gap <= current,
    perDimension,
  };
}

export interface ConcessionResult {
  /** 报价（当前单只上限） */
  quotePerUnit: number;
  /** 保本价（含约 5% 利润底线） */
  breakEvenPerUnit: number;
  /** 最大可让利（元/个） */
  maxConcessionPerUnit: number;
  /** 最大可让利率（%） */
  maxConcessionRatio: number;
}

/** 让利空间：由单只报价区间派生保本价与最大可让利 */
export function computeConcession(report: AnalysisReport): ConcessionResult {
  const quote = report.totalCost.perUnit.max;
  const floor = report.totalCost.perUnit.min;
  const breakEven = Math.round(floor * 0.95 * 10000) / 10000;
  const maxConcession = Math.round((quote - breakEven) * 10000) / 10000;
  const ratio = quote > 0 ? Math.round((maxConcession / quote) * 1000) / 10 : 0;
  return {
    quotePerUnit: quote,
    breakEvenPerUnit: breakEven,
    maxConcessionPerUnit: maxConcession,
    maxConcessionRatio: ratio,
  };
}

/** 谈判话术模板（引用真实字段：材料占比、利用率、成本驱动） */
export function buildNegotiationScripts(report: AnalysisReport): string[] {
  const scripts: string[] = [];
  const material = report.dimensions.find((d) => d.dimension === "material");
  const drivers = report.costDrivers ?? [];

  const noun = structureNoun(report.productType);
  const unit = report.productType === "flat_print" ? "册/张" : "只";
  if (material) {
    scripts.push(
      `材料占每${unit}成本约 ${material.ratio}%，是最大成本项；纸价波动是主要风险点，建议以锁价或集采对冲。`
    );
    const u = material.areaMetrics;
    if (u) {
      const util = (u.utilization * 100).toFixed(1);
      const waste = ((1 - u.utilization) * 100).toFixed(1);
      scripts.push(
        u.sheetBased
          ? `当前${noun}材料利用率仅 ${util}%，约 ${waste}% 为废边，结构/拼版优化是明确的 VAVE 抓手。`
          : `当前材料利用率按${noun}默认拼版约 ${util}%（未填全张纸/每版${report.productType === "flat_print" ? "页数" : "只数"}），填真实拼版数据后可量化废边优化空间。`
      );
    }
  }
  if (drivers[0]) {
    scripts.push(
      `第一大成本驱动为「${drivers[0].dimensionLabel}」（占 ${drivers[0].ratio}%）：${drivers[0].reason}`
    );
  }
  scripts.push(
    `建议基于上述成本透明拆解，与客户对齐各维降本优先级，避免笼统压价；对敏感归因用「设计冗余优化」等中性表述。`
  );
  return scripts;
}

/** 按产品类型返回利用率话术中的结构名词 */
function structureNoun(productType: string): string {
  return productType === "flat_print" ? "拼版" : "盒型";
}
