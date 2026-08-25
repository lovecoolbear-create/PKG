// ========== P0 统一结构化 LLM 调用封装 ==========
// 收敛所有 AI 介入点的 prompt 与回退逻辑，落实「确定性锚 + 优雅回退」精神。
// 所有上层 AI 层（P1 表达 / P2 判定 / P3 排序）统一经此入口，避免散落调用 chatCompletion。
//
// 设计要点：
// - 未配置 LLM 或任意失败（超时 / HTTP 错误 / 返回非 JSON）一律返回调用方提供的 `fallback`，绝不抛出。
// - 调用方必须在 `fallback` 中给出确定性规则/模板结果，保证「无 AI 时功能照常可用」。
// - 满足 §3.1 两条守恒：AI 只消费结构化输入、只产出可回引擎验证的输出。

import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
  type LlmMessage,
} from "./client";
import type { AiSettings } from "@/lib/config/ai-settings";

export interface StructuredCallOptions {
  /** 系统提示：定义 AI 角色、输出契约（JSON 结构）、约束（不得编造数字） */
  system: string;
  /** 用户提示：注入结构化事实（来自确定性层） */
  user: string;
  /** 确定性回退：失败/未配置时返回；必须为调用方准备的「无需 LLM 的兜底结果」 */
  fallback: unknown;
  /** 运行时动态 AI 配置（前端配置中心）；不传则读服务端环境变量 */
  settings?: AiSettings | null;
  /** 采样温度，默认 0.2（偏确定性） */
  temperature?: number;
  /** 超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 多模态消息（如视觉解析），插入在 system 之后、user 之前 */
  extraMessages?: LlmMessage[];
}

/**
 * 统一结构化 LLM 调用入口。
 * @returns 解析后的 JSON 对象（由调用方断言为具体类型 T），或 fallback。
 */
export async function callStructuredLLM<T = Record<string, unknown>>(
  opts: StructuredCallOptions
): Promise<T> {
  // 确定性锚前置：未配置即走回退，不触网
  if (!isLlmConfigured(opts.settings)) {
    return opts.fallback as T;
  }
  const messages: LlmMessage[] = [
    { role: "system", content: opts.system },
    ...(opts.extraMessages ?? []),
    { role: "user", content: opts.user },
  ];
  try {
    const raw = await chatCompletion(messages, {
      temperature: opts.temperature ?? 0.2,
      timeoutMs: opts.timeoutMs ?? 15000,
      settings: opts.settings,
    });
    return extractJsonObject(raw) as T;
  } catch {
    // 任意失败（超时/HTTP错/非JSON）统一回退，保证上层确定性
    return opts.fallback as T;
  }
}
