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
  /** 主模型名称（NLP 解析 / 文字类任务默认用此模型）：如 qwen3.8-27b / qwen2.5 / gpt-4o-mini */
  modelName: string;
  /** 视觉专用模型（选填）：扫描件/图纸解析优先用此模型。
   *  留空则复用 modelName。本机所有模型统一在 LM Studio 部署：NLP 用 qwen3.8-27b（27B），
   *  视觉建议单独下 qwen2.5-vl-3b（~2.5GB，冷载门槛低）填于此，与 27B 经 JIT 轮换、不双载不崩。 */
  visionModel?: string;
  /** 副驾驶/对话模型（选填）：AI 副驾驶聊天专用，留空则复用 modelName。
   *  为提速可填小模型（如 qwen2.5:14b / qwen2.5:7b），与 NLP 主模型(27B)分离——
   *  NLP 解析仍走 modelName 保质量，副驾驶走 chatModel 提速；注意 LM Studio JIT 单模型互斥，
   *  若需 27B(NLP) 与 14B(副驾驶) 并发，请关闭「Only Keep Last」双载。 */
  chatModel?: string;
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

/** 预设：本地 LM Studio（OpenAI 兼容 · 0 成本 / 离线）
 *  所有模型统一在此：NLP 主模型 qwen3.8-27b；视觉另下 qwen2.5-vl-3b 填到视觉模型栏。 */
export const LM_STUDIO_PRESET: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:1234",
  apiKey: "",
  modelName: "qwen/qwen3.8-27b",
  chatModel: "qwen2.5:14b",
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
      visionModel:
        typeof parsed.visionModel === "string" ? parsed.visionModel : "",
      chatModel:
        typeof parsed.chatModel === "string" ? parsed.chatModel : "",
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

/**
 * 首次进入时确保存在可用的本地默认配置：若 localStorage 无任何 AI 配置记录，
 * 自动落库「本地 LM Studio 预设」，做到开箱即用（NLP 主模型 qwen3.8-27b，副驾驶默认 qwen2.5:14b 提速；
 * 视觉回退主模型复用，因 qwen3.8 本身多模态）。已有记录（含用户显式关闭/自定义）
 * 则不覆盖，尊重用户选择。
 */
export function ensureDefaultAiSettings(): AiSettings {
  const existing = getAiSettings();
  if (existing) return existing;
  saveAiSettings(LM_STUDIO_PRESET);
  return LM_STUDIO_PRESET;
}

/**
 * 解析「视觉任务」实际使用的配置：优先 visionModel，否则回退 modelName。
 * 视觉调用方（扫描件抽取、图纸解析）用返回对象发起 LLM 请求即可，
 * 从而把视觉模型（如 qwen2.5vl）与文字模型（如 qwen3.8）分开，互不干扰。
 */
export function resolveVisionSettings(
  s: AiSettings | null | undefined
): AiSettings | null | undefined {
  if (!s) return s;
  if (s.visionModel && s.visionModel.trim()) {
    return { ...s, modelName: s.visionModel.trim() };
  }
  return s;
}

/**
 * 解析「副驾驶/对话任务」实际使用的配置：优先 chatModel，否则回退 modelName（主模型）。
 * 副驾驶调用方（/api/ai/chat）用返回对象发起请求，从而把副驾驶模型（如 qwen2.5:14b）
 * 与 NLP 主模型（qwen3.8-27b）分开，副驾驶提速不影响 NLP 解析质量。
 */
export function resolveChatSettings(
  s: AiSettings | null | undefined
): AiSettings | null | undefined {
  if (!s) return s;
  if (s.chatModel && s.chatModel.trim()) {
    return { ...s, modelName: s.chatModel.trim() };
  }
  return s;
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
