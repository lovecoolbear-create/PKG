"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MessageSquare, Send, Settings as SettingsIcon, FileText, Layers } from "lucide-react";
import { listProjects } from "@/lib/project-store";
import { readInfoSource, formatReportContext } from "@/lib/ai-context";
import {
  getAiSettings,
  isSettingsUsable,
  type AiSettings,
} from "@/lib/config/ai-settings";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";
import type { CostProject } from "@/types";

interface SourceItem {
  id: string;
  label: string;
  contextText: string;
  kind: "current" | "project";
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const BASE_PROMPT =
  "你是「包装降本分析工作台」的 AI 助手，专注纸/塑/木缓冲包装的成本估算与 VAVE 降本。用中文、简洁、专业地回答用户关于成本分析报告 / 报价单 / VAVE 方案的问题。可主动给出可落地的优化方向。";

const SUGGESTIONS = [
  "对比这几个项目的成本结构，哪个降本空间最大？",
  "主要成本驱动维度分别是什么？",
  "如果批量翻倍，单只成本大概降多少？",
  "用采购视角，这份方案怎么谈？",
];

function buildSystem(selected: SourceItem[]): string {
  if (selected.length === 0) {
    return (
      BASE_PROMPT +
      "\n\n注意：当前未选中任何信息源。请勿编造具体数字或报价，仅可基于通用包装成本知识做原则性说明，并提示用户先在左侧勾选信息源（如当前分析或某个 VAVE 项目）。"
    );
  }
  const blocks = selected
    .map((s) => `【信息源：${s.label}】\n${s.contextText}`)
    .join("\n\n");
  return (
    `${BASE_PROMPT}\n\n以下是用户选中的信息源，你只能基于这些内容回答：\n\n${blocks}\n\n` +
    `要求：回答中凡引用某信息源的内容，必须在相关句末标注【来源：信息源标签】；` +
    `若用户所问信息在所选信息源中均未提供，必须明确告知「所选信息源中未提供该信息」，不得编造或猜测。`
  );
}

function parseCitations(text: string): string[] {
  const re = /【来源：([^】]+)】/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].trim());
  return [...out];
}

export default function AiWorkspacePage() {
  const [projects, setProjects] = useState<CostProject[]>([]);
  const [current, setCurrent] = useState<SourceItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cfgOk, setCfgOk] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [lastCitations, setLastCitations] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 装载信息源：当前分析 + 已存 VAVE 项目
  useEffect(() => {
    const list = listProjects();
    setProjects(list);
    const ctx = readInfoSource();
    const cur: SourceItem | null = ctx
      ? { id: "current", label: ctx.source, contextText: ctx.contextText, kind: "current" }
      : null;
    setCurrent(cur);
    // 默认选中：当前分析优先，否则最近一个项目
    const def = new Set<string>();
    if (cur) def.add("current");
    else if (list[0]) def.add(list[0].id);
    setSelectedIds(def);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const sources: SourceItem[] = useMemo(() => {
    const arr: SourceItem[] = [];
    if (current) arr.push(current);
    for (const p of projects)
      arr.push({
        id: p.id,
        label: p.name,
        contextText: formatReportContext(p.report, p.input),
        kind: "project",
      });
    return arr;
  }, [current, projects]);

  const selected = useMemo(
    () => sources.filter((s) => selectedIds.has(s.id)),
    [sources, selectedIds]
  );

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: cfg,
          messages: [
            { role: "system", content: buildSystem(selected) },
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
        const ans = data.text ?? "";
        setMessages([...history, { role: "assistant", content: ans }]);
        setLastCitations(parseCitations(ans));
      } else {
        setMessages([
          ...history,
          { role: "assistant", content: `⚠️ ${data.message ?? "请求失败"}` },
        ]);
        setLastCitations([]);
      }
    } catch {
      setMessages([
        ...history,
        { role: "assistant", content: "⚠️ 网络异常，请稍后重试" },
      ]);
      setLastCitations([]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* 顶栏 */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft className="inline h-4 w-4" /> 首页
          </Link>
          <span className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <MessageSquare className="h-5 w-5 text-violet-600" /> AI 工作台
          </span>
          <span className="text-xs text-slate-400">NotebookLM 式 · 选中信息源再提问</span>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          <SettingsIcon className="h-4 w-4" /> AI 配置
        </button>
      </header>

      {/* 三栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左：信息源 */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">信息源（勾选）</h2>
          {sources.length === 0 && (
            <p className="text-xs text-slate-400">
              暂无可用信息源。请先在「成本分析」生成报告，或进入 VAVE 保存项目。
            </p>
          )}
          <ul className="space-y-2">
            {sources.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 hover:border-violet-400">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="mt-0.5 h-4 w-4 accent-violet-600"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {s.kind === "current" ? (
                        <FileText className="h-3.5 w-3.5 text-violet-500" />
                      ) : (
                        <Layers className="h-3.5 w-3.5 text-slate-400" />
                      )}
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {s.kind === "current" ? "当前分析" : "已存 VAVE 项目"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </aside>

        {/* 中：对话 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {!cfgOk && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                AI 尚未配置或不可用，请点右上角「AI 配置」进行设置。
              </div>
            )}
            {messages.length === 0 && cfgOk && (
              <div className="space-y-2">
                <p className="text-sm text-slate-500">
                  我是包装降本 AI 助手。已勾选 {selected.length} 个信息源，可基于它们回答；也可切换左侧勾选。试试：
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
          <div className="border-t border-slate-200 bg-white p-3">
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
        </main>

        {/* 右：引用溯源 */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">引用溯源</h2>
          <div className="mb-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            本次回答引用了 {lastCitations.length} 个信息源：
            {lastCitations.length === 0 ? (
              <span className="text-slate-400"> 暂无（发送消息后显示）</span>
            ) : (
              <ul className="mt-1 space-y-1">
                {lastCitations.map((c) => (
                  <li key={c} className="text-violet-700">· {c}</li>
                ))}
              </ul>
            )}
          </div>
          <h3 className="mb-2 text-xs font-medium text-slate-500">已选中信息源</h3>
          <ul className="space-y-1 text-xs text-slate-600">
            {selected.map((s) => (
              <li key={s.id} className="truncate">· {s.label}</li>
            ))}
            {selected.length === 0 && (
              <li className="text-slate-400">未选中任何信息源</li>
            )}
          </ul>
        </aside>
      </div>

      <AiSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
          isUser ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-800"
        }`}
      >
        {content}
      </div>
    </div>
  );
}
