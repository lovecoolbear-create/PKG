"use client";

import { useState } from "react";
import { Loader2, Check, Info } from "lucide-react";
import type { AnalysisInput, AnalysisReport } from "@/types";

// 克重档位（由低到高），用于「降一档」查找
const GRAMMAGE_STEPS = [80, 105, 128, 157, 200, 250];

function downOneGrammage(g?: string | number): number | undefined {
  const v = Number(g);
  if (!v) return undefined;
  const lower = [...GRAMMAGE_STEPS].reverse().find((s) => s < v);
  return lower;
}

// 瓦楞双坑 → 单坑（省一层瓦楞芯纸）
const DOUBLE_TO_SINGLE: Record<string, string> = {
  BC: "B",
  AB: "A",
  BE: "E",
};

type OverrideFn = (input: AnalysisInput) => AnalysisInput;

interface Scenario {
  id: string;
  label: string;
  desc: string;
  applies: (input: AnalysisInput) => boolean;
  build: OverrideFn;
}

const SCENARIOS: Scenario[] = [
  {
    id: "grammage_down",
    label: "克重优化（降一档）",
    desc: "面纸/内页/封面克重各降一档，材料成本直接下降（需确认强度满足要求）。",
    applies: (i) =>
      Object.keys(i).some(
        (k) =>
          k.toLowerCase().includes("grammage") &&
          downOneGrammage(i[k] as string | number) !== undefined
      ),
    build: (i) => {
      const out: AnalysisInput = { ...i };
      for (const k of Object.keys(out)) {
        if (k.toLowerCase().includes("grammage")) {
          const lower = downOneGrammage(out[k] as string | number);
          if (lower !== undefined) out[k] = lower;
        }
      }
      return out;
    },
  },
  {
    id: "qty_double",
    label: "批量提升（×2）",
    desc: "数量翻倍，制版/设计固定费摊薄、采购单价随量下探。",
    applies: (i) => Number(i.quantity) > 0,
    build: (i) => ({
      ...i,
      quantity: Math.max(1, Math.round(Number(i.quantity) * 2)),
    }),
  },
  {
    id: "no_surface",
    label: "去表面处理",
    desc: "取消覆膜/上光等表面处理，省去对应加工费（需确认外观与防护要求）。",
    applies: (i) => Boolean(i.surfaceTreatment) && i.surfaceTreatment !== "none",
    build: (i) => ({ ...i, surfaceTreatment: "none" }),
  },
  {
    id: "flute_down",
    label: "换单坑（瓦楞）",
    desc: "双坑改单坑，省去一层瓦楞芯纸材料，适合强度余量充足的场景。",
    applies: (i) =>
      Boolean(i.fluteType) && DOUBLE_TO_SINGLE[String(i.fluteType)] !== undefined,
    build: (i) => ({ ...i, fluteType: DOUBLE_TO_SINGLE[String(i.fluteType)] }),
  },
];

interface ScenarioRow {
  scenario: Scenario;
  report: AnalysisReport;
  quantity: number;
}

function dimAmount(report: AnalysisReport, code: string): number {
  return report.dimensions.find((d) => d.dimension === code)?.estimatedAmount ?? 0;
}

