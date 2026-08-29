// ========== 统一 LLM 客户端（OpenAI 兼容 + Ollama 本地） ==========
// 设计目标：以最小依赖（原生 fetch）接入任意 OpenAI 兼容大模型
// 或本地 Ollama，支持运行时动态传入配置（前端可视化配置中心）。
// 配置优先级：传入的 aiSettings → 服务端环境变量 process.env。
// 当不可用（未配置 / disabled）时，所有上层 Agent 自动优雅回退到规则/模板实现。

import type { AiSettings } from "@/lib/config/ai-settings";
import { isLocalBase } from "@/lib/config/ai-settings";

/** 多模态消息内容片段（OpenAI 兼容 vision 格式） */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  /** 纯文本，或多模态片段数组（含 image_url 时用于视觉模型） */
  content: string | LlmContentPart[];
}

export type AiProvider = AiSettings["provider"];

interface ResolvedConfig {
  /** 已规范化到 /v1 的 base（不含 /chat/completions） */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  provider: AiProvider;
}

export interface ChatOptions {
  temperature?: number;
  /** 超时时间（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 最大重试次数，默认 1 */
  retries?: number;
  /** 运行时动态 AI 配置（来自前端配置中心）；不传则回退服务端环境变量 */
  settings?: AiSettings | null;
}

/** 规范化 baseUrl：去除尾斜杠并补 /v1（Ollama 与 OpenAI 兼容端点统一） */
function normalizeBaseUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, "");
  if (!u.endsWith("/v1")) u += "/v1";
  return u;
}

/**
 * 是否已配置可用 LLM。
 * @param settings 前端传入的动态配置；不传则读服务端 process.env.LLM_API_KEY。
 */
export function isLlmConfigured(settings?: AiSettings | null): boolean {
  if (settings) {
    if (settings.provider === "disabled") return false;
    if (settings.provider === "ollama") return !!settings.baseUrl?.trim();
    // openai-compatible：云端必须有密钥；本地兼容端点（LM Studio）允许空 key
    if (settings.provider === "openai-compatible") {
      if (isLocalBase(settings.baseUrl ?? "")) return true;
      return !!settings.apiKey?.trim();
    }
    return !!settings.apiKey?.trim();
  }
  return !!process.env.LLM_API_KEY;
}

/** 解析最终可用的配置；不可用时返回 null */
function resolveConfig(settings?: AiSettings | null): ResolvedConfig | null {
  if (settings) {
    if (settings.provider === "disabled") return null;
    if (settings.provider === "ollama") {
      const base = settings.baseUrl?.trim();
      if (!base) return null;
      return {
        baseUrl: normalizeBaseUrl(base),
        // Ollama 本地一般不校验密钥，占位即可
        apiKey: settings.apiKey?.trim() || "ollama",
        model: settings.modelName?.trim() || "qwen2.5",
        temperature: 0.2,
        provider: "ollama",
      };
    }
    const key = settings.apiKey?.trim();
    const base = settings.baseUrl?.trim() || "https://api.openai.com/v1";
    // 本地兼容端点（LM Studio）允许空 key，否则必须有密钥
    if (!key && !isLocalBase(base)) return null;
    return {
      baseUrl: normalizeBaseUrl(base),
      apiKey: key || "lm-studio",
      model: settings.modelName?.trim() || "gpt-4o-mini",
      temperature: 0.2,
      provider: "openai-compatible",
    };
  }

  // 回退：服务端环境变量（仅服务端进程可见）
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: normalizeBaseUrl(
      process.env.LLM_BASE_URL || "https://api.openai.com/v1"
    ),
    apiKey,
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
    provider: "openai-compatible",
  };
}

/**
 * 调用 Chat Completions（OpenAI 兼容 / Ollama /v1）。
 * 失败（网络/超时/HTTP 错误）抛出 Error，由上层捕获并回退。
 */
