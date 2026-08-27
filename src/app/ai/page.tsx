"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  MessageSquare,
  Send,
  Settings as SettingsIcon,
  FileText,
  Layers,
  Database,
  FileUp,
  Trash2,
  Pin,
} from "lucide-react";
import { listProjects, getProject } from "@/lib/project-store";
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
  kind: "current" | "project" | "kb" | "doc";
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const BASE_PROMPT =
  "你是「包装降本分析工作台」的 AI 助手，专注纸/塑/木缓冲包装的成本估算与 VAVE 降本。用中文、简洁、专业地回答用户关于成本分析报告 / 报价单 / VAVE 方案 / 成本知识库的问题。可主动给出可落地的优化方向。";

const SUGGESTIONS = [
  "对比这几个项目的成本结构，哪个降本空间最大？",
  "主要成本驱动维度分别是什么？",
  "如果批量翻倍，单只成本大概降多少？",
  "白卡纸 300g 的当前基准价是多少（结合知识库）？",
  "用采购视角，这份方案怎么谈？",
];

/** 知识库中作为 AI 信息源的几类（权威成本参数），不含分析案例/反馈等噪声 */
const KB_SOURCE_CATEGORIES = [
  "material_price",
  "process_rate",
  "labor_rate",
  "market_price",
];
const KB_CAT_LABELS: Record<string, string> = {
  material_price: "材料基准价",
  process_rate: "工艺/费用费率",
  labor_rate: "人工/物流费率",
  market_price: "市场行情价",
};

