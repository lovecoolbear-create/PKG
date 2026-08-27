import { NextRequest, NextResponse } from "next/server";
import { pingModel, getEndpointForLoad } from "@/lib/llm/client";
import { isLocalBase } from "@/lib/config/ai-settings";
import type { AiSettings } from "@/lib/config/ai-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 载入页「连接并加载本地模型」：
 * 1) 本地兼容端点（LM Studio）best-effort 触发模型加载；
 * 2) 轮询 ping 直到模型就绪（最多约 25s）。
 * 非本地（云端）端点跳过加载，直接探测。
 */
async function tryLoadModel(baseUrl: string, model: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(`${baseUrl}/models/${encodeURIComponent(model)}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: ctrl.signal,
    }).catch(() => {});
  } catch {
    // 触发失败不阻塞：用户可在 LM Studio 中手动 Load
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = body.settings as AiSettings | undefined;
    if (!settings || !settings.provider) {
      return NextResponse.json(
        { ok: false, message: "缺少配置参数", stage: "config" },
        { status: 400 }
      );
    }
    if (settings.provider === "disabled") {
      return NextResponse.json({
        ok: false,
        message: "AI 已关闭，可离线使用",
        stage: "disabled",
        status: "disabled",
      });
    }

    const ep = getEndpointForLoad(settings);
    if (!ep) {
      return NextResponse.json(
        { ok: false, message: "配置不完整，请先填写地址或密钥", stage: "config" },
        { status: 400 }
      );
    }

    // 本地端点：best-effort 触发加载
    if (isLocalBase(ep.baseUrl)) {
      await tryLoadModel(ep.baseUrl, ep.model);
    }

    // 轮询等待就绪
    let lastMsg = "连接中…";
    for (let i = 0; i < 10; i++) {
      const r = await pingModel(settings);
      lastMsg = r.message;
      if (r.ok) {
        return NextResponse.json({
          ok: true,
          message: r.message,
          model: ep.model,
          stage: "ready",
          status: "online",
        });
      }
      await new Promise((res) => setTimeout(res, 2500));
    }

    return NextResponse.json({
      ok: false,
      message: `模型未在预期时间内就绪：${lastMsg}。若已配置，请到 LM Studio 点击 Load 后重试。`,
      stage: "timeout",
      status: "offline",
    });
  } catch {
    return NextResponse.json(
      { ok: false, message: "预热请求异常", stage: "error", status: "offline" },
      { status: 500 }
    );
  }
}
