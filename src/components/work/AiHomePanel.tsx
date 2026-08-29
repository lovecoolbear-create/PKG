"use client";

import {
  Sparkles,
  FlaskConical,
  Database,
  Plus,
  FileText,
  FolderOpen,
  CircleDot,
} from "lucide-react";
import { useAiReady, type AiReadyStatus } from "@/lib/ai-ready-store";
import type { CostProject } from "@/types";
import type { UploadedDoc } from "./LeftNav";

const STATUS_META: Record<
  AiReadyStatus,
  { dot: string; text: string; sub: string }
> = {
  online: { dot: "bg-emerald-500", text: "AI 在线", sub: "可随时问答" },
  unknown: { dot: "bg-slate-300", text: "AI 状态未知", sub: "点击检测" },
  unconfigured: { dot: "bg-slate-300", text: "AI 未配置", sub: "点击去设置" },
  disabled: { dot: "bg-slate-300", text: "AI 已关闭", sub: "点击去设置" },
  checking: { dot: "bg-amber-400", text: "检测中…", sub: "稍候" },
  offline: { dot: "bg-rose-500", text: "AI 离线", sub: "模型未启动" },
};

export default function AiHomePanel({
  projects,
  uploadedDocs,
  onNewAnalyze,
  onOpenSettings,
  onPickProject,
  onOpenCalibration,
  onOpenKnowledge,
}: {
  projects: CostProject[];
  uploadedDocs: UploadedDoc[];
  onNewAnalyze: () => void;
  onOpenSettings: () => void;
  onPickProject: (p: CostProject) => void;
  onOpenCalibration: () => void;
  onOpenKnowledge: () => void;
}) {
  const ai = useAiReady();
  const meta = STATUS_META[ai.status] ?? STATUS_META.unknown;
  const recent = projects.slice(0, 3);

  const hint = uploadedDocs.length
    ? `已上传 ${uploadedDocs.length} 份资料，可先问 AI「报价单里的纸价锚是否合理」。`
    : projects.length
      ? `已有 ${projects.length} 个项目，可选一个进入 VAVE 降本。`
      : `从左侧「新建成本分析」开始：选品类 → 上传图纸 → 填参数 → 看五维报告。`;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <Sparkles className="h-4 w-4 text-violet-600" />
        <span className="text-sm font-semibold text-slate-800">AI 副驾驶 · 开始中心</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* AI 状态卡 */}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-brand-400 hover:shadow"
        >
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800">{meta.text}</span>
            <span className="block truncate text-xs text-slate-400">
              {ai.model ? `${ai.model} · ${meta.sub}` : meta.sub}
            </span>
          </span>
        </button>

        {/* 快速开始 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-sm font-semibold text-slate-800">快速开始</p>
          <div className="space-y-2">
            <button
              type="button"
              onClick={onNewAnalyze}
              className="flex w-full items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> 新建成本分析
            </button>
            <button
              type="button"
              onClick={onOpenCalibration}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              <FlaskConical className="h-4 w-4" /> 校准录入
            </button>
            <button
              type="button"
              onClick={onOpenKnowledge}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              <Database className="h-4 w-4" /> 知识库
            </button>
          </div>
        </div>

        {/* 已上传资料 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <FileText className="h-4 w-4 text-slate-500" /> 已上传资料
            <span className="text-xs font-normal text-slate-400">({uploadedDocs.length})</span>
          </p>
          {uploadedDocs.length === 0 ? (
            <p className="text-xs text-slate-400">尚未上传，可在左侧添加 txt / md / csv / json。</p>
          ) : (
            <ul className="space-y-1.5">
              {uploadedDocs.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{d.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 最近项目 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <FolderOpen className="h-4 w-4 text-slate-500" /> 最近项目
            <span className="text-xs font-normal text-slate-400">({projects.length})</span>
          </p>
          {recent.length === 0 ? (
            <p className="text-xs text-slate-400">保存成本分析后会在此出现。</p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onPickProject(p)}
                    className="flex w-full items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-800"
                  >
                    <CircleDot className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 操作提示 */}
        <p className="rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-400">{hint}</p>
      </div>
    </aside>
  );
}
