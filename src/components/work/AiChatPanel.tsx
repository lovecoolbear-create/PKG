"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send, MessageSquare, Database, FileText, FileUp, Layers, ChevronDown, WifiOff, PowerOff, CircleDashed, Settings } from "lucide-react";
import { readInfoSource, formatReportContext } from "@/lib/ai-context";
import { listProjects, getProject } from "@/lib/project-store";
import { getAiSettings, isSettingsUsable, type AiSettings } from "@/lib/config/ai-settings";
import { useAiReady } from "@/lib/ai-ready-store";
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
      "\n\n注意：当前未选中任何信息源。" +
      "涉及具体数字或报价时不得编造；但可基于你在包装成本与 VAVE 领域的专业知识，给出原则性分析、降本方向与思路，并标注「AI 建议 · 未经信息源验证」。" +
      "同时提示用户可上传资料或进入某个分析项目，以获得可溯源的结论。"
    );
  }
  const blocks = selected.map((s) => `【信息源：${s.label}】\n${s.contextText}`).join("\n\n");
  return (
    `${BASE_PROMPT}\n\n以下是用户选中的信息源：\n\n${blocks}\n\n` +
    `你的回答分两类内容，要求不同，请严格遵守：\n` +
    `一、事实与数字（价格、成本金额、占比、数量、交期、参数取值等）：` +
    `必须来自上述信息源，并在相关句末标注【来源：信息源标签】；` +
    `若信息源中未提供该事实，必须明确告知「所选信息源中未提供该信息」，不得编造或猜测。\n` +
    `二、分析、判断与建议（降本方向、工艺替代思路、结构与材料选型权衡、风险预判、谈判策略与话术等）：` +
    `可结合你自身的包装成本与 VAVE 专业知识进行推理和发挥，不受信息源范围限制；` +
    `但凡属此类内容，必须在句首或句末标注「AI 建议 · 未经信息源验证」，` +
    `让用户清楚区分哪些是可直接引用的事实、哪些是有待验证的思路。\n` +
    `三、无论哪一类，凡给出具体成本数字，必须来自信息源，或明确标注「（估算，非信息源数据）」，不得凭空生成新数字。`
  );
}

function parseCitations(text: string): string[] {
  const re = /【来源：([^】]+)】/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].trim());
  return [...out];
}

/**
 * B2：把助手回答按行分流为「事实 / 建议 / 中性」三类并视觉分区。
 * 与 buildSystem 的三段式授权一一对应：
 *  - fact：带【来源：xx】的事实与数字，来自信息源，可溯源；
 *  - suggestion：带「AI 建议 · 未经信息源验证」或「（估算，非信息源数据）」，属模型推理或估算；
 *  - neutral：未标注，按中性渲染（不冒充可溯源事实）。
 */
const CITE_RE = /【来源：[^】]+】/;
const AI_TAG = "AI 建议 · 未经信息源验证";
const EST_TAG = "（估算，非信息源数据）";

type BlockKind = "fact" | "suggestion" | "neutral";

function classifyLine(line: string): BlockKind {
  if (!line.trim()) return "neutral";
  if (CITE_RE.test(line)) return "fact";
  if (line.includes(AI_TAG) || line.includes(EST_TAG)) return "suggestion";
  return "neutral";
}

function stripMarkers(line: string): string {
  return line
    .split(AI_TAG)
    .join("")
    .replace(/^[·：:\s\-]+/, "")
    .replace(/[·：:\s\-]+$/, "");
}

