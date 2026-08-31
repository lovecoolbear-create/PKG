"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers, Database, FlaskConical, Settings, Boxes, Plus, MessageSquare, ChevronUp, Zap } from "lucide-react";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";
import { getAiSettings } from "@/lib/config/ai-settings";
import { useAiReady, useAiReadyProbe, type AiReadyStatus } from "@/lib/ai-ready-store";
import LeftNav, { type UploadedDoc } from "./LeftNav";
import AnalyzeWorkView from "./AnalyzeWorkView";
import AiChatPanel from "./AiChatPanel";
import AiArtifactsPanel, { type AiArtifact } from "./AiArtifactsPanel";
import AiHomePanel from "./AiHomePanel";
import { loadArtifact, saveArtifact } from "@/lib/ai-artifact-store";
import { VaveWorkbench } from "@/components/vave/VaveWorkbench";
import { listProjects } from "@/lib/project-store";
import type { CostProject } from "@/types";
import { getProductConfig, getDefaultProductType, getAllProductTypes } from "@/config/products";
import { formatReportContext } from "@/lib/ai-context";

const DOCS_KEY = "ai_uploaded_docs";

export default function WorkbenchClient() {
  const [projects, setProjects] = useState<CostProject[]>([]);
  const [activeView, setActiveView] =
    useState<"none" | "analyze" | "vave" | "calibration" | "knowledge">("none");
  const [productType, setProductType] = useState<string>(getDefaultProductType().code);
  const [activeProject, setActiveProject] = useState<CostProject | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [artifact, setArtifact] = useState<AiArtifact | null>(null);
  const [aiUpdating, setAiUpdating] = useState(false);
  const [analyzeContextLabel, setAnalyzeContextLabel] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [analyzeStepHints, setAnalyzeStepHints] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [typePicker, setTypePicker] = useState<{
    fileName: string;
    availableTypes: { code: string; name: string }[];
    file: File;
    kind?: "xlsx" | "scan";
  } | null>(null);
  const [scanPreview, setScanPreview] = useState<{
    fileName: string;
    extracted: { headers: string[]; rows: string[][] };
    rowCount: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const ai = useAiReady();
  useAiReadyProbe();

  const aiStatusMeta: Record<AiReadyStatus, { dot: string; text: string }> = {
    online: { dot: "bg-emerald-500", text: "AI 在线" },
    offline: { dot: "bg-rose-500", text: "AI 离线" },
    checking: { dot: "bg-amber-400 animate-pulse", text: "连接中" },
    unconfigured: { dot: "bg-slate-300", text: "未配置 AI" },
    disabled: { dot: "bg-slate-300", text: "AI 已关闭" },
    unknown: { dot: "bg-slate-300", text: "AI 状态未知" },
  };
  const aiMeta = aiStatusMeta[ai.status] ?? aiStatusMeta.unknown;

  const allProducts = useMemo(() => getAllProductTypes(), []);
  const searchParams = useSearchParams();

  useEffect(() => {
    setProjects(listProjects());
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DOCS_KEY);
      if (raw) setUploadedDocs(JSON.parse(raw));
    } catch {}
  }, []);
  useEffect(() => {
    const p = searchParams.get("product");
    if (p && getProductConfig(p)) {
      setProductType(p);
      setActiveProject(null);
      setActiveView("analyze");
      setStep(0);
      setShowPicker(false);
    }
  }, [searchParams]);

  // 监听嵌入 iframe 内的「返回工作台」请求（校准录入 / 知识库的返回按钮）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "workbench:exit-to-center") {
        setActiveView("none");
        setActiveProject(null);
        setShowPicker(false);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const handleUploadDocs = useCallback(
    async (files: FileList | null) => {
      if (!files || !files.length || importing) return;
      const fileList = Array.from(files);
      const isXlsx = (f: File) =>
        /\.(xlsx|xls)$/i.test(f.name) ||
        f.type.includes("spreadsheetml") ||
        f.type === "application/vnd.ms-excel";
      const isScan = (f: File) =>
        /\.(pdf|png|jpe?g)$/i.test(f.name) ||
        f.type === "application/pdf" ||
        f.type.startsWith("image/");
      const xlsxFiles = fileList.filter(isXlsx);
      const scanFiles = fileList.filter(isScan);
      const textFiles = fileList.filter((f) => !isXlsx(f) && !isScan(f));

      // 文本类（.txt/.md/.csv/.json/.text）：维持原「AI 信息源」行为
      if (textFiles.length) {
        const newDocs: UploadedDoc[] = [];
        for (const f of textFiles) {
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
          } catch {}
          return merged;
        });
      }

      // 报价表（.xlsx）：导入解析 → 结构化映射 → 对比页
      for (const f of xlsxFiles) {
        try {
          setImporting(true);
          const fd = new FormData();
          fd.append("file", f);
          const res = await fetch("/api/import/customer-quote", {
            method: "POST",
            body: fd,
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            sessionStorage.setItem("customer_import_result", JSON.stringify(data));
            if (data.newTerms && data.newTerms > 0) {
              alert(
                `本次导入发现 ${data.newTerms} 个未收录描述词，已进「待审词典」，可在工作台「待审词典」标签审核确认。`,
              );
            }
            router.push("/import/compare");
            return; // 已跳转到对比页
          }
          if (data?.code === "UNKNOWN_PRODUCT_TYPE") {
            // 自动识别失败：引导用户手动选品类后重传
            setTypePicker({
              fileName: f.name,
              availableTypes: data.availableTypes || [],
              file: f,
              kind: "xlsx",
            });
            return;
          }
          alert(`导入「${f.name}」失败：${data?.message || "未知错误"}`);
        } catch (e) {
          alert(
            `导入「${f.name}」出错：${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          setImporting(false);
        }
      }

      // 扫描件/图片报价（PDF/PNG/JPG）：视觉抽取 → 复用映射管线 → 预览 → 对比页
      for (const f of scanFiles) {
        try {
          setImporting(true);
          const fd = new FormData();
          fd.append("file", f);
          const ai = getAiSettings();
          if (ai) fd.append("aiSettings", JSON.stringify(ai));
          const res = await fetch("/api/import/quote-scan", {
            method: "POST",
            body: fd,
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            sessionStorage.setItem("customer_import_result", JSON.stringify(data));
            if (data.newTerms && data.newTerms > 0) {
              alert(
                `本次导入发现 ${data.newTerms} 个未收录描述词，已进「待审词典」，可在工作台「待审词典」标签审核确认。`,
              );
            }
            setScanPreview({
              fileName: f.name,
              extracted: data.extracted,
              rowCount: data.rowCount,
            });
            return;
          }
          if (data?.code === "UNKNOWN_PRODUCT_TYPE") {
            setTypePicker({
              fileName: f.name,
              availableTypes: data.availableTypes || [],
              file: f,
              kind: "scan",
            });
            return;
          }
          alert(`扫描件「${f.name}」导入失败：${data?.message || "未知错误"}`);
        } catch (e) {
          alert(
            `扫描件「${f.name}」出错：${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          setImporting(false);
        }
      }
    },
    [importing, router],
  );

  // 未识别品类时，用户手动选品类后带 productType 重传（xlsx 与扫描件共用）
  const confirmType = async (code: string) => {
    if (!typePicker) return;
    const f = typePicker.file;
    const kind = typePicker.kind ?? "xlsx";
    setTypePicker(null);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("productType", code);
      const ai = getAiSettings();
      if (ai) fd.append("aiSettings", JSON.stringify(ai));
      const endpoint =
        kind === "scan"
          ? "/api/import/quote-scan"
          : "/api/import/customer-quote";
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.ok) {
        sessionStorage.setItem("customer_import_result", JSON.stringify(data));
        if (data.newTerms && data.newTerms > 0) {
          alert(
            `本次导入发现 ${data.newTerms} 个未收录描述词，已进「待审词典」，可在工作台「待审词典」标签审核确认。`,
          );
        }
        if (kind === "scan") {
          setScanPreview({
            fileName: f.name,
            extracted: data.extracted,
            rowCount: data.rowCount,
          });
          return;
        }
        router.push("/import/compare");
        return;
      }
      alert(`导入「${f.name}」失败：${data?.message || "未知错误"}`);
    } catch (e) {
      alert(
        `导入「${f.name}」出错：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  const handleRemoveDoc = useCallback((id: string) => {
    setUploadedDocs((prev) => {
      const merged = prev.filter((d) => d.id !== id);
      try {
        localStorage.setItem(DOCS_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    });
  }, []);

  const handleAnalyzeStep = useCallback((s: number, hints?: string[]) => {
    setStep(s);
    setAnalyzeStepHints(hints ?? []);
  }, []);

  const startNewAnalyze = (code: string) => {
    setProductType(code);
    setActiveProject(null);
    setActiveView("analyze");
    setStep(0);
    setShowPicker(false);
  };
  const pickProject = (p: CostProject) => {
    setActiveProject(p);
    setActiveView("vave");
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

  // 绑定键细化到「具体工作页」：不同品类的成本分析、不同 VAVE 项目各自成桶，
  // 对话历史与右栏产出共用同一套桶，切走不丢、切回能恢复、互不串味。
  const bindKey =
    activeView === "analyze"
      ? `analyze:${productType}`
      : activeView === "vave" && activeProject
        ? `vave:${activeProject.id}`
        : null;
  const boundKey = bindKey ?? "free";

  // 右栏产出分桶：切工作页时把上一页的产出落回它自己的桶，再载入新页的桶。
  // 之前是「切换即清空」，导致切走再切回右栏凭空变空，而中栏对话却还在 —— 两者口径不一致。
  const artifactRef = useRef<AiArtifact | null>(null);
  const boundKeyRef = useRef<string>(boundKey);
  const prevBoundRef = useRef<string | null>(null);

  // 必须在切换 effect 之前同步，保证保存时拿到的是「旧桶的产出」
  useEffect(() => {
    artifactRef.current = artifact;
  }, [artifact]);

  useEffect(() => {
    if (prevBoundRef.current !== null) {
      saveArtifact(prevBoundRef.current, artifactRef.current);
    }
    prevBoundRef.current = boundKey;
    boundKeyRef.current = boundKey;
    setArtifact(loadArtifact(boundKey));
  }, [boundKey]);

  // 关闭页面 / 组件卸载前把当前产出落盘。
  // 只写非空值：卸载不等于「用户清空产出」，写 null 会把桶里已有的产出抹掉。
  useEffect(() => {
    const flush = () => {
      if (artifactRef.current) saveArtifact(boundKeyRef.current, artifactRef.current);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  const updateArtifact = useCallback((a: AiArtifact | null) => {
    setArtifact(a);
    saveArtifact(boundKeyRef.current, a);
  }, []);
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
    if (activeView === "vave") return { pct: 100, label: "VAVE 降本进行中" };
    if (activeView === "calibration") return { pct: 0, label: "校准录入" };
    if (activeView === "knowledge") return { pct: 0, label: "知识库管理" };
    return { pct: 0, label: "—" };
  }, [activeView, step]);

  const isEmpty = activeView === "none";

  return (
    <div className="flex h-screen flex-col gap-3 bg-slate-100 p-3">
      {/* 顶栏：全局栏（在三栏之外） */}
      <header className="flex h-14 shrink-0 items-center justify-between rounded-xl border border-slate-200 bg-white px-5 shadow-sm">
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
          <span
            title={ai.message || aiMeta.text}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600"
          >
            <span className={`h-2 w-2 rounded-full ${aiMeta.dot}`} />
            {aiMeta.text}
          </span>
          <button
            type="button"
            onClick={() => setActiveView("calibration")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            <FlaskConical className="h-4 w-4" /> 校准录入
          </button>
          <button
            type="button"
            onClick={() => setActiveView("knowledge")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            <Database className="h-4 w-4" /> 知识库
          </button>
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
      <div className="flex min-h-0 flex-1 gap-3">
        <LeftNav
          projects={projects}
          activeProjectId={activeProject?.id ?? null}
          activeView={activeView}
          productType={productType}
          analyzeStep={step}
          analyzeStepHints={analyzeStepHints}
          activeProject={activeProject}
          onPickProject={pickProject}
          onNewAnalyze={() => setShowPicker(true)}
          onExitToCenter={exitToCenter}
          uploadedDocs={uploadedDocs}
          onUploadDocs={handleUploadDocs}
          onRemoveDoc={handleRemoveDoc}
          fileRef={fileRef}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {isEmpty && (
            <div className="flex flex-1 flex-col items-center justify-center p-8">
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
                        className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-brand-400 hover:shadow"
                      >
                        <p className="font-medium text-brand-900">{p.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{p.code}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50">
                    <Layers className="h-7 w-7 text-brand-600" />
                  </div>
                  <h2 className="mt-5 text-lg font-semibold text-slate-800">从一次成本分析开始</h2>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    完成分析后可保存为项目，进入 VAVE 降本工作台；也可以先在左侧上传资料作为 AI 信息源。
                  </p>
                  <div className="mt-6 flex flex-col items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowPicker(true)}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      <Plus className="h-4 w-4" />
                      新建成本分析
                    </button>
                    <p className="text-xs text-slate-400">或从左侧选择已有项目</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isEmpty && (
            <>
              {activeView === "calibration" ? (
                <div className="min-h-0 flex-1">
                  <iframe src="/calibration-intake" className="h-full w-full border-0" title="校准录入" />
                </div>
              ) : activeView === "knowledge" ? (
                <div className="min-h-0 flex-1">
                  <iframe src="/admin/knowledge" className="h-full w-full border-0" title="知识库" />
                </div>
              ) : (
                <>
                  <div className="flex min-h-0 flex-1 flex-col p-6">
                    {activeView === "vave" && activeProject && (
                      <div className="mb-4 flex shrink-0 items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
                        <Zap className="h-4 w-4 text-brand-600" />
                        <span className="text-sm font-semibold text-brand-800">VAVE 降本工作台</span>
                        <span className="truncate text-xs text-brand-500">· {activeProject.name}</span>
                        <button
                          type="button"
                          onClick={exitToCenter}
                          className="ml-auto rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-white"
                        >
                          返回项目中心
                        </button>
                      </div>
                    )}
                    {activeView === "analyze" && (
                      <AnalyzeWorkView
                        productType={productType}
                        onExit={exitToCenter}
                        onSaved={onSaved}
                        onStep={handleAnalyzeStep}
                        onContext={setAnalyzeContextLabel}
                      />
                    )}
                    {activeView === "vave" && activeProject && (
                      <VaveWorkbench report={activeProject.report} input={activeProject.input} />
                    )}
                  </div>
                  {(activeView === "analyze" || activeView === "vave") && (
                    aiChatOpen ? (
                      <div className="h-[280px] shrink-0 border-t border-slate-200">
                        <AiChatPanel
                          bindKey={bindKey}
                          mainSourceLabel={mainSourceLabel}
                          mainSource={vaveMain}
                          onArtifact={updateArtifact}
                          onCollapse={() => setAiChatOpen(false)}
                          onUpdating={setAiUpdating}
                          onOpenSettings={() => setSettingsOpen(true)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAiChatOpen(true)}
                        className="flex h-11 shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 text-sm text-slate-600 hover:bg-slate-50"
                      >
                        <MessageSquare className="h-4 w-4 text-violet-600" />
                        <span className="font-medium">AI 副驾驶</span>
                        <ChevronUp className="ml-auto h-4 w-4" />
                      </button>
                    )
                  )}
                </>
              )}
            </>
          )}
        </main>

        {(activeView === "analyze" || activeView === "vave") && (
          <AiArtifactsPanel artifact={artifact} updating={aiUpdating} />
        )}
        {activeView === "none" && (
          <AiHomePanel
            projects={projects}
            uploadedDocs={uploadedDocs}
            onNewAnalyze={() => setShowPicker(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onPickProject={pickProject}
            onOpenCalibration={() => setActiveView("calibration")}
            onOpenKnowledge={() => setActiveView("knowledge")}
          />
        )}
      </div>

      {/* 底部进度条 */}
      <footer className="flex h-14 shrink-0 items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 shadow-sm">
        <span className="w-40 shrink-0 text-sm text-slate-500">{progress.label}</span>
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${progress.pct}%` }}
          />
        </div>
        <span className="text-sm tabular-nums text-slate-400">{progress.pct}%</span>
      </footer>

      <AiSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {typePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">选择表格品类</h3>
            <p className="mt-1 text-sm text-slate-500">
              未能自动识别「{typePicker.fileName}」的品类，请手动指定后继续导入。
            </p>
            <div className="mt-4 space-y-2">
              {typePicker.availableTypes.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  onClick={() => confirmType(t.code)}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-left text-sm hover:border-brand-400 hover:bg-brand-50"
                >
                  <span className="font-medium text-slate-700">{t.name}</span>
                  <span className="text-xs text-slate-400">{t.code}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setTypePicker(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {scanPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">扫描件抽取结果预览</h3>
            <p className="mt-1 text-sm text-slate-500">
              请核对视觉模型从「{scanPreview.fileName}」读取的报价表（共 {scanPreview.rowCount} 行）。
              确认无误后查看对比分析；若偏差较大，请在「AI 设置」配置更强视觉模型，或改用 xlsx 结构化上传。
            </p>
            <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    {scanPreview.extracted.headers.map((h, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap border-b border-slate-200 px-2 py-1.5 text-left font-medium text-slate-600"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scanPreview.extracted.rows.slice(0, 50).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td
                          key={ci}
                          className="whitespace-nowrap border-b border-slate-100 px-2 py-1 text-slate-700"
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {scanPreview.extracted.rows.length > 50 && (
                    <tr>
                      <td
                        colSpan={scanPreview.extracted.headers.length || 1}
                        className="px-2 py-1 text-slate-400"
                      >
                        … 其余 {scanPreview.extracted.rows.length - 50} 行
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setScanPreview(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => {
                  setScanPreview(null);
                  router.push("/import/compare");
                }}
                className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                查看对比分析
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
