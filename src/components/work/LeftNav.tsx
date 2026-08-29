"use client";

import {
  Layers,
  Plus,
  FileUp,
  Trash2,
  FolderOpen,
  UploadCloud,
  ArrowLeft,
  CheckCircle2,
  Circle,
  FlaskConical,
  Database,
} from "lucide-react";
import type { CostProject } from "@/types";
import { getProductConfig } from "@/config/products";

export interface UploadedDoc {
  id: string;
  name: string;
  text: string;
}

const ANALYZE_STEPS = ["上传资料", "确认规格", "查看结果"];

export default function LeftNav({
  projects,
  activeProjectId,
  activeView,
  productType,
  analyzeStep = 0,
  analyzeStepHints = [],
  activeProject,
  onPickProject,
  onNewAnalyze,
  onExitToCenter,
  uploadedDocs,
  onUploadDocs,
  onRemoveDoc,
  fileRef,
}: {
  projects: CostProject[];
  activeProjectId: string | null;
  activeView: "none" | "analyze" | "vave" | "calibration" | "knowledge";
  productType?: string;
  analyzeStep?: number;
  analyzeStepHints?: string[];
  activeProject?: CostProject | null;
  onPickProject: (p: CostProject) => void;
  onNewAnalyze: () => void;
  onExitToCenter: () => void;
  uploadedDocs: UploadedDoc[];
  onUploadDocs: (files: FileList | null) => void;
  onRemoveDoc: (id: string) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  const productName = productType ? getProductConfig(productType)?.name ?? productType : "";

  const headerTitle =
    activeView === "analyze"
      ? `成本分析 · ${productName}`
      : activeView === "vave"
        ? "VAVE 降本"
        : activeView === "calibration"
          ? "校准录入"
          : activeView === "knowledge"
            ? "知识库管理"
            : "项目中心";

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold text-slate-800">{headerTitle}</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {activeView === "none" && (
          <HomePanel
            projects={projects}
            activeProjectId={activeProjectId}
            onPickProject={onPickProject}
            onNewAnalyze={onNewAnalyze}
            uploadedDocs={uploadedDocs}
            onUploadDocs={onUploadDocs}
            onRemoveDoc={onRemoveDoc}
            fileRef={fileRef}
          />
        )}
        {activeView === "analyze" && (
          <AnalyzePanel
            step={analyzeStep}
            hints={analyzeStepHints}
            productName={productName}
            onExit={onExitToCenter}
          />
        )}
        {activeView === "vave" && (
          <VavePanel
            activeProject={activeProject}
            projects={projects}
            activeProjectId={activeProjectId}
            onPickProject={onPickProject}
            onExit={onExitToCenter}
          />
        )}
        {activeView === "calibration" && <CalibrationPanel onExit={onExitToCenter} />}
        {activeView === "knowledge" && <KnowledgePanel onExit={onExitToCenter} />}
      </div>

      <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
        <Layers className="mr-1 inline h-3 w-3" />
        成本分析与 VAVE 共用同一成本引擎
      </div>
    </aside>
  );
}

