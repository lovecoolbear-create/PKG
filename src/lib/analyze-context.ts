// 当前成本分析上下文：analyze 页写入，全局 AI 抽屉读取作为信息源。
// 目的：让全局 AI 对话基于「用户当前这份分析」发挥，而不是凭空编造。

export interface AnalyzeContextReportLite {
  totalCost?: { min: number; max: number; perUnit?: { min: number; max: number } };
  dimensions?: { name: string; amount: number; ratio?: number }[];
  optimizationHints?: { title: string; summary?: string }[];
  sqeDiagnosis?: { text: string };
}

export interface AnalyzeContext {
  source: string;
  productTypeName?: string;
  quantity?: number;
  input?: Record<string, unknown>;
  report?: AnalyzeContextReportLite;
  updatedAt: number;
}

const KEY = "currentAnalyzeContext";

export function writeAnalyzeContext(ctx: AnalyzeContext): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ctx));
  } catch {
    // localStorage 不可用时静默
  }
}

export function readAnalyzeContext(): AnalyzeContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AnalyzeContext) : null;
  } catch {
    return null;
  }
}

export function clearAnalyzeContext(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
}

/** 把上下文格式化为 LLM 可读文本 */
export function formatAnalyzeContext(ctx: AnalyzeContext): string {
  const lines: string[] = [];
  lines.push(`来源：${ctx.source}`);
  if (ctx.productTypeName) lines.push(`产品类型：${ctx.productTypeName}`);
  if (ctx.quantity) lines.push(`数量：${ctx.quantity} 个`);

  if (ctx.input) {
    const i = ctx.input as Record<string, unknown>;
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

  if (ctx.report) {
    const r = ctx.report;
    if (r.totalCost) {
      const pu = r.totalCost.perUnit;
      lines.push(
        `总成本估算：¥${r.totalCost.min} ~ ${r.totalCost.max}` +
          (pu ? `（单只 ¥${pu.min} ~ ${pu.max}）` : "")
      );
    }
    if (r.dimensions && r.dimensions.length) {
      lines.push("成本维度拆分：");
      for (const d of r.dimensions) {
        lines.push(
          `  - ${d.name}：¥${d.amount}` +
            (d.ratio != null ? `（占比 ${(d.ratio * 100).toFixed(1)}%）` : "")
        );
      }
    }
    if (r.optimizationHints && r.optimizationHints.length) {
      lines.push("优化建议：");
      for (const h of r.optimizationHints)
        lines.push(`  - ${h.title}${h.summary ? "：" + h.summary : ""}`);
    }
    if (r.sqeDiagnosis?.text) lines.push(`SQE 诊断：${r.sqeDiagnosis.text}`);
  }

  return lines.join("\n");
}