function buildSystem(selected: SourceItem[]): string {
  if (selected.length === 0) {
    return (
      BASE_PROMPT +
      "\n\n注意：当前未选中任何信息源。请勿编造具体数字或报价，仅可基于通用包装成本知识做原则性说明，并提示用户先在左侧勾选信息源（如当前分析、某个 VAVE 项目、成本知识库或上传文档）。"
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

/** 把知识库条目格式化为 LLM 可读文本（仅取成本参数类目） */
function formatKbContext(entries: any[]): string {
  const filtered = entries.filter((e) =>
    KB_SOURCE_CATEGORIES.includes(e.category)
  );
  const groups = new Map<string, string[]>();
  for (const e of filtered) {
    const cat = KB_CAT_LABELS[e.category] || e.category;
    if (!groups.has(cat)) groups.set(cat, []);
    const v = e.value;
    const num =
      typeof v === "number"
        ? v
        : v?.value ?? v?.rate ?? v?.baseRate ?? v?.pricePerTon ?? null;
    const unit = v?.unit || "";
    groups
      .get(cat)!
      .push(`- ${e.key} = ${num ?? JSON.stringify(v)} ${unit}（来源：${e.source}）`);
  }
  const lines: string[] = ["成本知识库（权威参数基准）："];
  for (const [cat, items] of groups) {
    lines.push(`## ${cat}`);
    lines.push(...items);
  }
  return lines.join("\n");
}

const DOCS_KEY = "ai_uploaded_docs";
const CHAT_PREFIX = "ai_chat:";

interface UploadedDoc {
  id: string;
  name: string;
  text: string;
}

export default function AiWorkspacePage() {
  const router = useRouter();

  // 旧 AI 工作台已合并到统一工作台 /work，保留本路由仅作跳转兼容
  useEffect(() => {
    router.replace("/work");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
      <div className="text-center">
        <p className="text-base font-medium">正在跳转到新工作台…</p>
        <p className="mt-1 text-sm text-slate-400">AI 副驾驶已内置到统一工作台右侧</p>
      </div>
    </div>
  );
}

function AiWorkspacePageLegacy() {
  const [projects, setProjects] = useState<CostProject[]>([]);
  const [current, setCurrent] = useState<SourceItem | null>(null);
  const [kbItem, setKbItem] = useState<SourceItem | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cfgOk, setCfgOk] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [lastCitations, setLastCitations] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const loadedRef = useRef(false);
  const [bindKey, setBindKey] = useState<string | null>(null); // "analyze" | "vave:<id>" | null
  const [boundId, setBoundId] = useState<string | null>(null); // 锁定主源 source id

  // 装载信息源：当前分析 + 已存 VAVE 项目 + 成本知识库 + 已上传文档
  useEffect(() => {
    const list = listProjects();
    setProjects(list);
    const ctx = readInfoSource();
    const cur: SourceItem | null = ctx
      ? { id: "current", label: ctx.source, contextText: ctx.contextText, kind: "current" }
      : null;
    setCurrent(cur);

    // 知识库（成本参数）作为固定信息源
    fetch("/api/admin/knowledge-base")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const entries = data?.entries || [];
        if (entries.length) {
          setKbItem({
            id: "kb",
            label: "成本知识库",
            contextText: formatKbContext(entries),
            kind: "kb",
          });
          // 绑定模式下自动预挂知识库
          if (bId) setSelectedIds((prev) => new Set(prev).add("kb"));
        }
      })
      .catch(() => {
        /* 知识库不可用时静默忽略 */
      });

      // 已上传文档（持久化在 localStorage）
      try {
        const raw = localStorage.getItem(DOCS_KEY);
        if (raw) setUploadedDocs(JSON.parse(raw) as UploadedDoc[]);
      } catch {
        /* ignore */
      }

      // 解析入口绑定参数（?bind=analyze | ?bind=vave:<id> | 缺省=自由模式）
      const params = new URLSearchParams(window.location.search);
      const rawBind = params.get("bind");
      let bKey: string | null = null;
      let bId: string | null = null;
      if (rawBind && rawBind !== "none") {
        if (rawBind === "analyze") {
          bKey = "analyze";
          if (cur) bId = "current";
        } else if (rawBind.startsWith("vave:")) {
          const pid = rawBind.slice(5);
          const p = getProject(pid);
          if (p) {
            bKey = `vave:${pid}`;
            bId = pid;
          }
        }
      }
      setBindKey(bKey);
      setBoundId(bId);

      // 默认选中：绑定模式→主源（知识库异步补挂）；自由模式→当前分析优先，否则最近项目
      const def = new Set<string>();
      if (bId) def.add(bId);
      else if (cur) def.add("current");
      else if (list[0]) def.add(list[0].id);
      setSelectedIds(def);
  }, []);

  // 按绑定键加载对话历史（项目级留痕：同一项目反复进入可追溯）
  useEffect(() => {
    const key = CHAT_PREFIX + (bindKey ?? "free");
    try {
      const raw = localStorage.getItem(key);
      setMessages(raw ? (JSON.parse(raw) as ChatMsg[]) : []);
    } catch {
      setMessages([]);
    }
    loadedRef.current = true;
  }, [bindKey]);

  // 对话变化即持久化到当前绑定键（加载后的首次跳过由 loadedRef 控制）
  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(
        CHAT_PREFIX + (bindKey ?? "free"),
        JSON.stringify(messages)
      );
    } catch {
      /* 配额超限忽略 */
    }
  }, [messages, bindKey]);


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
    if (kbItem) arr.push(kbItem);
    arr.push(
      ...uploadedDocs.map((d) => ({
        id: d.id,
        label: d.name,
        contextText: d.text,
        kind: "doc" as const,
      }))
    );
    return arr;
  }, [current, projects, kbItem, uploadedDocs]);

  const selected = useMemo(
    () => sources.filter((s) => selectedIds.has(s.id)),
    [sources, selectedIds]
  );

  const boundSource = useMemo(
    () => sources.find((s) => s.id === boundId) ?? null,
    [sources, boundId]
  );
  const boundLabel = boundSource?.label;

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      // 主源锁定，不可取消勾选
      if (boundId != null && id === boundId) return prev;
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const newDocs: UploadedDoc[] = [];
      for (const f of Array.from(files)) {
        const text = await f.text();
        newDocs.push({
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${f.name}`,
          name: f.name,
          text,
        });
      }
      setUploadedDocs((prev) => {
        const merged = [...prev, ...newDocs];
        try {
          localStorage.setItem(DOCS_KEY, JSON.stringify(merged));
        } catch {
          /* 超出存储配额则仅保留内存态 */
        }
        return merged;
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeDoc = (id: string) => {
    setUploadedDocs((prev) => {
      const merged = prev.filter((d) => d.id !== id);
      try {
        localStorage.setItem(DOCS_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      return merged;
    });
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
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

  const kindIcon = (kind: SourceItem["kind"]) => {
    if (kind === "current")
      return <FileText className="h-3.5 w-3.5 text-violet-500" />;
    if (kind === "kb") return <Database className="h-3.5 w-3.5 text-emerald-500" />;
    if (kind === "doc") return <FileUp className="h-3.5 w-3.5 text-amber-500" />;
    return <Layers className="h-3.5 w-3.5 text-slate-400" />;
  };
  const kindLabel = (kind: SourceItem["kind"]) => {
    if (kind === "current") return "当前分析";
    if (kind === "kb") return "成本知识库";
    if (kind === "doc") return "上传文档";
    return "已存 VAVE 项目";
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
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">信息源（勾选）</h2>
          {bindKey && (
            <div className="mb-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-800">
              <span className="flex items-center gap-1 font-medium">
                <Pin className="h-3.5 w-3.5" />
                已绑定主源：{boundLabel || "（未检测到，请先在对应页面生成）"}
              </span>
              <button
                type="button"
                onClick={() => router.push("/ai")}
                className="ml-1 rounded px-1 text-violet-500 underline hover:text-violet-700"
              >
                解除绑定
              </button>
              <div className="mt-0.5 text-violet-500">
                AI 将以此为主源作答，仍可在下方勾选其他信息源做对比。
              </div>
            </div>
          )}
          {sources.length === 0 && (
            <p className="text-xs text-slate-400">
              暂无可用信息源。请先在「成本分析」生成报告，或进入 VAVE 保存项目。
            </p>
          )}
          <ul className="space-y-2">
            {sources.map((s) => (
              <li key={s.id}>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 hover:border-violet-400 ${
                    s.id === boundId
                      ? "border-violet-300 bg-violet-50"
                      : "border-slate-200"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    disabled={boundId != null && s.id === boundId}
                    onChange={() => toggle(s.id)}
                    className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-60"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {kindIcon(s.kind)}
                      <span className="truncate">{s.label}</span>
                      {s.id === boundId && (
                        <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">
                          主源
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {kindLabel(s.kind)}
                    </span>
                  </span>
                  {s.kind === "doc" && (
                    <button
                      type="button"
                      title="移除文档"
                      onClick={(e) => {
                        e.preventDefault();
                        removeDoc(s.id);
                      }}
                      className="mt-0.5 rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </label>
              </li>
            ))}
          </ul>

          {/* 上传文档 */}
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
            <p className="mb-2 text-xs font-medium text-slate-600">上传文档为信息源</p>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,.text"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              className="block w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-violet-50 file:px-2 file:py-1 file:text-violet-700"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              支持 .txt / .md / .csv / .json（建议用外部工具先把图片/PDF 转成文本）。
              {uploading && " 读取中…"}
            </p>
          </div>
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
