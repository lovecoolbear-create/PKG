import { NextRequest, NextResponse } from "next/server";
import { parseNaturalLanguage } from "@/lib/agents/nlp-parser";
import { getProductConfig } from "@/config/products";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "请输入需求描述" }, { status: 400 });
    }

    // 品类感知（2026-08-30）：前端已知当前品类，传给解析器以便校验枚举合法性、
    // 按品类取默认值，避免把彩盒口径（350g/tuck_end/E_flute）塞进瓦楞/平印/标签。
    const config =
      typeof body.productType === "string" && body.productType
        ? (getProductConfig(body.productType) ?? undefined)
        : undefined;

    const result = await parseNaturalLanguage(text, body.aiSettings, config);
    return NextResponse.json(result);
  } catch (error) {
    console.error("NLP parse error:", error);
    return NextResponse.json({ error: "解析失败" }, { status: 500 });
  }
}
