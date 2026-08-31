// ========== 五维偏差热力图 · 确定性计算层 ==========
// 红线：所有数值都是确定性纯函数算出来的，不交 AI（AI 只可能在上层做解读，不碰数）。
//
// 「偏差」的两个基准，按可用性自动选择：
//   1. expected —— 品类预期占比区间（config.dimensions.expectedRatioRange），单行即可用，首选。
//   2. cohort   —— 同批产品该维度占比的中位数，需 >= COHORT_MIN_ROWS 行，作为交叉参照。
// 两者都没有 → 返回 null，页面不渲染热力图（宁可不画，也不画没有基准的色块）。
//
// 口径说明（重要）：客户报价只有单只总价，没有五维分解。若按我方占比把客户价摊到五维，
// 每个维度的偏差都等于总价差 × 占比，整行同色、信息量为零。所以本层的「偏差」是
// **结构偏差**：我方的维度占比 vs 基准占比，用来定位「这批里哪一行、哪一维度结构异常」。

import type { ProductTypeConfig } from "@/types";
import type { ImportProductRow } from "@/lib/parse/import-shared";

/** 启用同批中位数基准所需的最少有效行数 */
export const COHORT_MIN_ROWS = 3;

/** |偏差 pp| 的分级阈值：<2 视为噪声，>=10 视为显著 */
export const DEVIATION_LEVELS = [2, 5, 10] as const;

export type DeviationBasis = "expected" | "cohort";

export interface HeatmapCell {
  dimension: string;
  dimensionLabel: string;
  /** 单只金额（元）= 维度总量 / 数量 */
  perUnit: number;
  /** 该维度占单只成本比例 % */
  ratio: number;
  /** 偏差（百分点）：>0 高于基准，<0 低于基准 */
  deviation: number;
  /** 色阶 -3~3，0 表示无显著偏差 */
  level: number;
  /** 该行没有这一维度的数据（该品类未产生该维度成本） */
  absent?: boolean;
  /** 同批该维度占比中位数（样本不足为 undefined） */
  cohortMedian?: number;
  /** 与同批中位数的差（百分点） */
  cohortDelta?: number;
}

export interface HeatmapRow {
  index: number;
  key: string;
  name: string;
  quantity: number;
  /** 我方单只估算（区间中值） */
  ourUnit: number;
  customerUnit?: number;
  /** 客户单价 − 我方单只 */
  delta?: number;
  /** 毛利率 %（相对客户单价） */
  margin?: number;
  missingFields: string[];
  cells: HeatmapCell[];
}

export interface HeatmapOutlier {
  rowIndex: number;
  rowName: string;
  dimension: string;
  dimensionLabel: string;
  deviation: number;
  direction: "high" | "low";
  perUnit: number;
  ratio: number;
}

export interface CohortSkew {
  dimension: string;
  dimensionLabel: string;
  direction: "high" | "low";
  /** 参与判定的行数 */
  count: number;
  /** 该维度的平均偏差（百分点，带符号） */
  avgDeviation: number;
}

