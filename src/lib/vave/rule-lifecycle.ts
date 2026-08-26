// ========== P9 AI 降本规则闭环：纯逻辑核心（无 DB 依赖，客户端安全） ==========
// 本文件只含确定性纯函数 + 类型，不 import prisma，可被客户端组件安全引用。
// DB 读写在同级 rule-store.ts（仅服务端 import）。
//
// 对应需求规格：
//  【规格1】pendingRuleToRuleTemplate —— LLM 蒸馏提案 → 确定性规则模板（JSON 结构）。
//  【规格2】shouldDeprecate / TTL / conflictRate —— 规则生命周期判定（纯函数）。
//  【规格3】localEmbedder / cosine / rankByCosine —— 语义向量（本地确定性 tokenizer）。
//  【规格3】deriveContext —— 从 AnalysisInput 派生元数据（箱型/材质/承重等级），
//           供确定性预过滤使用。

import type { AnalysisInput } from "@/types";
import type { PendingRule, PendingRuleTarget } from "./knowledge-distill";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 语义向量维度（本地确定性 tokenizer；生产可迁 pgvector 同维） */
export const EMBED_DIM = 256;
/** 规则生命周期：连续 N 天未触发 → 候选 DEPRECATED（规格2） */
export const TTL_DAYS = 90;
/** 冲突率阈值：>= 该值即判定 DEPRECATED（规格2） */
export const CONFLICT_RATE_THRESHOLD = 0.3;
/** 承重等级派生阈值（堆码载荷 kg = (层数-1) × 箱重） */
const LOAD_HEAVY_KG = 60;
const LOAD_MEDIUM_KG = 20;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type RuleStatus = "ACTIVE" | "DEPRECATED" | "PENDING";

/** 确定性元数据（规格3 预过滤用），由 AnalysisInput 派生 */
export interface RuleContext {
  productType: string;
  boxType?: string | null;
  material?: string | null;
  loadClass?: string | null;
}

/** 结构化确定性规则（规格1 模板产物，落库为 ruleJson 字符串） */
export interface DeterministicRuleJson {
  kind: "kb_override" | "validation_floor" | "parameter_adj";
  /** 知识库类别（material_price | process_rate | other） */
  category: string;
  /** 知识库键模板（人工固化时确认具体 key） */
  applyTo: string;
  action: "set" | "scale_by_ratio";
  value?: number;
  ratio?: number;
  unit?: string;
  /** 回显原始提案文案，保证可追溯 */
  note: string;
}

/** 落库创建对象（字段与 Prisma CostReductionRule 对齐，store 可直接 spread） */
export interface CostReductionRuleCreate {
  sourceRuleId?: string;
  title: string;
  target: string;
  productType: string;
  boxType?: string | null;
  material?: string | null;
  loadClass?: string | null;
  description: string;
  proposedValue: string;
  ruleJson: string;
  formula?: string | null;
  parameters?: string | null;
  confidence: number;
  evidence?: string | null;
  embedding?: string | null;
  status: RuleStatus;
}

/** 生命周期判定所需的规则快照（纯函数输入，避免依赖 Prisma 类型） */
export interface RuleLifecycleSnapshot {
  status: RuleStatus;
  createdAt: string | Date;
  lastTriggeredAt?: string | Date | null;
  triggerCount: number;
  conflictCount: number;
}

export interface DeprecateOptions {
  ttlDays?: number;
  conflictRateThreshold?: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// 规格3：本地确定性语义向量（零依赖、可测试；生产可替换 pgvector）
// ---------------------------------------------------------------------------

/** 字符串 → 32-bit hash（FNV-1a），用于把 term 映射到固定维度桶 */
function hashTerm(term: string): number {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % EMBED_DIM;
}

/** 中英文混合分词：ASCII 词 + 中文单字（unigram） */
function tokenize(text: string): string[] {
  const ascii = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []) as string[];
  const cjk = (text.match(/[一-鿿]/g) ?? []) as string[];
  return [...ascii, ...cjk];
}

