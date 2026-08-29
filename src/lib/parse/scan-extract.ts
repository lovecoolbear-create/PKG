// ========== 扫描件/图片报价 → 视觉抽取成表格矩阵 ==========
// 仅做「OCR + 版面还原」：把图片/PDF 页抽成 { headers, rows } 的逐字矩阵，
// 不归一化、不翻译、不预映射。后续映射与词典学习仍由确定性层 mapCustomerSheet 负责，
// 与 xlsx 结构化导入保持同一口径（单一真相源）。无视觉模型时优雅回退并标记原因。

import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
  type LlmContentPart,
} from "@/lib/llm/client";
import { type AiSettings, resolveVisionSettings } from "@/lib/config/ai-settings";

/** 单张图（PDF 已渲染为 PNG dataUrl） */
export interface ScanImage {
  dataUrl: string;
  mime: string;
}

/** 视觉模型抽出的报价表（逐字保留，未归一化） */
export interface ExtractedTable {
  headers: string[];
  rows: string[][];
  /** 回退/失败原因：NO_IMAGE / NO_VISION_MODEL / EXTRACT_FAILED */
  _error?: string;
}

const SYSTEM_PROMPT = `你是一名严谨的包装供应商报价单表格抽取专家。任务：把图片（扫描件或照片）中的产品报价明细表，原样还原为一个二维表格。

严格要求：
1. 只输出一个 JSON 对象，结构为 {"headers": string[], "rows": string[][]}，不得包含任何解释性文字或 Markdown 代码块包裹。
2. headers 为表头行，按从左到右顺序；rows 为数据行，每行与 headers 列数对齐。
3. 表头文字与每个单元格的值必须逐字保留图片中的原文（含中文、单位、料号、规格代号、数字），不要翻译、不要归一化、不要猜测补全。空单元格用空字符串 ""。
4. 若报价单有多页，合并为一张表：以第一页的表头为准，依次追加各页数据行。
5. 若图片中看不到任何报价表格，返回 {"headers":[],"rows":[]}。`;

/**
 * 让视觉模型把报价图片抽成表格矩阵。
 * 未配置视觉模型 / 任意失败 → 返回带 _error 标记的空表（由路由转成清晰提示，不抛错）。
 */
export async function extractQuoteTable(
  images: ScanImage[],
  aiSettings?: AiSettings | null
): Promise<ExtractedTable> {
  if (!images || images.length === 0) {
    return { headers: [], rows: [], _error: "NO_IMAGE" };
  }
  // 视觉任务优先用独立视觉模型（visionModel），否则回退主模型
  const visionSettings = resolveVisionSettings(aiSettings);
  if (!isLlmConfigured(visionSettings) || visionSettings?.provider === "disabled") {
    return { headers: [], rows: [], _error: "NO_VISION_MODEL" };
  }

  const content: LlmContentPart[] = [
    {
      type: "text",
      text: "请从以下图片中抽取供应商报价单的产品明细表，严格按系统指令输出 JSON。",
    },
    ...images.map((im) => ({
      type: "image_url" as const,
      image_url: { url: im.dataUrl },
    })),
  ];

  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      { temperature: 0.1, timeoutMs: 90000, settings: visionSettings }
    );
    const obj = extractJsonObject(raw);
    const headers = Array.isArray(obj.headers)
      ? obj.headers.map((h) => String(h ?? "").trim()).filter(Boolean)
      : [];
    const rows = Array.isArray(obj.rows)
      ? obj.rows.map((r) =>
          Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))) : []
        )
      : [];
    return { headers, rows };
  } catch {
    // 视觉解析失败（超时/HTTP错/非JSON）统一回退，绝不抛出
    return { headers: [], rows: [], _error: "EXTRACT_FAILED" };
  }
}
