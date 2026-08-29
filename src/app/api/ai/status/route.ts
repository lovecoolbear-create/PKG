import { NextRequest, NextResponse } from "next/server";
import type { AiSettings } from "@/lib/config/ai-settings";

/**
 * 轻量 AI 服务可达性检测：仅 GET /v1/models（或 Ollama /api/tags）确认服务在跑，
 * 不发起 chat/completions，因此不会强制加载大模型——避免本机 24G 双模型争显存被 guardrail 拒载。
 * 状态灯用此接口拿「服务可达」即可，真正加载由用户发起对话时惰性触发。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      settings?: AiSettings | null;
    };
    const settings = body.settings;
    if (!settings || !settings.provider) {
      return NextResponse.json({
        ok: false,
        status: "unconfigured",
        message: "未配置 AI，可离线使用",
      });
    }
    if (settings.provider === "disabled") {
      return NextResponse.json({
        ok: false,
        status: "disabled",
        message: "AI 已关闭，纯规则速算",
      });
    }
    const base = settings.baseUrl.trim().replace(/\/+$/, "");
    const modelsUrl =
      settings.provider === "ollama" ? `${base}/api/tags` : `${base}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(modelsUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });
      clearTimeout(timer);
      // 401/403 也代表服务在跑（鉴权层有响应），视为可达
      if (res.ok || res.status === 401 || res.status === 403) {
        return NextResponse.json({
          ok: true,
          status: "online",
          message: "AI 服务可达（本地 LM Studio）",
        });
      }
      return NextResponse.json({
        ok: false,
        status: "offline",
        message: `AI 服务返回 HTTP ${res.status}`,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json({
        ok: false,
        status: "offline",
        message: "无法连接 AI 服务，请确认 LM Studio 已启动",
      });
    }
  } catch {
    return NextResponse.json({
      ok: false,
      status: "offline",
      message: "状态检测异常",
    });
  }
}
