// ========== P7 知识沉淀闸门（人工审核防污染） ==========
// 硬约束 B：AI 只拥有「提案权」，无「写入权」。
// - AI 反推的规则 → addPendingRules 进入「待审核规则池（pending）」。
// - 仅当人类（SQE/工程师）在 UI 点击「确认固化」→ confirmPendingRule（确定性写入）才转入 kb-overrides。
// - AI 代码路径中绝不调用 confirmPendingRule；该写入动作只能由人工交互触发。

import type { PendingRule, PendingRuleTarget } from "./knowledge-distill";

const PENDING_KEY = "vave_pending_rules";
const OVERRIDE_KEY = "vave_kb_overrides";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export interface KbOverride {
  id: string;
  title: string;
  target: PendingRuleTarget;
  description: string;
  proposedValue: string;
  /** 源自哪条待审核规则 */
  fromRuleId: string;
  confirmedAt: string;
}

function read<T>(key: string): T[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  if (!isBrowser()) return;
  localStorage.setItem(key, JSON.stringify(value));
}

/** 列出待审核规则池（AI 提案，未固化） */
export function listPendingRules(): PendingRule[] {
  return read<PendingRule>(PENDING_KEY).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** AI 写入待审核池（唯一允许 AI 触发的存储动作） */
export function addPendingRules(rules: PendingRule[]): void {
  const all = listPendingRules();
  all.push(...rules);
  write(PENDING_KEY, all);
}

/** 人工确认固化 → 确定性写入 KB override（AI 无此权限） */
export function confirmPendingRule(id: string): KbOverride | null {
  const all = listPendingRules();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const rule = all[idx];
  rule.status = "confirmed";
  write(PENDING_KEY, all);

  const override: KbOverride = {
    id: `kb_${rule.id}`,
    title: rule.title,
    target: rule.target,
    description: rule.description,
    proposedValue: rule.proposedValue,
    fromRuleId: rule.id,
    confirmedAt: new Date().toISOString(),
  };
  const overrides = read<KbOverride>(OVERRIDE_KEY);
  overrides.push(override);
  write(OVERRIDE_KEY, overrides);
  return override;
}

/** 人工拒审（仅本地标记，不写入 KB） */
export function rejectPendingRule(id: string): void {
  const all = listPendingRules();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return;
  all[idx].status = "rejected";
  write(PENDING_KEY, all);
}

/** 列出已固化的 KB override（人工确认产物，确定性来源） */
export function listKbOverrides(): KbOverride[] {
  return read<KbOverride>(OVERRIDE_KEY).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
}
