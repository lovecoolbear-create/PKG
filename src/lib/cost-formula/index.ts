/**
 * 成本配方求值器（F2 · C3 公式资产化）
 * ----------------------------------------------------------------
 * 把「成本公式」从硬编码变成数据：每个成本项用一种**计算方式（kind）**
 * + 参数 + 适用条件表达，由本模块求值。
 *
 * 设计约束：
 *  - **纯函数**：相同输入永远相同输出，不读时间/随机/网络（可复现、可单测）；
 *  - **数值不写死**：params 里的可变数值写成
 *    `{ kb: "process_rate:surface:matte_laminate", fallback: 0.45 }`，
 *    由知识库解析——公式只表达结构，价格/费率归 KB；
 *  - **不重算派生量**：面积/数量/重量等一律由调用方（deriveAnalysisContext）
 *    算好后传入，避免公式分叉；
 *  - **求值失败不抛异常**：返回 null，由调用方决定回退，保证主链路不中断。
 *
 * kind=formula（DSL 兜底）在 F6 实现，本模块暂返回 null 并告警。
 */

import { getKbNumber, referenceFallback } from "@/lib/knowledge-base";
import { evalExpression, isDslEnabled } from "./dsl";

/** 参数中的数值：可直接给数字、引用知识库、引用上下文标量，或按字段查表 */
export type NumParam =
  | number
  | {
      /** 引用知识库："category:key"，支持 {field} 占位符 */
      kb?: string;
      /** 引用上下文标量（如 cmykColors） */
      ctx?: string;
      /** 按字段查表：by 指定字段，map 给出取值表（如加急档位） */
      by?: string;
      map?: Record<string, number>;
      fallback?: number;
    };

/** 阶梯定义：upTo=null 表示最后一档（不限上限） */
export interface TierDef {
  upTo: number | null;
  rate: NumParam;
}

export interface CostItemLike {
  id?: string;
  name: string;
  kind: string;
  /** JSON 字符串 */
  params: string;
  /** JSON 数组字符串，可选 */
  conditions?: string | null;
  weight?: number;
  sortOrder?: number;
  enabled?: boolean;
}

/** 求值上下文：全部为「已算好的标量」，本模块不做任何派生计算 */
export interface EvalContext {
  quantity: number;
  /** 生产面积（含废边，报价口径）m²/个 */
  areaM2: number;
  /** 理论净面积 m²/个 */
  netAreaM2: number;
  /** 表面处理面积 m²/个 */
  surfaceAreaM2: number;
  /** 印刷面积 m²（× 数量） */
  printAreaM2: number;
  /** 材料重量 kg（按当前成本项传入，未在 params 指定重量时使用） */
  weightKg: number;
  cmykColors: number;
  spotColors: number;
  /** percent_of 可用基数，如 { manufacturing: 1234, subtotal: 5678 } */
  bases: Record<string, number>;
  /** 本维度内**已算出的其他成本项**金额（按项名索引），
   *  供后续项引用（如利润 = 小计 + 物流 + 管理费，不含包装辅材）。
   *  由 evalRecipe 维护，单项求值时为空。 */
  lineAmounts?: Record<string, number>;
  /**
   * 按上下文派生、供配方引用的标量桶（避免硬编码重复计算）。
   * 如：材料各层用纸重量(kg)、地域系数、数量折扣、表面覆盖率、盒型复杂度系数、
   * 装订后道单价等。配方参数用 `{ ctx: "xxx" }` 引用这里的键。
   * 由 buildEvalContext 按品类计算后注入（只读，不重算）。
   */
  extra?: Record<string, number>;
}

export const DEFAULT_EVAL_CONTEXT: EvalContext = {
  quantity: 0,
  areaM2: 0,
  netAreaM2: 0,
  surfaceAreaM2: 0,
  printAreaM2: 0,
  weightKg: 0,
  cmykColors: 0,
  spotColors: 0,
  bases: {},
  extra: {},
};

