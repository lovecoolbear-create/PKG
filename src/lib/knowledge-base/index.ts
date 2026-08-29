/**
 * 知识库读取层（成本领域权威参数）
 * ----------------------------------------------------------------
 * 把原先散落在 cost-rules 里的硬编码常量（材料价 / 工艺费率 / 地域费率）
 * 抽象成「可由 KnowledgeEntry 管理的知识条目」，让成本引擎优先从知识库读取，
 * 读不到（库未初始化 / 查询失败 / 条目缺失）时回退到代码常量，保证不破坏现有行为。
 *
 * 设计要点：
 * - 读取为同步 getter，避免改动现有同步 Agent 的计算结构；
 * - loadKnowledgeBase() 在每次分析的 orchestrator 开头 await 一次，
 *   把 DB 条目预热进内存缓存（进程级单例，dev 热更新后自动重建）；
 * - 任何 DB 异常都被吞掉并标记 loadFailed，getter 直接走常量回退。
 */

import { prisma } from "@/lib/db";
import {
  MATERIAL_PRICES,
  PRINT_BASE_RATES,
  SURFACE_TREATMENT_RATES,
  CMYK_PLATE_COST,
  SPOT_COLOR_PLATE_COST,
  SPOT_COLOR_SETUP_COST,
  FLUTE_MOUNTING_RATE,
  CORRUGATED_LINER_PRICES,
  CORRUGATED_FLUTING_PRICES,
  LABOR_SETUP_HOURS,
  LOGISTICS_RATES,
  FLUTE_TYPES,
  INK_CMYK_GRAMMAGE_PER_M2,
  INK_CMYK_PRICE_PER_KG,
  INK_SPOT_GRAMMAGE_PER_M2,
  INK_SPOT_PRICE_PER_KG,
} from "@/lib/cost-rules";
import { LABOR_REGIONS, DEFAULT_LABOR_REGION, resolveLaborRegion } from "@/lib/cost-rules/labor-regions";

export const KB_CATEGORY = {
  materialPrice: "material_price",
  processRate: "process_rate",
  laborRate: "labor_rate",
  marketPrice: "market_price",
} as const;

/** 工艺/费用类常量的本地回退值（与 cost-rules 原常量保持一致） */
const PROCESS_RATE_FALLBACK: Record<string, number> = {
  "print:offset": PRINT_BASE_RATES.offset,
  "print:digital": PRINT_BASE_RATES.digital,
  "print:flexo": PRINT_BASE_RATES.flexo,
  "surface:none": SURFACE_TREATMENT_RATES.none,
  "surface:matte_laminate": SURFACE_TREATMENT_RATES.matte_laminate,
  "surface:gloss_laminate": SURFACE_TREATMENT_RATES.gloss_laminate,
  "surface:uv": SURFACE_TREATMENT_RATES.uv,
  "surface:foil": SURFACE_TREATMENT_RATES.foil,
  "surface:emboss": SURFACE_TREATMENT_RATES.emboss,
  plate_cmyk: CMYK_PLATE_COST,
  plate_spot: SPOT_COLOR_PLATE_COST,
  spot_color_setup: SPOT_COLOR_SETUP_COST,
  flute_mounting_rate: FLUTE_MOUNTING_RATE,
  // 油墨简化模型（可由知识库 ink:* 覆盖）
  "ink:cmyk_grammage_per_m2": INK_CMYK_GRAMMAGE_PER_M2,
  "ink:cmyk_price_per_kg": INK_CMYK_PRICE_PER_KG,
  "ink:spot_grammage_per_m2": INK_SPOT_GRAMMAGE_PER_M2,
  "ink:spot_price_per_kg": INK_SPOT_PRICE_PER_KG,
  // 人工简化模型（换线/调机固定工时，可由知识库 labor:setup_hours 覆盖）
  "labor:setup_hours": LABOR_SETUP_HOURS,
};

/** 条目的可信度元数据（C2：用于把知识库条目可信度传导到报告置信度） */
export interface KbMeta {
  confidence: number;
  source: string;
}

interface KbState {
  entries: Map<string, any>;
  /** 键同 entries：条目的 confidence / source 元数据 */
  meta: Map<string, KbMeta>;
  loadedAt: number;
}

let state: KbState | null = null;
let loadPromise: Promise<KbState | null> | null = null;
/**
 * 最近一次加载失败的时间戳（毫秒）。用于冷却重试：
 * 失败后不会永久锁定（否则会静默退化到硬编码常量且永不恢复），
 * 而是在冷却窗口结束后允许下一次加载重试，DB 抖动恢复后自动读回知识库。
 */
