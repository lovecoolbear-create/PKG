"use client";

import { useEffect, useState } from "react";
import type { AnalysisInput, AnalysisReport } from "@/types";
import { TTL_DAYS, CONFLICT_RATE_THRESHOLD } from "@/lib/vave/rule-lifecycle";

interface RuleRow {
  id: string;
  title: string;
  target: string;
  boxType: string | null;
  material: string | null;
  loadClass: string | null;
  proposedValue: string;
  ruleJson: unknown;
  confidence: number;
  status: "ACTIVE" | "DEPRECATED" | "PENDING";
  usageCount: number;
  triggerCount: number;
  conflictCount: number;
  createdAt: string;
  lastTriggeredAt: string | null;
  deprecatedAt: string | null;
}

interface RetrievedRow {
  id: string;
  title: string;
  target: string;
  boxType: string | null;
  material: string | null;
  loadClass: string | null;
  proposedValue: string;
  confidence: number;
  usageCount: number;
  status: string;
  score: number;
}

function conflictRate(r: RuleRow): number {
  return r.triggerCount > 0 ? r.conflictCount / r.triggerCount : 0;
}
function daysSince(s?: string | null): number | null {
  if (!s) return null;
  return Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000);
}

export function RuleClosurePanel() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // 检索区
  const [boxType, setBoxType] = useState("");
  const [material, setMaterial] = useState("");
  const [loadClass, setLoadClass] = useState("");
  const [query, setQuery] = useState("");
  const [retrieved, setRetrieved] = useState<RetrievedRow[] | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/vave/rules");
      const data = await res.json();
      setRules(data.rules ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function runSweep() {
    setMsg("");
    const res = await fetch("/api/vave/rules/sweep", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      setMsg(`TTL 扫描完成：扫描 ${data.scanned} 条，弃用 ${data.deprecatedIds.length} 条。`);
      load();
    } else setMsg("扫描失败：" + (data.error ?? ""));
  }

  async function runRetrieve() {
    setMsg("");
    const res = await fetch("/api/vave/rules/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boxType: boxType || null,
        material: material || null,
        loadClass: loadClass || null,
        query: query || undefined,
        limit: 20,
      }),
    });
    const data = await res.json();
    if (data.ok) setRetrieved(data.rules ?? []);
    else setMsg("检索失败：" + (data.error ?? ""));
  }

  const active = rules.filter((r) => r.status === "ACTIVE").length;
  const deprecated = rules.filter((r) => r.status === "DEPRECATED").length;

  return (
    <div className="space-y-5">
      {/* 概览 + TTL 扫描 */}
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-900">
            AI 降本规则闭环（P9）
          </h3>
          <button
            onClick={runSweep}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            运行 TTL 扫描
          </button>
        </div>
        <p className="mt-1 text-xs text-brand-500">
          规则生命周期：连续 {TTL_DAYS} 天未触发或冲突率 ≥ {CONFLICT_RATE_THRESHOLD} 自动标记{" "}
          <span className="font-semibold text-brand-700">DEPRECATED</span>（停用）。
        </p>
        <div className="mt-3 flex gap-3 text-sm">
          <span className="rounded bg-emerald-50 px-3 py-1 text-emerald-700">
            生效 ACTIVE：{active}
          </span>
          <span className="rounded bg-red-50 px-3 py-1 text-red-700">
            已弃用 DEPRECATED：{deprecated}
          </span>
          <span className="rounded bg-brand-50 px-3 py-1 text-brand-700">
            总计：{rules.length}
          </span>
        </div>
        {msg && <p className="mt-2 text-sm text-brand-600">{msg}</p>}
      </div>

      {/* 规则库列表：状态 / TTL / 使用频次 / 冲突率 */}
      <div className="card p-5">
        <h4 className="text-sm font-bold text-brand-900">规则库（生命周期视图）</h4>
        {loading ? (
          <p className="mt-2 text-xs text-brand-500">加载中…</p>
        ) : rules.length === 0 ? (
          <p className="mt-2 text-xs text-brand-500">
            暂无降本规则。可在「知识沉淀」页将 LLM 提案一键固化为确定性规则。
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-brand-500">
                <tr className="border-b border-brand-200">
                  <th className="py-2 pr-2">标题</th>
                  <th className="py-2 pr-2">箱型/材质/承重</th>
                  <th className="py-2 pr-2">状态</th>
                  <th className="py-2 pr-2">使用</th>
                  <th className="py-2 pr-2">冲突率</th>
                  <th className="py-2 pr-2">距上次触发</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const cr = conflictRate(r);
                  const stale = daysSince(r.lastTriggeredAt ?? r.createdAt);
                  return (
                    <tr key={r.id} className="border-b border-brand-100">
                      <td className="py-2 pr-2">
                        <div className="font-medium text-brand-900">{r.title}</div>
                        <div className="text-[11px] text-brand-500">
                          {r.proposedValue}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-brand-600">
                        {[r.boxType, r.material, r.loadClass]
                          .filter(Boolean)
                          .join(" / ") || "—"}
                      </td>
                      <td className="py-2 pr-2">
                        <span
                          className={`rounded px-2 py-0.5 ${
                            r.status === "ACTIVE"
                              ? "bg-emerald-100 text-emerald-700"
                              : r.status === "DEPRECATED"
                              ? "bg-red-100 text-red-700"
                              : "bg-brand-100 text-brand-700"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-brand-600">
                        {r.usageCount}
                        <span className="text-brand-400"> / 触发{r.triggerCount}</span>
                      </td>
                      <td
                        className={`py-2 pr-2 ${
                          cr >= CONFLICT_RATE_THRESHOLD
                            ? "font-semibold text-red-600"
                            : "text-brand-600"
                        }`}
                      >
                        {(cr * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 pr-2 text-brand-600">
                        {stale == null ? "—" : `${stale}天`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 规格3：元数据预过滤 + 语义检索 */}
      <div className="card p-5">
        <h4 className="text-sm font-bold text-brand-900">
          案例检索（确定性预过滤 → 语义重排）
        </h4>
        <p className="mt-1 text-xs text-brand-500">
          先按箱型/材质/承重等级确定性收敛候选，再按查询文本语义向量余弦排序。
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            value={boxType}
            onChange={(e) => setBoxType(e.target.value)}
            placeholder="箱型 (single_wall…)"
            className="rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
          <input
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="材质 (kraft…)"
            className="rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
          <input
            value={loadClass}
            onChange={(e) => setLoadClass(e.target.value)}
            placeholder="承重 (light/medium/heavy)"
            className="rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="语义查询 (如：双坑降单坑降本)"
            className="rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
        </div>
        <button
          onClick={runRetrieve}
          className="mt-3 rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white"
        >
          检索案例
        </button>

        {retrieved && (
          <div className="mt-4 space-y-2">
            {retrieved.length === 0 ? (
              <p className="text-xs text-brand-500">无匹配规则。</p>
            ) : (
              retrieved.map((r) => (
                <div
                  key={r.id}
                  className="rounded-md border border-brand-200 bg-brand-50/40 p-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-brand-900">{r.title}</span>
                    <span className="text-xs text-brand-500">
                      余弦 {r.score.toFixed(3)} · 使用 {r.usageCount}
                    </span>
                  </div>
                  <p className="mt-1 text-brand-700">{r.proposedValue}</p>
                  <p className="mt-1 text-[11px] text-brand-500">
                    {[r.boxType, r.material, r.loadClass].filter(Boolean).join(" / ") ||
                      "无元数据"}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
