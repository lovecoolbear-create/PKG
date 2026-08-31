// ========== 输入层确定性 Guardrail（建议 #1） ==========
// 在「成本估算」之前对结构化入参做一次纯确定性校验，拦截 garbage-in，
// 防止 2.5mm→25mm 这类单位混淆 / 数量=0 / 枚举非法 直接进入成本引擎。
//
// 设计铁律：
// - 本模块只做确定性规则判断，绝不调用 LLM；所有规则可溯源、可复算。
// - 与「5 specialist 数值计算永不交 AI」同源：输入校验是确定性层职责。
// - 严重度两级：
//     block = 必须修正，否则拒绝生成报告（避免基于无效输入产出误导性成本）；
//     warn  = 风险提示，仍允许生成，但须在 UI 明示，用户知情后继续。

import type { AnalysisInput, ProductTypeConfig, ProductField } from "@/types";

export type GuardrailSeverity = "block" | "warn";

export interface GuardrailIssue {
  severity: GuardrailSeverity;
  /** 关联的入参字段（用于 UI 定位） */
  field?: string;
  /** 机器可读编码 */
  code: string;
  /** 面向用户的中文说明 */
  message: string;
}

export interface GuardrailResult {
  issues: GuardrailIssue[];
  hasBlocker: boolean;
  blockers: GuardrailIssue[];
  warnings: GuardrailIssue[];
}

/** 走枚举校验的字段（值必须落在 config 对应字段的 options 内） */
const ENUM_FIELDS: string[] = [
  "boxType",
  "material",
  "printMethod",
  "surfaceTreatment",
  "fluteType",
];

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

function allowedValues(config: ProductTypeConfig, key: string): Set<string> {
  const f: ProductField | undefined = config.fields.find((x) => x.key === key);
  if (!f?.options) return new Set();
  return new Set(f.options.map((o) => String(o.value)));
}

/**
 * 运行输入 Guardrail。
 * @param input 结构化入参（已合并 AI 解析 + 用户填写 + 系统默认）
 * @param config 当前品类配置（用于枚举合法性、瓦楞载荷规则等品类相关判断）
 */
