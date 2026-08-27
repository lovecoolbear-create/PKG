"use client";

import { useState } from "react";
import * as XLSX from "xlsx";
import type { ProductTypeConfig } from "@/types";
import type { IntakeInitial } from "./CalibrationIntakeForm";
import { getAiSettings } from "@/lib/config/ai-settings";

/**
 * 报价单上传解析（规则打底 + AI 增强，两条路径统一回灌表单）。
 * - Excel：SheetJS 浏览器端解析，按字段名+同义词映射（零 LLM 依赖，必填可兜底）。
 * - md 文本 / 图片：调 /api/calibration/extract（LLM 只抽原文、不补全五维），结果预填。
 * 两条路径都"只提取已有信息、转换格式"，绝不补全文件没有的字段；确认环节由用户把关。
 */

// 字段 key -> 中文同义词（含产品配置 label 之外的常见别名）
const SYNONYMS: Record<string, string[]> = {
  length: ["长", "长度", "l", "长边"],
  width: ["宽", "宽度", "w"],
  height: ["高", "高度", "h"],
  quantity: ["数量", "订单数量", "下单量", "qty", "生产数量", "批量"],
  material: ["材质", "材料", "纸张", "纸材", "纸板"],
  grammage: ["克重", "克重g", "g", "gsm", "定量"],
  printMethod: ["印刷方式", "印刷工艺", "印法", "印刷"],
  colorCount: ["色数", "颜色数", "几色", "印刷色数", "色彩数"],
  surfaceTreatment: ["表面处理", "表面", "表面工艺", "后道", "后加工", "工艺"],
  needGluing: ["糊盒", "粘盒", "胶装", "是否糊盒", "粘盒方式"],
  boxType: ["盒型", "盒种类", "款式", "箱型"],
  deliveryLocation: ["交付地", "交货地", "收货地", "目的地", "交期地"],
  laborRegion: ["人工区域", "工价区域", "地区", "区域"],
};
const ACTUAL_TOTAL_KEYS = ["total", "总价", "实际总价", "报价", "报价金额", "金额", "合计", "总计", "含税总价"];
const DIM_MAP: { key: string; keys: string[] }[] = [
  { key: "material", keys: ["材料", "材料费", "材料成本"] },
  { key: "labor", keys: ["人工", "人工费"] },
  { key: "process", keys: ["加工", "加工费", "印刷费", "印工"] },
  { key: "design_plate", keys: ["制版", "设计", "设计制版", "版费"] },
  { key: "finance_other", keys: ["财务", "管理费", "利润", "其他费用"] },
];
const ANCHOR_MAP: { key: string; keys: string[] }[] = [
  { key: "paperPricePerTon", keys: ["纸价", "纸价元吨", "吨价", "原纸价", "纸单价", "纸价吨"] },
  { key: "laborRatePerPiece", keys: ["工价", "计件工价", "单只工价", "工价元个"] },
  { key: "plateCost", keys: ["制版费", "刀模费", "版费", "制版"] },
  { key: "financeTotal", keys: ["财务合计", "管理费合计", "物流合计", "费用合计"] },
];

function norm(s: unknown): string {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, "");
}
function findVal(row: Record<string, unknown>, keys: string[]): unknown {
  const nk = keys.map(norm);
  for (const [k, v] of Object.entries(row)) if (nk.includes(norm(k))) return v;
  return undefined;
}
function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace(/[, ¥￥元%]/g, ""));
  return isFinite(n) ? n : undefined;
}
function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  if (["是", "true", "1", "y", "yes", "有"].includes(s)) return true;
  if (["否", "false", "0", "n", "no", "无"].includes(s)) return false;
  return undefined;
}