export async function chatCompletion(
  messages: LlmMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const cfg = resolveConfig(opts.settings);
  if (!cfg) throw new Error("LLM_NOT_CONFIGURED");

  // 本地端点（Ollama / LM Studio）首次加载慢，默认超时放长到 60s；云端保持 15s
  const timeoutMs =
    opts.timeoutMs ?? (isLocalBase(cfg.baseUrl) ? 60000 : 15000);
  const retries = opts.retries ?? 1;
  const temperature = opts.temperature ?? cfg.temperature;

  // 部分模型（如 Qwen3）默认倾向调用工具；统一加 system prompt 要求直接回答
  const systemInjected: LlmMessage[] =
    messages.length > 0 && messages[0].role === "system"
      ? messages
      : [
          {
            role: "system",
            content:
              "You are a helpful assistant. Answer the user's request directly and concisely. Do not use tools unless explicitly asked.",
          },
          ...messages,
        ];

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: systemInjected,
          temperature,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM_API_ERROR ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: {
          message?: {
            content?: string;
            // Qwen3 / DeepSeek-R1 等 reasoning 模型可能把回复放在 reasoning_content
            reasoning_content?: string;
          };
        }[];
      };
      const message = data.choices?.[0]?.message ?? {};
      const content = (message.content ?? message.reasoning_content ?? "").trim();
      if (!content) throw new Error("LLM_EMPTY_RESPONSE");
      return content;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM_UNKNOWN_ERROR");
}

/**
 * 测试连接：给指定模型发一条极小 ping 请求，返回成功/失败提示。
 * 供前端「测试连接」按钮与 /api/ai-settings/test 调用。
 */
export async function pingModel(
  settings: AiSettings
): Promise<{ ok: boolean; message: string }> {
  const cfg = resolveConfig(settings);
  if (!cfg) {
    return {
      ok: false,
      message:
        settings.provider === "disabled"
          ? "已关闭 AI，无需连接测试"
          : "配置不完整：请填写地址（Ollama）或密钥（云端 API）",
    };
  }
  try {
    const controller = new AbortController();
    // 本地端点首次生成可能较慢，延长 ping 超时
    const pingTimeoutMs = isLocalBase(cfg.baseUrl) ? 60000 : 12000;
    const timer = setTimeout(() => controller.abort(), pingTimeoutMs);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Reply directly without using tools.",
          },
          { role: "user", content: "ping" },
        ],
        max_tokens: 64,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        choices?: {
          message?: {
            content?: string;
            reasoning_content?: string;
          };
        }[];
      };
      const message = data.choices?.[0]?.message ?? {};
      const content = (message.content ?? message.reasoning_content ?? "").trim();
      if (content) {
        return {
          ok: true,
          message: `连接成功（${cfg.provider} · 模型 ${cfg.model}）`,
        };
      }
      return { ok: false, message: "模型返回为空，请确认模型名称是否正确" };
    }
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: `连接失败 HTTP ${res.status}：${text.slice(0, 200)}`,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = raw.includes("aborted")
      ? "连接被中断：请确认 LM Studio/Ollama 已启动且端口正确，或检查代理/VPN 是否拦截 localhost"
      : raw;
    return { ok: false, message: `连接异常：${msg}` };
  }
}

/**
 * 供「载入页」预热使用：返回规范化后的 baseUrl（含 /v1）与模型名，
 * 用于在本地端点（LM Studio）触发模型加载。配置不可用返回 null。
 */
export function getEndpointForLoad(
  settings?: AiSettings | null
): { baseUrl: string; model: string } | null {
  const cfg = resolveConfig(settings);
  if (!cfg) return null;
  return { baseUrl: cfg.baseUrl, model: cfg.model };
}

/**
 * 从模型输出中稳健地提取 JSON 对象。
 * 兼容模型在 JSON 外包裹 ```json ``` 代码块或前后缀说明文字的情况。
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // 忽略
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim()) as Record<string, unknown>;
    } catch {
      // 忽略
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // 忽略
    }
  }
  throw new Error("LLM_RESPONSE_NOT_JSON");
}
