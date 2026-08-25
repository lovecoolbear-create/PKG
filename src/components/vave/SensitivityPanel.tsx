"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceDot,
} from "recharts";
import { Loader2 } from "lucide-react";
import type { AnalysisInput, AnalysisReport } from "@/types";

const QTY_STEPS = [1000, 2000, 5000, 10000, 20000, 50000];

const SURFACE_OPTIONS = [
  { value: "none", label: "无" },
  { value: "matte_laminate", label: "哑膜" },
  { value: "gloss_laminate", label: "亮膜" },
  { value: "uv", label: "UV上光" },
  { value: "foil", label: "烫金/烫银" },
  { value: "emboss", label: "压纹/击凸" },
];

function analyzeQtyCurve(data: { qty: number; perUnit: number }[]): string {
  if (data.length < 2) return "";
  let best = { a: data[0], b: data[1], drop: 0 };
  for (let i = 0; i < data.length - 1; i++) {
    const drop = data[i].perUnit - data[i + 1].perUnit;
    if (drop > best.drop) best = { a: data[i], b: data[i + 1], drop };
  }
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const lastDrop = prev.perUnit - last.perUnit;
  return `重点加量区间：${best.a.qty / 1000}k→${best.b.qty / 1000}k（单只降¥${best.drop.toFixed(3)}）；批量达 ${last.qty / 1000}k 后边际降本趋缓（每翻倍仅降¥${lastDrop.toFixed(3)}）。`;
}