// ── 参数解析 ────────────────────────────────────────────────────────────

/** 变量表：上下文标量 + 累计基数 + 条件事实，供 { ctx } 引用与 kb 占位符替换 */
type Vars = Record<string, unknown>;

/**
 * 解析数值参数，支持三种写法：
 *  1. 直接数字：`0.45`
 *  2. 引用知识库：`{ kb: "process_rate:surface:matte_laminate", fallback: 0.45 }`
 *     —— 可变的价格/费率归 KB，公式只表达结构
 *  3. 引用上下文标量：`{ ctx: "cmykColors" }`
 *     —— 色数、页数这类由输入决定的量，从求值上下文取
 *
 * kb 支持占位符：`{ kb: "labor_rate:logistics:{delivery}", fallback: 0.035 }`，
 * `{xxx}` 会用 vars 中同名字段替换（如按交付地域取对应物流费率）。
 *
 * @param p    参数
 * @param dflt 缺省值
 * @param vars 变量表（上下文标量 + 条件事实 + 累计基数）
 */
export function resolveNum(
  p: NumParam | undefined,
  dflt = 0,
  vars: Record<string, unknown> = {}
): number {
  if (p == null) return dflt;
  if (typeof p === "number") return Number.isFinite(p) ? p : dflt;
  if (typeof p !== "object") return dflt;

  const obj = p as {
    kb?: string;
    ctx?: string;
    by?: string;
    map?: Record<string, number>;
    fallback?: number;
  };
  const fallbackVal = typeof obj.fallback === "number" ? obj.fallback : dflt;

  // 引用上下文标量
  if (typeof obj.ctx === "string") {
    const v = Number(vars[obj.ctx]);
    return Number.isFinite(v) ? v : fallbackVal;
  }

  // 按字段查表：如加急档位 { by:"urgency", map:{ standard:0, urgent:7.5, express:15 } }
  if (typeof obj.by === "string" && obj.map && typeof obj.map === "object") {
    const v = obj.map[String(vars[obj.by])];
    return typeof v === "number" && Number.isFinite(v) ? v : fallbackVal;
  }

  if (typeof obj.kb === "string" && obj.kb.includes(":")) {
    const explicit = typeof obj.fallback === "number" ? obj.fallback : undefined;
    // 占位符替换：{delivery} → 实际地域码
    const interpolated = obj.kb.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const v = vars[name];
      return v == null ? "" : String(v);
    });
    if (!interpolated || interpolated.includes("{}")) return explicit ?? dflt;

    const idx = interpolated.indexOf(":");
    const category = interpolated.slice(0, idx);
    const key = interpolated.slice(idx + 1);
    /**
     * 回退优先级：知识库条目 > 配方显式 fallback > 代码基准常量 > 缺省值。
     * 基准常量兜底让通用 kb 引用与硬编码 Agent 的类型化 getter 语义一致
     * （知识库缺条目时读同一份 cost-rules 常量），避免配方迁移后成本塌成 0。
     */
    const fallback = explicit ?? referenceFallback(category, key) ?? dflt;
    return getKbNumber(category, key, fallback);
  }

  if (typeof obj.fallback === "number") return obj.fallback;
  return dflt;
}

/**
 * 解析参数（转发到 schema.ts，保持调用方不变）。
 * @returns 解析结果；**坏 JSON 返回 null**（区别于"合法的空对象"）。
 */
function parseParams(raw: string): Record<string, any> | null {
  return parseParamsObject(raw);
}

// ── 条件判定 ────────────────────────────────────────────────────────────