/* ============ 首页（项目中心） ============ */
function HomePanel({
  projects,
  activeProjectId,
  onPickProject,
  onNewAnalyze,
  uploadedDocs,
  onUploadDocs,
  onRemoveDoc,
  fileRef,
}: {
  projects: CostProject[];
  activeProjectId: string | null;
  onPickProject: (p: CostProject) => void;
  onNewAnalyze: () => void;
  uploadedDocs: UploadedDoc[];
  onUploadDocs: (files: FileList | null) => void;
  onRemoveDoc: (id: string) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onNewAnalyze}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        <Plus className="h-4 w-4" />
        新建成本分析
      </button>

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
              const isActive = activeProjectId === p.id;
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

      {/* 上传资料区（仅首页显示） */}
      <div className="rounded-xl border border-dashed border-slate-300 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <UploadCloud className="h-3.5 w-3.5" />
          上传资料（作为 AI 信息源）
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.markdown,.csv,.json,.text,.xlsx,.xls,.pdf,.png,.jpg,.jpeg"
          multiple
          onChange={(e) => onUploadDocs(e.target.files)}
          className="block w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-violet-50 file:px-2 file:py-1 file:text-violet-700"
        />
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          文本（.txt/.md/.csv/.json）作为 AI 信息源；报价表（.xlsx）自动解析并对比成本。
        </p>
        {uploadedDocs.length > 0 && (
          <ul className="mt-2 space-y-1">
            {uploadedDocs.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-1.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600"
              >
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
    </>
  );
}

/* ============ 成本分析（与中间 3 步骤同步） ============ */
function AnalyzePanel({
  step,
  hints,
  productName,
  onExit,
}: {
  step: number;
  hints: string[];
  productName: string;
  onExit: () => void;
}) {
  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-xs font-medium text-slate-500">分析步骤</p>
        <ol className="space-y-2">
          {ANALYZE_STEPS.map((label, i) => {
            const done = i < step;
            const current = i === step;
            return (
              <li key={label} className="flex items-center gap-2">
                {done ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : current ? (
                  <Circle className="h-4 w-4 shrink-0 fill-brand-500 text-brand-500" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-slate-300" />
                )}
                <span
                  className={`text-sm ${
                    current
                      ? "font-semibold text-brand-700"
                      : done
                        ? "text-slate-500"
                        : "text-slate-400"
                  }`}
                >
                  {i + 1}. {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {hints.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="mb-1.5 text-xs font-medium text-amber-700">当前步骤提示</p>
          <ul className="space-y-1">
            {hints.map((h, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-amber-800">
                · {h}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={onExit}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        返回项目中心
      </button>
    </>
  );
}

/* ============ VAVE 降本（当前项目 + 历史切换） ============ */
function VavePanel({
  activeProject,
  projects,
  activeProjectId,
  onPickProject,
  onExit,
}: {
  activeProject?: CostProject | null;
  projects: CostProject[];
  activeProjectId: string | null;
  onPickProject: (p: CostProject) => void;
  onExit: () => void;
}) {
  const report = activeProject?.report;
  const drivers = report?.costDrivers?.slice(0, 3) ?? [];
  const others = projects.filter((p) => p.id !== activeProjectId);

  return (
    <>
      {report && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="truncate text-sm font-semibold text-slate-800">{activeProject!.name}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            单件成本 ¥{report.totalCost.perUnit.min}–{report.totalCost.perUnit.max}
            {report.totalCost.unit ? `/${report.totalCost.unit}` : ""}
          </p>
          <p className="text-[11px] text-slate-500">完整度 {report.completeness}%</p>

          {drivers.length > 0 && (
            <div className="mt-2 border-t border-slate-200 pt-2">
              <p className="mb-1 text-[11px] font-medium text-slate-500">主要成本驱动</p>
              <ul className="space-y-1">
                {drivers.map((d, i) => (
                  <li key={i} className="text-[11px] text-slate-600">
                    <span className="font-medium text-slate-700">{d.dimensionLabel}</span>
                    <span className="float-right tabular-nums">¥{d.amount} · {d.ratio}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-slate-500">
            <FolderOpen className="h-3.5 w-3.5" />
            切换其他项目
          </p>
          <ul className="space-y-1.5">
            {others.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPickProject(p)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-brand-400"
                >
                  <p className="truncate text-sm font-medium text-slate-800">{p.name}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {new Date(p.createdAt).toLocaleDateString("zh-CN")} · ¥
                    {p.report.totalCost.perUnit.max}/只
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={onExit}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        返回项目中心
      </button>
    </>
  );
}

/* ============ 校准录入 ============ */
function CalibrationPanel({ onExit }: { onExit: () => void }) {
  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <FlaskConical className="h-3.5 w-3.5 text-brand-600" />
          校准录入说明
        </p>
        <ul className="space-y-1 text-[11px] leading-relaxed text-slate-600">
          <li>· 在右侧页面填入真实报价单与厂端实际成本。</li>
          <li>· 系统据真实数据反推行业常数，逐步收敛估算精度。</li>
          <li>· 字段缺失可留空，不影响已填项的学习。</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onExit}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        返回工作台
      </button>
    </>
  );
}

/* ============ 知识库 ============ */
function KnowledgePanel({ onExit }: { onExit: () => void }) {
  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <Database className="h-3.5 w-3.5 text-brand-600" />
          知识库说明
        </p>
        <ul className="space-y-1 text-[11px] leading-relaxed text-slate-600">
          <li>· 右侧为知识库管理页，可维护材料/工艺/地域费率等条目。</li>
          <li>· 成本引擎在估算时优先读取此处已确认知识。</li>
          <li>· 待审词条审核通过后自动进入正式知识。</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onExit}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        返回工作台
      </button>
    </>
  );
}
