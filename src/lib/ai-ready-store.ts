"use client";

import { useSyncExternalStore } from "react";

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
  return useSyncExternalStore(aiReadyStore.subscribe, aiReadyStore.get);
}
