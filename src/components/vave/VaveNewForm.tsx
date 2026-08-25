"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { getAllProductTypes, getProductConfig } from "@/config/products";
import type { AnalysisInput, AnalysisReport, ProductTypeConfig } from "@/types";

// 独立新建：按所选品类的配置动态渲染关键字段（required 或 weight>=8），
// 其余由引擎默认值补齐；先跑一次成本分析作为 VAVE 基石。
function buildDefaults(config: ProductTypeConfig): AnalysisInput {
  const init: AnalysisInput = { targetDelivery: "standard" };
  for (const f of config.fields) {
    if (f.defaultValue !== undefined) {
      (init as Record<string, unknown>)[f.key] = f.defaultValue;
    }
  }
  return init;
}

export function VaveNewForm({
  onAnalyzed,
}: {
  onAnalyzed: (report: AnalysisReport, input: AnalysisInput) => void;
}) {
  const productTypes = getAllProductTypes();
  const [productType, setProductType] = useState(
    productTypes[0]?.code ?? "color_print_box"
  );
  const config = getProductConfig(productType) ?? productTypes[0];
  const fields = config.fields.filter(
    (f) => f.required || (f.weight ?? 0) >= 8
  );
  const [input, setInput] = useState<AnalysisInput>(() => buildDefaults(config));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 切换品类时按新配置重置默认值
  useEffect(() => {
    setInput(buildDefaults(config));
  }, [config]);

  const setField = (key: string, value: string | number | boolean) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/vave/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, productType }),
      });
      const data = await res.json();
      if (res.ok) onAnalyzed(data.report as AnalysisReport, input);
      else setError(data.error || "分析失败");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h2 className="text-xl font-bold text-brand-900">
        新建成本分析（将作为 VAVE 基础）
      </h2>
      <p className="mt-1 text-sm text-brand-500">
        选择产品类别并填写关键参数，系统先跑一次成本引擎，再进入 VAVE 工作台。
      </p>

      <div className="mt-6 card p-6">
        <label className="block">
          <span className="text-sm text-brand-700">产品类别</span>
          <select
            value={productType}
            onChange={(e) => setProductType(e.target.value)}
            className="mt-1 w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
          >
            {productTypes.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {fields.map((f) => {
            if (f.type === "number") {
              const v = input[f.key];
              return (
                <label key={f.key} className="block">
                  <span className="text-sm text-brand-700">
                    {f.label}
                    {f.unit ? ` (${f.unit})` : ""}
                  </span>
                  <input
                    type="number"
                    value={typeof v === "number" ? v : ""}
                    onChange={(e) =>
                      setField(
                        f.key,
                        e.target.value ? Number(e.target.value) : ""
                      )
                    }
                    placeholder={f.placeholder}
                    className="mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
                  />
                </label>
              );
            }
            if (f.type === "boolean") {
              return (
                <label
                  key={f.key}
                  className="flex items-center gap-2 text-sm text-brand-700"
                >
                  <input
                    type="checkbox"
                    checked={!!input[f.key]}
                    onChange={(e) => setField(f.key, e.target.checked)}
                  />
                  {f.label}
                </label>
              );
            }
            return (
              <label key={f.key} className="block">
                <span className="text-sm text-brand-700">{f.label}</span>
                <select
                  value={String(input[f.key] ?? "")}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className="mt-1 w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-6 flex justify-end">
        <button
          onClick={run}
          disabled={loading}
          className="btn-primary inline-flex items-center gap-2"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {loading ? "分析中..." : "开始分析"}
        </button>
      </div>
    </div>
  );
}
