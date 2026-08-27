"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send, MessageSquare, Database, FileText, FileUp, Layers } from "lucide-react";
import { readInfoSource, formatReportContext } from "@/lib/ai-context";
import { listProjects, getProject } from "@/lib/project-store";
import { getAiSettings, isSettingsUsable, type AiSettings } from "@/lib/config/ai-settings";
import type { AiArtifact } from "./AiArtifactsPanel";

interface SourceItem {
  id: string;
  label: string;
  contextText: string;
  kind: "current" | "project" | "kb" | "doc";
}
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}
interface UploadedDoc {
  id: string;
  name: string;
  text: string;
}

const BASE_PROMPT =
  "你是「包装降本分析工作台」的 AI 副驾驶，专注纸/塑/木缓冲包装的成本估算与 VAVE 降本。用中文、简洁、专业地回答用户关于成本分析报告 / 报价单 / VAVE 方案 / 成本知识库的问题。可主动给出可落地的优化方向。";

const KB_SOURCE_CATEGORIES = ["material_price", "process_rate", "labor_rate", "market_price"];
const KB_CAT_LABELS: Record<string, string> = {
  material_price: "材料基准价",
  process_rate: "工艺/费用费率",
  labor_rate: "人工/物流费率",
  market_price: "市场行情价",
};
const DOCS_KEY = "ai_uploaded_docs";

function buildSystem(selected: SourceItem[]): string {
  if (selected.length === 0) {
    return (
      BASE_PROMPT +
      "\n\n注意：当前未选中任何信息源。请勿编造具体数字或报价，仅可基于通用包装成本知识做原则性说明，并提示用户先在左侧上传资料或进入某个分析/项目。"
    );
  }
  const blocks = selected.map((s) => `【信息源：${s.label}】\n${s.contextText}`).join("\n\n");
  return (
    `${BASE_PROMPT}\n\n以下是用户选中的信息源，你只能基于这些内容回答：\n\n${blocks}\n\n` +
    `要求：回答中凡引用某信息源的内容，必须在相关句末标注【来源：信息源标签】；` +
    `若用户所问信息在所选信息源中均未提供，必须明确告知「所选信息源中未提供该信息」，不得编造或猜测。` +
    `涉及具体成本数字时，必须来自信息源或明确标注「（估算，非信息源数据）」，不得凭空生成新数字。`
  );
}

function parseCitations(text: string): string[] {
  const re = /【来源：([^】]+)】/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].trim());
  return [...out];
}

function formatKbContext(entries: any[]): string {
  const filtered = entries.filter((e) => KB_SOURCE_CATEGORIES.includes(e.category));
  const groups = new Map<string, string[]>();
  for (const e of filtered) {
    const cat = KB_CAT_LABELS[e.category] || e.category;
    if (!groups.has(cat)) groups.set(cat, []);
    const v = e.value;
    const num = typeof v === "number" ? v : v?.value ?? v?.rate ?? v?.baseRate ?? v?.pricePerTon ?? null;
    const unit = v?.unit || "";
    groups.get(cat)!.push(`- ${e.key} = ${num ?? JSON.stringify(v)} ${unit}（来源：${e.source}）`);
  }
  const lines: string[] = ["成本知识库（权威参数基准）："];
  for (const [cat, items] of groups) {
    lines.push(`## ${cat}`);
    lines.push(...items);
  }
  return lines.join("\n");
}

const SUGGESTIONS = [
  "这份方案最大的降本空间在哪？",
  "如果批量翻倍，单只成本大概降多少？",
  "用采购视角，这份方案怎么谈？",
  "主要成本驱动维度分别是什么？",
];

