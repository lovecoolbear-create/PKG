import { NextRequest, NextResponse } from "next/server";
import { parseNaturalLanguage } from "@/lib/agents/nlp-parser";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "请输入需求描述" }, { status: 400 });
    }

    const result = await parseNaturalLanguage(text);
    return NextResponse.json(result);
  } catch (error) {
    console.error("NLP parse error:", error);
    return NextResponse.json({ error: "解析失败" }, { status: 500 });
  }
}
