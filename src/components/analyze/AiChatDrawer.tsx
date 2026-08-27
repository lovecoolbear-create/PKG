"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare, X, Send, Settings as SettingsIcon, Paperclip, RefreshCw, Unlink } from "lucide-react";
import {
  getAiSettings,
  isSettingsUsable,
  type AiSettings,
} from "@/lib/config/ai-settings";
import {
  readAnalyzeContext,
  clearAnalyzeContext,
  formatAnalyzeContext,
  type AnalyzeContext,
} from "@/lib/analyze-context";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT =
  "你是「包装降本分析工作台」的 AI 助手，专注纸/塑/木缓冲包装的成本估算与 VAVE 降本。用中文、简洁、专业地回答用户关于当前页面（成本分析报告 / 报价单 / VAVE 方案）的问题。涉及具体金额必须基于用户提供的信息，绝不编造数字。可主动给出可落地的优化方向。";

const SUGGESTIONS = [
  "当前这份报价的降本空间在哪？",
  "哪些维度占比偏高、值得优先优化？",
  "如果批量翻倍，单只成本大概降多少？",
  "用采购视角，这份方案怎么谈？",
];

export function AiChatDrawer() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cfgOk, setCfgOk] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [ctx, setCtx] = useState<AnalyzeContext | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      const cfg = getAiSettings();
      setCfgOk(isSettingsUsable(cfg));
      setCtx(readAnalyzeContext());
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    const cfg: AiSettings | null = getAiSettings();
    if (!isSettingsUsable(cfg)) {
      setCfgOk(false);
      return;
    }
    const history: ChatMsg[] = [...messages, { role: "user", content: t }];
    setMessages(history);
    setInput("");
    setSending(true);
    try {
      const liveCtx = readAnalyzeContext();
      setCtx(liveCtx);
      const contextText = liveCtx ? formatAnalyzeContext(liveCtx) : "";
      const sysPrompt = contextText
        ? `${SYSTEM_PROMPT}\n\n【当前绑定信息源】\n${contextText}\n\n只能基于以上【当前绑定信息源】中的内容回答用户问题。若用户所问的信息在信息源中未提供（如未填写的字段、未给出的具体数字），必须明确告知「资料中未提供该信息」，不得凭空编造或猜测。`
        : `${SYSTEM_PROMPT}\n\n注意：当前未绑定任何信息源。请勿编造具体数字或报价，仅可基于通用包装成本知识做原则性说明，并主动提示用户：先在「成本分析」页生成报告、或在分析页打开本抽屉，AI 才能基于真实数据作答。`;
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: cfg,
          messages: [
            { role: "system", content: sysPrompt },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        text?: string;
        message?: string;
      };
      if (res.ok && data.ok) {
        setMessages([...history, { role: "assistant", content: data.text ?? "" }]);
      } else {
        setMessages([
          ...history,
          { role: "assistant", content: `⚠️ ${data.message ?? "请求失败"}` },
        ]);
      }
    } catch {
      setMessages([
        ...history,
        { role: "assistant", content: "⚠️ 网络异常，请稍后重试" },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* 悬浮按钮 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AI 助手"
        className="fixed bottom-4 right-4 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg transition hover:bg-violet-700"
      >
        <MessageSquare className="h-5 w-5" />
      </button>

      {/* 抽屉 */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-full w-full max-w-sm flex-col bg-white shadow-2xl">
            {/* header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-violet-600" />
                <span className="font-semibold text-slate-800">AI 助手</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  title="AI 配置"
                  className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <SettingsIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* 消息区 */}
            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
            >
              {/* 信息源绑定状态条 */}
              {ctx ? (
                <div className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
                  <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="flex-1 leading-relaxed">
                    <span className="font-medium">已绑定信息源：</span>
                    {ctx.productTypeName ?? ctx.source}
                    {ctx.quantity ? ` · ${ctx.quantity}个` : ""}
                    <span className="text-violet-500">（AI 仅基于此回答）</span>
                  </div>
                  <button
                    type="button"
                    title="刷新绑定"
                    onClick={() => setCtx(readAnalyzeContext())}
                    className="rounded p-0.5 text-violet-500 hover:bg-violet-100"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="解除绑定"
                    onClick={() => {
                      clearAnalyzeContext();
                      setCtx(null);
                    }}
                    className="rounded p-0.5 text-violet-500 hover:bg-violet-100"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">
                  未绑定信息源，AI 仅基于通用知识回答。在「成本分析」页打开本抽屉可自动绑定当前报告，避免凭空作答。
                </div>
              )}

              {!cfgOk && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  AI 尚未配置或不可用，请在右上角「设置」中配置本地/云端模型。
                </div>
              )}
              {messages.length === 0 && cfgOk && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-500">
                    我是包装降本 AI 助手，可以基于当前页面帮你分析成本、找优化点、模拟谈判。试试：
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 hover:border-violet-400 hover:bg-violet-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} />
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-400">
                    思考中…
                  </div>
                </div>
              )}
            </div>

            {/* 输入区 */}
            <div className="border-t border-slate-200 p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  rows={1}
                  placeholder="问点什么…（Enter 发送 / Shift+Enter 换行）"
                  className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-400"
                />
                <button
                  type="button"
                  onClick={() => send(input)}
                  disabled={sending || !input.trim()}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <AiSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
          isUser
            ? "bg-violet-600 text-white"
            : "bg-slate-100 text-slate-800"
        }`}
      >
        {content}
      </div>
    </div>
  );
}
