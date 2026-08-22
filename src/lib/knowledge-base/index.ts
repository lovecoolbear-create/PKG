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
  EQUIPMENT_RATE,
  LOGISTICS_RATES,
  FLUTE_TYPES,
} from "@/lib/cost-rules";
import { LABOR_REGIONS, DEFAULT_LABOR_REGION } from "@/lib/cost-rules/labor-regions";

export const KB_CATEGORY = {
  materialPrice: "material_price",
  processRate: "process_rate",
  laborRate: "labor_rate",
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
  equipment_rate: EQUIPMENT_RATE,
};

interface KbState {
  entries: Map<string, any>;
  loadedAt: number;
}

let state: KbState | null = null;
let loadPromise: Promise<KbState | null> | null = null;
let loadFailed = false;

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

/**
 * 预热知识库到内存。幂等：已加载或已失败则直接返回。
 * 任何异常都被吞掉，避免影响主分析链路。
 */
export async function loadKnowledgeBase(force = false): Promise<void> {
  if (force) {
    state = null;
    loadFailed = false;
    loadPromise = null;
  }
  if (state || loadFailed) return;
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
            ],
          },
        },
        select: { category: true, key: true, value: true },
      });
      const entries = new Map<string, any>();
      for (const r of rows) {
        try {
          entries.set(composite(r.category, r.key), JSON.parse(r.value));
        } catch {
          // 单条解析失败不影响其他条目
        }
      }
      return { entries, loadedAt: Date.now() };
    } catch {
      // DB 不可用：标记失败，后续全走常量回退
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  state = await loadPromise;
  if (!state) loadFailed = true;
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
}

/** 材料单价（元/吨）：优先知识库，回退 MATERIAL_PRICES 常量 */
export function getMaterialPrice(material: string, grammage: string): KbValue {
  const v = numOf(getRaw(KB_CATEGORY.materialPrice, `${material}:${grammage}`));
  if (v != null) return { value: v, fromKb: true };
  return { value: MATERIAL_PRICES[material]?.[grammage] ?? 5500, fromKb: false };
}

/** 坑纸/底纸单价（元/吨）：优先知识库，回退 FLUTE_TYPES 常量 */
export function getFlutePrice(code: string): KbValue {
  const v = numOf(getRaw(KB_CATEGORY.processRate, `flute:${code}`));
  if (v != null) return { value: v, fromKb: true };
  return { value: FLUTE_TYPES[code]?.flutePricePerTon ?? 0, fromKb: false };
}

/** 工艺/费用类费率：统一入口，key 见 PROCESS_RATE_FALLBACK */
export function getProcessRate(key: string): KbValue {
  const v = numOf(getRaw(KB_CATEGORY.processRate, key));
  if (v != null) return { value: v, fromKb: true };
  return { value: PROCESS_RATE_FALLBACK[key] ?? 0, fromKb: false };
}

/** 地域基础人工费率（元/小时）：优先知识库，回退 LABOR_REGIONS 配置 */
export function getRegionRate(code: string): KbValue {
  const v = numOf(getRaw(KB_CATEGORY.laborRate, `region:${code}`));
  if (v != null) return { value: v, fromKb: true };
  const fallback =
    LABOR_REGIONS[code]?.baseRate ??
    LABOR_REGIONS[DEFAULT_LABOR_REGION].baseRate;
  return { value: fallback, fromKb: false };
}

/** 物流费率：优先知识库，回退 LOGISTICS_RATES 配置 */
export function getLogisticsRate(code: string): KbValue {
  const v = numOf(getRaw(KB_CATEGORY.laborRate, `logistics:${code}`));
  if (v != null) return { value: v, fromKb: true };
  return { value: LOGISTICS_RATES[code] ?? 0.035, fromKb: false };
}
