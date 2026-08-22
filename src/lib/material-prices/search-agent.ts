// ========== 入口二：实时纸价行情 Web Search / Agent 抓取 ==========
// 重构材料 Fetcher：接入带 Web Search 或大模型联网检索能力的 Agent，
// 动态检索纸业大盘当月白卡/瓦楞原纸最新吨价，提炼为数字更新计算引擎。
// 降级兜底：若 API / 网络失败，优雅回退至本地静态基准价 MATERIAL_PRICES，标记 isFallback:true。

import type { MaterialPriceFetchResult } from "@/types";
import type { AiSettings } from "@/lib/config/ai-settings";
import { MATERIAL_LABELS } from "@/lib/cost-rules";
import {
  fetchMaterialPrices,
  resolvePaperPrice,
} from "@/lib/material-prices/fetcher";
import { getMaterialPrice } from "@/lib/knowledge-base";
import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
} from "@/lib/llm/client";

export interface PaperPriceResult {
  price: number;
  source: string;
  isFallback: boolean;
  /** 是否实时检索获得（true=行情检索；false=模型估算或本地基准） */
  live: boolean;
  priceTimestamp: string;
  note?: string;
}

const MATERIAL_DESC: Record<string, string> = {
  white_card: "白卡纸",
  coated_paper: "铜版纸",
  grey_board: "灰底白板",
  kraft: "牛皮纸",
  special: "特种纸",
};

/** 可选：用 Tavily 等搜索 API 获取实时行情片段 */
async function webSearchSnippets(query: string): Promise<string | null> {
  const apiKey = process.env.SEARCH_API_KEY;
  const endpoint =
    process.env.SEARCH_API_URL || "https://api.tavily.com/search";
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: "news",
        max_results: 5,
        search_depth: "basic",
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { content?: string; title?: string }[];
    };
    const snippets = (data.results || [])
      .map((r) => `${r.title || ""} ${r.content || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    return snippets || null;
  } catch {
    return null;
  }
}

/**
 * 动态检索某材质/克重的最新吨价。
 * 优先级：可选 Web 搜索 + LLM 提炼 → 纯 LLM 知识估算 → 本地基准回退。
 */
export async function searchPaperPrice(
  material: string,
  grammage: string,
  aiSettings?: AiSettings
): Promise<PaperPriceResult> {
  const now = new Date().toISOString();
  const desc = MATERIAL_DESC[material] || MATERIAL_LABELS[material] || material;
  const benchmark = await resolvePaperPrice(material, grammage);

  if (!isLlmConfigured(aiSettings)) {
    // 无 LLM → 直接回退本地基准
    return {
      price: benchmark.price,
      source: benchmark.source,
      isFallback: true,
      live: false,
      priceTimestamp: now,
      note: "未配置大模型，已回退本地权威基准价",
    };
  }

  try {
    const snippets = await webSearchSnippets(
      `${desc} ${grammage}g 最新吨价 出厂价 白卡纸 瓦楞原纸 行情 ${new Date().getFullYear()}年${new Date().getMonth() + 1}月`
    );
    const context = snippets
      ? `以下是联网检索到的近期纸业行情片段：\n"""${snippets}"""\n`
      : "（未启用联网搜索，请基于你的行业知识给出最新参考吨价估算）";

    const sys = `你是包装材料成本分析师。请根据提供的信息，给出「${desc} ${grammage}g」的当前市场参考吨价（元/吨）。
只输出 JSON：{"price": <数字，元/吨>, "source": "<简短来源说明>", "live": <布尔，true表示来自实时检索、false表示模型知识估算>}。`;

    const raw = await chatCompletion(
      [
        { role: "system", content: sys },
        { role: "user", content: context },
      ],
      { temperature: 0.1, timeoutMs: 15000, settings: aiSettings }
    );

    const obj = extractJsonObject(raw);
    const price = Number(obj.price);
    if (!Number.isNaN(price) && price > 0 && price < 50000) {
      const live = obj.live === true && !!snippets;
      return {
        price: Math.round(price * 100) / 100,
        source: live
          ? `实时行情检索（${String(obj.source || "纸业大盘")}）`
          : `大模型知识估算（${String(obj.source || "行业基准")}）`,
        isFallback: false,
        live,
        priceTimestamp: now,
        note: live
          ? "已通过联网检索获取实时行情"
          : "大模型基于知识估算，非实时行情，建议核实",
      };
    }
  } catch {
    // LLM/检索失败 → 回退
  }

  return {
    price: benchmark.price,
    source: benchmark.source,
    isFallback: true,
    live: false,
    priceTimestamp: now,
    note: "行情检索失败，已回退本地权威基准价",
  };
}

/**
 * 统一获取材料价格（含纸板主材的实时检索/估算）。
 * 表面处理费率与油墨仍沿用本地基准；纸板主材优先走 searchPaperPrice。
 */
export async function getMaterialPrices(params: {
  material: string;
  grammage: string;
  surfaceTreatment?: string;
  aiSettings?: AiSettings;
}): Promise<MaterialPriceFetchResult> {
  const base = await fetchMaterialPrices(params);
  const paper = await searchPaperPrice(
    params.material,
    params.grammage,
    params.aiSettings
  );

  const entries = base.entries.map((e) =>
    e.category === "paper"
      ? {
          ...e,
          price: paper.price,
          source: paper.source,
          isFallback: paper.isFallback,
          live: paper.live,
          priceTimestamp: paper.priceTimestamp,
        }
      : e
  );

  const paperEntry = entries.find((e) => e.category === "paper");
  const summary = paper.isFallback
    ? "纸板主材价格已回退至本地权威基准价（未配置外部行情 API 或请求失败）"
    : `纸板主材价格已通过${paper.live ? "实时行情检索" : "大模型估算"}获取`;

  return {
    entries,
    hasFallback: !!paperEntry?.isFallback,
    fetchedAt: new Date().toISOString(),
    summary,
  };
}

// 便于上层在缺省材质时也有基准价（来自知识库，缺失回退常量）
export function localBenchmarkPrice(material: string, grammage: string): number {
  return getMaterialPrice(material, grammage).value;
}
