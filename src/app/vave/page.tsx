"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Layers } from "lucide-react";
import { listProjects, getProject, deleteProject } from "@/lib/project-store";
import type { AnalysisInput, AnalysisReport, CostProject } from "@/types";
import { VaveWorkbench } from "@/components/vave/VaveWorkbench";
import { VaveNewForm } from "@/components/vave/VaveNewForm";

export default function VavePage() {
  const [mode, setMode] = useState<"select" | "new" | null>(null);
  const [projects, setProjects] = useState<CostProject[]>([]);
  const [active, setActive] = useState<{
    report: AnalysisReport;
    input: AnalysisInput;
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const list = listProjects();
    setProjects(list);
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("projectId");
    if (pid) {
      const p = getProject(pid);
      if (p) {
        setActive({ report: p.report, input: p.input });
        setActiveId(pid);
        return;
      }
    }
    setMode(list.length > 0 ? "select" : "new");
  }, []);

  if (!mode && !active) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="sticky top-0 z-30 border-b border-brand-200 bg-white">
        <div className="flex items-center justify-between px-4 py-3 lg:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Layers className="h-6 w-6 text-brand-800" />
            <span className="text-base font-semibold text-brand-900">
              VAVE 降本工作台
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {activeId && (
              <Link
                href={`/ai?bind=vave:${activeId}`}
                className="text-sm text-violet-600 hover:text-violet-800"
              >
                就此项目问 AI
              </Link>
            )}
            <Link
              href="/analyze"
              className="text-sm text-brand-600 hover:text-brand-800"
            >
              成本分析
            </Link>
            <Link href="/" className="btn-secondary py-1.5 px-3 text-sm">
              返回首页
            </Link>
          </div>
        </div>
      </header>

      {active ? (
        <VaveWorkbench report={active.report} input={active.input} />
      ) : mode === "select" ? (
        <SelectProject
          projects={projects}
          onPick={(p) => {
            setActiveId(p.id);
            setActive({ report: p.report, input: p.input });
          }}
          onNew={() => setMode("new")}
          onDelete={(id) => setProjects(listProjects())}
        />
      ) : (
        <VaveNewForm
          onAnalyzed={(r, i) => {
            setActiveId(null);
            setActive({ report: r, input: i });
          }}
        />
      )}
    </div>
  );
}

function SelectProject({
  projects,
  onPick,
  onNew,
  onDelete,
}: {
  projects: CostProject[];
  onPick: (p: CostProject) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h2 className="text-xl font-bold text-brand-900">选择已有项目</h2>
      <p className="mt-1 text-sm text-brand-500">
        基于已保存的成本项目进入 VAVE（不重算、不丢上下文）。
      </p>
      <div className="mt-6 space-y-3">
        {projects.map((p) => (
          <div key={p.id} className="flex items-center gap-3">
            <button
              onClick={() => onPick(p)}
              className="card flex-1 p-4 text-left hover:border-brand-400"
            >
              <p className="font-semibold text-brand-900">{p.name}</p>
              <p className="mt-1 text-xs text-brand-500">
                {new Date(p.createdAt).toLocaleString("zh-CN")} ·{" "}
                {p.report.productType === "flat_print" ? "每册/张" : "单只"} ¥
                {p.report.totalCost.perUnit.max}
              </p>
            </button>
            <Link
              href={`/ai?bind=vave:${p.id}`}
              className="text-xs text-violet-600 hover:text-violet-800"
            >
              就此项目问 AI
            </Link>
            <button
              onClick={() => {
                if (confirm(`确认删除项目「${p.name}」？`)) {
                  deleteProject(p.id);
                  onDelete(p.id);
                }
              }}
              className="text-xs text-red-500 hover:text-red-700"
            >
              删除
            </button>
          </div>
        ))}
        <button
          onClick={onNew}
          className="text-sm text-brand-600 hover:text-brand-800"
        >
          或新建一份成本分析 →
        </button>
      </div>
    </div>
  );
}
