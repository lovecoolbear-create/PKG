"use client";

import type { AiArtifact } from "@/components/work/AiArtifactsPanel";

/**
 * AI 结构化产出的分桶持久化。
 *
 * 与对话历史（`ai_chat:<key>`）使用同一套 bucket key，保证「对话 ↔ 产出」始终成对：
 * - 切走工作页：当前产出落回自己的桶，不会被下个工作页覆盖；
 * - 切回工作页：产出与对话一起恢复，右栏不再凭空变空；
 * - 「新建分析」这类明确重开的动作由调用方显式清空（写 null 即清桶）。
 *
 * bucket key 由 WorkbenchClient 的 bindKey 决定：`analyze:<品类>` / `vave:<项目id>` / `free`。
 */
const PREFIX = "ai_artifact:";

function bucketKey(bindKey: string | null): string {
  return `${PREFIX}${bindKey ?? "free"}`;
}

export function loadArtifact(bindKey: string | null): AiArtifact | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(bucketKey(bindKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AiArtifact;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      hints: Array.isArray(parsed.hints) ? parsed.hints : [],
      strategies: Array.isArray(parsed.strategies) ? parsed.strategies : [],
      effects: Array.isArray(parsed.effects) ? parsed.effects : [],
      results: Array.isArray(parsed.results) ? parsed.results : [],
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
      round: typeof parsed.round === "number" ? parsed.round : undefined,
      sourceLabel: typeof parsed.sourceLabel === "string" ? parsed.sourceLabel : undefined,
    };
  } catch {
    return null;
  }
}

/** 写 null 等价于清空该桶 */
export function saveArtifact(bindKey: string | null, artifact: AiArtifact | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!artifact) {
      localStorage.removeItem(bucketKey(bindKey));
      return;
    }
    localStorage.setItem(bucketKey(bindKey), JSON.stringify(artifact));
  } catch {
    /* 配额满或隐私模式：产出不持久化，不影响主流程 */
  }
}

export function clearAllArtifacts(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* 忽略 */
  }
}