function AssistantMessage({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="max-w-[85%] space-y-1 rounded-2xl bg-slate-100 px-2 py-2 text-sm text-slate-800">
      {lines.map((line, i) => {
        const kind = classifyLine(line);
        if (kind === "fact") {
          return (
            <div key={i} className="rounded-lg bg-white px-2 py-1">
              <span className="mr-1.5 rounded bg-emerald-100 px-1 py-0.5 align-middle text-[10px] text-emerald-700">
                可溯源
              </span>
              <span className="whitespace-pre-wrap">{line}</span>
            </div>
          );
        }
        if (kind === "suggestion") {
          // 估算数字单独标注为「估算」（它是对数字的限定，去掉会让数字看起来像已核实事实），
          // 其余推理/建议标注为「AI 建议」。
          const isEstimate = line.includes(EST_TAG);
          return (
            <div key={i} className="rounded-lg bg-amber-50 px-2 py-1">
              <span className="mr-1.5 rounded bg-amber-200 px-1 py-0.5 align-middle text-[10px] text-amber-800">
                {isEstimate ? "估算" : "AI 建议"}
              </span>
              <span className="whitespace-pre-wrap">{stripMarkers(line)}</span>
            </div>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap px-2 py-1">
            {line}
          </div>
        );
      })}
    </div>
  );
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
  onCollapse,
  onUpdating,
  onOpenSettings,
}: {
  bindKey: string | null;
  mainSourceLabel: string;
  mainSource?: { label: string; contextText: string } | null;
  onArtifact: (a: AiArtifact | null) => void;
  onCollapse?: () => void;
  /** 正在归纳右栏产出：由工作台转发给右栏显示「更新中」 */
  onUpdating?: (updating: boolean) => void;
  /** 离线态占位里的「去设置」入口 */
  onOpenSettings?: () => void;
}) {
  const ai = useAiReady();
  const [current, setCurrent] = useState<SourceItem | null>(null);
  const [kbItem, setKbItem] = useState<SourceItem | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
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
      const key = "ai_chat:" + (bindKey ?? "free");
      let raw = localStorage.getItem(key);
      // 读穿兼容：绑定键曾从 `analyze` 细化为 `analyze:<品类>`，
      // 新桶为空时回读旧桶，历史不丢（只读取、不回写，避免旧桶长期滞留）。
      if (!raw && bindKey && bindKey.startsWith("analyze:")) {
        raw = localStorage.getItem("ai_chat:analyze");
      }
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

  // 离线 / 未配置 / 已关闭：进工作台就显式占位，而不是等用户点完发送才弹一条 ⚠️。
  // unknown 与 checking 期间不判定为不可用，避免首屏探测未回时误伤。
  const aiBlocked =
    ai.status === "offline" || ai.status === "unconfigured" || ai.status === "disabled";
  const blockedMeta = {
    offline: { text: "AI 服务当前不可达", hint: "本地模型未启动或地址不可访问。启动后会自动恢复。", icon: <WifiOff className="h-4 w-4 text-rose-500" /> },
    unconfigured: { text: "尚未配置 AI", hint: "配置后即可基于当前工作页提问；未配置时成本分析、VAVE 等确定性功能不受影响。", icon: <CircleDashed className="h-4 w-4 text-slate-400" /> },
    disabled: { text: "AI 已关闭", hint: "你在 AI 设置中主动关闭了 AI。重新开启后对话可用。", icon: <PowerOff className="h-4 w-4 text-slate-400" /> },
  }[ai.status as "offline" | "unconfigured" | "disabled"] ?? null;

  const sources: SourceItem[] = useMemo(() => {
    const arr: SourceItem[] = [];
    if (current) arr.push(current);
    if (kbItem) arr.push(kbItem);
    arr.push(...uploadedDocs.map((d) => ({ id: d.id, label: d.name, contextText: d.text, kind: "doc" as const })));
    return arr;
  }, [current, kbItem, uploadedDocs]);

  // 默认仅选中主源（current / 绑定项目），不默认勾选知识库/上传文档，避免 100+ 条 KB 把 prefill 拖到分钟级。
  // 用户需要基于 KB 回答时，可在下拉面板手动勾选。
  const selected = useMemo(() => sources.filter((s) => s.id === boundId), [sources, boundId]);

  const extractArtifact = async (history: ChatMsg[]) => {
    const cfg = getAiSettings();
    if (!isSettingsUsable(cfg) || history.length === 0) return;
    setExtracting(true);
    onUpdating?.(true);
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
          // 轮次 = 本轮之前已产生的助手回答数 + 1，与中栏消息流一一对应，便于右栏标注「第 N 轮」
          const round = history.filter((m) => m.role === "assistant").length + 1;
          onArtifact({
            hints: Array.isArray(parsed.提示) ? parsed.提示 : [],
            strategies: Array.isArray(parsed.策略) ? parsed.策略 : [],
            effects: Array.isArray(parsed.效果) ? parsed.效果 : [],
            results: Array.isArray(parsed.结果) ? parsed.结果 : [],
            updatedAt: Date.now(),
            round,
            sourceLabel: mainSourceLabel || current?.label || "",
          });
        }
      }
    } catch {
      /* 提取失败静默 */
    } finally {
      setExtracting(false);
      onUpdating?.(false);
    }
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    const cfg: AiSettings | null = getAiSettings();
    if (!isSettingsUsable(cfg)) {
      // 兜底：全局状态还没探回来时用户已点发送，仍给出可操作的提示而不是静默失败
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ AI 尚未配置或不可用，请在顶栏「AI 设置」中配置本地模型。" },
      ]);
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
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="收起"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {aiBlocked && blockedMeta && (
          <div className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="mt-0.5 shrink-0">{blockedMeta.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700">AI 副驾驶离线 · {blockedMeta.text}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{blockedMeta.hint}</p>
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                >
                  <Settings className="h-3 w-3" /> AI 设置
                </button>
              )}
            </div>
          </div>
        )}
        {messages.length === 0 && !aiBlocked && (
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
            {m.role === "user" ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-violet-600 px-3 py-2 text-sm text-white">
                {m.content}
              </div>
            ) : (
              <AssistantMessage content={m.content} />
            )}
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
          disabled={aiBlocked}
          placeholder={
            aiBlocked ? "AI 离线，配置后可提问（其余功能不受影响）" : "问点什么…（Enter 发送 / Shift+Enter 换行）"
          }
          className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400"
        />
        <button
          type="button"
          onClick={() => send(input)}
          disabled={sending || !input.trim() || aiBlocked}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
