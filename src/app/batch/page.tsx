"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, UploadCloud, Loader2, FileSpreadsheet, AlertTriangle } from "lucide-react";
import { getAllProductTypes, getProductConfig } from "@/config/products";
import {
  buildTemplateHeaders,
  buildSampleRow,
  buildInstructionRows,
  buildResultHeaders,
  resultToValues,
  type BatchResultRow,
} from "@/lib/batch/template";

type BatchResponse = {
  ok: boolean;
  message?: string;
  productType: string;
  productTypeName: string;
  total: number;
  success: number;
  failed: number;
  results: BatchResultRow[];
  errors: { name: string; message: string }[];
};

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function BatchPage() {
  const productTypes = useMemo(() => getAllProductTypes(), []);
  const [productType, setProductType] = useState(productTypes[0]?.code ?? "color_print_box");
  const config = useMemo(() => getProductConfig(productType)!, [productType]);

  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<BatchResponse | null>(null);

  const resultColumns = useMemo(() => buildResultHeaders(config), [config]);

  const downloadTemplate = useCallback(async () => {
    const mod = await import("xlsx");
    const XLSX = (mod as any).default ?? mod;
    const headers = buildTemplateHeaders(config);
    const sample = buildSampleRow(config);
    const instructions = buildInstructionRows(config);

    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    ws["!cols"] = headers.map((h) => ({ wch: Math.max(14, String(h).length * 2) }));
    const ws2 = XLSX.utils.aoa_to_sheet(instructions);
    ws2["!cols"] = [{ wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 60 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "批量模板");
    XLSX.utils.book_append_sheet(wb, ws2, "填写说明");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    saveBlob(
      new Blob([out], { type: "application/octet-stream" }),
      `批量成本分析模板_${config.name}.xlsx`
    );
  }, [config]);

  const handleAnalyze = useCallback(async () => {
    if (!file) {
      setError("请先选择填好的 Excel 文件");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("productType", productType);
      const res = await fetch("/api/batch/analyze", { method: "POST", body: fd });
      const data: BatchResponse = await res.json();
      if (!data.ok) {
        setError(data.message ?? "分析失败");
        setResp(null);
      } else {
        setResp(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [file, productType]);

  const exportResults = useCallback(async () => {
    if (!resp) return;
    const mod = await import("xlsx");
    const XLSX = (mod as any).default ?? mod;
    const aoa: (string | number)[][] = [resultColumns.map((c) => c.label)];
    for (const r of resp.results) {
      aoa.push(resultToValues(r, config));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = resultColumns.map((c) => ({ wch: Math.max(12, String(c.label).length) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "成本分析汇总");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    saveBlob(
      new Blob([out], { type: "application/octet-stream" }),
      `成本分析汇总_${resp.productTypeName}_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  }, [resp, config, resultColumns]);

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="border-b border-brand-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="btn-secondary inline-flex items-center gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Link>
            <span className="text-lg font-semibold text-brand-900">批量成本分析</span>
          </div>
          <Link href="/work" className="btn-secondary inline-flex items-center gap-1.5">
            <FileSpreadsheet className="h-4 w-4" />
            单笔分析
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* 品类选择 */}
        <section className="card p-6">
          <h2 className="text-base font-semibold text-brand-900">1. 选择产品类别</h2>
          <p className="mt-1 text-sm text-brand-500">
            批量功能针对单一品类。如需多品类混合，请分多次上传。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {productTypes.map((p) => (
              <button
                key={p.code}
                onClick={() => {
                  setProductType(p.code);
                  setResp(null);
                  setFile(null);
                  setError(null);
                }}
                className={`rounded-lg border p-4 text-left transition ${
                  productType === p.code
                    ? "border-accent-orange bg-orange-50"
                    : "border-brand-200 bg-white hover:border-brand-300"
                }`}
              >
                <div className="font-medium text-brand-900">{p.name}</div>
                <div className="mt-1 text-xs text-brand-500">{p.description}</div>
              </button>
            ))}
          </div>
        </section>

        {/* 模板 + 上传 */}
        <section className="card mt-6 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-brand-900">2. 下载模板并填写</h2>
            <p className="mt-1 text-sm text-brand-500">
              模板含「批量模板」与「填写说明」两个 sheet。第一行「产品名称」必填，其余填字段 value。
            </p>
          </div>
          <button onClick={downloadTemplate} className="btn-primary inline-flex items-center gap-1.5">
            <Download className="h-4 w-4" />
            下载 Excel 模板
          </button>
        </section>

        <section className="card mt-6 p-6">
          <h2 className="text-base font-semibold text-brand-900">3. 上传并批量分析</h2>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
            <label className="flex flex-1 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-4 py-3 text-sm text-brand-600">
              <UploadCloud className="h-5 w-5 shrink-0" />
              <span className="truncate">
                {file ? file.name : "点击选择填好的 .xlsx 文件"}
              </span>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              onClick={handleAnalyze}
              disabled={loading || !file}
              className="btn-accent inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {loading ? "分析中…" : "开始分析"}
            </button>
          </div>
          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {/* 结果 */}
        {resp && (
          <section className="card mt-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-brand-900">4. 分析结果</h2>
                <p className="mt-1 text-sm text-brand-500">
                  共 {resp.total} 行 · 成功 <span className="text-green-600">{resp.success}</span> · 失败{" "}
                  <span className={resp.failed > 0 ? "text-red-600" : "text-brand-400"}>{resp.failed}</span>
                </p>
              </div>
              <button onClick={exportResults} className="btn-primary inline-flex items-center gap-1.5">
                <Download className="h-4 w-4" />
                导出汇总 xlsx
              </button>
            </div>

            {resp.errors.length > 0 && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
                <div className="text-sm font-medium text-red-700">失败行（已隔离，不影响其他行）</div>
                <ul className="mt-2 space-y-1 text-xs text-red-600">
                  {resp.errors.map((e, i) => (
                    <li key={i}>
                      · {e.name}：{e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-brand-100 text-brand-800">
                    {resultColumns.map((c) => (
                      <th key={c.key} className="border border-brand-200 px-2 py-1.5 text-left font-medium">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resp.results.map((r, i) => (
                    <tr key={i} className="odd:bg-white even:bg-brand-50/40">
                      {resultToValues(r, config).map((v, j) => (
                        <td
                          key={j}
                          className={`border border-brand-200 px-2 py-1.5 ${
                            typeof v === "number" ? "text-right tabular-nums" : "text-left"
                          }`}
                        >
                          {v === "" ? "—" : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
