// ========== P2 判定解释层 ==========
// 消费 orchestrator/reviewer 产出的结构化校验证据（ValidationIssue），
// 由 AI 生成「为什么重要 + 可操作修复建议」的专业叙述。
//
// 铁律落地：
// - 触发条件与严重度（severity/type）一律来自确定性规则，AI 绝不重判。
// - AI 只消费结构化证据做「说法」表达（事实守恒），不编造数字。
// - 可溯源：explanation 与确定性 issue 一一对应，前端可并排展示原始校验。

import type { AnalysisReport, ValidationIssue } from "@/types";
import {
  runGated,
  reconcileJudge,
  type ConsistencyWarning,
} from "@/lib/agents/consistency-gate";
import { MATERIAL_PRICES_META } from "@/lib/cost-rules";
import { getBenchmarkContextNote } from "@/lib/material-prices/context-layer";
import type { AiSettings } from "@/lib/config/ai-settings";

/** 单条校验发现的专业解释（severity/type 来自确定性层） */
export interface JudgeFinding {
  type: ValidationIssue["type"];
  severity: "warning" | "error";
  /** AI 或模板生成的「为什么重要」解释 */
  why: string;
  /** 修复建议（来自确定性 suggestion 或 AI 展开） */
  fix: string;
  source: "llm" | "template";
}

export interface JudgeExplanation {
  findings: JudgeFinding[];
  /** 总体风险概述 */
  overview: string;
  source: "llm" | "template";
  asOf: string;
  /** P8 一致性闸门：叙述与确定性判定冲突的告警 */
  consistencyWarnings?: ConsistencyWarning[];
}

/** 模型原始输出：仅 why/fix，severity/type 由确定性层回填 */
interface RawJudge {
  overview: string;
  findings: { why: string; fix: string }[];
}

const SYSTEM_PROMPT = `你是一名资深包装 SQE 与成本审计专家。下面是一份成本报告的结构化校验发现，由确定性规则产出。
铁律（不可违反）：
- 不得修改任何发现的 severity 或 type；不得编造金额、占比、工期等任何数字。
- 你的职责是：对每条发现写「为什么重要」（why，专业、客观）与「可操作修复建议」（fix），并给一句话 overview 总结整体风险。
- 输出严格 JSON（不要多余文字）：{"overview":"...","findings":[{"why":"...","fix":"..."}]}，findings 顺序与输入一一对应。
语气：给采购与质量团队可执行的建议，简洁、有顾问感。`;

/** 确定性模板解释（无 LLM 兜底，仍基于真实 issue 证据） */
function templateJudge(issues: ValidationIssue[]): RawJudge {
  if (issues.length === 0) {
    return { overview: "校验通过：未发现冲突或占比越界，成本结构自洽。", findings: [] };
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.length - errors;
  return {
    overview: `共 ${issues.length} 项校验提示（${errors} 错误 / ${warns} 警告），${errors > 0 ? "存在需优先处理的硬冲突" : "均为可优化的软提示"}。`,
    findings: issues.map((i) => ({
      why: i.message,
      fix: i.suggestion ?? "请核对输入参数后重新计算。",
    })),
  };
}

/** 把原始解释（LLM 或模板）与确定性 issue 合并，回填 severity/type */
function finalize(
  raw: RawJudge,
  issues: ValidationIssue[],
  source: "llm" | "template",
  warnings: ConsistencyWarning[] = []
): JudgeExplanation {
  const findings: JudgeFinding[] = issues.map((issue, i) => {
    const r = raw.findings[i] ?? {};
    return {
      type: issue.type,
      severity: issue.severity,
      why: r.why?.trim() || issue.message,
      fix: r.fix?.trim() || issue.suggestion || "请核对输入参数后重新计算。",
      source,
    };
  });
  return {
    findings,
    overview: raw.overview,
    source,
    asOf: MATERIAL_PRICES_META.asOf,
    consistencyWarnings: warnings.length ? warnings : undefined,
  };
}

/**
 * 生成判定解释（P2 核心）。
 * 确定性校验证据 → AI 专业叙述；失败/未配置时返回确定性模板（基于真实 issue）。
 * 经 runGated 统一管道；reconcile 拦截「确定性 error 但 AI 称可行」的冲突。
 */
export async function generateJudgeExplanation(
  report: AnalysisReport,
  aiSettings?: AiSettings
): Promise<JudgeExplanation> {
  const issues = report.validationIssues ?? [];
  const fallback = templateJudge(issues);
  const user = `请基于以下结构化校验发现，生成专业解释（findings 与输入顺序一一对应）：\n${JSON.stringify(
    issues
  )}\n\n时效背景：${getBenchmarkContextNote()}`;

  const issueRefs = issues.map((i) => ({ type: i.type, severity: i.severity }));

  const { result, warnings } = await runGated<RawJudge>({
    layer: "judge_explain",
    system: SYSTEM_PROMPT,
    user,
    fallback,
    settings: aiSettings,
    temperature: 0.2,
    timeoutMs: 20000,
    engineKV: { issueCount: issues.length },
    reconcile: (raw) => reconcileJudge(raw as RawJudge, issueRefs),
  });

  return finalize(
    result,
    issues,
    result === fallback ? "template" : "llm",
    warnings
  );
}
