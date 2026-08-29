/**
 * 配方加载器（F2）
 * ----------------------------------------------------------------
 * 从 CostItem 表加载「生效中」的配方行，进程内缓存（同知识库的做法）。
 *
 * 生效判定：status=active && enabled=true，且（若设置了）当前时间落在
 * effectiveFrom~effectiveTo 区间内。**未设置日期的条目视为长期有效**，
 * 这样黄金基线回归不受"当前时间"影响，保持可复现。
 *
 * 库为空时 getRecipeItems 返回空数组 → 调用方回退现有硬编码，行为完全不变。
 */

import { prisma } from "@/lib/db";
import type { CostItemLike } from "./index";

interface RecipeState {
  /** key: `${productType}::${dimension}` */
  byKey: Map<string, CostItemLike[]>;
  loadedAt: number;
}

let state: RecipeState | null = null;
let loadFailedAt = 0;
const RETRY_COOLDOWN_MS = 60_000;

/**
 * 是否正处于「草稿覆盖」期间。
 * 覆盖期内必须冻结缓存：否则 TTL 一到期就会重新查库，把草稿悄悄换回已保存的值，
 * 试算结果就成了假的（看起来"改了没影响"）。
 */
let overriding = false;

/**
 * 缓存有效期。
 *
 * ⚠️ 早期版本是「无 TTL 的永久缓存」：只有调用 reloadRecipes()（即通过本管理接口
 * 写库）才会失效。一旦有人直接改库（脚本、迁移、手工 SQL、另一套后台），
 * 运行中的进程会一直用旧配方算钱——实测同一个库两个进程算出相差 16.6% 的结果，
 * 且界面毫无提示。
 *
 * 现在加 TTL：超过有效期后下一次读取自动重取。默认 5 分钟——既避免每次请求查库，
 * 也不会让错误的配方存活到下次重启。设为 0 可恢复"永不过期"。
 */
const CACHE_TTL_MS = Number(process.env.RECIPE_CACHE_TTL_MS ?? 300_000);

function keyOf(productType: string, dimension: string): string {
  return `${productType}::${dimension}`;
}

/** 缓存状态（给管理页显示，让"我算的是哪一版配方"可见） */
export function getRecipeCacheInfo(): {
  loadedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
  stale: boolean;
  groups: number;
} {
  if (!state) {
    return {
      loadedAt: null,
      ageMs: null,
      ttlMs: CACHE_TTL_MS,
      stale: true,
      groups: 0,
    };
  }
  const ageMs = Date.now() - state.loadedAt;
  return {
    loadedAt: state.loadedAt,
    ageMs,
    ttlMs: CACHE_TTL_MS,
    stale: CACHE_TTL_MS > 0 && ageMs > CACHE_TTL_MS,
    groups: state.byKey.size,
  };
}

export async function loadRecipes(force = false): Promise<void> {
  // 覆盖期内一律不动缓存（含 force），否则草稿会被换回已保存值
  if (overriding) return;
  if (force) {
    state = null;
    loadFailedAt = 0;
  }
  // TTL 到期 → 当作未加载，下次读取重新查库
  if (state && CACHE_TTL_MS > 0 && Date.now() - state.loadedAt > CACHE_TTL_MS) {
    state = null;
  }
  if (state) return;
  if (loadFailedAt && Date.now() - loadFailedAt < RETRY_COOLDOWN_MS) return;

  try {
    const rows = await prisma.costItem.findMany({
      where: { status: "active", enabled: true },
      orderBy: [{ productType: "asc" }, { dimension: "asc" }, { sortOrder: "asc" }],
    });

    const byKey = new Map<string, CostItemLike[]>();
    const now = Date.now();
    for (const r of rows) {
      if (r.effectiveFrom && r.effectiveFrom.getTime() > now) continue;
      if (r.effectiveTo && r.effectiveTo.getTime() < now) continue;

      const k = keyOf(r.productType, r.dimension);
      const list = byKey.get(k) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        kind: r.kind,
        params: r.params,
        conditions: r.conditions,
        weight: r.weight,
        sortOrder: r.sortOrder,
        enabled: r.enabled,
      });
      byKey.set(k, list);
    }
    state = { byKey, loadedAt: now };
  } catch {
    // 库不可用 → 标记失败，调用方回退硬编码，不阻断主链路
    loadFailedAt = Date.now();
  }
}

/** 取某品类某维度的生效配方行；无配方返回空数组 */
export function getRecipeItems(
  productType: string,
  dimension: string
): CostItemLike[] {
  return state?.byKey.get(keyOf(productType, dimension)) ?? [];
}

/** 是否已有任何配方（用于判断是否处于"配方驱动"模式） */
export function hasAnyRecipe(): boolean {
  return (state?.byKey.size ?? 0) > 0;
}

/**
 * 在「临时配方覆盖」下执行 fn（试算未保存改动用），**完全不写库**。
 *
 * 早期试算只能跑"已保存"的状态，于是流程变成「改 → 保存 → 试算 → 发现偏了 → 手动改回」，
 * 正好是用户最想避免的顺序。这里让试算可以带着草稿跑：临时替换缓存里的配方，
 * 跑完立即还原，数据库与审计日志全程不动。
 *
 * 并发保护：覆盖期间拒绝新的覆盖（返回 null），避免两个试算互相踩脏缓存。
 *
 * @param overrides key = 成本项 id，value = 要覆盖的字段
 * @returns fn 的结果；若已有覆盖在进行中则返回 null
 */
export async function withRecipeOverrides<T>(
  overrides: Record<string, Partial<CostItemLike>>,
  fn: () => Promise<T> | T
): Promise<T | null> {
  if (overriding) return null;
  if (!Object.keys(overrides).length) return fn();

  const snapshot = state;
  if (!snapshot) await loadRecipes(true);
  const backup = state;
  if (!backup) return fn();

  overriding = true;
  try {
    const next = new Map<string, CostItemLike[]>();
    for (const [k, list] of backup.byKey) {
      next.set(
        k,
        list
          .map((it) => {
            const ov = it.id ? overrides[it.id] : undefined;
            if (!ov) return it;
            const merged = { ...it, ...ov };
            // 停用的项在 loader 里本就不会被加载，覆盖时同样按"移除"处理
            return merged.enabled === false ? null : merged;
          })
          .filter((x): x is CostItemLike => x !== null)
      );
    }
    // loadedAt 取「当下」而非 backup 的时间：即使备份已接近过期，
    // 覆盖期内也不会被 TTL 判定为 stale（配合 loadRecipes 里的 overriding 早退双保险）
    state = { byKey: next, loadedAt: Date.now() };
    return await fn();
  } finally {
    state = backup;
    overriding = false;
  }
}

/** 清空缓存（改配方后即时生效，无需重启） */
export async function reloadRecipes(): Promise<{ loadedAt: number }> {
  await loadRecipes(true);
  return { loadedAt: state?.loadedAt ?? 0 };
}
