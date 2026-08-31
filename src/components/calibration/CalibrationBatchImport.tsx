"use client";

import { useMemo, useState } from "react";
import type { ProductTypeConfig } from "@/types";
import {
  buildTemplateColumns,
  buildTemplateRow,
  parseClipboardTable,
  type BatchPreview,
} from "@/lib/calibration/batch";

/**
 * 校准案例批量导入
 *
 * 三个入口：下载 xlsx 模板 / 上传 xlsx·csv / 直接粘贴表格。
 * 解析全在客户端（xlsx 动态 import），映射与校验走服务端 /api/calibration/batch，
 * 保证与单条表单、calibration-real.ts 消费口径一致。
 */

type Row = Record<string, unknown>;

export function CalibrationBatchImport({
  productTypes,
  onImported,
}: {
  productTypes: ProductTypeConfig[];
  onImported?: (count: number) => void;
}) {
  const [pt, setPt] = useState(productTypes[0]?.code ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const cfg = useMemo(() => productTypes.find((p) => p.code === pt), [productTypes, pt]);

  async function downloadTemplate() {
    if (!cfg) return;
    const mod = await import("xlsx");
    const XLSX = mod.default ?? mod;
    const cols = buildTemplateColumns(cfg);
    const aoa = [cols.map((c) => c.header), buildTemplateRow(cfg, cols)];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols.map((c) => ({ wch: Math.max(12, c.header.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "校准案例");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `校准案例模板_${cfg.name}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const mod = await import("xlsx");
      const XLSX = mod.default ?? mod;
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("文件里没有可读的工作表");
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
      if (matrix.length < 2) throw new Error("至少要有一行表头 + 一行数据");
      const headers = (matrix[0] as unknown[]).map((h) => String(h ?? "").trim());
      const parsed = matrix.slice(1).map((line) => {
        const row: Row = {};
        (line as unknown[]).forEach((v, i) => {
          if (headers[i]) row[headers[i]] = v ?? "";
        });
        return row;
      });
      setRows(parsed);
      await runPreview(parsed, false);
    } catch (err) {
      setRows([]);
      setPreview(null);
      setMsg({ ok: false, text: "解析失败：" + String(err) });
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  function onPaste() {
    const parsed = parseClipboardTable(pasteText);
    if (!parsed.length) {
      setMsg({ ok: false, text: "粘贴内容至少要一行表头 + 一行数据（从 Excel 直接复制即可）" });
      return;
    }
    setRows(parsed);
    setPasteOpen(false);
    void runPreview(parsed, false);
  }

  async function runPreview(next: Row[], commit: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/calibration/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: next, productType: pt, commit }),
      });
      const data = await res.json();
      if (data.preview) setPreview(data.preview);
      if (!res.ok || !data.ok) {
        setMsg({ ok: false, text: data.error || "导入失败" });
        return;
      }
      if (commit) {
        setMsg({
          ok: true,
          text: `已导入 ${data.committed} 例${data.skipped ? `，跳过 ${data.skipped} 例（有阻断错误）` : ""}；当前共 ${data.count} 例。`,
        });
        setRows([]);
        setPreview(null);
        setPasteText("");
        onImported?.(data.count);
      }
    } catch (e) {
      setMsg({ ok: false, text: "网络错误：" + String(e) });
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.rows.filter((r) => r.errors.length === 0).length ?? 0;

  return (
    <section className="card mb-5 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-brand-900">批量导入（攒案例最快的方式）</h2>
          <p className="mt-1 text-xs text-brand-500">
            下载模板 → 按列填（一单一行）→ 上传或粘贴回来。只认供应商实报的数，不猜、不补。
          </p>
        </div>
        <label className="block">
          <span className="label-text text-brand-700">模板品类</span>
          <select
            className="select select-bordered select-sm"
            value={pt}
            onChange={(e) => {
              setPt(e.target.value);
              setRows([]);
              setPreview(null);
            }}
          >
            {productTypes.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-outline btn-sm" onClick={downloadTemplate} disabled={busy}>
          下载 xlsx 模板
        </button>

        <label className="btn btn-outline btn-sm cursor-pointer">
          上传填好的表格
          <input
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv"
            onChange={onFile}
            disabled={busy}
          />
        </label>

        <button
          className="btn btn-outline btn-sm"
          onClick={() => setPasteOpen((v) => !v)}
          disabled={busy}
        >
          {pasteOpen ? "收起粘贴框" : "粘贴表格"}
        </button>

        {rows.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setRows([]);
              setPreview(null);
              setMsg(null);
            }}
            disabled={busy}
          >
            清空
          </button>
        )}
      </div>

      {pasteOpen && (
        <div className="mt-3">
          <textarea
            className="textarea textarea-bordered w-full font-mono text-xs"
            rows={6}
            placeholder={"直接从 Excel 复制（含表头）粘贴到这里，支持 Tab 分隔与 CSV"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button className="btn btn-primary btn-sm mt-2" onClick={onPaste} disabled={busy}>
            解析粘贴内容
          </button>
        </div>
      )}

      {busy && <p className="mt-3 text-sm text-brand-500">处理中…</p>}

      {preview && !busy && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-brand-800">共 {preview.totalRows} 行</span>
            <span className="text-green-700">可导入 {preview.validRows}</span>
            {preview.warnRows > 0 && (
              <span className="text-amber-700">有提示 {preview.warnRows}</span>
            )}
            {preview.invalidRows > 0 && (
              <span className="text-red-700">有阻断错误 {preview.invalidRows}</span>
            )}
            <button
              className="btn btn-primary btn-sm ml-auto"
              onClick={() => runPreview(rows, true)}
              disabled={ready === 0}
            >
              确认导入 {ready} 条
            </button>
          </div>

          <div className="max-h-80 overflow-auto rounded-lg border border-brand-100">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-brand-50 text-brand-700">
                <tr>
                  <th className="px-2 py-2">行</th>
                  <th className="px-2 py-2">案例标识</th>
                  <th className="px-2 py-2">品类</th>
                  <th className="px-2 py-2">总价</th>
                  <th className="px-2 py-2">状态</th>
                  <th className="px-2 py-2">说明</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const bad = r.errors.length > 0;
                  return (
                    <tr key={r.index} className="border-t border-brand-50">
                      <td className="px-2 py-1.5 text-brand-400">{r.index + 2}</td>
                      <td className="px-2 py-1.5">{r.caseId || "—"}</td>
                      <td className="px-2 py-1.5">{r.productType || "—"}</td>
                      <td className="px-2 py-1.5">
                        {r.total !== undefined ? `¥${r.total.toLocaleString()}` : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        {bad ? (
                          <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">阻断</span>
                        ) : r.warnings.length ? (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                            提示
                          </span>
                        ) : (
                          <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">
                            通过
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-brand-600">
                        {(bad ? r.errors : r.warnings).map((i, k) => (
                          <div key={k}>{i.message}</div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {msg && (
        <div
          className={`mt-4 rounded-lg p-3 text-sm ${
            msg.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </div>
      )}
    </section>
  );
}