export function matchesConditions(
  raw: string | null | undefined,
  facts: Record<string, unknown>
): boolean {
  const list = parseConditions(raw);
  // 条件解析失败视为无限制（兼容旧行为）；**是否要阻断由调用方另行判断**，
  // 见 evalCostItem——那里会先把坏 JSON 拦下来，不会走到这里。
  if (!list || list.length === 0) return true;

  return list.every((cond) => {
    const actual = facts[cond.field];
    switch (cond.op) {
      case "==":
        return actual === cond.value;
      case "!=":
        return actual !== cond.value;
      case "in":
        return Array.isArray(cond.value) && cond.value.includes(actual);
      case "not_in":
        return Array.isArray(cond.value) && !cond.value.includes(actual);
      case ">":
        return Number(actual) > Number(cond.value);
      case ">=":
        return Number(actual) >= Number(cond.value);
      case "<":
        return Number(actual) < Number(cond.value);
      case "<=":
        return Number(actual) <= Number(cond.value);
      default:
        return true;
    }
  });
}

// ── 各 kind 求值（均为纯函数） ───────────────────────────────────────────

/** flat：固定金额（如设计费 800、打样费 300） */
function evalFlat(p: Record<string, any>, vars: Vars): number {
  return resolveNum(p.amount, 0, vars);
}

/** unit_rate：单价 × 件数（如模切 0.03 元/个 × quantity；制版 350 元/色 × 色数）
 * 可选 multiplier：按上下文动态乘子（如地域系数 × 盒型复杂度系数），由 { ctx } 引用 extra 桶。 */
function evalUnitRate(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const rate = resolveNum(p.rate, 0, vars);
  const qty = p.qty != null ? resolveNum(p.qty, ctx.quantity, vars) : ctx.quantity;
  const mult = p.multiplier != null ? resolveNum(p.multiplier, 1, vars) : 1;
  return rate * qty * mult;
}

/** area_rate：单价 × 面积（如覆膜 0.45 元/m² × 表面面积 × 数量）
 * 可选 multiplier：按上下文动态乘子（如表面覆盖率）。 */
function evalAreaRate(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const rate = resolveNum(p.rate, 0, vars);
  const areaPerPiece =
    p.area != null ? resolveNum(p.area, ctx.surfaceAreaM2, vars) : ctx.surfaceAreaM2;
  const timesQty = p.timesQuantity !== false;
  const mult = p.multiplier != null ? resolveNum(p.multiplier, 1, vars) : 1;
  return rate * areaPerPiece * (timesQty ? ctx.quantity : 1) * mult;
}

/** weight_rate：重量(kg) × 吨价 ÷ 1000（材料主公式） */
function evalWeightRate(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const weight = p.weight != null ? resolveNum(p.weight, ctx.weightKg, vars) : ctx.weightKg;
  const pricePerTon = resolveNum(p.pricePerTon, 0, vars);
  const discount = p.discount != null ? resolveNum(p.discount, 1, vars) : 1;
  return (weight * pricePerTon * discount) / 1000;
}

/** ink_rate：面积 × 墨量(g/m²) × 单价(元/kg) ÷ 1000（× 色数） */
function evalInkRate(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const area =
    p.area != null ? resolveNum(p.area, ctx.printAreaM2, vars) : ctx.printAreaM2;
  const gPerM2 = resolveNum(p.grammagePerM2, 0, vars);
  const pricePerKg = resolveNum(p.pricePerKg, 0, vars);
  const colors =
    p.colors != null
      ? resolveNum(p.colors, 1, vars)
      : p.useSpot === true
        ? ctx.spotColors
        : ctx.cmykColors || 1;
  return (area * gPerM2 * pricePerKg * colors) / 1000;
}

/** tiered：按数量分档取费率（档位按 upTo 升序匹配，最后可用 upTo=null 兜底） */
function evalTiered(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const tiers = Array.isArray(p.tiers) ? (p.tiers as TierDef[]) : [];
  if (!tiers.length) return 0;
  const qty = ctx.quantity;
  let hit: TierDef | undefined;
  for (const t of tiers) {
    if (t.upTo == null) {
      hit = t;
      break;
    }
    if (qty <= t.upTo) {
      hit = t;
      break;
    }
  }
  if (!hit) hit = tiers[tiers.length - 1];
  const rate = resolveNum(hit.rate, 0, vars);
  // mode="flat"：该档为整单固定金额；默认 "per_unit"：单价 × 数量
  return p.mode === "flat" ? rate : rate * qty;
}