export function runInputGuardrail(
  input: AnalysisInput,
  config: ProductTypeConfig
): GuardrailResult {
  const issues: GuardrailIssue[] = [];

  // ---- 1. 订单数量 ----
  const qty = toNumber(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    issues.push({
      severity: "block",
      field: "quantity",
      code: "qty_invalid",
      message: "订单数量必须大于 0，请填写真实批量（如 3000）。",
    });
  } else if (qty < 50) {
    issues.push({
      severity: "warn",
      field: "quantity",
      code: "qty_small",
      message: `印量偏小（${qty} 个），单价会偏高，请确认数量是否准确。`,
    });
  } else if (qty > 5_000_000) {
    issues.push({
      severity: "warn",
      field: "quantity",
      code: "qty_huge",
      message: `印量异常大（${qty} 个），请确认是否为真实批量（疑似多写/少写 0）。`,
    });
  }

  // ---- 2. 尺寸（长/宽/高）----
  for (const dim of ["length", "width", "height"] as const) {
    if (input[dim] === undefined) continue; // 缺失走完整度，不在此 block
    const n = toNumber(input[dim]);
    if (!Number.isFinite(n)) {
      issues.push({
        severity: "block",
        field: dim,
        code: "dim_nan",
        message: `尺寸「${dim}」不是有效数字，请核对输入。`,
      });
    } else if (n <= 0) {
      issues.push({
        severity: "block",
        field: dim,
        code: "dim_nonpositive",
        message: `尺寸「${dim}」必须大于 0，请检查是否漏填或填错。`,
      });
    } else if (n > 2000) {
      issues.push({
        severity: "warn",
        field: dim,
        code: "dim_oversize",
        message: `尺寸「${dim}」=${n}mm 超过 2000mm，疑似单位填错（mm/cm 混淆），请确认单位。`,
      });
    }
  }

  // ---- 3. 克重（枚举，须落在品类可选范围）----
  if (input.grammage !== undefined) {
    const g = String(input.grammage).replace(/[^\d]/g, "");
    const allowed = allowedValues(config, "grammage");
    if (allowed.size > 0 && !allowed.has(g)) {
      issues.push({
        severity: "block",
        field: "grammage",
        code: "grammage_out_of_range",
        message: `克重「${input.grammage}」不在可选范围（${[...allowed].join("/")} g），请选择合法克重。`,
      });
    }
  }

  // ---- 3.5 页数（平印专用；越小批量越敏感，异常值会直接放大材料与装订）----
  // 说明：pages 在 config 里是自由数字字段（海报填 1 合法），故无枚举可校验，
  // 此前完全没有边界校验——填 9999 会静默产出天文数字成本。此处补确定性边界。
  if (input.pages !== undefined && input.pages !== null && String(input.pages).trim() !== "") {
    const p = toNumber(input.pages);
    if (!Number.isFinite(p) || p <= 0) {
      issues.push({
        severity: "block",
        field: "pages",
        code: "pages_invalid",
        message: `页数「${input.pages}」必须为正整数，请检查是否漏填或填错。`,
      });
    } else if (p > 2000) {
      issues.push({
        severity: "warn",
        field: "pages",
        code: "pages_oversize",
        message: `页数 ${p}P 远超常规（画册一般 ≤ 400P），疑似把「印数」误填成了「页数」，请确认。`,
      });
    }
  }

  // ---- 4. 枚举字段合法性 ----
  for (const key of ENUM_FIELDS) {
    const v = input[key];
    if (v === undefined || v === "") continue;
    const allowed = allowedValues(config, key);
    if (allowed.size > 0 && !allowed.has(String(v))) {
      const label = config.fields.find((f) => f.key === key)?.label ?? key;
      issues.push({
        severity: "block",
        field: key,
        code: "enum_invalid",
        message: `字段「${label}」值「${v}」非法，请在下拉中选择有效项。`,
      });
    }
  }

  // ---- 5. 专色色数 ----
  if (input.spotColorCount !== undefined) {
    const n = toNumber(input.spotColorCount);
    if (!Number.isFinite(n) || n < 0 || n > 8) {
      issues.push({
        severity: "block",
        field: "spotColorCount",
        code: "spot_invalid",
        message: `专色色数须在 0~8 之间，当前值无效。`,
      });
    }
  }

  // ---- 6. 理论面积单位混淆（mm² vs cm²）----
  if (input.dielineAreaMm2 !== undefined) {
    const area = toNumber(input.dielineAreaMm2);
    if (!Number.isFinite(area) || area <= 0) {
      issues.push({
        severity: "block",
        field: "dielineAreaMm2",
        code: "area_invalid",
        message: "理论展开面积须为正数（mm²）。",
      });
    } else if (area > 50_000_000) {
      issues.push({
        severity: "block",
        field: "dielineAreaMm2",
        code: "area_oversize",
        message: "理论展开面积超过 50,000,000 mm²，疑似单位填错，请核对。",
      });
    } else {
      // 与长宽乘积比对：偏差 >8 倍或 <1/20 提示单位混淆
      const lw = toNumber(input.length) * toNumber(input.width);
      if (Number.isFinite(lw) && lw > 0) {
        const ratio = area / lw;
        if (ratio > 8 || ratio < 0.05) {
          issues.push({
            severity: "warn",
            field: "dielineAreaMm2",
            code: "area_unit_mismatch",
            message: `理论面积与「长×宽」乘积偏差过大（约 ${ratio.toFixed(1)} 倍），疑似 mm²/cm² 单位混淆，请核对。`,
          });
        }
      }
    }
  }

  // ---- 7. 瓦楞载荷数据（物理门禁 #4 的前置条件）----
  // 仅瓦楞品类需要载荷数据以驱动 BCT 门禁；非瓦楞（彩盒/平印/标签）无 BCT 模型，不触发。
  const isCorrugated = config.code === "corrugated_box";
  if (isCorrugated) {
    const hasLoad =
      input.boxWeight !== undefined || input.stackLayers !== undefined;
    if (!hasLoad) {
      issues.push({
        severity: "warn",
        field: "boxWeight",
        code: "corrugated_missing_load",
        message:
          "瓦楞结构未填毛重/堆码层数，抗压(BCT)门禁无法校验；降克重类建议存在运输破损风险，请补充后生成。",
      });
    }
  }

  const blockers = issues.filter((i) => i.severity === "block");
  const warnings = issues.filter((i) => i.severity === "warn");
  return { issues, hasBlocker: blockers.length > 0, blockers, warnings };
}
