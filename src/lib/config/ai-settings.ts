// ========== AI 模型配置中心（前端可视化配置） ==========
// 配置优先读取浏览器 localStorage；无则视为「未配置」返回 null（由后端回退服务端环境变量）。
// 该模块同时被前端（UI 读写 localStorage）与类型共享使用。

export type AiProvider = "ollama" | "openai-compatible" | "disabled";

export interface AiSettings {
  /** 模型提供方：ollama=本地大模型 / openai-compatible=云端兼容接口 / disabled=关闭 AI（纯规则速算） */
  provider: AiProvider;
  /** API 请求地址：Ollama 默认 http://localhost:11434；云端可填 https://api.openai.com/v1 */
  baseUrl: string;
  /** 密钥（Ollama 本地一般留空；云端必需） */
  apiKey: string;
  /** 模型名称：如 qwen2.5 / gemma2 / deepseek-chat / gpt-4o-mini */
  modelName: string;
}

/** 预设：本地 Ollama（0 成本 / 离线） */
export const OLLAMA_PRESET: AiSettings = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  apiKey: "",
  modelName: "qwen2.5",
};

/** 预设：云端 OpenAI 兼容 API */
export const OPENAI_PRESET: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  modelName: "gpt-4o-mini",
};

/** 预设：关闭 AI（纯规则速算） */
export const DISABLED_PRESET: AiSettings = {
  provider: "disabled",
  baseUrl: "",
  apiKey: "",
  modelName: "",
};

/** 预设：本地 LM Studio（OpenAI 兼容 · 0 成本 / 离线） */
export const LM_STUDIO_PRESET: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:1234",
  apiKey: "",
  modelName: "",
};

/** 判断是否为本地兼容端点（localhost / 127.0.0.1），此类端点通常不校验密钥 */
export function isLocalBase(base: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base.trim());
}

const STORAGE_KEY = "ai_settings";

/**
 * 读取当前 AI 配置。
 * - 浏览器端：优先读 localStorage；无存储记录返回 null（交由服务端回退环境变量）。
 * - 服务端（SSR）：返回 null。
 */
export function getAiSettings(): AiSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    if (!parsed || typeof parsed !== "object" || !parsed.provider) return null;
    return {
      provider: parsed.provider,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      modelName: typeof parsed.modelName === "string" ? parsed.modelName : "",
    };
  } catch {
    return null;
  }
}

/** 持久化配置到 localStorage */
export function saveAiSettings(settings: AiSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** 清除已保存配置（恢复为「未配置」，走服务端 env 回退） */
export function clearAiSettings(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/** 判断某份配置是否「可用于发起 LLM 请求」（disabled / 缺地址 / 缺 key 均视为不可用） */
export function isSettingsUsable(s: AiSettings | null | undefined): boolean {
  if (!s) return false;
  if (s.provider === "disabled") return false;
  if (s.provider === "ollama") return !!s.baseUrl.trim();
  if (s.provider === "openai-compatible") {
    // 本地兼容端点（LM Studio 等）通常不校验密钥，允许空 key
    if (isLocalBase(s.baseUrl)) return true;
    return !!s.apiKey.trim();
  }
  return false;
}
