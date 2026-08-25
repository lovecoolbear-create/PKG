import { NextRequest, NextResponse } from "next/server";
import { parseDrawingImage, type DrawingImage } from "@/lib/agents/nlp-parser";
import type { AiSettings } from "@/lib/config/ai-settings";

// 图纸转 base64 经 JSON POST，Vercel 函数体硬限 4.5MB，预留安全余量
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "图纸数据过大（请减少页数或图片尺寸后再试）" },
        { status: 413 }
      );
    }
    const body = JSON.parse(raw) as {
      images?: unknown;
      aiSettings?: AiSettings;
      /** P4：确定性尺寸源（DXF/结构文本），优先于视觉 LLM 抽尺寸 */
      vectorText?: string;
    };
    const images = Array.isArray(body.images) ? body.images : [];
    const clean: DrawingImage[] = images
      .filter(
        (im: unknown) =>
          im &&
          typeof (im as DrawingImage).dataUrl === "string" &&
          (im as DrawingImage).dataUrl.startsWith("data:image/")
      )
      .map((im: DrawingImage) => ({
        dataUrl: im.dataUrl,
        mime: im.mime || "image/png",
      }));

    if (clean.length === 0 && !(body.vectorText && body.vectorText.trim())) {
      return NextResponse.json(
        { error: "未收到有效的图纸图片或 DXF/结构文本" },
        { status: 400 }
      );
    }
    // 限制单次最多 4 张，避免超大请求
    if (clean.length > 4) clean.length = 4;

    const result = await parseDrawingImage(clean, body.aiSettings, {
      deterministicSource:
        typeof body.vectorText === "string" && body.vectorText.trim()
          ? body.vectorText
          : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Drawing parse error:", error);
    return NextResponse.json({ error: "图纸解析失败" }, { status: 500 });
  }
}