/** stepped：起步价 + 超出部分 × 单价（印刷起步价模型）
 * 可选 floor：返回 max(floor, base + extra×rate)，表达「印刷费不低于起步开机费」的托底语义。 */
function evalStepped(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  const base = resolveNum(p.base, 0, vars);
  const includes = resolveNum(p.baseIncludes, 0, vars);
  const rate = resolveNum(p.rate, 0, vars);
  const qty = ctx.quantity;
  const extra = Math.max(0, qty - includes);
  const linear = base + extra * rate;
  if (p.floor != null) return Math.max(resolveNum(p.floor, 0, vars), linear);
  return linear;
}

/**
 * percent_of：按基数取百分比（物流 3% / 管理费 6% / 利润 8%）
 * 基数可用 base（单个）或 baseExpr（多个相加，如利润 = 小计 + 本维度已算项）。
 */
function evalPercentOf(p: Record<string, any>, ctx: EvalContext, vars: Vars): number {
  let baseAmount = 0;
  // 单个基数
  if (typeof p.base === "string") baseAmount += ctx.bases[p.base] ?? 0;
  // 多个基数相加
  if (Array.isArray(p.baseExpr)) {
    for (const k of p.baseExpr) {
      if (typeof k === "string") baseAmount += ctx.bases[k] ?? 0;
    }
  }
  // 引用本维度内已算出的指定项（按项名）
  if (Array.isArray(p.baseLines)) {
    for (const n of p.baseLines) {
      if (typeof n === "string") baseAmount += ctx.lineAmounts?.[n] ?? 0;
    }
  }
  // rate 既支持 6（百分比）也支持 0.06（小数）；显式 percent 优先，否则 >1 视为百分比
  const raw = resolveNum(p.rate, 0, vars);
  const asPercent = p.percent === true || (p.percent !== false && raw > 1);
  const ratio = asPercent ? raw / 100 : raw;
  return baseAmount * ratio;
}

// ── 统一入口 ────────────────────────────────────────────────────────────

// 结构与静态校验统一放在 schema.ts（纯逻辑、无服务端依赖，客户端也可 import）。
// 这里 re-export 以保持既有调用方（engine-bridge / API / 测试）不变。
export {
  SUPPORTED_KINDS,
  ALL_KINDS,
  CONDITION_OPS,
  KIND_LABELS,
  REQUIRED_PARAMS,
  parseConditions,
  validateCostItem,
} from "./schema";
export type { SupportedKind, Condition, ConditionOp } from "./schema";
import { parseParamsObject, parseConditions, validateCostItem } from "./schema";

/**
 * 求单个成本项。
 * @returns 金额；条件不满足返回 0；**不支持/未启用/数据损坏的 kind 返回 null**
 *          （null 会让整组配方回退硬编码，绝不静默算成 0）
 */
