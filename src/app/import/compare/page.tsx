"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileSpreadsheet, AlertTriangle } from "lucide-react";
import { getProductConfig } from "@/config/products";
import type { AnalysisInput } from "@/types";
import type { ImportProductRow } from "@/app/api/import/customer-quote/route";
import { DeviationHeatmap } from "@/components/import/DeviationHeatmap";
import { customerUnitPrice } from "@/lib/import/deviation";

interface ImportResult {
  productType: string;
  productTypeName: string;
  hasPrice: boolean;
  rowCount: number;
  products: ImportProductRow[];
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€" };

function buildSpecs(
  input: Partial<AnalysisInput>,
  productType: string
): { label: string; value: string }[] {
  const config = getProductConfig(productType);
  const out: { label: string; value: string }[] = [];
  if (!config) return out;

  // 尺寸合并为 长×宽×高 / 长×宽（不依赖具体品类字段名）
  const dims: number[] = [];
  for (const k of ["length", "width", "height"] as const) {
    const v = input[k];
    if (typeof v === "number" && !isNaN(v)) dims.push(v);
  }
  if (dims.length) out.push({ label: "尺寸", value: `${dims.join("×")} mm` });

  // 遍历该品类配置字段，通用输出（避免品类差异硬编码）
  for (const f of config.fields) {
    if (f.key === "length" || f.key === "width" || f.key === "height") continue;
    const raw = input[f.key];
    if (raw == null || raw === "" || typeof raw === "object") continue;
    if (typeof raw === "number" && isNaN(raw)) continue;

    let value: string;
    if (f.type === "boolean") {
      value = raw ? "是" : "否";
    } else if (f.options) {
      const opt = f.options.find((o) => o.value === String(raw));
      value = opt ? opt.label : String(raw);
    } else {
      value = `${raw}${f.unit ? ` ${f.unit}` : ""}`;
    }
    out.push({ label: f.label, value });
  }
  return out;
}

export default function ImportComparePage() {
  const router = useRouter();
  const [data, setData] = useState<ImportResult | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("customer_import_result");
      if (raw) setData(JSON.parse(raw) as ImportResult);
      else setMissing(true);
    } catch {
      setMissing(true);
    }
  }, []);

  const config = useMemo(
    () => (data ? getProductConfig(data.productType) : undefined),
    [data]
  );

  const openRow = (row: ImportProductRow) => {
    sessionStorage.setItem("customer_seed_input", JSON.stringify(row.input ?? {}));
    router.push(`/work?product=${data?.productType ?? "flat_print"}`);
  };

  if (missing) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-8">
        <FileSpreadsheet className="h-10 w-10 text-slate-400" />
        <p className="text-sm text-slate-500">没有可对比的导入结果。</p>
        <Link href="/work" className="btn-primary">
          前往工作台
        </Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <span className="text-sm text-slate-400">加载中…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-5 shadow-sm">
        <Link
          href="/work"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-brand-700"
        >
          <ArrowLeft className="h-4 w-4" /> 返回工作台
        </Link>
        <span className="text-sm font-semibold text-slate-800">
          {data.productTypeName} · 客户报价对比
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
          {data.rowCount} 行
        </span>
      </header>

      <main className="mx-auto max-w-6xl space-y-3 p-5">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          说明：客户报价仅用于当次对比，<b>不会</b>写入知识库或校准数据。规格字段已解析为该品类标准字段。
        </p>

        <DeviationHeatmap
          rows={data.products}
          config={config}
          symbol={CURRENCY_SYMBOL[data.products[0]?.price?.currency ?? "CNY"] ?? "¥"}
          onRowClick={(index) => {
            const row = data.products.find((r) => r.index === index);
            if (row) openRow(row);
          }}
        />

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-3 py-2.5 font-medium">产品 / 规格</th>
                {data.hasPrice && (
                  <th className="px-3 py-2.5 text-right font-medium">客户报价</th>
                )}
                <th className="px-3 py-2.5 text-right font-medium">我方估算（单）</th>
                {data.hasPrice && (
                  <th className="px-3 py-2.5 text-right font-medium">差额 / 毛利率</th>
                )}
                <th className="px-3 py-2.5 font-medium">置信度</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((row) => {
                const specs = buildSpecs(row.input, data.productType);
                const sym = CURRENCY_SYMBOL[row.price?.currency ?? "CNY"] ?? "¥";
                const custUnit = customerUnitPrice(row);
                const ourUnit = row.estimate?.perUnit;
                const showDelta = data.hasPrice && custUnit != null && ourUnit != null;
                const delta = showDelta ? Math.round((custUnit! - ourUnit!) * 100) / 100 : undefined;
                const margin =
                  showDelta && custUnit! > 0
                    ? Math.round(((custUnit! - ourUnit!) / custUnit!) * 1000) / 10
                    : undefined;
                return (
                  <tr
                    key={row.index}
                    onClick={() => openRow(row)}
                    className="cursor-pointer border-b border-slate-100 align-top hover:bg-brand-50/50"
                  >
                    <td className="px-3 py-3">
                      <p className="font-medium text-slate-800">
                        {row.name || `产品 ${row.index + 1}`}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {specs.map((s) => (
                          <span
                            key={s.label}
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                          >
                            {s.label}：{s.value}
                          </span>
                        ))}
                      </div>
                      {(row.notes.length > 0 || row.unmatched.length > 0) && (
                        <div className="mt-1.5 space-y-0.5">
                          {row.notes.map((n, i) => (
                            <p key={`n${i}`} className="text-[11px] text-amber-600">
                              ⚠ {n}
                            </p>
                          ))}
                          {row.unmatched.length > 0 && (
                            <p className="text-[11px] text-slate-400">
                              未匹配列：{row.unmatched.join("、")}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    {data.hasPrice && (
                      <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                        {row.price ? (
                          <>
                            {row.price.unitPrice != null && (
                              <div>{sym}{row.price.unitPrice}</div>
                            )}
                            {row.price.totalPrice != null && (
                              <div className="text-xs text-slate-400">
                                总价 {sym}
                                {row.price.totalPrice}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                      {row.estimate ? (
                        <>
                          <div>{sym}{row.estimate.perUnitMin} ~ {row.estimate.perUnitMax}</div>
                          <div className="text-xs text-slate-400">
                            合计 {sym}
                            {Math.round(row.estimate.totalMin)}~{Math.round(row.estimate.totalMax)}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-rose-400">估算失败</span>
                      )}
                    </td>
                    {data.hasPrice && (
                      <td className="px-3 py-3 text-right tabular-nums">
                        {showDelta && delta != null && margin != null ? (
                          <span
                            className={
                              margin >= 0 ? "font-medium text-emerald-600" : "font-medium text-rose-600"
                            }
                          >
                            {delta >= 0 ? "+" : ""}
                            {sym}
                            {delta} / {margin}%
                          </span>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 text-slate-500">
                      {row.estimate ? `${row.estimate.confidence}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="flex items-center gap-1.5 px-1 text-[11px] text-slate-400">
          <AlertTriangle className="h-3 w-3" />
          点击任意一行可在工作台打开并预填该产品的规格参数，继续做完整成本分析 / VAVE。
        </p>
      </main>
    </div>
  );
}
