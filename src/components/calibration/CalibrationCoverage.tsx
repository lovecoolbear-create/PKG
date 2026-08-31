"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProductTypeConfig } from "@/types";
import {
  summarizeCoverage,
  caseOfProductType,
  validateCase,
  type CaseLike,
} from "@/lib/calibration/validate";

/** 地域代码 → 中文（兜底：原样显示代码） */
const REGION_LABELS: Record<string, string> = {
  east_china: "华东",
  south_china: "华南(dg)",
  north_china: "华北",
  central_china: "华中",
  southwest: "西南",
  unknown: "未填",
};

export function CalibrationCoverage({
  productTypes,
  refreshToken = 0,
  onDeleted,
  onCountChange,
}: {
  productTypes: ProductTypeConfig[];
  refreshToken?: number;
  onDeleted?: (count: number) => void;
  /** 案例数变化上报（供「跑校准」按钮判断是否可跑） */
  onCountChange?: (count: number) => void;
}) {
  const [cases, setCases] = useState<CaseLike[]>([]);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/calibration/cases")
      .then((r) => r.json())
      .then((d) => {
        setCases(Array.isArray(d.cases) ? d.cases : []);
        setSource(d.source ?? "");
        setErr(null);
        onCountChange?.(Array.isArray(d.cases) ? d.cases.length : 0);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [refreshToken]);

  const cov = useMemo(() => summarizeCoverage(cases), [cases]);
  const ptLabel = (code: string) =>
    productTypes.find((p) => p.code === code)?.name ?? code;

  const pct = Math.min(100, Math.round((cov.total / cov.target) * 100));
  const reached = cov.total >= cov.target;

  async function remove(caseId: string) {
    if (!confirm(`删除案例「${caseId}」？此操作会直接从 calibration-cases.json 移除。`)) return;
    setDeleting(caseId);
    try {
      const res = await fetch(`/api/calibration/cases?caseId=${encodeURIComponent(caseId)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErr(data.error || "删除失败");
        return;
      }
      setCases((prev) => prev.filter((c) => String(c.caseId) !== caseId));
      onDeleted?.(data.count);
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="card mb-5 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-brand-900">攒案例进度</h2>
        <span className="text-xs text-brand-400">数据源：{source || "—"}</span>
      </div>

      {loading && <p className="text-sm text-brand-500">加载中…</p>}
      {err && <p className="text-sm text-red-700">读取失败：{err}</p>}

      {!loading && !err && (
        <>
          {/* 进度条 */}
          <div className="mb-4">
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="font-medium text-brand-800">
                当前 {cov.total} 例 / 起步目标 {cov.target} 例（建议 {cov.target}–{cov.targetMax}）
              </span>
              <span className={reached ? "text-green-700" : "text-brand-500"}>
                {reached ? "已够跑第一轮校准" : `还差 ${cov.target - cov.total} 例`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100">
              <div
                className={`h-full rounded-full ${reached ? "bg-green-500" : "bg-brand-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* 覆盖矩阵 */}
          <div className="mb-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-brand-600">品类分布</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(cov.byProductType).map(([k, v]) => (
                  <span
                    key={k}
                    className="rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-800"
                  >
                    {ptLabel(k)} {v}
                  </span>
                ))}
                {cov.total === 0 && <span className="text-xs text-brand-400">暂无案例</span>}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-brand-600">地域分布</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(cov.byRegion).map(([k, v]) => (
                  <span
                    key={k}
                    className="rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-800"
                  >
                    {REGION_LABELS[k] ?? k} {v}
                  </span>
                ))}
                {cov.total === 0 && <span className="text-xs text-brand-400">暂无案例</span>}
              </div>
            </div>
          </div>

          {/* 缺口提示 */}
          {(cov.missingProductTypes.length > 0 || cov.missingRegions.length > 0) &&
            cov.total > 0 && (
              <p className="mb-3 text-xs text-amber-700">
                还缺：
                {cov.missingProductTypes.map((p) => ptLabel(p)).join("、")}
                {cov.missingProductTypes.length && cov.missingRegions.length ? "；" : ""}
                {cov.missingRegions.map((r) => REGION_LABELS[r] ?? r).join("、")}
                {cov.missingRegions.length ? " 的案例" : ""}
                （跨品类/跨地域才能验证常数是否真通用）
              </p>
            )}

          <div className="mb-4 flex flex-wrap gap-3 text-xs text-brand-600">
            <span>完整五维拆解 {cov.fullDims} 例</span>
            <span>带外部锚 {cov.withAnchor} 例</span>
          </div>

          {/* 案例列表 */}
          {cases.length > 0 && (
            <details open={cases.length <= 8}>
              <summary className="cursor-pointer text-sm font-medium text-brand-700">
                已录入 {cases.length} 例（点击展开/收起）
              </summary>
              <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-brand-100">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-brand-50 text-brand-700">
                    <tr>
                      <th className="px-2 py-2">案例标识</th>
                      <th className="px-2 py-2">品类</th>
                      <th className="px-2 py-2">地域</th>
                      <th className="px-2 py-2">实际总价</th>
                      <th className="px-2 py-2">质量</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c, i) => {
                      const { errors, warnings } = validateCase(c);
                      const region =
                        (c.input?.deliveryLocation as string) ||
                        (c.input?.laborRegion as string) ||
                        "unknown";
                      return (
                        <tr key={`${String(c.caseId)}-${i}`} className="border-t border-brand-50">
                          <td className="px-2 py-1.5">{String(c.caseId ?? "—")}</td>
                          <td className="px-2 py-1.5">{ptLabel(caseOfProductType(c))}</td>
                          <td className="px-2 py-1.5">{REGION_LABELS[region] ?? region}</td>
                          <td className="px-2 py-1.5">
                            {typeof c.actual?.total === "number"
                              ? `¥${c.actual.total.toLocaleString()}`
                              : "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            {errors.length ? (
                              <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">
                                {errors.length} 处阻断
                              </span>
                            ) : warnings.length ? (
                              <span
                                className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700"
                                title={warnings.map((w) => w.message).join("\n")}
                              >
                                {warnings.length} 处提示
                              </span>
                            ) : (
                              <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">
                                完整
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              className="text-red-600 hover:underline disabled:opacity-40"
                              onClick={() => remove(String(c.caseId ?? ""))}
                              disabled={deleting === String(c.caseId ?? "")}
                            >
                              {deleting === String(c.caseId ?? "") ? "删除中…" : "删除"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
