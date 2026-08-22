// ========== 入口三：AI 包装 SQE 专家诊断报告生成器 ==========
// System Prompt 设定为「20 年经验的 B2B 包装供应链与 SQE 质量管理专家」。
// 输入：计算引擎输出的全量 Cost Breakdown JSON。
// 输出：150-200 字专业诊断（起步价占比 / 批次规模效应 / 工艺性价比 / 降本建议）。
// 降级兜底：若无 API Key，回退到预设模板诊断段落（基于真实数据动态生成）。

import type { AnalysisReport } from "@/types";
import { chatCompletion, isLlmConfigured } from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";

export interface SqeDiagnosis {
  text: string;
  source: "llm" | "template";
  generatedAt: string;
}

const SYSTEM_PROMPT = `你是一名拥有 20 年经验的 B2B 包装供应链与 SQE（供应商质量管理）专家，长期服务快消、食品、电子行业的包装采购与质量团队。

现在拿到一份彩印纸盒的成本拆解明细（JSON），请用专业、简洁、可执行的中文，写一段 150-200 字的诊断报告。必须覆盖以下要点：
1. 起步价/制版等固定成本在总成本的占比与合理性；
2. 批次规模效应（当前数量下的单位成本是否处在最优区间）；
3. 工艺（表面处理/专色/盒型复杂度）的性价比评估；
4. 1-2 条具体、可落地的降本建议（优先 VAVE 视角）。

不要使用 Markdown 标题或列表符号，直接连续成段输出，语气专业、客观、有顾问感。`;

/** 提取简明成本摘要，避免把整份报告大对象塞给模型 */
function buildBrief(report: AnalysisReport): string {
  const dims = report.dimensions
    .map(
      (d) =>
        `${d.dimensionLabel}: ¥${d.estimatedAmount}（${d.ratio}%）${d.breakdown?.length ? " [" + d.breakdown.map((b) => `${b.label}¥${b.amount}`).join("、") + "]" : ""}`
    )
    .join("；");
  return JSON.stringify({
    productType: report.productTypeName,
    totalCost: report.totalCost,
    overallConfidence: report.overallConfidence,
    dimensions: dims,
    defaultAssumptions: (report.defaultAssumptions || []).map(
      (a) => `${a.label}=${a.assumedValue}`
    ),
  });
}

/** 无 API Key 时的模板诊断（基于真实数据动态生成，比例严谨） */
function templateDiagnosis(report: AnalysisReport): string {
  const process = report.dimensions.find((d) => d.dimension === "process");
  const material = report.dimensions.find((d) => d.dimension === "material");
  const design = report.dimensions.find((d) => d.dimension === "design_plate");
  const quantity = Math.round(
    (report.totalCost.min + report.totalCost.max) / 2 /
      ((report.totalCost.perUnit.min + report.totalCost.perUnit.max) / 2 || 1)
  );

  const processRatio = process?.ratio ?? 0;
  const materialRatio = material?.ratio ?? 0;
  const designAmt = design?.estimatedAmount ?? 0;

  const scaleTip =
    quantity < 5000
      ? `当前订单约 ${quantity} 个，处于小批量区间，开机/制版等固定成本分摊偏高，单位成本尚未进入最优规模区间；建议评估合并批次或提升至 1 万+ 以摊薄固定费用。`
      : `当前订单约 ${quantity} 个，规模效应已较充分，固定成本分摊合理；后续可通过年度框架协议进一步锁定材料单价。`;

  const processTip =
    processRatio > 25
      ? "工艺加工占比偏高，建议复核表面处理与专色是否必要，局部烫金或减色可显著降本。"
      : "工艺结构占比健康，性价比尚可。";

  const designTip =
    designAmt > 800
      ? `设计与制版约 ¥${designAmt}，若后期有翻单，首单后制版费可摊薄，建议建立稿件资产复用机制。`
      : "设计制版费用可控。";

  return `作为包装供应链与 SQE 视角，本方案材料占比约 ${materialRatio}%、工艺占比约 ${processRatio}%，整体结构基本合理（置信度 ${report.overallConfidence}%）。${scaleTip}${processTip}${designTip}综合建议优先从盒型简化、工艺必要性与批次规模三处切入做 VAVE 降本。`;
}

/** 生成 AI 包装 SQE 专家诊断 */
export async function generateSqeDiagnosis(
  report: AnalysisReport,
  aiSettings?: AiSettings
): Promise<SqeDiagnosis> {
  const generatedAt = new Date().toISOString();

  if (!isLlmConfigured(aiSettings)) {
    return {
      text: templateDiagnosis(report),
      source: "template",
      generatedAt,
    };
  }

  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `请基于以下成本拆解明细撰写诊断报告：\n${buildBrief(report)}`,
        },
      ],
      { temperature: 0.4, timeoutMs: 20000, settings: aiSettings }
    );
    const text = raw.trim();
    if (text.length >= 30) {
      return { text, source: "llm", generatedAt };
    }
  } catch {
    // 失败回退模板
  }
  return {
    text: templateDiagnosis(report),
    source: "template",
    generatedAt,
  };
}