export function SensitivityPanel({
  baseReport,
  baseInput,
}: {
  baseReport: AnalysisReport;
  baseInput: AnalysisInput;
}) {
  const unit = baseReport.productType === "flat_print" ? "册/张" : "只";
  const [qtyData, setQtyData] = useState<
    { qty: number; perUnit: number }[] | null
  >(null);
  const [loadingQty, setLoadingQty] = useState(false);
  const [paperPct, setPaperPct] = useState(0);
  const [surface, setSurface] = useState<string>(
    String(baseInput.surfaceTreatment ?? "none")
  );
  const [surfaceReport, setSurfaceReport] = useState<AnalysisReport | null>(
    null
  );
  const [loadingSurface, setLoadingSurface] = useState(false);

  const runQty = async () => {
    setLoadingQty(true);
    try {
      const results = await Promise.all(
        QTY_STEPS.map(async (q) => {
          const res = await fetch("/api/vave/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: { ...baseInput, quantity: q } }),
          });
          const data = await res.json();
          const r = data.report as AnalysisReport;
          return { qty: q, perUnit: r.totalCost.perUnit.max };
        })
      );
      setQtyData(results);
    } finally {
      setLoadingQty(false);
    }
  };

  const runSurface = async () => {
    setLoadingSurface(true);
    try {
      const res = await fetch("/api/vave/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { ...baseInput, surfaceTreatment: surface } }),
      });
      const data = await res.json();
      setSurfaceReport(data.report as AnalysisReport);
    } finally {
      setLoadingSurface(false);
    }
  };

  // 纸价冲击：材料金额线性近似（标注，非重跑引擎）
  const material = baseReport.dimensions.find((d) => d.dimension === "material");
  const otherTotal = baseReport.dimensions
    .filter((d) => d.dimension !== "material")
    .reduce((s, d) => s + d.estimatedAmount, 0);
  const baseTotal = Math.round(
    baseReport.dimensions.reduce((s, d) => s + d.estimatedAmount, 0) * 100
  ) / 100;
  const newMaterial = material
    ? Math.round(material.estimatedAmount * (1 + paperPct / 100) * 100) / 100
    : 0;
  const newTotal = Math.round((otherTotal + newMaterial) * 100) / 100;
  const newMaterialRatio =
    material && baseTotal > 0
      ? Math.round((newMaterial / baseTotal) * 1000) / 10
      : 0;

  return (
    <div className="space-y-6">
      {/* 量价曲线 */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-brand-900">
            量价敏感性（每{unit}成本随数量下降）
          </h3>
          <button onClick={runQty} disabled={loadingQty} className="btn-secondary">
            {loadingQty ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "重算曲线"
            )}
          </button>
        </div>
        <p className="mt-1 text-xs text-brand-500">
          固定费（制版/设计）摊薄 + 材料采购单价随量下降，每{unit}成本随批量递减。
        </p>
        {qtyData ? (
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={qtyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="qty"
                  tickFormatter={(v) => `${v / 1000}k`}
                  fontSize={12}
                />
                <YAxis fontSize={12} />
                <Tooltip
                  formatter={(v: number) => `¥${v}`}
                  labelFormatter={(l) => `数量 ${l} ${unit}`}
                />
                {Number(baseInput.quantity) > 0 && (
                  <ReferenceDot
                    x={Number(baseInput.quantity)}
                    y={baseReport.totalCost.perUnit.max}
                    r={5}
                    fill="#e11d48"
                    stroke="#fff"
                    strokeWidth={2}
                    isFront
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="perUnit"
                  stroke="#243b53"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="mt-4 text-sm text-brand-400">
            点击「重算曲线」生成 1k–50k 批量梯度。
          </p>
        )}
        {qtyData && (
          <p className="mt-2 text-xs text-brand-500">
            {analyzeQtyCurve(qtyData)}（红点为当前批量{" "}
            {Number(baseInput.quantity).toLocaleString()} {unit}）
          </p>
        )}
      </div>

      {/* 纸价冲击（线性近似） */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          纸价冲击（材料单价敏感性）
        </h3>
        <p className="mt-1 text-xs text-brand-500">
          材料单价变化对总成本的影响（线性近似，未含克重替代等非线性效应）。
        </p>
        <div className="mt-4 flex items-center gap-4">
          <input
            type="range"
            min={-20}
            max={40}
            value={paperPct}
            onChange={(e) => setPaperPct(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-20 text-right text-sm font-medium text-brand-800">
            {paperPct > 0 ? "+" : ""}
            {paperPct}%
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">材料成本</p>
            <p className="text-lg font-bold text-brand-900">
              ¥{newMaterial.toLocaleString()}
            </p>
            <p className="text-xs text-brand-500">
              占比 {newMaterialRatio}%（原 {material?.ratio}%）
            </p>
          </div>
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">总成本</p>
            <p className="text-lg font-bold text-brand-900">
              ¥{newTotal.toLocaleString()}
            </p>
            <p className="text-xs text-brand-500">原 ¥{baseTotal.toLocaleString()}</p>
          </div>
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">每{unit}成本</p>
            <p className="text-lg font-bold text-brand-900">
              ¥
              {baseReport.totalCost.perUnit.max > 0
                ? ((newTotal / (Number(baseInput.quantity) || 1)) ).toFixed(4)
                : "—"}
            </p>
            <p className="text-xs text-brand-500">按当前数量摊算</p>
          </div>
        </div>

        {/* 纸价冲击连续曲线 */}
        <div className="mt-4 h-48">
          <p className="mb-1 text-xs text-brand-500">
            单只成本随纸价变化（-20%~+40%，基于材料单价敏感性推演）
          </p>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={[-20, -10, 0, 10, 20, 30, 40].map((p) => {
                const mat = material
                  ? material.estimatedAmount * (1 + p / 100)
                  : 0;
                const total = otherTotal + mat;
                const perUnit =
                  baseReport.totalCost.perUnit.max > 0
                    ? total / (Number(baseInput.quantity) || 1)
                    : 0;
                return { pct: p, perUnit: Math.round(perUnit * 10000) / 10000 };
              })}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="pct"
                tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}%`}
                fontSize={12}
              />
              <YAxis fontSize={12} />
              <Tooltip
                formatter={(v: number) => `¥${v}`}
                labelFormatter={(l: number) => `纸价 ${l}%`}
              />
              <Line
                type="monotone"
                dataKey="perUnit"
                stroke="#243b53"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 工艺对比 */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-brand-900">工艺路线对比</h3>
          <div className="flex items-center gap-2">
            <select
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
              className="rounded-md border border-brand-200 bg-white px-2 py-1.5 text-sm"
            >
              {SURFACE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={runSurface}
              disabled={loadingSurface}
              className="btn-secondary"
            >
              {loadingSurface ? <Loader2 className="h-4 w-4 animate-spin" /> : "对比"}
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-brand-500">
          切换表面处理工艺，重跑引擎对比每{unit}成本与加工费占比。
        </p>
        {surfaceReport && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-brand-50 p-3">
              <p className="text-xs text-brand-500">切换后每{unit}成本</p>
              <p className="text-lg font-bold text-brand-900">
                ¥{surfaceReport.totalCost.perUnit.max}
              </p>
            </div>
            <div className="rounded-lg bg-brand-50 p-3">
              <p className="text-xs text-brand-500">与原方案差异</p>
              <p className="text-lg font-bold text-brand-900">
                ¥
                {(
                  surfaceReport.totalCost.perUnit.max -
                  baseReport.totalCost.perUnit.max
                ).toFixed(4)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
