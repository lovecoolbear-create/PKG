// ========== P8 一致性闸门（Consistency Gate） ==========
// 目标：把 AI 输出锁死在确定性真相源上，防止「数字漂移 / 跨层矛盾 / 无审计」三类跑偏。
//
// 本模块设计铁律：
// - 不得静态引入 node:fs（ranker 经 structured 进入客户端打包图，静态 fs 会破坏 build）。
//   审计落盘统一在函数内用 `import(/* webpackIgnore: true */ "node:fs/promises")`
//   动态导入，并由 `typeof window === "undefined"` 守护，浏览器永不执行。
// - 不反向 import 任何 AI 层（llm-analyst / judge-explain / ranker / negotiation-agent），
//   一律使用结构类型（DataPointerLike / RoleReportLike ...），避免循环依赖。
// - 所有检测都是「只读 + 修正文本」，绝不改写引擎数字（数字守恒）。

import type { AiSettings } from "@/lib/config/ai-settings";

// ---------------------------------------------------------------------------
// 类型（结构化，避免循环 import）
// ---------------------------------------------------------------------------

/** 与 llm-analyst.DataPointer 结构兼容的最小形态 */
export interface DataPointerLike {
  fieldPath: string;
  label: string;
  value: string;
}

export type ConsistencySeverity = "info" | "warning" | "error";

/** 数字漂移发现：AI 文本中的数字与 Pointer 真实数字不一致 */
export interface DriftFinding {
  matched: string; // 原文片段，如 "¥6.50" 或 "30%"
  kind: "amount" | "percent";
  textValue: number;
  expectedValue?: number;
  expectedLabel?: string;
  deviationPct?: number;
  severity: ConsistencySeverity;
  message: string;
}

export type ConsistencyCode = "drift" | "contradiction" | "cross_layer";

/** 一致性告警（跨层矛盾 / 叙述冲突 / 漂移汇总） */
export interface ConsistencyWarning {
  layer: string;
  code: ConsistencyCode;
  message: string;
  severity: "warning" | "error";
}

export interface AuditEntry {
  ts: string;
  layer: string;
  source: "llm" | "template";
  model: string;
  inputSummary: string;
  engineKeyValues: Record<string, string | number>;
  outputText: string;
  warnings: ConsistencyWarning[];
}

// ---------------------------------------------------------------------------
// 1) 漂移检测：扫描 AI 文本中的金额/百分比，与 Pointer 真实数字比对
// ---------------------------------------------------------------------------

