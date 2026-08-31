"use client";

import { Lightbulb, Target, TrendingUp, CheckCircle2, FileSearch } from "lucide-react";

export interface AiArtifact {
  hints: string[]; // 提示
  strategies: string[]; // 策略
  effects: string[]; // 效果
  results: string[]; // 结果
  updatedAt?: number;
  /** 产出所基于的对话轮次（第几条助手回答），用于右栏标注「第 N 轮」 */
  round?: number;
  /** 产出所基于的主信息源标签，便于一眼确认没有跨工作页串味 */
  sourceLabel?: string;
}

const EMPTY: AiArtifact = {
  hints: [],
  strategies: [],
  effects: [],
  results: [],
};

function Card({
  icon,
  title,
  items,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className={`mb-2 flex items-center gap-1.5 text-sm font-semibold ${accent}`}>
        {icon}
        {title}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">暂无</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="rounded-lg bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-700">
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AiArtifactsPanel({
  artifact,
  updating = false,
  emptyHint = "AI 尚未生成结构化产出。在下方对话框提问后，右侧会自动归纳「提示 / 策略 / 效果 / 结果」。",
}: {
  artifact: AiArtifact | null;
  /** 正在基于新一轮对话重新归纳：右栏顶部显示增量更新指示，避免「干等没反馈」 */
  updating?: boolean;
  emptyHint?: string;
}) {
  const a = artifact ?? EMPTY;
  const hasAny = a.hints.length || a.strategies.length || a.effects.length || a.results.length;
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <FileSearch className="h-4 w-4 text-violet-600" />
        <span className="text-sm font-semibold text-slate-800">AI 结构化产出</span>
        {updating && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
            更新中
          </span>
        )}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!hasAny && (
          <p className="rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-400">
            {emptyHint}
          </p>
        )}
        <Card
          icon={<Lightbulb className="h-4 w-4" />}
          title="提示"
          items={a.hints}
          accent="text-amber-600"
        />
        <Card
          icon={<Target className="h-4 w-4" />}
          title="策略"
          items={a.strategies}
          accent="text-violet-600"
        />
        <Card
          icon={<TrendingUp className="h-4 w-4" />}
          title="效果"
          items={a.effects}
          accent="text-emerald-600"
        />
        <Card
          icon={<CheckCircle2 className="h-4 w-4" />}
          title="结果"
          items={a.results}
          accent="text-sky-600"
        />
      </div>
      {a.updatedAt && (
        <div
          className="border-t border-slate-200 bg-white px-4 py-2 text-[11px] text-slate-400"
          title={a.sourceLabel ? `主信息源：${a.sourceLabel}` : undefined}
        >
          基于{a.round ? `第 ${a.round} 轮` : ""}
          {a.sourceLabel ? `「${a.sourceLabel}」` : ""}对话归纳 ·{" "}
          {new Date(a.updatedAt).toLocaleTimeString("zh-CN")}
        </div>
      )}
    </aside>
  );
}
