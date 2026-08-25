// ========== P5 上下文层（行情 / 动态外部上下文） ==========
// 聚合「本地基准价 + 实时行情趋势」为统一的时效 Context，供 P1/P2 表达层与判定层注入。
//
// 铁律落地（§3.1 / §3.2 硬约束 A）：
// - 价格数字永远来自确定性源（MATERIAL_PRICES / 知识库），AI 只产出定性趋势，不得产出价格数字（数字守恒）。
// - 无实时行情前，Context 显式声明「asOf 本地基准，未含实时行情」，使 AI 解释带时效边界、不偏向静态。

import { MATERIAL_PRICES_META } from "@/lib/cost-rules";
import { searchPaperPrice, type PaperPriceResult } from "./search-agent";
import type { AiSettings } from "@/lib/config/ai-settings";

export interface PricingContext {
  /** 确定性价格（元/吨），来自基准/知识库 */
  price: number;
  /** 基准戳：本地基准价生效月份 */
  asOf: string;
  /** 价格来源说明 */
  source: string;
  /** 是否实时 */
  live: boolean;
  /** 行情趋势方向（AI 定性，可为空） */
  trend?: "up" | "down" | "flat" | null;
  /** 行情趋势说明（定性） */
  trendNote?: string;
  /** 时效背景文案（供 P1/P2 直接注入 prompt） */
  contextNote: string;
}

/**
 * 获取某材质的统一时效 Context。
 * 价格走确定性基准；trend 由 AI 产出（仅定性）。无 LLM 时 trend 为空、仍带 asOf 边界。
 */
export async function getPricingContext(
  material: string,
  grammage: string,
  aiSettings?: AiSettings
): Promise<PricingContext> {
  const paper: PaperPriceResult = await searchPaperPrice(material, grammage, aiSettings);
  const contextNote = `材料价格基于本地基准价（asOf ${MATERIAL_PRICES_META.asOf}，${MATERIAL_PRICES_META.source}）${MATERIAL_PRICES_META.note ? "，" + MATERIAL_PRICES_META.note : ""}。${
    paper.trend
      ? `当前行情趋势：${paper.trend === "up" ? "上涨" : paper.trend === "down" ? "下跌" : "持平"}${paper.trendNote ? "（" + paper.trendNote + "）" : ""}。`
      : "未含实时行情，相关判断为静态基准，建议以工厂当期报价为准。"
  }`;
  return {
    price: paper.price,
    asOf: MATERIAL_PRICES_META.asOf,
    source: paper.source,
    live: paper.live,
    trend: paper.trend,
    trendNote: paper.trendNote,
    contextNote,
  };
}

/**
 * 同步轻量时效文案（不触发额外 LLM 调用），供 P1/P2 prompt 注入。
 * 仅声明本地基准边界，避免无谓的二次模型开销。
 */
export function getBenchmarkContextNote(): string {
  return `材料价格基于本地基准价（asOf ${MATERIAL_PRICES_META.asOf}，${MATERIAL_PRICES_META.source}）；未含实时行情，相关判断为静态基准，请勿暗示实时行情。`;
}
