// ========== 统一 LLM 客户端（OpenAI 兼容） ==========
// 设计目标：以最小依赖（原生 fetch）接入任意 OpenAI 兼容大模型
// （OpenAI / DeepSeek / 通义千问 / 本地 vLLM 等），通过环境变量配置，
// 未配置 API Key 时所有上层 Agent 自动优雅回退到规则/模板实现。

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}

export interface ChatOptions {
  temperature?: number;
  /** 超时时间（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 最大重试次数，默认 1 */
  retries?: number;
}

/** 读取 LLM 配置；未配置 API Key 返回 null（上层应回退） */
export function getLlmConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    ),
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
  };
}

/** 是否已配置可用 LLM（供 UI 判断是否展示「AI 实时」标签） */
export function isLlmConfigured(): boolean {
  return !!process.env.LLM_API_KEY;
}

/**
 * 调用 Chat Completions（OpenAI 兼容）。
 * 失败（网络/超时/HTTP 错误）抛出 Error，由上层捕获并回退。
 */
export async function chatCompletion(
  messages: LlmMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const cfg = getLlmConfig();
  if (!cfg) throw new Error("LLM_NOT_CONFIGURED");

  const timeoutMs = opts.timeoutMs ?? 15000;
  const retries = opts.retries ?? 1;
  const temperature = opts.temperature ?? cfg.temperature;

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
          messages,
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
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content) throw new Error("LLM_EMPTY_RESPONSE");
      return content;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // 最后一次仍失败则退出
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM_UNKNOWN_ERROR");
}

/**
 * 从模型输出中稳健地提取 JSON 对象。
 * 兼容模型在 JSON 外包裹 ```json ``` 代码块或前后缀说明文字的情况。
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  // 优先尝试整体解析
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // 忽略
  }
  // 提取 ```json ... ``` 块
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim()) as Record<string, unknown>;
    } catch {
      // 忽略
    }
  }
  // 提取第一个 { 到最后一个 } 之间的内容
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
