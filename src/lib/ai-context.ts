// 全局 AI 信息源：各业务页（成本分析 / VAVE）激活时注册「当前可对话源」，
// 全局 AI 抽屉读取「当前激活信息源」作为 LLM 上下文，避免裸调大模型乱说。
// scope 字段为 P2「多源可选」预留（届时按 scope 列出已注册源供用户勾选）。

import type { AnalysisInput, AnalysisReport } from "@/types";

export type InfoSourceScope = "analyze" | "vave";

export interface InfoSource {
  scope: InfoSourceScope;
  /** 展示标签，如 "成本分析 · 彩盒" / "VAVE · 彩盒" */
  source: string;
  /** 已预格式化为 LLM 可读文本的上下文 */
  contextText: string;
  updatedAt: number;
}

const KEY = "activeAiContext";

export function writeInfoSource(src: InfoSource): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(src));
  } catch {
    // localStorage 不可用时静默
  }
}

export function readInfoSource(): InfoSource | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as InfoSource) : null;
  } catch {
    return null;
  }
}

export function clearInfoSource(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
}

/**
 * 把标准 AnalysisReport + AnalysisInput 统一格式化为 LLM 可读文本。
 * analyze 与 VAVE 共用，避免两套字段名（dimensionLabel/estimatedAmount vs name/amount）出错。
 */
export function formatReportContext(
  report: AnalysisReport,
  input?: AnalysisInput
): string {
  const lines: string[] = [];
  lines.push(`产品类型：${report.productTypeName}`);

  if (input && typeof input.quantity === "number") {
    lines.push(`数量：${input.quantity} 个`);
  }

  if (input) {
    const i = input as Record<string, unknown>;
    const parts: string[] = [];
    if (i.material) parts.push(`材质=${i.material}`);
    if (i.length && i.width && i.height)
      parts.push(`尺寸=${i.length}×${i.width}×${i.height}mm`);
    else if (i.length && i.width) parts.push(`尺寸=${i.length}×${i.width}mm`);
    if (i.printColors) parts.push(`印刷色数=${i.printColors}`);
    if (i.quantity) parts.push(`数量=${i.quantity}`);
    if (i.laborRegion) parts.push(`人工地域=${i.laborRegion}`);
    if (parts.length) lines.push(`输入参数：${parts.join("；")}`);
  }

  const tc = report.totalCost;
  lines.push(
    `成本估算：总成本 ¥${tc.min} ~ ${tc.max}` +
      (tc.perUnit
        ? `（单只/件 ¥${tc.perUnit.min} ~ ${tc.perUnit.max}）`
        : "") +
      ` · 整体置信度 ${report.overallConfidence}%`
  );

  if (report.dimensions?.length) {
    lines.push("成本维度拆分：");
    for (const d of report.dimensions) {
      lines.push(
        `  - ${d.dimensionLabel}：¥${d.estimatedAmount}` +
          (d.ratio != null ? `（占比 ${(d.ratio * 100).toFixed(1)}%）` : "")
      );
    }
  }

  if (report.optimizationHints?.length) {
    lines.push("优化建议：");
    for (const h of report.optimizationHints)
      lines.push(`  - ${h.title}${h.summary ? "：" + h.summary : ""}`);
  }

  if (report.sqeDiagnosis?.text) lines.push(`SQE 诊断：${report.sqeDiagnosis.text}`);

  return lines.join("\n");
}