/**
 * 本地确定性 embedder：词频(tf) 加权 + L2 归一化。
 * 不依赖任何外部模型，输出固定 EMBED_DIM 维、可复现向量，便于单测与本地运行。
 * 生产可替换为真实 EmbeddingFn（OpenAI/Cohere/Ollama），接口一致。
 */
export function localEmbedder(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const counts: Record<number, number> = {};
  for (const term of tokenize(text)) {
    const idx = hashTerm(term);
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  for (const k in counts) vec[Number(k)] = counts[k];
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** 余弦相似度（已 L2 归一化时 = 点积）；空向量返回 0 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// ---------------------------------------------------------------------------
// 派生元数据（规格3 确定性预过滤的输入）
// ---------------------------------------------------------------------------

/** 从 AnalysisInput 派生箱型 / 材质 / 承重等级 */
export function deriveContext(input: AnalysisInput, productType: string): RuleContext {
  const flute = (input.fluteType as string | undefined) ?? "";
  let boxType: string | null = null;
  if (flute === "single") boxType = "single_wall";
  else if (flute === "double") boxType = "double_wall";
  else if (flute === "triple") boxType = "triple_wall";
  else if (productType === "flat_print") boxType = "folding_carton";
  else if (/rigid|gift|礼/.test(productType)) boxType = "rigid";

  const material = (input.linerMaterial as string | undefined) ?? null;

  const load = Number(input.stackLayers ?? 1) * Number(input.boxWeightKg ?? 0);
  const loadClass =
    load >= LOAD_HEAVY_KG ? "heavy" : load >= LOAD_MEDIUM_KG ? "medium" : "light";

  return { productType, boxType, material, loadClass };
}

// ---------------------------------------------------------------------------
// 规格1：LLM 蒸馏提案 → 确定性规则模板
// ---------------------------------------------------------------------------

/** 从自由文本提案里尝试解析数值 / 百分比（确定性、尽力而为） */
function parseValue(text: string): { value?: number; ratio?: number } {
  const pct = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (pct) return { ratio: Number(pct[1]) / 100 };
  const num = text.match(/(-?\d+(?:\.\d+)?)/);
  if (num) return { value: Number(num[1]) };
  return {};
}

/** 按 target 把提案映射为结构化确定性规则（路由到对应知识库类别/键） */
function buildRuleJson(
  target: PendingRuleTarget,
  proposedValue: string,
  ctx: RuleContext
): DeterministicRuleJson {
  const parsed = parseValue(proposedValue);
  const base = { note: proposedValue };
  switch (target) {
    case "material_price":
      return {
        ...base,
        kind: "kb_override",
        category: "material_price",
        applyTo: `corr_liner:${ctx.material ?? "auto"}:auto`,
        action: parsed.ratio != null ? "scale_by_ratio" : "set",
        value: parsed.value,
        ratio: parsed.ratio,
        unit: "元/吨",
      };
    case "flute_config":
      return {
        ...base,
        kind: "parameter_adj",
        category: "process_rate",
        applyTo: "flute:auto",
        action: parsed.ratio != null ? "scale_by_ratio" : "set",
        value: parsed.value,
        ratio: parsed.ratio,
      };
    case "grammage_floor":
      return {
        ...base,
        kind: "validation_floor",
        category: "other",
        applyTo: "grammage_floor",
        action: "set",
        value: parsed.value,
        unit: "g/m²",
      };
    case "process_rate":
      return {
        ...base,
        kind: "kb_override",
        category: "process_rate",
        applyTo: "process:auto",
        action: parsed.ratio != null ? "scale_by_ratio" : "set",
        value: parsed.value,
        ratio: parsed.ratio,
      };
    case "loss_rate":
      return {
        ...base,
        kind: "kb_override",
        category: "process_rate",
        applyTo: "loss_rate",
        action: parsed.ratio != null ? "scale_by_ratio" : "set",
        value: parsed.value,
        ratio: parsed.ratio,
      };
    default:
      return {
        ...base,
        kind: "parameter_adj",
        category: "other",
        applyTo: "auto",
        action: parsed.ratio != null ? "scale_by_ratio" : "set",
        value: parsed.value,
        ratio: parsed.ratio,
      };
  }
}

/**
 * 把一条 PendingRule（LLM 提案）确定性转换为落库规则对象。
 * 纯函数、可复现；embedding 用 localEmbedder（可注入真实 EmbeddingFn）。
 * 人类点击「固化为规则」时调用此函数后写库——AI 代码路径绝不调用本函数写库。
 */
export function pendingRuleToRuleTemplate(
  rule: PendingRule,
  ctx: RuleContext,
  embedder: (text: string) => number[] = localEmbedder
): CostReductionRuleCreate {
  const ruleJson = buildRuleJson(rule.target, rule.proposedValue, ctx);
  const embedText = [rule.title, rule.description, rule.proposedValue, rule.evidence]
    .filter(Boolean)
    .join(" ");
  return {
    sourceRuleId: rule.id,
    title: rule.title,
    target: rule.target,
    productType: ctx.productType,
    boxType: ctx.boxType ?? null,
    material: ctx.material ?? null,
    loadClass: ctx.loadClass ?? null,
    description: rule.description,
    proposedValue: rule.proposedValue,
    ruleJson: JSON.stringify(ruleJson),
    formula: null,
    parameters: null,
    confidence: rule.confidence,
    evidence: rule.evidence,
    embedding: JSON.stringify(embedder(embedText)),
    status: "ACTIVE",
  };
}

// ---------------------------------------------------------------------------
// 规格2：规则生命周期判定（纯函数）
// ---------------------------------------------------------------------------

/** 冲突率 = 冲突次数 / 触发次数（无触发记 0） */
export function conflictRateOf(snap: RuleLifecycleSnapshot): number {
  if (snap.triggerCount <= 0) return 0;
  return snap.conflictCount / snap.triggerCount;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * 判定某规则是否应标记 DEPRECATED（规格2）：
 *  - 已非 ACTIVE → 否
 *  - 冲突率 >= 阈值 → 是
 *  - 参考时间（lastTriggeredAt 优先，否则 createdAt）距今 > ttlDays → 是
 */
export function shouldDeprecate(
  snap: RuleLifecycleSnapshot,
  opts: DeprecateOptions = {}
): boolean {
  if (snap.status !== "ACTIVE") return false;
  const ttl = opts.ttlDays ?? TTL_DAYS;
  const thr = opts.conflictRateThreshold ?? CONFLICT_RATE_THRESHOLD;
  const now = opts.now ?? new Date();

  if (conflictRateOf(snap) >= thr) return true;

  const ref = snap.lastTriggeredAt ? new Date(snap.lastTriggeredAt) : new Date(snap.createdAt);
  return daysBetween(ref, now) > ttl;
}

// ---------------------------------------------------------------------------
// 规格3：向量检索排序（确定性预过滤后的语义重排）
// ---------------------------------------------------------------------------

export interface RankCandidate {
  id: string;
  embedding?: string | null;
  /** 无向量时的回退排序分（如 usageCount） */
  fallbackScore?: number;
}

/** 解析候选的 embedding 列（JSON 字符串）为向量；非法返回 null */
function parseEmbedding(raw?: string | null): number[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * 对已通过元数据预过滤的候选，按语义余弦相似度降序排序。
 * 无向量的候选排末尾（按 fallbackScore 降序）。
 */
export function rankByCosine(
  candidates: RankCandidate[],
  queryEmbedding: number[]
): { id: string; score: number }[] {
  return candidates
    .map((c) => {
      const emb = parseEmbedding(c.embedding);
      const score = emb ? cosine(emb, queryEmbedding) : (c.fallbackScore ?? -1);
      return { id: c.id, score };
    })
    .sort((a, b) => b.score - a.score);
}
