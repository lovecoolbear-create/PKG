"use client";

import { useEffect, useCallback, useSyncExternalStore } from "react";
import {
  ensureDefaultAiSettings,
  isSettingsUsable,
  type AiSettings,
} from "@/lib/config/ai-settings";

export type AiReadyStatus =
  | "unknown"
  | "unconfigured"
  | "disabled"
  | "checking"
  | "online"
  | "offline";

export interface AiReadyState {
  status: AiReadyStatus;
  model: string;
  message: string;
  updatedAt: number;
}

const INITIAL: AiReadyState = {
  status: "unknown",
  model: "",
  message: "",
  updatedAt: 0,
};

let state: AiReadyState = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * 全局 AI 就绪状态 store（轻量、无第三方依赖）。
 * 载入页写、工作台顶栏状态灯读，统一来源，避免各页各自 ping。
 */
export const aiReadyStore = {
  get(): AiReadyState {
    return state;
  },
  set(patch: Partial<AiReadyState>): void {
    state = { ...state, ...patch, updatedAt: Date.now() };
    emit();
  },
  reset(): void {
    state = { ...INITIAL, updatedAt: Date.now() };
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useAiReady(): AiReadyState {
  return useSyncExternalStore(aiReadyStore.subscribe, aiReadyStore.get, () => INITIAL);
}

/**
 * 首屏自动探测 AI 服务可达性并写入全局状态灯：
 * - 挂载即探测（解决深链 /work 显示「状态未知」）；
 * - 首次进入自动落库本地 LM Studio 预设（ensureDefaultAiSettings）；
 * - 每 60s、窗口聚焦/可见时重探，状态始终最新。
 * 用轻量 /api/ai/status（仅探测服务可达，不强制加载模型）。
 */
export function useAiReadyProbe(): void {
  const probe = useCallback(async () => {
    let cfg: AiSettings;
    try {
      cfg = ensureDefaultAiSettings();
    } catch {
      return;
    }
    if (cfg.provider === "disabled") {
      aiReadyStore.set({ status: "disabled", message: "AI 已关闭，纯规则速算" });
      return;
    }
    if (!isSettingsUsable(cfg)) {
      aiReadyStore.set({ status: "unconfigured", message: "未配置 AI，可离线使用" });
      return;
    }
    aiReadyStore.set({ status: "checking", message: "正在检测 AI 服务…" });
    try {
      const res = await fetch("/api/ai/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: cfg }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: AiReadyStatus;
        message?: string;
      };
      const next: AiReadyStatus =
        data.status === "online" ||
        data.status === "offline" ||
        data.status === "unconfigured" ||
        data.status === "disabled"
          ? data.status
          : data.ok
            ? "online"
            : "offline";
      aiReadyStore.set({ status: next, message: data.message ?? "" });
    } catch {
      aiReadyStore.set({ status: "offline", message: "无法连接检测接口" });
    }
  }, []);

  useEffect(() => {
    probe();
    const t = setInterval(probe, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", probe);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", probe);
    };
  }, [probe]);
}