let loadFailedAt = 0;
const KB_LOAD_RETRY_COOLDOWN_MS = 60_000;

function composite(category: string, key: string): string {
  return `${category}::${key}`;
}

/** 从条目里尽量解析出一个数值（兼容多种存储字段命名） */
function numOf(entry: any): number | undefined {
  if (entry == null) return undefined;
  if (typeof entry === "number") return entry;
  if (typeof entry.value === "number") return entry.value;
  if (typeof entry.rate === "number") return entry.rate;
  if (typeof entry.pricePerTon === "number") return entry.pricePerTon;
  if (typeof entry.baseRate === "number") return entry.baseRate;
  return undefined;
}

function getRaw(category: string, key: string): any | undefined {
  return state?.entries.get(composite(category, key));
}

/** 取条目的可信度元数据（未加载或无该条目时返回 undefined） */
function getMeta(category: string, key: string): KbMeta | undefined {
  return state?.meta.get(composite(category, key));
}

/**
 * 按 `category:key` 直接取数值（C3 配方参数用）。
 * 配方 params 里的可变数值写成 { kb: "process_rate:surface:matte_laminate", fallback: 0.45 }，
 * 由本函数解析成实际数值——**公式只表达结构，数值归知识库**，
 * 避免把会变的价格/费率写死在配方里（对应调研中「硬编码可变值」这条坑）。
 */
export function getKbNumber(
  category: string,
  key: string,
  fallback: number
): number {
  const v = numOf(getRaw(category, key));
  return v != null ? v : fallback;
}

/**
 * 通用 `category:key` 的**代码基准常量回退**（F3/F4 配方迁移必需）。
 * ----------------------------------------------------------------
 * 背景：硬编码 Agent 走 getMaterialPrice / getFlutePrice / getProcessRate 等
 * 「类型化 getter」，这些 getter 的回退值来自 cost-rules 代码常量（唯一真相源）。
 * 而配方里的通用写法 `{ kb:"material_price:white_card:350" }` 原先只经 getKbNumber，
 * 知识库无该条目时直接吃调用方 fallback（默认 0）→ 材料成本塌成 0。
 *
 * 本函数把「通用 kb 引用」的回退语义对齐到类型化 getter：
 * 知识库无条目时，用同一份代码常量兜底，**不必把常量复制进 DB**（避免双真相源）。
 *
 * 优先级（在 resolveNum 中）：知识库条目 > 配方显式 fallback > 本函数基准常量 > 缺省值。
 *
 * @returns 命中基准常量时返回数值；该 key 无对应常量则返回 undefined。
 */
export function referenceFallback(category: string, key: string): number | undefined {
  if (category === KB_CATEGORY.materialPrice) {
    // 瓦楞·面纸/里纸：corr_liner:{material}:{grammage}
    if (key.startsWith("corr_liner:")) {
      const [material, grammage] = key.slice("corr_liner:".length).split(":");
      return CORRUGATED_LINER_PRICES[material]?.[grammage] ?? 4000;
    }
    // 瓦楞·芯纸：corr_fluting:{grammage}
    if (key.startsWith("corr_fluting:")) {
      return CORRUGATED_FLUTING_PRICES[key.slice("corr_fluting:".length)] ?? 3800;
    }
    // 卡纸类：{material}:{grammage}
    const [material, grammage] = key.split(":");
    return MATERIAL_PRICES[material]?.[grammage] ?? 5500;
  }

  if (category === KB_CATEGORY.processRate) {
    // 坑纸单价：flute:{code}
    if (key.startsWith("flute:")) {
      return FLUTE_TYPES[key.slice("flute:".length)]?.flutePricePerTon ?? 0;
    }
    return PROCESS_RATE_FALLBACK[key];
  }

  if (category === KB_CATEGORY.laborRate) {
    if (key.startsWith("region:")) {
      const resolved = resolveLaborRegion(key.slice("region:".length));
      return (
        LABOR_REGIONS[resolved]?.baseRate ??
        LABOR_REGIONS[DEFAULT_LABOR_REGION].baseRate
      );
    }
    if (key.startsWith("logistics:")) {
      return LOGISTICS_RATES[key.slice("logistics:".length)];
    }
    return undefined;
  }

  return undefined;
}

/**
 * 预热知识库到内存。幂等：已成功加载则直接复用。
 * 加载失败时记录时间戳并进入冷却窗口，窗口结束后允许自动重试，
 * 避免 DB 偶发抖动后永久静默退化到硬编码常量（冷却期 60s）。
 * 任何异常都被吞掉，避免影响主分析链路。
 */