export function evalCostItem(
  item: CostItemLike,
  ctx: EvalContext,
  facts: Record<string, unknown> = {}
): number | null {
  if (item.enabled === false) return 0;

  // 数据损坏信号：坏 JSON 一律返回 null，让整组配方回退，而不是算成 0。
  // （早期实现把坏 JSON 当空对象处理，导致成本项凭空消失、报价少算 60%）
  if (parseConditions(item.conditions) === null) return null;

  if (!matchesConditions(item.conditions, facts)) return 0;

  const p = parseParams(item.params);
  if (p === null) return null;
  const weight = typeof item.weight === "number" ? item.weight : 1;

  // 变量表：上下文标量 + 累计基数 + 条件事实 + 派生量桶（供 { ctx: "..." } 与 kb 占位符使用）
  const vars: Vars = {
    quantity: ctx.quantity,
    areaM2: ctx.areaM2,
    netAreaM2: ctx.netAreaM2,
    surfaceAreaM2: ctx.surfaceAreaM2,
    printAreaM2: ctx.printAreaM2,
    weightKg: ctx.weightKg,
    cmykColors: ctx.cmykColors,
    spotColors: ctx.spotColors,
    ...ctx.bases,
    ...ctx.extra,
    ...facts,
  };

  let amount: number;
  switch (item.kind) {
    case "flat":
      amount = evalFlat(p, vars);
      break;
    case "unit_rate":
      amount = evalUnitRate(p, ctx, vars);
      break;
    case "area_rate":
      amount = evalAreaRate(p, ctx, vars);
      break;
    case "weight_rate":
      amount = evalWeightRate(p, ctx, vars);
      break;
    case "ink_rate":
      amount = evalInkRate(p, ctx, vars);
      break;
    case "tiered":
      amount = evalTiered(p, ctx, vars);
      break;
    case "stepped":
      amount = evalStepped(p, ctx, vars);
      break;
    case "percent_of":
      amount = evalPercentOf(p, ctx, vars);
      break;
    case "formula": {
      // F6：DSL 兜底（白名单沙箱，**默认关闭**——未显式开启时直接回退，
      // 让攻击面保持为零；只有确实需要时才由运维显式打开）
      if (!isDslEnabled()) return null;
      const expr = typeof p.expr === "string" ? p.expr : "";
      if (!expr.trim()) return null;

      // 变量白名单 = 上下文标量 + 累计基数 + 条件事实（只收数值）
      const numericVars: Record<string, number> = {};
      for (const [k, v] of Object.entries(vars)) {
        const n = Number(v);
        if (Number.isFinite(n)) numericVars[k] = n;
      }

      const res = evalExpression(expr, numericVars);
      // 求值失败 → 返回 null → 整组配方回退硬编码，绝不猜算
      if (!res.ok) return null;
      amount = res.value;
      break;
    }
    default:
      return null;
  }

  if (!Number.isFinite(amount)) return null;
  return amount * weight;
}

export interface RecipeLine {
  name: string;
  amount: number;
  source: "recipe";
}

/**
 * 求一组成本项（同一维度内），返回合计与逐项明细。
 *
 * @param issues 可选出参：求值失败的项会被 push 进去（如"制版费 · CMYK：参数不是合法 JSON"）。
 *               调用方据此把问题暴露到报告/管理页，**不要静默吞掉**。
 * @returns null 表示整组不可用 → 调用方回退硬编码（绝不半配方算数）
 */
export function evalRecipe(
  items: CostItemLike[],
  ctx: EvalContext,
  facts: Record<string, unknown> = {},
  issues: string[] = []
): { total: number; lines: RecipeLine[] } | null {
  if (!items.length) return null;
  const lines: RecipeLine[] = [];
  let total = 0;
  let sawNull = false;

  const sorted = [...items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  let self = 0; // 本维度内已算项累计（供 baseExpr 引用 "self"）
  const byName: Record<string, number> = {}; // 按项名记录，供 baseLines 精确引用

  for (const it of sorted) {
    const amt = evalCostItem(
      it,
      {
        ...ctx,
        bases: { ...ctx.bases, self },
        lineAmounts: { ...byName },
      },
      facts
    );
    if (amt == null) {
      sawNull = true;
      const why = validateCostItem(it);
      issues.push(
        `${it.name}：${why ?? "当前计算方式未启用或无法求值（如 formula 需开启 FORMULA_DSL_ENABLED）"}`
      );
      continue;
    }
    lines.push({ name: it.name, amount: amt, source: "recipe" });
    total += amt;
    self += amt;
    byName[it.name] = amt;
  }

  // 有任何一项无法求值 → 整个配方不可用，交由调用方回退（避免半配方静默算错）
  if (sawNull) return null;
  return { total, lines };
}