function parseAmount(value: string): number | null {
  const m = value.match(/¥\s?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parsePercent(value: string): number | null {
  const m = value.match(/([\d.]+)\s?%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

interface ExpectedNumbers {
  amounts: number[];
  percents: number[];
}

function collectExpected(pointers: DataPointerLike[]): ExpectedNumbers {
  const out: ExpectedNumbers = { amounts: [], percents: [] };
  for (const p of pointers) {
    const a = parseAmount(p.value);
    if (a !== null) out.amounts.push(a);
    const pc = parsePercent(p.value);
    if (pc !== null) out.percents.push(pc);
  }
  return out;
}

interface TextNumber {
  raw: string;
  kind: "amount" | "percent";
  value: number;
}

function extractTextNumbers(text: string): TextNumber[] {
  const out: TextNumber[] = [];
  const amtRe = /¥\s?([\d,]+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = amtRe.exec(text))) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push({ raw: m[0], kind: "amount", value: n });
  }
  const pctRe = /(\d+(?:\.\d+)?)\s?%/g;
  while ((m = pctRe.exec(text))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push({ raw: m[0], kind: "percent", value: n });
  }
  return out;
}

/** 金额容差：随数量级放大，避免小额（perUnit ¥6.21）因四舍五入误报 */
function amountTolerance(ref: number): number {
  const a = Math.abs(ref);
  if (a < 1) return 0.02;
  if (a < 10) return 0.15;
  if (a < 100) return 1;
  return Math.max(1, a * 0.02);
}

/**
 * 漂移检测核心。逐条比对文本数字与 Pointer 真实数字，超出容差即记为发现。
 * @returns 漂移发现列表（可能为空）
 */
export function detectNumberDrift(
  text: string,
  pointers: DataPointerLike[]
): DriftFinding[] {
  if (!text || pointers.length === 0) return [];
  const expected = collectExpected(pointers);
  const found: DriftFinding[] = [];
  const nums = extractTextNumbers(text);

  for (const tn of nums) {
    const pool = tn.kind === "amount" ? expected.amounts : expected.percents;
    if (pool.length === 0) continue;
    // 找最近基准
    let best = Infinity;
    let bestVal = NaN;
    for (const e of pool) {
      const d = Math.abs(e - tn.value);
      if (d < best) {
        best = d;
        bestVal = e;
      }
    }
    if (!Number.isFinite(bestVal)) continue;
    const tol = tn.kind === "amount" ? amountTolerance(bestVal) : 2.5;
    if (best <= tol) continue; // 在容差内，视为一致
    const dev = bestVal !== 0 ? (best / Math.abs(bestVal)) * 100 : 100;
    const severity: ConsistencySeverity =
      best > tol * 2.5 ? "error" : "warning";
    found.push({
      matched: tn.raw,
      kind: tn.kind,
      textValue: tn.value,
      expectedValue: bestVal,
      deviationPct: +dev.toFixed(1),
      severity,
      message: `AI 文本中的 ${tn.raw} 与引擎真实值 ${tn.kind === "amount" ? "¥" : ""}${bestVal}${tn.kind === "percent" ? "%" : ""} 偏差 ${dev.toFixed(1)}%，疑似数字漂移`,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 2) 叙述一致性：确定性判定 vs AI 自由文本（防「判定否决但文本说可行」）
// ---------------------------------------------------------------------------

// 注：「可行」用负向后顾 (?<!不) 排除「不可行」误命中；「推荐」覆盖软断言。
const SAFE_ASSERT =
  /(完全可行|无风险|没有问题|没问题|可接受|建议采用|推荐采用|推荐该方案|符合规范无问题|风险极低|完全合规|(?<!不)可行|推荐)/;

/**
 * 单条叙述与确定性结论对账。
 * @param deterministicVerdict 确定性结论：reject=硬性否决 / caution=需谨慎 / pass=可行
 * @param narrativeText AI 生成的叙述文本
 * @param correction 确定性结论的强制陈述（用于替换/附注）
 */
export function reconcileNarrative(opts: {
  deterministicVerdict: "reject" | "caution" | "pass";
  narrativeText: string;
  correction: string;
}): { text: string; hadConflict: boolean } {
  const t = opts.narrativeText || "";
  if (opts.deterministicVerdict === "reject" && SAFE_ASSERT.test(t)) {
    return { text: `（确定性结论：不可行）${opts.correction}`, hadConflict: true };
  }
  if (opts.deterministicVerdict === "caution" && /(完全可行|无风险|符合规范无问题)/.test(t)) {
    return {
      text: `${t}（注：存在需谨慎项——${opts.correction}）`,
      hadConflict: true,
    };
  }
  return { text: t, hadConflict: false };
}

/** judge-explain 原始结构（结构兼容，避免循环依赖） */
export interface RawJudgeFindingLike {
  type?: string;
  severity?: string;
  why?: string;
  fix?: string;
}
export interface RawJudgeLike {
  findings: RawJudgeFindingLike[];
  overview?: string;
}

/**
 * 判定层对账：若确定性 severity=error 但 AI 的 why 文本称「可行」，强制以确定性结论为准。
 */
export function reconcileJudge(
  raw: RawJudgeLike,
  issues: { type: string; severity: string }[]
): { raw: RawJudgeLike; warnings: ConsistencyWarning[] } {
  const errorTypes = new Set(
    issues.filter((i) => i.severity === "error").map((i) => i.type)
  );
  const warnings: ConsistencyWarning[] = [];
  const findings = (raw.findings || []).map((f, i) => {
    const issue = issues[i];
    const isError =
      (issue && issue.severity === "error") || (f.type && errorTypes.has(f.type));
    if (isError && SAFE_ASSERT.test(f.why || "")) {
      warnings.push({
        layer: "judge_explain",
        code: "contradiction",
        severity: "error",
        message: `判定项「${issue?.type || f.type}」确定性为 error（硬性冲突），但 AI 叙述称可行，已强制以确定性结论为准`,
      });
      return {
        ...f,
        why: `（确定性结论：该问题为硬性冲突，不可行）${(f.fix || "").trim()}`,
      };
    }
    return f;
  });
  return { raw: { ...raw, findings }, warnings };
}

/** ranker 原始结构（结构兼容） */
export interface RawRankLike {
  order: string[];
  reasons: Record<string, string>;
}

/**
 * 排序层对账：若某方案已被确定性硬约束否决（filterResults 标记 passed=false），
 * 但 AI 排序理由文本称「可行/推荐」，强制以否决理由替换。
 * @param filterResults 由 ranker 在调用前算好的 {passed, reason}
 */
export function reconcileRankerNarrative(
  raw: RawRankLike,
  filterResults: Record<string, { passed: boolean; reason?: string }>
): { raw: RawRankLike; warnings: ConsistencyWarning[] } {
  const warnings: ConsistencyWarning[] = [];
  const reasons: Record<string, string> = { ...(raw.reasons || {}) };
  for (const [id, fr] of Object.entries(filterResults)) {
    if (!fr.passed) {
      const r = reasons[id];
      if (r && SAFE_ASSERT.test(r)) {
        warnings.push({
          layer: "ranker",
          code: "contradiction",
          severity: "warning",
          message: `方案「${id}」已被硬约束否决（${fr.reason}），但 AI 排序理由称可行，已强制以否决为准`,
        });
        reasons[id] = fr.reason || "已被硬约束否决";
      }
    }
  }
  return { raw: { ...raw, reasons }, warnings };
}

/** 角色报告结构（结构兼容） */
export interface RoleReportLike {
  role: string;
  roleLabel: string;
  headline: string;
  points: string[];
}

/**
 * 跨层对账：判定层存在 error 级冲突时，若表达层（尤其客户/成本视角）宣称「无风险」，
 * 强制在叙述中标注「须以判定层确定性结论为准」，并产出跨层告警。
 */
export function reconcileCrossLayer(opts: {
  judgeHasError: boolean;
  roleReports: RoleReportLike[];
}): { reports: RoleReportLike[]; warnings: ConsistencyWarning[] } {
  const warnings: ConsistencyWarning[] = [];
  if (!opts.judgeHasError) {
    return { reports: opts.roleReports, warnings };
  }
  const reports = opts.roleReports.map((r) => {
    const isSensitive = r.role === "client" || r.role === "cost";
    const text = `${r.headline} ${r.points.join(" ")}`;
    if (
      isSensitive &&
      /(无风险|完全可行|符合规范无问题|风险可控)/.test(text) &&
      !/须|需|谨慎|验证|消除该冲突/.test(text)
    ) {
      warnings.push({
        layer: "cross_layer",
        code: "cross_layer",
        severity: "warning",
        message: `判定层存在 error 级冲突，但「${r.roleLabel}」叙述宣称无风险，已标注须以判定层为准`,
      });
      return {
        ...r,
        points: [
          ...r.points,
          "⚠ 注意：判定层已识别硬性冲突（error），上述「风险可控」表述须以判定层确定性结论为准，落地前须先消除该冲突。",
        ],
      };
    }
    return r;
  });
  return { reports, warnings };
}

// ---------------------------------------------------------------------------
// 3) 审计日志（内存环形 + 服务端落盘）
// ---------------------------------------------------------------------------

const mem: AuditEntry[] = [];

export function modelLabel(settings?: AiSettings | null): string {
  if (settings?.modelName) return `${settings.provider}:${settings.modelName}`;
  if (typeof process !== "undefined" && process.env?.LLM_MODEL) {
    return `env:${process.env.LLM_MODEL}`;
  }
  return "unknown";
}

function summarize(text: string): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > 800 ? t.slice(0, 800) + "…" : t;
}

/** 审计落盘路径（仅服务端） */
function logPath(): string {
  const cwd = typeof process !== "undefined" && process.cwd ? process.cwd() : ".";
  return `${cwd}/logs/ai-audit.jsonl`;
}

/**
 * 记录一次 AI 调用。浏览器环境只留内存；服务端追加到 logs/ai-audit.jsonl。
 * 任何异常都被吞掉，绝不影响主流程。
 */
export function auditLLMCall(entry: AuditEntry): void {
  mem.push(entry);
  if (mem.length > 500) mem.shift();
  if (typeof window !== "undefined") return; // 浏览器：仅内存，避免触碰 node:fs
  void persist(entry);
}

async function persist(e: AuditEntry): Promise<void> {
  try {
    const fs = await import(/* webpackIgnore: true */ "node:fs/promises");
    const p = logPath();
    const dir = p.slice(0, p.lastIndexOf("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(p, JSON.stringify(e) + "\n", "utf8");
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 读取最近审计日志（内存态，调试/自测用） */
export function listAuditLog(limit = 200): AuditEntry[] {
  return mem.slice(-limit);
}

// ---------------------------------------------------------------------------
// 4) 统一返回管道：runGated（所有 AI 层统一经此出口，自动审计）
// ---------------------------------------------------------------------------

import { callStructuredLLM, type StructuredCallOptions } from "@/lib/llm/structured";

export interface GatedCallOptions extends Omit<StructuredCallOptions, "fallback"> {
  /** 调用所属层（用于审计分层） */
  layer: string;
  /** 引擎关键数字快照（确定性来源，用于审计可追溯） */
  engineKV?: Record<string, string | number>;
  /** 可选：调用后叙述一致性修正（返回修正后 raw + 告警） */
  reconcile?: (raw: unknown) => { raw: unknown; warnings: ConsistencyWarning[] };
}

/**
 * 统一 AI 调用管道：callStructuredLLM → 可选叙述对账 → 审计落盘。
 * 返回 { result, warnings }，warnings 为叙述对账产出的告警（供层函数挂到结果对象）。
 */
export async function runGated<T>(
  opts: GatedCallOptions & { fallback: T }
): Promise<{ result: T; warnings: ConsistencyWarning[] }> {
  const result = await callStructuredLLM<T>({
    ...opts,
    fallback: opts.fallback,
  });
  const usedFallback = result === opts.fallback;
  const source: "llm" | "template" = usedFallback ? "template" : "llm";

  let raw: unknown = result;
  let warnings: ConsistencyWarning[] = [];
  if (opts.reconcile && !usedFallback) {
    const r = opts.reconcile(raw);
    raw = r.raw;
    warnings = r.warnings;
  }

  auditLLMCall({
    ts: new Date().toISOString(),
    layer: opts.layer,
    source,
    model: modelLabel(opts.settings),
    inputSummary: summarize(
      `${opts.system}\n---\n${typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user)}`
    ),
    engineKeyValues: opts.engineKV ?? {},
    outputText: JSON.stringify(raw),
    warnings,
  });

  return { result: raw as T, warnings };
}

/** 把漂移发现转换为一致性告警（供聚合进 AnalysisReport.consistencyWarnings） */
export function driftToWarnings(
  drift: DriftFinding[],
  layer: string
): ConsistencyWarning[] {
  return drift.map((d) => ({
    layer,
    code: "drift",
    severity: d.severity === "error" ? "error" : "warning",
    message: d.message,
  }));
}
