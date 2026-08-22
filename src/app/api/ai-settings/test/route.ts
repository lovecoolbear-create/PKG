import { NextRequest, NextResponse } from "next/server";
import { pingModel } from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = body.settings as AiSettings | undefined;
    if (!settings || !settings.provider) {
      return NextResponse.json(
        { ok: false, message: "缺少配置参数" },
        { status: 400 }
      );
    }
    const result = await pingModel(settings);
    return NextResponse.json(result);
  } catch (error) {
    console.error("AI settings test error:", error);
    return NextResponse.json(
      { ok: false, message: "测试连接异常" },
      { status: 500 }
    );
  }
}
