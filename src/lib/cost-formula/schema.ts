/**
 * 配方结构定义与静态校验（纯逻辑，无服务端依赖）
 * ----------------------------------------------------------------
 * 单独成文件、且**不 import 任何 Node/Prisma/KB 模块**，
 * 目的：让浏览器端的管理页也能 import 它做实时校验，
 * 不必等服务端往返——用户改完 JSON 立刻看到红字。
 *
 * 若把 validateCostItem 留在 index.ts，客户端会顺带把
 * knowledge-base（→ prisma）打进 bundle，直接构建失败。
 */

// ── kind ────────────────────────────────────────────────────────────────

export const SUPPORTED_KINDS = [
  "flat",
  "unit_rate",
  "area_rate",
  "weight_rate",
  "ink_rate",
  "tiered",
  "stepped",
  "percent_of",
] as const;

export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

/** 含 DSL 兜底在内的全部合法 kind（formula 受 FORMULA_DSL_ENABLED 开关控制） */
export const ALL_KINDS = [...SUPPORTED_KINDS, "formula"] as const;

/** kind 的中文说明（管理页下拉框与提示用） */
export const KIND_LABELS: Record<string, string> = {
  flat: "固定金额",
  unit_rate: "单价 × 件数",
  area_rate: "单价 × 面积",
  weight_rate: "重量 × 吨价",
  ink_rate: "面积 × 墨量 × 单价",
  tiered: "按数量分档",
  stepped: "起步价 + 超出部分",
  percent_of: "按基数取百分比",
  formula: "表达式（DSL，默认关闭）",
};

// ── 条件 ────────────────────────────────────────────────────────────────

export type ConditionOp =
  | "=="
  | "!="
  | "in"
  | "not_in"
  | ">"
  | ">="
  | "<"
  | "<=";

export const CONDITION_OPS: readonly ConditionOp[] = [
  "==",
  "!=",
  "in",
  "not_in",
  ">",
  ">=",
  "<",
  "<=",
];

export interface Condition {
  field: string;
  op: ConditionOp;
  value: unknown;
}

// ── 解析 ────────────────────────────────────────────────────────────────

/**
 * 解析参数 JSON。
 * @returns 解析结果；**坏 JSON 返回 null**（区别于"合法的空对象"）。
 *
 * ⚠️ 刻意不吞异常：早期实现失败时返回 `{}`，坏 JSON 的成本项被当成
 * "参数全缺省"静默算成 0——报价少算 60% 而全程无提示。
 */
export function parseParamsObject(raw: string): Record<string, any> | null {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * 解析条件数组。
 * @returns null 表示坏 JSON 或格式不合法（不是数组 / 元素不是 {field,op}）
 */
export function parseConditions(
  raw: string | null | undefined
): Condition[] | null {
  if (raw == null || raw === "") return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out: Condition[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    const cond = c as Partial<Condition>;
    if (typeof cond.field !== "string" || typeof cond.op !== "string") return null;
    out.push({ field: cond.field, op: cond.op as ConditionOp, value: cond.value });
  }
  return out;
}

// ── 校验 ────────────────────────────────────────────────────────────────

/** 各 kind 的必填参数；缺任何一个都会让该项静默算成 0，必须在写库前拦住 */
export const REQUIRED_PARAMS: Record<string, string[]> = {
  flat: [], // amount 缺省 0，合法
  unit_rate: ["rate"],
  area_rate: ["rate"],
  weight_rate: ["pricePerTon"],
  ink_rate: ["grammagePerM2", "pricePerKg"],
  tiered: ["tiers"],
  stepped: ["base", "rate"],
  percent_of: ["rate"],
  formula: ["expr"],
};

/**
 * 静态校验一个成本项是否**结构上可求值**。
 *
 * 不依赖运行上下文，只检查「JSON 合法 / kind 认识 / 必填参数在 / 条件格式对」，
 * 因此可以在**写库前**拦住坏数据——而不是等它把报价算少 60% 才发现。
 *
 * @returns 错误描述；合法返回 null
 */
export function validateCostItem(item: {
  name?: string;
  kind?: string;
  params?: string | null;
  conditions?: string | null;
}): string | null {
  const kind = item.kind ?? "";
  if (!(ALL_KINDS as readonly string[]).includes(kind)) {
    return `不支持的计算方式「${kind}」`;
  }

  const p = parseParamsObject(item.params ?? "");
  if (p === null) return "参数不是合法 JSON（须为对象，如 {\"amount\":800}）";

  const conds = parseConditions(item.conditions);
  if (conds === null) {
    return "条件不是合法 JSON 数组（如 [{\"field\":\"printMethod\",\"op\":\"!=\",\"value\":\"digital\"}]）";
  }
  for (const c of conds) {
    if (!(CONDITION_OPS as readonly string[]).includes(c.op)) {
      return `条件运算符「${c.op}」不支持（可用：${CONDITION_OPS.join(" / ")}）`;
    }
  }

  for (const k of REQUIRED_PARAMS[kind] ?? []) {
    if (p[k] === undefined) {
      return `${kind} 缺少必填参数「${k}」`;
    }
  }

  if (kind === "tiered" && (!Array.isArray(p.tiers) || p.tiers.length === 0)) {
    return "tiered 的 tiers 必须是非空数组";
  }
  if (kind === "percent_of") {
    const hasBase =
      typeof p.base === "string" ||
      Array.isArray(p.baseExpr) ||
      Array.isArray(p.baseLines);
    if (!hasBase) {
      return "percent_of 需指定 base / baseExpr / baseLines 之一作为计算基数";
    }
  }
  if (kind === "formula" && (typeof p.expr !== "string" || !p.expr.trim())) {
    return "formula 缺少表达式 expr";
  }

  return null;
}
