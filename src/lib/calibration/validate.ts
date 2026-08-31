/**
 * 校准案例共享校验（前端表单 / 批量导入 API 共用同一份规则，避免口径分叉）
 *
 * 铁律：这里**只做提示，不改数**。缺失字段只产生 warning（不阻断提交）——
 * 供应商只报总价也是合法案例，能否校准由 calibration-real.ts 判断，
 * 但缺失高影响字段会让引擎估算失真，必须在录入时就把风险显式告知用户。
 */

import type { ProductField, ProductTypeConfig } from "@/types";
import { getProductConfig } from "@/config/products";

export const DIM_KEYS = [
  "material",
  "labor",
  "process",
  "design_plate",
  "finance_other",
] as const;

export const DIM_LABELS: Record<string, string> = {
  material: "材料",
  labor: "人工",
  process: "加工费(含设备)",
  design_plate: "设计与制版",
  finance_other: "财务与其他",
};

export const ANCHOR_KEYS = [
  "paperPricePerTon",
  "laborRatePerPiece",
  "plateCost",
  "financeTotal",
] as const;

/** 权重 ≥ 此值视为「高影响字段」（与 docs/question-priority.md 的高影响清单一致） */
export const HIGH_IMPACT_WEIGHT = 9;

export interface CaseIssue {
  level: "error" | "warn";
  /** 关联字段（input.xxx / actual.total / caseId …），用于前端定位 */
  field?: string;
  message: string;
}

/** 校准案例的最小形状（兼容前端表单与 JSON 文件里已有的案例） */
export interface CaseLike {
  caseId?: unknown;
  productType?: unknown;
  input?: Record<string, unknown> | null;
  actual?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (typeof v === "number" && !Number.isFinite(v));
}

function isPosNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isVisible(field: ProductField, values: Record<string, unknown>): boolean {
  const sw = field.showWhen;
  if (!sw) return true;
  const cur = values[sw.field];
  const targets = Array.isArray(sw.value) ? sw.value : [sw.value];
  return targets.includes(cur as never);
}

/** 取案例的品类 code：优先顶层 productType，其次 input.productType（前端表单写在 input 里） */
export function caseOfProductType(c: CaseLike): string {
  const top = typeof c.productType === "string" ? c.productType : "";
  const inner = typeof c.input?.productType === "string" ? c.input.productType : "";
  return top || inner || "";
}

/** 按品类给出高影响字段（必填 或 权重≥9），已按当前取值过滤掉 showWhen 不可见的 */
export function highImpactFields(
  cfg: ProductTypeConfig,
  values: Record<string, unknown>
): ProductField[] {
  return cfg.fields.filter(
    (f) => (f.required || f.weight >= HIGH_IMPACT_WEIGHT) && isVisible(f, values)
  );
}

/**
 * 单条案例校验。
 * error = 不能入库（缺 caseId / 总价非正 / 未知品类）；warn = 可入库但会削弱校准价值。
 */