export interface HeatmapModel {
  basis: DeviationBasis;
  dimensions: { key: string; label: string; maxPerUnit: number }[];
  rows: HeatmapRow[];
  /** 偏差绝对值最大的若干个（行, 维度）组合，最多 3 个，且每个维度只出最极端的一条 */
  outliers: HeatmapOutlier[];
  /** 整批同向偏离基准的维度：这时更该怀疑基准/口径，而不是某一个产品 */
  cohortSkew: CohortSkew[];
  /** 本次最大 |偏差|，供图例标定色阶 */
  maxAbsDeviation: number;
  /** 同批有效行数 */
  cohortSize: number;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** 取客户单只价：优先单价列，否则总价 / 数量 */
export function customerUnitPrice(row: ImportProductRow): number | undefined {
  const p = row.price;
  if (!p) return undefined;
  if (typeof p.unitPrice === "number" && isFinite(p.unitPrice)) return p.unitPrice;
  if (typeof p.totalPrice === "number" && isFinite(p.totalPrice)) {
    const q = Number(row.input?.quantity);
    if (isFinite(q) && q > 0) return round(p.totalPrice / q);
  }
  return undefined;
}

/**
 * 「单只金额」口径的色阶 0~3：按该维度列内最大单只金额归一化，越大越暖（成本重心）。
 * 全列为 0（或只有一个样本）时返回 0，避免单人独舞时满屏深色。
 */
export function amountLevel(perUnit: number, maxPerUnit: number): number {
  if (!maxPerUnit || maxPerUnit <= 0 || perUnit <= 0) return 0;
  const r = perUnit / maxPerUnit;
  if (r >= 0.999) return 3;
  if (r >= 0.66) return 2;
  if (r >= 0.33) return 1;
  return 0;
}

function levelOf(deviation: number): number {
  const a = Math.abs(deviation);
  if (a < DEVIATION_LEVELS[0]) return 0;
  if (a < DEVIATION_LEVELS[1]) return deviation > 0 ? 1 : -1;
  if (a < DEVIATION_LEVELS[2]) return deviation > 0 ? 2 : -2;
  return deviation > 0 ? 3 : -3;
}

/**
 * 构造「产品 × 五维」偏差热力图模型。
 * @param rows    导入结果行（含 estimate.dimensions）
 * @param config  品类配置，提供维度顺序与预期占比区间
 * @returns 无有效估算 / 无可用基准时返回 null（调用方应跳过渲染）
 */
export function buildDeviationHeatmap(
  rows: ImportProductRow[],
  config?: ProductTypeConfig
): HeatmapModel | null {
  const valid = rows.filter((r) => r.estimate && r.estimate.dimensions.length > 0);
  if (!valid.length) return null;

  // ---- 维度顺序：品类配置 order 优先，行里多出来的维度补在后面 ----
  const dimOrder: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const cfgDims = [...(config?.dimensions ?? [])].sort(
    (a, b) => (a.order ?? 99) - (b.order ?? 99)
  );
  for (const d of cfgDims) {
    dimOrder.push({ key: d.key, label: d.label });
    seen.add(d.key);
  }
  for (const r of valid) {
    for (const d of r.estimate!.dimensions) {
      if (!seen.has(d.dimension)) {
        dimOrder.push({ key: d.dimension, label: d.dimensionLabel });
        seen.add(d.dimension);
      }
    }
  }
  if (!dimOrder.length) return null;

  const ranges = new Map<string, [number, number]>();
  for (const d of config?.dimensions ?? []) {
    if (d.expectedRatioRange) ranges.set(d.key, d.expectedRatioRange);
  }

  // ---- 同批中位数（每个维度一列样本） ----
  const cohortSize = valid.length;
  const useCohort = cohortSize >= COHORT_MIN_ROWS;
  const cohortMedian = new Map<string, number>();
  if (useCohort) {
    for (const dim of dimOrder) {
      const samples: number[] = [];
      for (const r of valid) {
        const c = r.estimate!.dimensions.find((x) => x.dimension === dim.key);
        if (c && isFinite(c.ratio)) samples.push(c.ratio);
      }
      if (samples.length >= COHORT_MIN_ROWS) cohortMedian.set(dim.key, median(samples));
    }
  }

  // ---- 基准选择：预期区间覆盖过半维度优先，否则退回同批中位数 ----
  const covered = dimOrder.filter((d) => ranges.has(d.key)).length;
  let basis: DeviationBasis | null = null;
  if (covered / dimOrder.length >= 0.6) basis = "expected";
  else if (cohortMedian.size) basis = "cohort";
  if (!basis) return null;

  // ---- 逐行逐维计算 ----
  const outRows: HeatmapRow[] = [];
  let maxAbs = 0;
  const maxPerUnit = new Map<string, number>();

  for (const r of valid) {
    const est = r.estimate!;
    const qtyRaw = Number(r.input?.quantity);
    const quantity = isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;

    const cells: HeatmapCell[] = dimOrder.map((dim) => {
      const d = est.dimensions.find((x) => x.dimension === dim.key);
      if (!d) {
        return {
          dimension: dim.key,
          dimensionLabel: dim.label,
          perUnit: 0,
          ratio: 0,
          deviation: 0,
          level: 0,
          absent: true,
        };
      }
      const ratio = isFinite(d.ratio) ? d.ratio : 0;
      const perUnit = round(d.amount / quantity);

      let deviation = 0;
      const range = ranges.get(dim.key);
      if (basis === "expected" && range) {
        const [min, max] = range;
        if (ratio > max) deviation = round(ratio - max, 1);
        else if (ratio < min) deviation = round(ratio - min, 1);
      }
      if (deviation === 0 && basis === "expected" && !range) {
        const m = cohortMedian.get(dim.key);
        if (m != null) deviation = round(ratio - m, 1);
      }
      if (basis === "cohort") {
        const m = cohortMedian.get(dim.key);
        if (m != null) deviation = round(ratio - m, 1);
      }

      const cell: HeatmapCell = {
        dimension: dim.key,
        dimensionLabel: d.dimensionLabel || dim.label,
        perUnit,
        ratio: round(ratio, 1),
        deviation,
        level: levelOf(deviation),
        cohortMedian: cohortMedian.get(dim.key),
        cohortDelta:
          cohortMedian.get(dim.key) != null
            ? round(ratio - cohortMedian.get(dim.key)!, 1)
            : undefined,
      };
      maxAbs = Math.max(maxAbs, Math.abs(cell.deviation));
      maxPerUnit.set(dim.key, Math.max(maxPerUnit.get(dim.key) ?? 0, cell.perUnit));
      return cell;
    });

    const custUnit = customerUnitPrice(r);
    const ourUnit = est.perUnit;
    const hasDelta = custUnit != null && isFinite(ourUnit);
    const delta = hasDelta ? round(custUnit! - ourUnit) : undefined;
    const margin =
      hasDelta && custUnit! > 0 ? round(((custUnit! - ourUnit) / custUnit!) * 100, 1) : undefined;

    outRows.push({
      index: r.index,
      key: `row-${r.index}`,
      name: r.name?.trim() || `产品 ${r.index + 1}`,
      quantity,
      ourUnit: round(ourUnit),
      customerUnit: custUnit,
      delta,
      margin,
      missingFields: est.missingFields ?? [],
      cells,
    });
  }

  // ---- 偏差最大的若干组合（同偏差时按单只金额降序，金额大的更值得看） ----
  const outliers: HeatmapOutlier[] = [];
  for (const row of outRows) {
    for (const c of row.cells) {
      if (c.absent || !c.deviation) continue;
      outliers.push({
        rowIndex: row.index,
        rowName: row.name,
        dimension: c.dimension,
        dimensionLabel: c.dimensionLabel,
        deviation: c.deviation,
        direction: c.deviation > 0 ? "high" : "low",
        perUnit: c.perUnit,
        ratio: c.ratio,
      });
    }
  }
  outliers.sort(
    (a, b) => Math.abs(b.deviation) - Math.abs(a.deviation) || b.perUnit - a.perUnit
  );
  // 每个维度只留最极端的一条：否则「材料成本」一个维度就能占满 Top3，看不出别的维度的问题
  const perDim = new Map<string, HeatmapOutlier>();
  for (const o of outliers) {
    if (!perDim.has(o.dimension)) perDim.set(o.dimension, o);
  }
  const topOutliers = [...perDim.values()]
    .sort(
      (a, b) => Math.abs(b.deviation) - Math.abs(a.deviation) || b.perUnit - a.perUnit
    )
    .slice(0, 3);

  // ---- 整批同向偏离：所有行都朝同一侧偏，先怀疑基准/口径本身 ----
  const cohortSkew: CohortSkew[] = [];
  if (cohortSize >= 2) {
    for (const dim of dimOrder) {
      const devs: number[] = [];
      for (const row of outRows) {
        const c = row.cells.find((x) => x.dimension === dim.key);
        // 只统计「显著」偏离（>= 噪声阈值），避免 0.3pp 这种噪声也被判成整批偏离
        if (c && !c.absent && Math.abs(c.deviation) >= DEVIATION_LEVELS[0])
          devs.push(c.deviation);
      }
      if (devs.length < cohortSize) continue; // 有行没数据就不下结论
      const positive = devs.filter((d) => d > 0).length;
      const negative = devs.filter((d) => d < 0).length;
      if (positive !== cohortSize && negative !== cohortSize) continue;
      const avg = devs.reduce((a, b) => a + b, 0) / devs.length;
      cohortSkew.push({
        dimension: dim.key,
        dimensionLabel: dim.label,
        direction: positive === cohortSize ? "high" : "low",
        count: cohortSize,
        avgDeviation: round(avg, 1),
      });
    }
  }

  return {
    basis,
    dimensions: dimOrder.map((d) => ({
      ...d,
      maxPerUnit: round(maxPerUnit.get(d.key) ?? 0),
    })),
    rows: outRows,
    outliers: topOutliers,
    cohortSkew,
    maxAbsDeviation: round(maxAbs, 1),
    cohortSize,
  };
}
