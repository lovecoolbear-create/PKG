/**
 * 网络行情定时刷新
 * ----------------------------------------------------------------
 * 周期性从外部行情 API 拉取纸价，写入 market_price 分类（仅作观察参考，
 * 成本引擎不读取该分类，避免覆盖人工设定的内部基准）。
 *
 * 关键约束：
 * - 仅当 fetchMaterialPrices 返回「真实行情」（hasFallback=false）时才落库；
 *   无 API Key / 网络失败 / 回退本地基准时一律跳过，绝不写入假行情。
 * - 调度由 instrumentation.ts 在 nodejs 运行时启动，全局去重避免热更新叠加。
 */

import { MATERIAL_PRICES } from "@/lib/cost-rules";
import { fetchMaterialPrices } from "@/lib/material-prices/fetcher";
import {
  KB_CATEGORY,
  listKnowledgeEntries,
  upsertKnowledgeEntry,
} from "@/lib/knowledge-base";

const GRAMMAGES = ["230", "250", "300", "350", "400", "450"];

/** 需要定时刷新的（材料 × 克重）组合 */
export const CONFIGURED_PAIRS: { material: string; grammage: string }[] =
  Object.keys(MATERIAL_PRICES).flatMap((material) =>
    GRAMMAGES.map((grammage) => ({ material, grammage }))
  );

export interface NetworkRefreshSummary {
  updated: number;
  skipped: number;
  total: number;
  apiConfigured: boolean;
}

/** 拉取全部配置组合的行情，真实行情写入 market_price，回退/失败跳过 */
export async function refreshAllNetworkPrices(): Promise<NetworkRefreshSummary> {
  const apiConfigured = !!(
    process.env.PAPER_PRICE_API_KEY && process.env.PAPER_PRICE_API_URL
  );
  let updated = 0;
  let skipped = 0;

  for (const { material, grammage } of CONFIGURED_PAIRS) {
    try {
      const r = await fetchMaterialPrices({ material, grammage });
      if (r.hasFallback) {
        skipped++; // 无真实行情：跳过，不写假数据
        continue;
      }
      const paper = r.entries.find((e) => e.category === "paper");
      if (!paper) {
        skipped++;
        continue;
      }
      await upsertKnowledgeEntry({
        category: KB_CATEGORY.marketPrice,
        key: `${material}:${grammage}`,
        value: {
          value: paper.price,
          material,
          grammage,
          unit: "元/吨",
          fetchedAt: paper.priceTimestamp,
        },
        source: "network",
        confidence: 75,
        tags: [material, `${grammage}g`, "network"],
      });
      updated++;
    } catch {
      skipped++;
    }
  }

  return {
    updated,
    skipped,
    total: CONFIGURED_PAIRS.length,
    apiConfigured,
  };
}

/** 启动定时刷新（全局单例，热更新安全） */
export function startNetworkCron(): void {
  const g = globalThis as any;
  if (g.__kbNetworkCron) return; // 已启动，去重
  const minutes = Math.max(
    1,
    Number(process.env.KB_NETWORK_REFRESH_MINUTES || 60)
  );
  // 启动时先跑一次（无 API 时自然空转）
  refreshAllNetworkPrices().catch(() => {});
  g.__kbNetworkCron = setInterval(() => {
    refreshAllNetworkPrices().catch(() => {});
  }, minutes * 60 * 1000);
  console.log(
    `[network-cron] 已启动定时刷新：间隔 ${minutes} 分钟，监控 ${CONFIGURED_PAIRS.length} 个材料组合`
  );
}

/** 供管理接口使用：读取当前市场行情与基准对照 */
export async function getNetworkStatus() {
  const [marketEntries, baselineEntries] = await Promise.all([
    listKnowledgeEntries(KB_CATEGORY.marketPrice),
    listKnowledgeEntries(KB_CATEGORY.materialPrice),
  ]);
  return {
    pairs: CONFIGURED_PAIRS,
    marketEntries,
    baselineEntries,
    intervalMinutes: Math.max(
      1,
      Number(process.env.KB_NETWORK_REFRESH_MINUTES || 60)
    ),
    apiConfigured: !!(
      process.env.PAPER_PRICE_API_KEY && process.env.PAPER_PRICE_API_URL
    ),
  };
}
