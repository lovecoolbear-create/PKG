// ========== P9 AI 降本规则闭环：服务端 DB 读写层（仅服务端 import） ==========
// 依赖 prisma，承接确定性纯逻辑（rule-lifecycle.ts）与数据库之间的桥接。
// 所有「写库」动作均由人工交互触发的 API 调用，AI 代码路径不调用本文件。

import { prisma } from "@/lib/db";
import type { AnalysisInput } from "@/types";
import type { PendingRule } from "./knowledge-distill";
import {
  deriveContext,
  pendingRuleToRuleTemplate,
  shouldDeprecate,
  rankByCosine,
  localEmbedder,
  type DeprecateOptions,
  type DeterministicRuleJson,
  type RankCandidate,
} from "./rule-lifecycle";

// ---------------------------------------------------------------------------
// 规格1：一键转换（人工触发）→ 落库为确定性规则
// ---------------------------------------------------------------------------

/** 把 LLM 蒸馏提案（PendingRule）确定性转换为数据库降本规则（status=ACTIVE） */
export async function convertPendingRule(
  rule: PendingRule,
  input: AnalysisInput,
  productType: string
) {
  const ctx = deriveContext(input, productType);
  const create = pendingRuleToRuleTemplate(rule, ctx);
  return prisma.costReductionRule.create({ data: create });
}

// ---------------------------------------------------------------------------
// 规格2：生命周期计数与 TTL 扫描
// ---------------------------------------------------------------------------

/** 记录一次规则命中（使用频次 +1，刷新 lastTriggeredAt；曾被弃用则自动复活） */
export async function recordTrigger(id: string): Promise<void> {
  const existing = await prisma.costReductionRule.findUnique({ where: { id } });
  if (!existing) return;
  await prisma.costReductionRule.update({
    where: { id },
    data: {
      usageCount: { increment: 1 },
      triggerCount: { increment: 1 },
      lastTriggeredAt: new Date(),
      status: existing.status === "DEPRECATED" ? "ACTIVE" : existing.status,
      deprecatedAt: existing.status === "DEPRECATED" ? null : undefined,
    },
  });
}

/** 记录一次规则冲突（冲突次数 +1，并计入一次触发） */
export async function recordConflict(id: string): Promise<void> {
  await prisma.costReductionRule.update({
    where: { id },
    data: {
      conflictCount: { increment: 1 },
      triggerCount: { increment: 1 },
      lastTriggeredAt: new Date(),
    },
  });
}

/**
 * TTL 扫描（规格2）：对所有 ACTIVE 规则做确定性判定，
 * 连续 90 天未触发或冲突率超阈值的 → DEPRECATED。
 * 返回本次被弃用的规则 id 列表。
 */
export async function sweepDeprecated(opts: DeprecateOptions = {}) {
  const active = await prisma.costReductionRule.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      createdAt: true,
      lastTriggeredAt: true,
      triggerCount: true,
      conflictCount: true,
    },
  });
  const deprecatedIds: string[] = [];
  const now = opts.now ?? new Date();
  for (const r of active) {
    const hit = shouldDeprecate(
      {
        status: "ACTIVE",
        createdAt: r.createdAt,
        lastTriggeredAt: r.lastTriggeredAt,
        triggerCount: r.triggerCount,
        conflictCount: r.conflictCount,
      },
      { ...opts, now }
    );
    if (hit) {
      await prisma.costReductionRule.update({
        where: { id: r.id },
        data: { status: "DEPRECATED", deprecatedAt: now },
      });
      deprecatedIds.push(r.id);
    }
  }
  return { deprecatedIds, scanned: active.length };
}

// ---------------------------------------------------------------------------
// 规格3：向量检索（确定性元数据预过滤 → 语义余弦重排）
// ---------------------------------------------------------------------------

export interface RetrieveFilter {
  productType?: string;
  boxType?: string | null;
  material?: string | null;
  loadClass?: string | null;
  limit?: number;
}

export interface RetrievedRule {
  id: string;
  title: string;
  target: string;
  boxType: string | null;
  material: string | null;
  loadClass: string | null;
  description: string;
  proposedValue: string;
  ruleJson: DeterministicRuleJson;
  confidence: number;
  usageCount: number;
  status: string;
  score: number;
}

/**
 * 检索降本案例库（规格3）：
 *  1) 确定性元数据预过滤（boxType / material / loadClass / productType），
 *     只取 ACTIVE 规则，先在 SQL 层 WHERE 收敛候选集（提升效率与准确度）；
 *  2) 若提供 query 文本，则用语义向量余弦对候选重排；否则按使用频次降序。
 *
 * ── 生产 pgvector 升级路径（可选）──
 * 当前 embedding 存为 JSON 字符串、在应用内做余弦。启用 pgvector 时：
 *   a) 将 CostReductionRule.embedding 列改为 `vector(${EMBED_DIM})`；
 *   b) 建索引：CREATE INDEX ON "CostReductionRule" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
 *   c) 把本函数的「取候选 → rankByCosine」替换为一条 SQL：
 *      SELECT ..., 1 - (embedding <=> $queryVec) AS score
 *      FROM "CostReductionRule"
 *      WHERE status='ACTIVE' AND ("boxType"=$boxType OR $boxType IS NULL) ...
 *      ORDER BY score DESC LIMIT $limit;
 *  检索语义/接口不变，仅底层从应用内余弦切到 DB 向量检索。
 */
export async function retrieveCases(
  filter: RetrieveFilter,
  query?: string
): Promise<RetrievedRule[]> {
  const where: Record<string, unknown> = { status: "ACTIVE" };
  if (filter.productType) where.productType = filter.productType;
  if (filter.boxType) where.boxType = filter.boxType;
  if (filter.material) where.material = filter.material;
  if (filter.loadClass) where.loadClass = filter.loadClass;

  const rows = await prisma.costReductionRule.findMany({
    where,
    orderBy: { usageCount: "desc" },
    take: filter.limit && filter.limit > 0 ? filter.limit * 4 : 200, // 预过滤后多取，重排再截断
  });

  const candidates: RankCandidate[] = rows.map((r) => ({
    id: r.id,
    embedding: r.embedding,
    fallbackScore: r.usageCount,
  }));

  const scored =
    query && query.trim() ? rankByCosine(candidates, localEmbedder(query)) : null;
  const orderedIds = scored
    ? scored.map((s) => s.id)
    : candidates
        .sort((a, b) => (b.fallbackScore ?? 0) - (a.fallbackScore ?? 0))
        .map((c) => c.id);
  const scoreById = new Map((scored ?? []).map((s) => [s.id, s.score]));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: RetrievedRule[] = orderedIds
    .map((id) => byId.get(id)!)
    .map((r) => ({
      id: r.id,
      title: r.title,
      target: r.target,
      boxType: r.boxType,
      material: r.material,
      loadClass: r.loadClass,
      description: r.description,
      proposedValue: r.proposedValue,
      ruleJson: safeParseJson<DeterministicRuleJson>(r.ruleJson),
      confidence: r.confidence,
      usageCount: r.usageCount,
      status: r.status,
      score: scoreById.get(r.id) ?? 0,
    }));
  return filter.limit ? result.slice(0, filter.limit) : result;
}

// ---------------------------------------------------------------------------
// 列表（供面板展示状态 / TTL / 使用频次）
// ---------------------------------------------------------------------------

export async function listRules(status?: string) {
  return prisma.costReductionRule.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
}

function safeParseJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}
