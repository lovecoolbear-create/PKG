import { NextRequest, NextResponse } from "next/server";
import { chatCompletion } from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";
import type { LlmMessage } from "@/lib/llm/client";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      messages?: LlmMessage[];
      settings?: AiSettings | null;
    };
    const messages = body.messages ?? [];
    if (!messages.length) {
      return NextResponse.json(
        { ok: false, message: "消息为空" },
        { status: 400 }
      );
    }
    const text = await chatCompletion(messages, {
      settings: body.settings ?? null,
    });
    return NextResponse.json({ ok: true, text });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