export function validateCase(c: CaseLike): { errors: CaseIssue[]; warnings: CaseIssue[] } {
  const errors: CaseIssue[] = [];
  const warnings: CaseIssue[] = [];

  // ---- 阻断项 ----
  if (typeof c.caseId !== "string" || !c.caseId.trim()) {
    errors.push({ level: "error", field: "caseId", message: "缺少案例标识 caseId" });
  }

  const total = c.actual?.total;
  if (isBlank(total)) {
    errors.push({ level: "error", field: "actual.total", message: "缺少实际总价（必填）" });
  } else if (!isPosNum(total)) {
    errors.push({
      level: "error",
      field: "actual.total",
      message: "实际总价必须是大于 0 的数字",
    });
  }

  const pt = caseOfProductType(c);
  if (!pt) {
    errors.push({ level: "error", field: "productType", message: "未指定产品类别" });
  }

  // ---- 提示项：高影响字段缺失 ----
  const cfg = pt ? getProductConfig(pt) : undefined;
  if (pt && !cfg) {
    errors.push({ level: "error", field: "productType", message: `未知产品类别：${pt}` });
  }
  if (cfg) {
    const values = c.input ?? {};
    const missing = highImpactFields(cfg, values).filter((f) => isBlank(values[f.key]));
    if (missing.length) {
      warnings.push({
        level: "warn",
        field: "input",
        message: `缺高影响参数：${missing.map((f) => f.label).join("、")}（引擎将走默认值，估算偏差会放大）`,
      });
    }

    // 已知非法枚举值（选项类字段填了不在选项表里的值）
    for (const f of cfg.fields) {
      const v = values[f.key];
      if (isBlank(v) || !f.options?.length) continue;
      const ok = f.options.some((o) => String(o.value) === String(v));
      if (!ok) {
        warnings.push({
          level: "warn",
          field: `input.${f.key}`,
          message: `${f.label} 的值「${String(v)}」不在选项表内，建议先补进字典或改写法`,
        });
      }
    }
  }

  // ---- 提示项：五维拆解与总价对不上（口径问题，会让分维度校准失真）----
  if (isPosNum(total)) {
    const parts = DIM_KEYS.map((k) => c.actual?.[k]).filter(isPosNum) as number[];
    if (parts.length === DIM_KEYS.length) {
      const sum = parts.reduce((a, b) => a + b, 0);
      const diff = Math.abs(sum - (total as number)) / (total as number);
      if (diff > 0.02) {
        warnings.push({
          level: "warn",
          field: "actual",
          message: `五维合计 ¥${sum.toFixed(0)} 与总价 ¥${Number(total).toFixed(0)} 差 ${(diff * 100).toFixed(1)}%，请核对是否含税/含运/含打样`,
        });
      }
    } else if (parts.length > 0) {
      warnings.push({
        level: "warn",
        field: "actual",
        message: `五维只拆了 ${parts.length}/${DIM_KEYS.length} 项，未拆维度不参与分维度校准（总价校准仍有效）`,
      });
    }
  }

  // ---- 提示项：口径未记录 ----
  const note = c.meta?.note;
  if (isBlank(note)) {
    warnings.push({
      level: "warn",
      field: "meta.note",
      message: "未备注口径（含税？含运？打样费是否单列），跨案例混口径会让校准失真",
    });
  }

  // ---- 提示项：无外部锚 ----
  const hasAnchor = ANCHOR_KEYS.some(
    (k) => isPosNum(c.meta?.[k]) || isPosNum((c.actual as Record<string, unknown> | null)?.[k])
  );
  if (!hasAnchor) {
    warnings.push({
      level: "warn",
      field: "anchors",
      message: "无外部锚（纸价/工价/版费/财务），只能做总价校准；补纸价锚可半拆解定位加工费偏差",
    });
  }

  return { errors, warnings };
}

// ========== 覆盖度 ==========

export const COVERAGE_TARGET = 10;
export const COVERAGE_TARGET_MAX = 20;
/** 建议覆盖的品类（校准起步量口径：彩盒/瓦楞/精品盒/不同地域） */
export const TARGET_PRODUCT_TYPES = ["color_print_box", "corrugated_box", "flat_print"];
export const TARGET_REGIONS = ["east_china", "south_china"];

export interface CoverageSummary {
  total: number;
  target: number;
  targetMax: number;
  /** 品类 → 例数 */
  byProductType: Record<string, number>;
  /** 地域 → 例数 */
  byRegion: Record<string, number>;
  /** 还缺哪些品类 */
  missingProductTypes: string[];
  /** 还缺哪些地域 */
  missingRegions: string[];
  /** 有完整五维拆解的例数 */
  fullDims: number;
  /** 有外部锚的例数 */
  withAnchor: number;
}

export function summarizeCoverage(cases: CaseLike[]): CoverageSummary {
  const byProductType: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  let fullDims = 0;
  let withAnchor = 0;

  for (const c of cases) {
    const pt = caseOfProductType(c) || "unknown";
    byProductType[pt] = (byProductType[pt] ?? 0) + 1;

    const region =
      (c.input?.deliveryLocation as string) || (c.input?.laborRegion as string) || "unknown";
    byRegion[region] = (byRegion[region] ?? 0) + 1;

    if (DIM_KEYS.every((k) => isPosNum(c.actual?.[k]))) fullDims += 1;
    if (ANCHOR_KEYS.some((k) => isPosNum(c.meta?.[k]) || isPosNum(c.actual?.[k]))) withAnchor += 1;
  }

  return {
    total: cases.length,
    target: COVERAGE_TARGET,
    targetMax: COVERAGE_TARGET_MAX,
    byProductType,
    byRegion,
    missingProductTypes: TARGET_PRODUCT_TYPES.filter((p) => !byProductType[p]),
    missingRegions: TARGET_REGIONS.filter((r) => !byRegion[r]),
    fullDims,
    withAnchor,
  };
}
