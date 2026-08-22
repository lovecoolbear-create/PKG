import { MATERIAL_LABELS } from "@/lib/cost-rules";
import { getMaterialPrice, getProcessRate } from "@/lib/knowledge-base";
import type { MaterialPriceEntry, MaterialPriceFetchResult } from "@/types";

const SURFACE_LABELS: Record<string, string> = {
  matte_laminate: "哑膜",
  gloss_laminate: "亮膜",
  uv: "UV上光",
  foil: "烫金箔",
  emboss: "压纹",
};

// ========== 统一纸价 Fetcher 接口 ==========
/**
 * 纸价来源（Fetcher）统一接口。
 * 返回 null 表示本源无法提供价格（需回退到下一个源）；
 * 框架按注册顺序依次尝试，最终回退到本地权威基准价。
 */
export interface PaperPriceSource {
  id: string;
  label: string;
  fetch(
    material: string,
    grammage: string
  ): Promise<{ price: number; source: string } | null>;
}

/** 本地权威基准价（永远可用，作为最终回退）——直接来自知识库条目 */
class LocalBenchmarkSource implements PaperPriceSource {
  id = "local_benchmark";
  label = "本地权威基准价";
  async fetch(material: string, grammage: string) {
    const kb = getMaterialPrice(material, grammage);
    return { price: kb.value, source: "本地权威基准价（知识库）" };
  }
}

/**
 * 外部行情 API（预留接口）。
 * 未配置 API Key 或请求失败（超时/网络错误/非法响应）均返回 null，
 * 触发框架优雅回退到本地权威基准价，不会抛出。
 */
class ExternalApiSource implements PaperPriceSource {
  id = "external_api";
  label = "外部行情 API";
  constructor(
    private apiKey?: string,
    private endpoint?: string
  ) {}
  async fetch(material: string, grammage: string) {
    if (!this.apiKey || !this.endpoint) return null; // 无 Key，优雅回退
    try {
      const url = `${this.endpoint}?material=${encodeURIComponent(
        material
      )}&grammage=${encodeURIComponent(grammage)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { price?: number; source?: string };
      const price = Number(data?.price);
      if (!price || price <= 0) return null;
      return { price, source: data?.source || "外部行情 API" };
    } catch {
      return null; // 网络失败，优雅回退
    }
  }
}

/** 已注册的纸价 Fetcher（顺序即优先级：外部 API 优先，本地基准兜底） */
export const PAPER_PRICE_FETCHERS: PaperPriceSource[] = [
  new ExternalApiSource(
    process.env.PAPER_PRICE_API_KEY,
    process.env.PAPER_PRICE_API_URL
  ),
  new LocalBenchmarkSource(),
];

export interface ResolvedPaperPrice {
  price: number;
  source: string;
  isFallback: boolean;
  priceTimestamp: string;
}

/** 依次尝试各 Fetcher，自动优雅回退，返回价格与时间戳 */
export async function resolvePaperPrice(
  material: string,
  grammage: string
): Promise<ResolvedPaperPrice> {
  const now = new Date().toISOString();
  for (const src of PAPER_PRICE_FETCHERS) {
    try {
      const r = await src.fetch(material, grammage);
      if (r) {
        return {
          price: r.price,
          source: r.source,
          isFallback: src.id === "local_benchmark",
          priceTimestamp: now,
        };
      }
    } catch {
      // 单个源异常不阻断，继续尝试下一个
    }
  }
  const price = getMaterialPrice(material, grammage).value;
  return {
    price,
    source: "本地权威基准价（知识库）",
    isFallback: true,
    priceTimestamp: now,
  };
}

function buildSurfaceEntry(
  surfaceTreatment: string,
  now: string
): MaterialPriceEntry | null {
  const surfaceRate = getProcessRate(`surface:${surfaceTreatment}`).value;
  if (surfaceRate === undefined) return null;
  return {
    item: SURFACE_LABELS[surfaceTreatment] || surfaceTreatment,
    category: "surface",
    price: surfaceRate,
    unit: "元/m²",
    source: "本地权威基准价（知识库·表面处理费率）",
    fetchedAt: now,
    priceTimestamp: now,
    isFallback: true,
    priceRange: [surfaceRate * 0.9, surfaceRate * 1.1],
  };
}

export interface FetchMaterialPricesParams {
  material: string;
  grammage: string;
  surfaceTreatment?: string;
}

/**
 * 获取材料价格 - 统一 Fetcher 架构
 * 纸板主材优先走外部行情 API，失败/无 Key 自动回退本地权威基准价，
 * 并标记 isFallback 与 priceTimestamp。
 */
export async function fetchMaterialPrices(
  params: FetchMaterialPricesParams
): Promise<MaterialPriceFetchResult> {
  const { material, grammage, surfaceTreatment } = params;
  const entries: MaterialPriceEntry[] = [];
  const now = new Date().toISOString();

  // 1. 纸板主材：统一 Fetcher 架构（外部 API -> 本地基准回退）
  const paper = await resolvePaperPrice(material, grammage);
  entries.push({
    item: `${MATERIAL_LABELS[material] || material} ${grammage}g`,
    category: "paper",
    price: paper.price,
    unit: "元/吨",
    source: paper.source,
    fetchedAt: now,
    priceTimestamp: paper.priceTimestamp,
    isFallback: paper.isFallback,
    priceRange: [paper.price * 0.95, paper.price * 1.05],
  });

  // 2. 表面处理材料（覆膜、烫金箔等，沿用本地基准费率）
  if (surfaceTreatment && surfaceTreatment !== "none") {
    const surfaceEntry = buildSurfaceEntry(surfaceTreatment, now);
    if (surfaceEntry) entries.push(surfaceEntry);
  }

  // 3. 油墨参考（固定条目）
  entries.push({
    item: "四色油墨（CMYK）",
    category: "ink",
    price: 42,
    unit: "元/kg",
    source: "本地权威基准价（油墨固定基准）",
    fetchedAt: now,
    priceTimestamp: now,
    isFallback: true,
    priceRange: [38, 48],
  });

  const hasFallback = entries.some((e) => e.isFallback);
  return {
    entries,
    hasFallback,
    fetchedAt: now,
    summary: hasFallback
      ? "纸板主材价格已回退至本地权威基准价（未配置外部行情 API 或请求失败）"
      : "纸板主材价格已通过外部行情 API 实时获取",
  };
}

/** 从价格结果中获取纸板单价（元/吨） */
export function getPaperPriceFromFetch(
  result: MaterialPriceFetchResult,
  material: string,
  grammage: string
): { price: number; entry: MaterialPriceEntry } {
  const paperEntry = result.entries.find((e) => e.category === "paper");
  if (paperEntry) {
    return { price: paperEntry.price, entry: paperEntry };
  }
  const fallbackPrice = getMaterialPrice(material, grammage).value;
  const fallback: MaterialPriceEntry = {
    item: `${MATERIAL_LABELS[material] || material} ${grammage}g`,
    category: "paper",
    price: fallbackPrice,
    unit: "元/吨",
    source: "本地权威基准价（知识库）",
    fetchedAt: new Date().toISOString(),
    priceTimestamp: new Date().toISOString(),
    isFallback: true,
    priceRange: [fallbackPrice * 0.95, fallbackPrice * 1.05],
  };
  return { price: fallback.price, entry: fallback };
}