export function CalibrationUpload({
  productTypes,
  onParsed,
}: {
  productTypes: ProductTypeConfig[];
  onParsed: (init: IntakeInitial, summary: string) => void;
}) {
  const [tab, setTab] = useState<"excel" | "md" | "image">("excel");
  const [pt, setPt] = useState(productTypes[0]?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mdText, setMdText] = useState("");
  const [imgBase64, setImgBase64] = useState<string | null>(null);

  const cfg = productTypes.find((p) => p.code === pt);

  function emit(input: Record<string, unknown>, actualTotal: number | string, anchors: Record<string, string>) {
    const init: IntakeInitial = { productType: pt, input, actualTotal: actualTotal ?? "", anchors };
    const recognized = Object.keys(input).length;
    const miss: string[] = [];
    if (actualTotal === undefined || actualTotal === "") miss.push("实际总价");
    for (const f of cfg?.fields ?? []) {
      if (f.required && (input[f.key] === undefined || input[f.key] === "")) miss.push(f.label);
    }
    const summary = `已识别 ${recognized} 个产品参数${
      actualTotal !== undefined && actualTotal !== "" ? `、总价 ¥${actualTotal}` : ""
    }${Object.keys(anchors || {}).length ? `、${Object.keys(anchors).length} 个外部锚` : ""}。${
      miss.length ? `还需补充：${miss.join("、")}（在下方表单填写后提交）` : "必填项已齐，可直接提交。"
    }`;
    onParsed(init, summary);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
      if (!rows.length) {
        setErr("Excel 无数据行（请确认首个工作表有表头+数据）");
        setBusy(false);
        return;
      }
      const row = rows[0];
      const input: Record<string, unknown> = {};
      for (const f of cfg?.fields ?? []) {
        const keys = [f.key, f.label, ...(SYNONYMS[f.key] ?? [])];
        const v = findVal(row, keys);
        if (v === undefined || v === "") continue;
        if (f.type === "number") {
          const n = toNum(v);
          if (n !== undefined) input[f.key] = n;
        } else if (f.type === "boolean") {
          const b = toBool(v);
          if (b !== undefined) input[f.key] = b;
        } else {
          input[f.key] = String(v);
        }
      }
      const actualTotal = toNum(findVal(row, ACTUAL_TOTAL_KEYS)) ?? "";
      const anchors: Record<string, string> = {};
      for (const a of ANCHOR_MAP) {
        const v = toNum(findVal(row, a.keys));
        if (v !== undefined) anchors[a.key] = String(v);
      }
      emit(input, actualTotal, anchors);
    } catch (e) {
      setErr("解析失败：" + String(e));
    } finally {
      setBusy(false);
    }
  }

  function fieldSpecs() {
    return (cfg?.fields ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type, unit: f.unit }));
  }

  async function handleMdExtract() {
    if (!mdText.trim()) {
      setErr("请粘贴报价单文本");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const settings = getAiSettings();
      if (!settings) {
        setErr("未配置 AI：请在配置中心填写 Ollama 地址或云端密钥");
        setBusy(false);
        return;
      }
      const res = await fetch("/api/calibration/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "md", text: mdText, settings, productType: pt, fieldSpecs: fieldSpecs() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErr(data.error || "AI 抽取失败");
        setBusy(false);
        return;
      }
      emit(data.input || {}, data.actualTotal, data.anchors || {});
    } catch (e) {
      setErr("AI 抽取失败：" + String(e));
    } finally {
      setBusy(false);
    }
  }

  function onImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const d = reader.result as string;
      setImgBase64(d.split(",")[1] ?? null);
    };
    reader.readAsDataURL(file);
  }

  async function handleImageExtract() {
    if (!imgBase64) {
      setErr("请先选择报价单图片");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const settings = getAiSettings();
      if (!settings) {
        setErr("未配置 AI：请在配置中心填写 Ollama 地址或云端密钥");
        setBusy(false);
        return;
      }
      const res = await fetch("/api/calibration/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "image", imageBase64: imgBase64, settings, productType: pt, fieldSpecs: fieldSpecs() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErr(data.error || "AI 识别失败");
        setBusy(false);
        return;
      }
      emit(data.input || {}, data.actualTotal, data.anchors || {});
    } catch (e) {
      setErr("AI 识别失败：" + String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mb-5 p-5">
      <h2 className="mb-1 text-lg font-semibold text-brand-900">上传报价单（自动提取）</h2>
      <p className="mb-3 text-xs text-brand-500">
        Excel 按表头自动映射（零 LLM 依赖）；md 文本/图片由 AI 提取（只抽原文、不补全五维）。
        图片/PDF 也可先在别的工具转成 Excel/md 再上传。
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="block">
          <span className="label-text text-brand-700">产品类别</span>
          <select className="select select-bordered select-sm" value={pt} onChange={(e) => setPt(e.target.value)}>
            {productTypes.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="tabs tabs-boxed bg-brand-100">
          <button className={`tab ${tab === "excel" ? "tab-active" : ""}`} onClick={() => setTab("excel")}>
            Excel
          </button>
          <button className={`tab ${tab === "md" ? "tab-active" : ""}`} onClick={() => setTab("md")}>
            MD 文本
          </button>
          <button className={`tab ${tab === "image" ? "tab-active" : ""}`} onClick={() => setTab("image")}>
            图片
          </button>
        </div>
      </div>

      {tab === "excel" && (
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          className="file-input file-input-bordered file-input-sm w-full max-w-xs"
          onChange={handleFile}
          disabled={busy}
        />
      )}

      {tab === "md" && (
        <div>
          <textarea
            className="textarea textarea-bordered w-full"
            rows={5}
            placeholder="粘贴报价单文本（在外部工具转好的 md/文本）"
            value={mdText}
            onChange={(e) => setMdText(e.target.value)}
          />
          <button className="btn btn-primary btn-sm mt-2" onClick={handleMdExtract} disabled={busy}>
            {busy ? "AI 抽取中…" : "AI 提取并预填"}
          </button>
        </div>
      )}

      {tab === "image" && (
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept="image/*" className="file-input file-input-bordered file-input-sm w-full max-w-xs" onChange={onImagePick} disabled={busy} />
          <button className="btn btn-primary btn-sm" onClick={handleImageExtract} disabled={busy || !imgBase64}>
            {busy ? "AI 识别中…" : "AI 识别并预填"}
          </button>
        </div>
      )}

      {busy && <span className="mt-2 block text-sm text-brand-500">处理中…</span>}
      {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{err}</div>}
    </section>
  );
}