export function ScenarioPanel({
  baseReport,
  baseInput,
  productType,
}: {
  baseReport: AnalysisReport;
  baseInput: AnalysisInput;
  productType: string;
}) {
  const unit = baseReport.productType === "flat_print" ? "册/张" : "只";
  const applicable = SCENARIOS.filter((s) => s.applies(baseInput));
  const [selected, setSelected] = useState<Set<string>>(
    new Set(applicable.map((s) => s.id))
  );
  const [rows, setRows] = useState<ScenarioRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    const chosen = applicable.filter((s) => selected.has(s.id));
    if (chosen.length === 0) return;
    setLoading(true);
    try {
      const results = await Promise.all(
        chosen.map(async (s) => {
          const input = s.build(baseInput);
          const res = await fetch("/api/vave/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input, productType }),
          });
          const data = await res.json();
          return {
            scenario: s,
            report: data.report as AnalysisReport,
            quantity: Number(input.quantity) || Number(baseInput.quantity) || 1,
          };
        })
      );
      const basePerUnit = baseReport.totalCost.perUnit.max;
      results.sort((a, b) => {
        const ra = (basePerUnit - a.report.totalCost.perUnit.max) / basePerUnit;
        const rb = (basePerUnit - b.report.totalCost.perUnit.max) / basePerUnit;
        return rb - ra;
      });
      setRows(results);
    } finally {
      setLoading(false);
    }
  };

  const basePerUnit = baseReport.totalCost.perUnit.max;
  const baseMaterial = dimAmount(baseReport, "material");
  const baseQty = Number(baseInput.quantity) || 1;
  const baseUnitMaterial = baseMaterial / baseQty;

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">多情景 VAVE 对比</h3>
        <p className="mt-1 text-xs text-brand-500">
          勾选降本情景（各基于基线独立测算，便于横向比较「改哪里最划算」）。一键跑全部后按降本幅度排序，自动定位最优杠杆。下方金额均为单只口径，可直接比较。
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {applicable.map((s) => {
            const on = selected.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition ${
                  on
                    ? "border-brand-500 bg-brand-50"
                    : "border-brand-200 bg-white hover:border-brand-300"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    on
                      ? "border-brand-600 bg-brand-600 text-white"
                      : "border-brand-300"
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-brand-900">
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-brand-500">
                    {s.desc}
                  </span>
                </span>
              </button>
            );
          })}
          {applicable.length === 0 && (
            <p className="text-sm text-brand-400">
              当前方案暂无可自动生成的降本情景。
            </p>
          )}
        </div>

        <button
          onClick={run}
          disabled={loading || applicable.length === 0}
          className="btn-primary mt-4"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "一键跑全部情景"
          )}
        </button>
      </div>

      {rows && (
        <div className="card p-5">
          <h3 className="text-base font-bold text-brand-900">
            对比结果（按降本幅度排序）
          </h3>
          <p className="mt-1 text-xs text-brand-500">
            基线：每{unit} ¥{basePerUnit.toFixed(3)}（总成本 ¥
            {baseReport.totalCost.max.toLocaleString()}）
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-brand-200 text-left text-xs text-brand-500">
                  <th className="py-2 pr-3 font-medium">情景</th>
                  <th className="py-2 px-3 font-medium">单只成本</th>
                  <th className="py-2 px-3 font-medium">降本 ¥</th>
                  <th className="py-2 px-3 font-medium">降本 %</th>
                  <th className="py-2 px-3 font-medium">材料(单只)</th>
                  <th className="py-2 px-3 font-medium">加工(单只)</th>
                  <th className="py-2 px-3 font-medium">设计(单只)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const perUnit = r.report.totalCost.perUnit.max;
                  const cut = Math.round((basePerUnit - perUnit) * 10000) / 10000;
                  const cutPct =
                    basePerUnit > 0 ? Math.round((cut / basePerUnit) * 1000) / 10 : 0;
                  const isBest = idx === 0 && cut > 0;
                  const matUnit = dimAmount(r.report, "material") / r.quantity;
                  const matUnitDiff =
                    Math.round((matUnit - baseUnitMaterial) * 100) / 100;
                  return (
                    <tr
                      key={r.scenario.id}
                      className={`border-b border-brand-100 ${
                        isBest ? "bg-emerald-50/60" : ""
                      }`}
                    >
                      <td className="py-2 pr-3">
                        <span className="font-medium text-brand-900">
                          {r.scenario.label}
                        </span>
                        {isBest && (
                          <span className="ml-2 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            最优杠杆
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-brand-800">
                        ¥{perUnit.toFixed(3)}
                      </td>
                      <td className="py-2 px-3 font-medium text-emerald-700">
                        {cut > 0 ? `-¥${cut.toFixed(3)}` : "—"}
                      </td>
                      <td className="py-2 px-3 font-medium text-emerald-700">
                        {cut > 0 ? `${cutPct}%` : "0%"}
                      </td>
                      <td className="py-2 px-3 text-brand-700">
                        ¥{matUnit.toFixed(3)}
                        <span className="ml-1 text-xs text-brand-400">
                          {matUnitDiff < 0
                            ? `省¥${-matUnitDiff}`
                            : matUnitDiff > 0
                            ? `增¥${matUnitDiff}`
                            : "—"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-brand-700">
                        ¥
                        {(dimAmount(r.report, "process") / r.quantity).toFixed(3)}
                      </td>
                      <td className="py-2 px-3 text-brand-700">
                        ¥
                        {(dimAmount(r.report, "design_plate") / r.quantity).toFixed(3)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(() => {
            const best =
              rows.find((r) => basePerUnit - r.report.totalCost.perUnit.max > 0) ??
              null;
            if (!best) return null;
            const cut = basePerUnit - best.report.totalCost.perUnit.max;
            const cutPct = Math.round((cut / basePerUnit) * 1000) / 10;
            const totalSave =
              Math.round(cut * Number(baseInput.quantity || 0) * 100) / 100;
            return (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-sm text-emerald-900">
                  综合建议：优先落地「{best.scenario.label}」，单{unit}可降 ¥
                  {cut.toFixed(3)}（{cutPct}%），按当前{" "}
                  {Number(baseInput.quantity || 0).toLocaleString()} {unit} 测算总降本约 ¥
                  {totalSave.toLocaleString()}。
                </p>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