export async function loadKnowledgeBase(force = false): Promise<void> {
  if (force) {
    state = null;
    loadFailedAt = 0;
    loadPromise = null;
  }
  if (state) return;
  // 冷却期内不重试（避免 DB 抖动时每次分析都打 DB），冷却结束后自动重试
  if (loadFailedAt && Date.now() - loadFailedAt < KB_LOAD_RETRY_COOLDOWN_MS) {
    return;
  }
  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async (): Promise<KbState | null> => {
    try {
      const rows = await prisma.knowledgeEntry.findMany({
        where: {
          category: {
            in: [
              KB_CATEGORY.materialPrice,
              KB_CATEGORY.processRate,
              KB_CATEGORY.laborRate,
              // 市场行情价（network-cron / admin 网络刷新写入的真实外部纸价）。
              // 此前遗漏导致真实行情进库后成本引擎的内存缓存读不到，
              // getMaterialPrice 等 getter 只能回退到代码常量，行情数据形同虚设。
              KB_CATEGORY.marketPrice,
            ],
          },
        },
        select: { category: true, key: true, value: true, confidence: true, source: true },
      });
      const entries = new Map<string, any>();
      const meta = new Map<string, KbMeta>();
      for (const r of rows) {
        try {
          entries.set(composite(r.category, r.key), JSON.parse(r.value));
          meta.set(composite(r.category, r.key), {
            confidence: r.confidence,
            source: r.source,
          });
        } catch {
          // 单条解析失败不影响其他条目
        }
      }
      return { entries, meta, loadedAt: Date.now() };
    } catch {
      // DB 不可用：标记失败，后续全走常量回退
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  state = await loadPromise;
  if (!state) loadFailedAt = Date.now();
}

export function isKnowledgeBaseLoaded(): boolean {
  return state !== null;
}

/** 重新从 DB 加载知识库到内存（增量刷新，改库后即时生效，无需重启） */
export async function reloadKnowledgeBase(): Promise<{ loadedAt: number }> {
  await loadKnowledgeBase(true);
  return { loadedAt: state?.loadedAt ?? 0 };
}

export interface KnowledgeEntryView {
  id: string;
  category: string;
  key: string;
  value: any;
  source: string;
  confidence: number;
  tags: string[];
}

/** 列出知识库条目（可选按 category 过滤） */
export async function listKnowledgeEntries(
  category?: string
): Promise<KnowledgeEntryView[]> {
  const rows = await prisma.knowledgeEntry.findMany({
    where: category ? { category } : undefined,
    orderBy: [{ category: "asc" }, { key: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    key: r.key,
    value: safeParse(r.value),
    source: r.source,
    confidence: r.confidence,
    tags: safeParse(r.tags ?? "[]") ?? [],
  }));
}

export interface UpsertKnowledgeEntryInput {
  category: string;
  key: string;
  value: Record<string, unknown> | number;
  source?: string;
  confidence?: number;
  tags?: string[];
}

/** 新增或更新一条知识库条目，并立即刷新内存缓存 */
export async function upsertKnowledgeEntry(
  input: UpsertKnowledgeEntryInput
): Promise<KnowledgeEntryView> {
  const valueObj =
    typeof input.value === "number" ? { value: input.value } : input.value;
  const existing = await prisma.knowledgeEntry.findFirst({
    where: { category: input.category, key: input.key },
  });
  const data = {
    value: JSON.stringify(valueObj),
    source: input.source ?? existing?.source ?? "manual",
    confidence: input.confidence ?? existing?.confidence ?? 70,
    tags: JSON.stringify(input.tags ?? existing?.tags ?? []),
  };
  let row: (typeof existing) | null;
  if (existing) {
    row = await prisma.knowledgeEntry.update({
      where: { id: existing.id },
      data,
    });
  } else {
    row = await prisma.knowledgeEntry.create({
      data: { category: input.category, key: input.key, ...data },
    });
  }
  await reloadKnowledgeBase();
  return {
    id: row!.id,
    category: row!.category,
    key: row!.key,
    value: safeParse(row!.value),
    source: row!.source,
    confidence: row!.confidence,
    tags: safeParse(row!.tags ?? "[]") ?? [],
  };
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export interface KbValue {
  value: number;
  fromKb: boolean;
  /** 命中知识库时的条目可信度（0~100）；回退代码常量时为 undefined。
   *  C2：供成本引擎把「参数可信度」传导到报告置信度。 */
  confidence?: number;
  /** 命中知识库时的条目来源（manual / import / analysis / feedback）；
   *  回退代码常量时为 undefined。 */
  source?: string;
}

/**
 * C2：知识库条目使用追踪器。
 * 记录本次计算实际命中的条目里**最低的 confidence**，供编排器把
 * 「参数可信度」传导到报告置信度（低置信参数 → 降置信度 + 提示核实）。
 * 仅进程内、单次分析生命周期内有效；编排器在每个 agent 前后 reset/take。
 */
let usageMinConfidence: number | null = null;

function recordKbUsage(confidence?: number): void {
  if (confidence == null) return;
  usageMinConfidence =
    usageMinConfidence == null ? confidence : Math.min(usageMinConfidence, confidence);
}

/** 清空追踪器（编排器在每个 agent 计算前调用） */
export function resetKbUsageTracker(): void {
  usageMinConfidence = null;
}

/** 取出并清空当前追踪到的最低置信度；期间未命中任何知识库条目则返回 null */
export function takeKbUsageMinConfidence(): number | null {
  const v = usageMinConfidence;
  usageMinConfidence = null;
  return v;
}

/**
 * 统一取值：命中知识库则返回 { value, fromKb:true, confidence, source }，
 * 否则返回回退值并标记 fromKb:false（此时 confidence/source 为 undefined，
 * 代表「用的是代码内置常量，非知识库条目」）。
 */
function kbValue(category: string, key: string, fallback: number): KbValue {
  const v = numOf(getRaw(category, key));
  if (v != null) {
    const m = getMeta(category, key);
    recordKbUsage(m?.confidence);
    return { value: v, fromKb: true, confidence: m?.confidence, source: m?.source };
  }
  return { value: fallback, fromKb: false };
}

/** 材料单价（元/吨）：优先知识库，回退 MATERIAL_PRICES 常量 */
export function getMaterialPrice(material: string, grammage: string): KbValue {
  return kbValue(
    KB_CATEGORY.materialPrice,
    `${material}:${grammage}`,
    MATERIAL_PRICES[material]?.[grammage] ?? 5500
  );
}

/** 坑纸/底纸单价（元/吨）：优先知识库，回退 FLUTE_TYPES 常量 */
export function getFlutePrice(code: string): KbValue {
  return kbValue(
    KB_CATEGORY.processRate,
    `flute:${code}`,
    FLUTE_TYPES[code]?.flutePricePerTon ?? 0
  );
}

/** 瓦楞纸箱·面纸/里纸（挂面纸）单价（元/吨）：优先知识库，回退 CORRUGATED_LINER_PRICES 常量 */
export function getCorrugatedLinerPrice(material: string, grammage: string): KbValue {
  return kbValue(
    KB_CATEGORY.materialPrice,
    `corr_liner:${material}:${grammage}`,
    CORRUGATED_LINER_PRICES[material]?.[grammage] ?? 4000
  );
}

/** 瓦楞纸箱·芯纸（corrugated medium）单价（元/吨）：优先知识库，回退 CORRUGATED_FLUTING_PRICES 常量 */
export function getCorrugatedFlutingPrice(grammage: string): KbValue {
  return kbValue(
    KB_CATEGORY.materialPrice,
    `corr_fluting:${grammage}`,
    CORRUGATED_FLUTING_PRICES[grammage] ?? 3800
  );
}

/** 工艺/费用类费率：统一入口，key 见 PROCESS_RATE_FALLBACK */
export function getProcessRate(key: string): KbValue {
  return kbValue(KB_CATEGORY.processRate, key, PROCESS_RATE_FALLBACK[key] ?? 0);
}

/** 地域基础人工费率（元/小时）：优先知识库，回退 LABOR_REGIONS 配置 */
export function getRegionRate(code?: string): KbValue {
  const resolved = resolveLaborRegion(code);
  return kbValue(
    KB_CATEGORY.laborRate,
    `region:${resolved}`,
    LABOR_REGIONS[resolved]?.baseRate ?? LABOR_REGIONS[DEFAULT_LABOR_REGION].baseRate
  );
}

/** 地域系数：以默认地域(华东)人工费率为基准=1.0，用于人工成本随地域浮动。
 * 支持交付地域 code（如 south_china）经别名映射为人工地域 code（south_china_dg）。 */
export function getRegionMultiplier(code?: string): number {
  const base = LABOR_REGIONS[DEFAULT_LABOR_REGION].baseRate || 1;
  const rate = getRegionRate(code ?? DEFAULT_LABOR_REGION).value || base;
  return Math.round((rate / base) * 1000) / 1000;
}

/** 物流费率：优先知识库，回退 LOGISTICS_RATES 配置 */
export function getLogisticsRate(code: string): KbValue {
  return kbValue(KB_CATEGORY.laborRate, `logistics:${code}`, LOGISTICS_RATES[code] ?? 0.035);
}
