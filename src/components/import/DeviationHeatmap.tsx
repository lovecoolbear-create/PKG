"use client";

import { useMemo, useState } from "react";
import { Flame, Info } from "lucide-react";
import type { ProductTypeConfig } from "@/types";
import type { ImportProductRow } from "@/lib/parse/import-shared";
import {
  buildDeviationHeatmap,
  amountLevel,
  DEVIATION_LEVELS,
  type HeatmapCell,
} from "@/lib/import/deviation";

/** 偏差色阶：负=占比低于基准（冷），正=高于基准（暖/红） */
const HEAT: Record<number, string> = {
  [-3]: "bg-emerald-200 text-emerald-900",
  [-2]: "bg-emerald-100 text-emerald-800",
  [-1]: "bg-emerald-50 text-emerald-700",
  0: "bg-white text-slate-600",
  1: "bg-amber-50 text-amber-800",
  2: "bg-amber-100 text-amber-900",
  3: "bg-rose-100 text-rose-900",
};

/** 金额色阶：0~3，越暖表示单只成本越重 */
const WARM: Record<number, string> = {
  0: "bg-white text-slate-600",
  1: "bg-orange-50 text-orange-800",
  2: "bg-orange-100 text-orange-900",
  3: "bg-rose-100 text-rose-900",
};

type Mode = "deviation" | "amount";

function cellTitle(
  c: HeatmapCell,
  basis: "expected" | "cohort",
  range: [number, number] | undefined,
  symbol: string
): string {
  const parts = [
    `${c.dimensionLabel} ${symbol}${c.perUnit}/只`,
    `占比 ${c.ratio}%`,
  ];
  if (basis === "expected" && range) parts.push(`预期区间 ${range[0]}~${range[1]}%`);
  if (c.cohortMedian != null) parts.push(`同批中位 ${Math.round(c.cohortMedian * 10) / 10}%`);
  if (c.deviation) parts.push(`偏差 ${c.deviation > 0 ? "+" : ""}${c.deviation}pp`);
  if (c.absent) parts.push("该行无此维度成本");
  return parts.join(" · ");
}

