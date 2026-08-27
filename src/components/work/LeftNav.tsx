"use client";

import { Layers, Plus, FileUp, Trash2, FolderOpen, UploadCloud } from "lucide-react";
import type { CostProject } from "@/types";

export interface UploadedDoc {
  id: string;
  name: string;
  text: string;
}

export default function LeftNav({
  projects,
  activeProjectId,
  activeView,
  onPickProject,
  onNewAnalyze,
  uploadedDocs,
  onUploadDocs,
  onRemoveDoc,
  fileRef,
}: {
  projects: CostProject[];
  activeProjectId: string | null;
  activeView: "none" | "analyze" | "vave";
  onPickProject: (p: CostProject) => void;
  onNewAnalyze: () => void;
  uploadedDocs: UploadedDoc[];
  onUploadDocs: (files: FileList | null) => void;
  onRemoveDoc: (id: string) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold text-slate-800">项目中心</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {/* 新建 */}
        <button
          type="button"
          onClick={onNewAnalyze}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          新建成本分析
        </button>

        {/* 已存项目（VAVE） */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-slate-500">
            <FolderOpen className="h-3.5 w-3.5" />
            已存项目（{projects.length}）
          </p>
          {projects.length === 0 ? (
            <p className="px-1 text-xs text-slate-400">暂无。完成一次成本分析并保存后即出现。</p>
          ) : (
            <ul className="space-y-1.5">
              {projects.map((p) => {
                const isActive = activeView === "vave" && activeProjectId === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onPickProject(p)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition hover:border-brand-400 ${
                        isActive ? "border-brand-400 bg-brand-50" : "border-slate-200"
                      }`}
                    >
                      <p className="truncate text-sm font-medium text-slate-800">{p.name}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {new Date(p.createdAt).toLocaleDateString("zh-CN")} · ¥
                        {p.report.totalCost.perUnit.max}/只
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 上传资料区 */}
        <div className="rounded-xl border border-dashed border-slate-300 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <UploadCloud className="h-3.5 w-3.5" />
            上传资料（作为 AI 信息源）
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,.text"
            multiple
            onChange={(e) => onUploadDocs(e.target.files)}
            className="block w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-violet-50 file:px-2 file:py-1 file:text-violet-700"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            支持 .txt / .md / .csv / .json。成本分析相关文档会被 AI 副驾驶引用。
          </p>
          {uploadedDocs.length > 0 && (
            <ul className="mt-2 space-y-1">
              {uploadedDocs.map((d) => (
                <li key={d.id} className="flex items-center gap-1.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
                  <FileUp className="h-3 w-3 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveDoc(d.id)}
                    className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
        <Layers className="mr-1 inline h-3 w-3" />
        成本分析与 VAVE 共用同一成本引擎
      </div>
    </aside>
  );
}
