"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Layers, Database, FlaskConical, Settings, Boxes } from "lucide-react";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";
import LeftNav, { type UploadedDoc } from "./LeftNav";
import AnalyzeWorkView from "./AnalyzeWorkView";
import AiChatPanel from "./AiChatPanel";
import AiArtifactsPanel, { type AiArtifact } from "./AiArtifactsPanel";
import { VaveWorkbench } from "@/components/vave/VaveWorkbench";
import { listProjects } from "@/lib/project-store";
import type { CostProject } from "@/types";
import { getProductConfig, getDefaultProductType, getAllProductTypes } from "@/config/products";
import { formatReportContext } from "@/lib/ai-context";

const DOCS_KEY = "ai_uploaded_docs";

export default function WorkbenchClient() {
  const [projects, setProjects] = useState<CostProject[]>([]);
  const [activeView, setActiveView] = useState<"none" | "analyze" | "vave">("none");
  const [productType, setProductType] = useState<string>(getDefaultProductType().code);
  const [activeProject, setActiveProject] = useState<CostProject | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [artifact, setArtifact] = useState<AiArtifact | null>(null);
  const [analyzeContextLabel, setAnalyzeContextLabel] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const allProducts = useMemo(() => getAllProductTypes(), []);

  useEffect(() => {
    setProjects(listProjects());
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DOCS_KEY);
      if (raw) setUploadedDocs(JSON.parse(raw));
    } catch {}
  }, []);

  const handleUploadDocs = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return;
    const newDocs: UploadedDoc[] = [];
    for (const f of Array.from(files)) {
      const text = await f.text();
      newDocs.push({
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${f.name}`,
        name: f.name,
        text,
      });
    }
    setUploadedDocs((prev) => {
      const merged = [...prev, ...newDocs];
      try {
        localStorage.setItem(DOCS_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    });
  }, []);

  const handleRemoveDoc = useCallback((id: string) => {
    setUploadedDocs((prev) => {
      const merged = prev.filter((d) => d.id !== id);
      try {
        localStorage.setItem(DOCS_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    });
  }, []);

  const startNewAnalyze = (code: string) => {
    setProductType(code);
    setActiveProject(null);
    setActiveView("analyze");
    setArtifact(null);
    setStep(0);
    setShowPicker(false);
  };
  const pickProject = (p: CostProject) => {
    setActiveProject(p);
    setActiveView("vave");
    setArtifact(null);
  };
  const onSaved = (p: CostProject) => {
    setProjects(listProjects());
    setActiveProject(p);
    setActiveView("vave");
    setStep(0);
  };
  const exitToCenter = () => {
    setActiveView("none");
    setActiveProject(null);
    setArtifact(null);
    setShowPicker(false);
  };

  const categoryLabel = useMemo(() => {
    if (activeView === "analyze") return getProductConfig(productType)?.name ?? "";
    if (activeView === "vave" && activeProject) return activeProject.report.productTypeName;
    return "—";
  }, [activeView, productType, activeProject]);

  const vaveMain =
    activeView === "vave" && activeProject
      ? { label: activeProject.name, contextText: formatReportContext(activeProject.report, activeProject.input) }
      : null;

  const bindKey =
    activeView === "analyze"
      ? "analyze"
      : activeView === "vave" && activeProject
        ? `vave:${activeProject.id}`
        : null;
  const mainSourceLabel =
    activeView === "analyze"
      ? analyzeContextLabel ?? "当前成本分析"
      : activeView === "vave" && activeProject
        ? activeProject.name
        : "";

  const progress = useMemo(() => {
    if (activeView === "none") return { pct: 0, label: "未选择项目" };
    if (activeView === "analyze")
      return { pct: [15, 50, 85][step] ?? 0, label: `成本分析 · 步骤 ${step + 1}/3` };
    return { pct: 100, label: "VAVE 降本进行中" };
  }, [activeView, step]);

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* 顶栏：全局栏（在三栏之外） */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/intro" className="flex items-center gap-2 text-slate-800 hover:text-brand-700">
            <Boxes className="h-5 w-5 text-brand-600" />
            <span className="text-sm font-semibold">包装降本工作台</span>
          </Link>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
            品类：{categoryLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/calibration-intake"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            <FlaskConical className="h-4 w-4" /> 校准录入
          </Link>
          <Link
            href="/admin/knowledge"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            <Database className="h-4 w-4" /> 知识库
          </Link>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            >
              <Settings className="h-4 w-4" /> AI 设置
            </button>
          </div>
      </header>

      {/* 三栏 */}
      <div className="flex min-h-0 flex-1">
        <LeftNav
          projects={projects}
          activeProjectId={activeProject?.id ?? null}
          activeView={activeView}
          onPickProject={pickProject}
          onNewAnalyze={() => setShowPicker(true)}
          uploadedDocs={uploadedDocs}
          onUploadDocs={handleUploadDocs}
          onRemoveDoc={handleRemoveDoc}
          fileRef={fileRef}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {activeView === "none" && (
            <div className="flex flex-1 flex-col items-center justify-center p-6">
              {showPicker ? (
                <div className="w-full max-w-2xl">
                  <h2 className="text-lg font-semibold text-slate-800">选择品类，开始新的成本分析</h2>
                  <p className="mt-1 text-sm text-slate-500">品类在新建时确定，进入后可在参数页调整具体规格。</p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    {allProducts.map((p) => (
                      <button
                        key={p.code}
                        type="button"
                        onClick={() => startNewAnalyze(p.code)}
                        className="card p-4 text-left hover:border-brand-400"
                      >
                        <p className="font-medium text-brand-900">{p.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{p.code}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center text-slate-400">
                  <Layers className="mx-auto mb-3 h-10 w-10" />
                  <p className="text-sm">从左侧「新建成本分析」开始，或选择已有项目进入 VAVE 降本。</p>
                  <button type="button" onClick={() => setShowPicker(true)} className="btn-primary mt-4">
                    新建成本分析
                  </button>
                </div>
              )}
            </div>
          )}

          {activeView !== "none" && (
            <>
              <div className="flex-1 overflow-y-auto p-6">
                {activeView === "analyze" && (
                  <AnalyzeWorkView
                    productType={productType}
                    onExit={exitToCenter}
                    onSaved={onSaved}
                    onStep={setStep}
                    onContext={setAnalyzeContextLabel}
                  />
                )}
                {activeView === "vave" && activeProject && (
                  <VaveWorkbench report={activeProject.report} input={activeProject.input} />
                )}
              </div>
              <div className="h-[340px] shrink-0">
                <AiChatPanel
                  bindKey={bindKey}
                  mainSourceLabel={mainSourceLabel}
                  mainSource={vaveMain}
                  onArtifact={setArtifact}
                />
              </div>
            </>
          )}
        </main>

        {activeView !== "none" && <AiArtifactsPanel artifact={artifact} />}
      </div>

      {/* 底部进度条 */}
      <footer className="flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-2">
        <span className="w-40 shrink-0 text-xs text-slate-500">{progress.label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${progress.pct}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-slate-400">{progress.pct}%</span>
      </footer>

      <AiSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