export function DeviationHeatmap({
  rows,
  config,
  symbol = "¥",
  onRowClick,
}: {
  rows: ImportProductRow[];
  config?: ProductTypeConfig;
  symbol?: string;
  onRowClick?: (index: number) => void;
}) {
  const [mode, setMode] = useState<Mode>("deviation");
  const model = useMemo(() => buildDeviationHeatmap(rows, config), [rows, config]);

  if (!model) return null;

  const ranges = new Map<string, [number, number]>();
  for (const d of config?.dimensions ?? []) {
    if (d.expectedRatioRange) ranges.set(d.key, d.expectedRatioRange);
  }
  const hasPrice = model.rows.some((r) => r.customerUnit != null);

  return (
    <section
      data-testid="deviation-heatmap"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <Flame className="h-4 w-4 text-orange-500" />
        <h2 className="text-sm font-semibold text-slate-800">五维结构偏差热力图</h2>
        <span
          data-testid="heatmap-basis"
          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
        >
          {model.basis === "expected"
            ? "基准：品类预期占比区间"
            : `基准：同批中位数（${model.cohortSize} 行）`}
        </span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-slate-200 text-[11px]">
          {(["deviation", "amount"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                mode === m
                  ? "bg-brand-700 px-2.5 py-1 text-white"
                  : "bg-white px-2.5 py-1 text-slate-500 hover:bg-slate-50"
              }
            >
              {m === "deviation" ? "结构偏差" : "单只金额"}
            </button>
          ))}
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-3 py-2 font-medium">产品</th>
              {model.dimensions.map((d) => (
                <th key={d.key} className="px-2 py-2 text-center font-medium">
                  {d.label}
                </th>
              ))}
              {hasPrice && (
                <th className="px-3 py-2 text-right font-medium">客户价 / 毛利</th>
              )}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr
                key={row.key}
                data-testid="heatmap-row"
                onClick={() => onRowClick?.(row.index)}
                className="cursor-pointer border-b border-slate-100 hover:bg-brand-50/40"
              >
                <td className="max-w-[14rem] px-3 py-2 align-middle">
                  <p className="truncate font-medium text-slate-800" title={row.name}>
                    {row.name}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {row.quantity.toLocaleString()} 只 · 我方 {symbol}
                    {row.ourUnit}/只
                    {row.missingFields.length > 0 && (
                      <span
                        className="ml-1 text-amber-600"
                        title={`缺失字段：${row.missingFields.join("、")}`}
                      >
                        ⚠{row.missingFields.length}
                      </span>
                    )}
                  </p>
                </td>

                {row.cells.map((c) => {
                  const dimMax =
                    model.dimensions.find((d) => d.key === c.dimension)?.maxPerUnit ?? 0;
                  const lv =
                    mode === "deviation" ? c.level : amountLevel(c.perUnit, dimMax);
                  const cls = mode === "deviation" ? HEAT[lv] : WARM[lv];
                  return (
                    <td
                      key={c.dimension}
                      data-testid="heatmap-cell"
                      data-level={lv}
                      data-dimension={c.dimension}
                      title={cellTitle(c, model.basis, ranges.get(c.dimension), symbol)}
                      className={`px-2 py-2 text-center tabular-nums ${cls ?? "bg-white text-slate-600"} ${
                        c.absent ? "opacity-40" : ""
                      }`}
                    >
                      <div className="text-[13px]">
                        {symbol}
                        {c.perUnit}
                      </div>
                      <div className="text-[11px] opacity-80">
                        {c.ratio}%
                        {mode === "deviation" && c.deviation !== 0 && (
                          <span className="ml-1 font-medium">
                            {c.deviation > 0 ? "▲" : "▼"}
                            {Math.abs(c.deviation)}
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}

                {hasPrice && (
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {row.customerUnit != null ? (
                      <>
                        <div>
                          {symbol}
                          {row.customerUnit}
                        </div>
                        <div
                          className={`text-[11px] ${
                            (row.margin ?? 0) >= 0 ? "text-emerald-600" : "text-rose-600"
                          }`}
                        >
                          {row.margin != null ? `${row.margin}%` : "—"}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="space-y-2 border-t border-slate-200 px-4 py-3 text-[11px] text-slate-500">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-slate-600">
            {mode === "deviation" ? "偏差色阶（百分点）" : "金额色阶（单只）"}
          </span>
          <span className="flex items-center gap-1">
            {mode === "deviation" ? (
              <>
                <i className="inline-block h-3 w-5 rounded bg-emerald-200" /> 低于基准
                <i className="ml-2 inline-block h-3 w-5 rounded bg-white ring-1 ring-slate-200" />{" "}
                区间内（±{DEVIATION_LEVELS[0]}pp 内）
                <i className="ml-2 inline-block h-3 w-5 rounded bg-amber-100" /> 偏高
                <i className="ml-2 inline-block h-3 w-5 rounded bg-rose-100" /> 显著偏高
              </>
            ) : (
              <>
                <i className="inline-block h-3 w-5 rounded bg-white ring-1 ring-slate-200" /> 轻
                <i className="ml-2 inline-block h-3 w-5 rounded bg-orange-100" /> 中
                <i className="ml-2 inline-block h-3 w-5 rounded bg-rose-100" /> 重
              </>
            )}
          </span>
        </div>

        {model.cohortSkew.length > 0 && (
          <p data-testid="heatmap-skew" className="text-amber-700">
            ⚠ 整批同向偏离基准：
            {model.cohortSkew
              .map(
                (s) =>
                  `${s.dimensionLabel} ${s.direction === "high" ? "偏高" : "偏低"}（${s.count} 行同向，均 ${
                    s.avgDeviation > 0 ? "+" : ""
                  }${s.avgDeviation}pp）`
              )
              .join("、")}
            —— 这种情况先怀疑基准或字段口径，而不是单个产品。
          </p>
        )}

        {model.outliers.length > 0 && (
          <div data-testid="heatmap-outliers" className="space-y-1">
            <span className="font-medium text-slate-600">结构异常 Top {model.outliers.length}</span>
            {model.outliers.map((o) => (
              <p key={`${o.rowIndex}-${o.dimension}`} className="text-slate-500">
                <span className="text-slate-700">{o.rowName}</span> · {o.dimensionLabel}{" "}
                <span className={o.direction === "high" ? "text-rose-600" : "text-emerald-600"}>
                  {o.direction === "high" ? "高于基准" : "低于基准"} {Math.abs(o.deviation)}pp
                </span>
                （{o.ratio}% · {symbol}
                {o.perUnit}/只）
                {o.direction === "high"
                  ? " —— 该维度是这行的成本重心，优先谈"
                  : " —— 明显低于基准，先核字段是否填漏"}
              </p>
            ))}
          </div>
        )}

        <p className="flex items-start gap-1 text-slate-400">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          客户报价只有单只总价、没有五维分解，刻意不按我方占比把客户价摊到各维度（那样每行同色、没有信息量）。
          这里的偏差是<b className="text-slate-500">结构偏差</b>：我方维度占比 vs 基准占比，用来定位异常行与降本靶点。
        </p>
      </footer>
    </section>
  );
}
