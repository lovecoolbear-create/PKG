"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderOpen, Trash2 } from "lucide-react";
import { listProjects, deleteProject } from "@/lib/project-store";
import type { CostProject } from "@/types";

/** 首页「我的项目」区块：读 localStorage 展示已保存的成本项目，可一键进入 VAVE */
export function ProjectListCard() {
  const [projects, setProjects] = useState<CostProject[]>([]);

  useEffect(() => {
    setProjects(listProjects());
  }, []);

  if (projects.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-bold text-brand-900">
          <FolderOpen className="h-5 w-5 text-brand-700" />
          我的项目
        </h2>
        <Link
          href="/work"
          className="text-sm font-medium text-brand-600 hover:text-brand-800"
        >
          进入工作台 →
        </Link>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <div key={p.id} className="card p-4">
            <p className="truncate font-semibold text-brand-900" title={p.name}>
              {p.name}
            </p>
            <p className="mt-1 text-xs text-brand-500">
              {new Date(p.createdAt).toLocaleString("zh-CN")}
            </p>
            <p className="mt-2 text-sm text-brand-700">
              {p.report.productType === "flat_print" ? "每册/张" : "单只"} ¥
              {p.report.totalCost.perUnit.max}
              <span className="ml-2 text-brand-400">
                / 总 ¥{p.report.totalCost.max.toLocaleString()}
              </span>
            </p>
            <div className="mt-3 flex items-center justify-between">
              <Link
                href={`/vave?projectId=${p.id}`}
                className="btn-secondary py-1.5 px-3 text-sm"
              >
                VAVE 分析
              </Link>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`确认删除项目「${p.name}」？`)) {
                    deleteProject(p.id);
                    setProjects(listProjects());
                  }
                }}
                className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
