import { NextRequest } from "next/server";
import { getProductConfig, getAllProductTypes } from "@/config/products";
import { detectProductType } from "@/lib/parse/column-map";
import * as dictStore from "@/lib/parse/dict-store";
import { runImportPipeline } from "@/lib/parse/import-shared";
import { extractQuoteTable, type ScanImage } from "@/lib/parse/scan-extract";
import type { AiSettings } from "@/lib/config/ai-settings";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 8;

/** 按文件头判断是否为 PDF（上传时 type 可能缺失/不准） */
function looksLikePdf(buf: Buffer): boolean {
  return buf.slice(0, 5).toString("latin1") === "%PDF-";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const forcedType = form.get("productType");
    const forcedTypeStr =
      typeof forcedType === "string" ? forcedType.trim() : "";
    const aiRaw = form.get("aiSettings");
    let aiSettings: AiSettings | null = null;
    if (aiRaw) {
      try {
        aiSettings = JSON.parse(String(aiRaw)) as AiSettings;
      } catch {
        aiSettings = null;
      }
    }

    if (!(file instanceof File)) {
      return Response.json({ ok: false, message: "未收到文件" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return Response.json(
        {
          ok: false,
          message: `文件过大（约 ${Math.round(file.size / 1024 / 1024)}MB），上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`,
        },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "";
    const images: ScanImage[] = [];

    // 1) PDF → 逐页渲染为 PNG；图片 → 直接转 dataUrl
    if (mime === "application/pdf" || looksLikePdf(buf)) {
      const pdfMod = await import("pdf-to-img");
      // pdf-to-img 为命名导出 `pdf`（非 default）
      const pdfFn = (pdfMod as unknown as { pdf: (input: Buffer, opts?: unknown) => Promise<AsyncIterable<Buffer> & { destroy: () => Promise<void> }> }).pdf;
      const doc = await pdfFn(buf, { scale: 2 });
      let n = 0;
      for await (const page of doc) {
        if (n >= MAX_PAGES) break;
        images.push({
          dataUrl: `data:image/png;base64,${page.toString("base64")}`,
          mime: "image/png",
        });
        n++;
      }
      await doc.destroy();
    } else if (mime.startsWith("image/")) {
      images.push({
        dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        mime,
      });
    } else {
      return Response.json(
        { ok: false, message: "仅支持 PDF / PNG / JPG 格式的报价文件" },
        { status: 400 }
      );
    }

    if (images.length === 0) {
      return Response.json(
        { ok: false, message: "未能从文件中解析出任何图像" },
        { status: 400 }
      );
    }

    // 2) 视觉抽取：图片/PDF 页 → 逐字表格矩阵（不归一化、不预映射）
    const extracted = await extractQuoteTable(images, aiSettings);
    if (extracted._error) {
      const message =
        extracted._error === "NO_VISION_MODEL"
          ? "未配置支持视觉的模型（如本地 LM Studio 的 qwen2.5-vl-3b）。请在右上角「AI 设置」中配置视觉模型后重试，或改用 xlsx 结构化报价上传。"
          : "视觉模型未能从图片/PDF 中抽取到报价表格，请确认文件清晰或改用 xlsx 上传。";
      return Response.json(
        { ok: false, code: extracted._error, message, extracted },
        { status: 200 }
      );
    }
    if (extracted.headers.length === 0) {
      return Response.json(
        {
          ok: false,
          code: "NO_TABLE",
          message: "未在图片/PDF 中识别到报价表格，请确认文件内容或改用 xlsx 上传。",
          extracted,
        },
        { status: 200 }
      );
    }

    // 3) 复用与 xlsx 导入完全相同的确定性后段（映射 + 词典捕获 + 成本引擎）
    const headers = extracted.headers;
    const dataMatrix = extracted.rows
      .map((r) => r.map((c) => (c == null ? "" : c)))
      .filter((r) => r.some((c) => String(c).trim() !== ""));

    if (dataMatrix.length > 500) {
      return Response.json(
        {
          ok: false,
          message: `数据行数 ${dataMatrix.length} 超过上限 500 行，请拆分上传`,
        },
        { status: 400 }
      );
    }

    let productType = forcedTypeStr || detectProductType(headers) || "";
    const config = getProductConfig(productType);
    if (!config) {
      const availableTypes = getAllProductTypes().map((c) => ({
        code: c.code,
        name: c.name,
      }));
      return Response.json(
        {
          ok: false,
          code: "UNKNOWN_PRODUCT_TYPE",
          message:
            "无法自动识别扫描件品类，请指定品类后重试。可用品类见 availableTypes。",
          availableTypes,
          extracted,
        },
        { status: 200 }
      );
    }

    const result = await runImportPipeline(
      productType,
      headers,
      dataMatrix as (string | number | undefined)[][],
      dictStore.loadOverrides()
    );

    return Response.json({ ok: true, ...result, extracted });
  } catch (e) {
    return Response.json(
      { ok: false, message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