export default function AiChatPanel({
  bindKey,
  mainSourceLabel,
  mainSource,
  onArtifact,
}: {
  bindKey: string | null;
  mainSourceLabel: string;
  mainSource?: { label: string; contextText: string } | null;
  onArtifact: (a: AiArtifact | null) => void;
}) {
  const [current, setCurrent] = useState<SourceItem | null>(null);
  const [kbItem, setKbItem] = useState<SourceItem | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cfgOk, setCfgOk] = useState(true);
  const [lastCitations, setLastCitations] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const boundId = bindKey ?? "current";

  // 装载信息源：当前分析 / 知识库 / 上传文档（主源锁定为 current 或绑定项目）
  useEffect(() => {
    if (mainSource) {
      setCurrent({ id: "current", label: mainSource.label, contextText: mainSource.contextText, kind: "current" });
    } else {
      const ctx = readInfoSource();
      setCurrent(ctx ? { id: "current", label: ctx.source, contextText: ctx.contextText, kind: "current" } : null);
    }
    fetch("/api/admin/knowledge-base")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const entries = data?.entries || [];
        if (entries.length) setKbItem({ id: "kb", label: "成本知识库", contextText: formatKbContext(entries), kind: "kb" });
      })
      .catch(() => {});
    try {
      const raw = localStorage.getItem(DOCS_KEY);
      if (raw) setUploadedDocs(JSON.parse(raw) as UploadedDoc[]);
    } catch {}
  }, [bindKey, mainSource]);

  // 按绑定键加载对话历史
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ai_chat:" + (bindKey ?? "free"));
      setMessages(raw ? (JSON.parse(raw) as ChatMsg[]) : []);
    } catch {
      setMessages([]);
    }
    loadedRef.current = true;
  }, [bindKey]);

  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem("ai_chat:" + (bindKey ?? "free"), JSON.stringify(messages));
    } catch {}
  }, [messages, bindKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const sources: SourceItem[] = useMemo(() => {
    const arr: SourceItem[] = [];
    if (current) arr.push(current);
    if (kbItem) arr.push(kbItem);
    arr.push(...uploadedDocs.map((d) => ({ id: d.id, label: d.name, contextText: d.text, kind: "doc" as const })));
    return arr;
  }, [current, kbItem, uploadedDocs]);

  // 默认选中：主源（current / 绑定项目）+ 知识库 + 文档
  const selected = useMemo(() => sources.filter((s) => s.id === boundId || s.kind !== "current"), [sources, boundId]);

  const extractArtifact = async (history: ChatMsg[]) => {
    const cfg = getAiSettings();
    if (!isSettingsUsable(cfg) || history.length === 0) return;
    setExtracting(true);
    try {
      const last = history[history.length - 1];
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: cfg,
          messages: [
            {
              role: "system",
              content:
                "你是结构化归纳器。请把下面「用户-助手」对话的要点，归纳成严格 JSON，不要任何多余文字。字段：提示(建议/注意点数组)、策略(可落地做法数组)、效果(预期收益/影响数组)、结果(结论/决策数组)。若某类无内容则为空数组。",
            },
            { role: "user", content: `对话原文（最后一条是助手回答）：\n${history
              .slice(-4)
              .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
              .join("\n")}\n\n请只输出 JSON。` },
          ],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string };
      if (res.ok && data.ok && data.text) {
        const jsonMatch = data.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          onArtifact({
            hints: Array.isArray(parsed.提示) ? parsed.提示 : [],
            strategies: Array.isArray(parsed.策略) ? parsed.策略 : [],
            effects: Array.isArray(parsed.效果) ? parsed.效果 : [],
            results: Array.isArray(parsed.结果) ? parsed.结果 : [],
            updatedAt: Date.now(),
          });
        }
      }
    } catch {
      /* 提取失败静默 */
    } finally {
      setExtracting(false);
    }
  };

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
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; message?: string };
      if (res.ok && data.ok) {
        const ans = data.text ?? "";
        const full = [...history, { role: "assistant" as const, content: ans }];
        setMessages(full);
        setLastCitations(parseCitations(ans));
        extractArtifact(full);
      } else {
        setMessages([...history, { role: "assistant", content: `⚠️ ${data.message ?? "请求失败"}` }]);
        setLastCitations([]);
      }
    } catch {
      setMessages([...history, { role: "assistant", content: "⚠️ 网络异常，请稍后重试" }]);
      setLastCitations([]);
    } finally {
      setSending(false);
    }
  };

  const kindIcon = (kind: SourceItem["kind"]) => {
    if (kind === "current") return <FileText className="h-3.5 w-3.5 text-violet-500" />;
    if (kind === "kb") return <Database className="h-3.5 w-3.5 text-emerald-500" />;
    if (kind === "doc") return <FileUp className="h-3.5 w-3.5 text-amber-500" />;
    return <Layers className="h-3.5 w-3.5 text-slate-400" />;
  };

  return (
    <div className="flex h-full flex-col border-t border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
        <MessageSquare className="h-4 w-4 text-violet-600" />
        <span className="text-sm font-semibold text-slate-800">AI 副驾驶</span>
        <span className="truncate text-xs text-slate-400">
          主源：{mainSourceLabel || current?.label || "未绑定（自由提问）"}
        </span>
        {extracting && <span className="text-xs text-violet-400">归纳中…</span>}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {!cfgOk && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            AI 尚未配置或不可用，请在顶栏「AI 设置」中配置本地模型。
          </div>
        )}
        {messages.length === 0 && cfgOk && (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">
              我已绑定当前工作页作为信息源，可基于它回答。试试：
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
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "user" ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-800"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-400">思考中…</div>
          </div>
        )}
      </div>

      {/* 信息源微标签（透明） */}
      <div className="flex flex-wrap gap-1 border-t border-slate-100 px-4 py-1.5">
        {selected.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            {kindIcon(s.kind)}
            {s.label}
          </span>
        ))}
        {selected.length === 0 && <span className="text-[10px] text-slate-400">未选中信息源</span>}
      </div>

      <div className="flex items-end gap-2 p-3">
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
  );
}
