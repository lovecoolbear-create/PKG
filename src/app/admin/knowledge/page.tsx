"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Database,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";

// 材料选项（避免从服务端 cost-rules 引入 prisma 依赖进客户端包）
const MATERIAL_OPTIONS: { value: string; label: string }[] = [
  { value: "white_card", label: "白卡纸" },
  { value: "gray_card", label: "灰底白板" },
  { value: "kraft", label: "牛皮纸" },
  { value: "coated", label: "铜版纸" },
  { value: "ivory_board", label: "白板纸(再生)" },
  { value: "corrugated", label: "瓦楞纸" },
];
const GRAMMAGE_OPTIONS = ["230", "250", "300", "350", "400", "450"];
const SURFACE_OPTIONS = [
  { value: "", label: "无" },
  { value: "matte_laminate", label: "哑膜" },
  { value: "gloss_laminate", label: "亮膜" },
  { value: "uv", label: "UV上光" },
  { value: "foil", label: "烫金" },
  { value: "emboss", label: "压纹" },
];

const CATEGORY_LABELS: Record<string, string> = {
  material_price: "材料基准价",
  process_rate: "工艺 / 费用费率",
  labor_rate: "人工 / 物流费率",
  rule: "规则",
  feedback: "反馈",
  analysis_result: "分析案例",
};

// 人类维护的数据 source 归类（其余视为网络/系统）
const MANUAL_SOURCES = ["manual", "import", "analysis", "feedback", "network_adopted"];

interface KbEntry {
  id: string;
  category: string;
  key: string;
  value: any;
  source: string;
  confidence: number;
  tags: string[];
}

function primaryValue(e: KbEntry): number {
  if (typeof e.value === "number") return e.value;
  if (e.value && typeof e.value.value === "number") return e.value.value;
  if (e.value && typeof e.value.rate === "number") return e.value.rate;
  if (e.value && typeof e.value.baseRate === "number") return e.value.baseRate;
  return 0;
}

function unitOf(e: KbEntry): string {
  if (e.category === "material_price") return "元/吨";
  if (e.category === "process_rate") {
    if (e.key.startsWith("surface")) return "元/m²";
    if (e.key.startsWith("print")) return "元/千印";
    if (e.key.startsWith("plate") || e.key.startsWith("spot")) return "元";
    if (e.key.startsWith("equipment")) return "元/小时";
    if (e.key.startsWith("flute")) return "元/m²";
    return "元";
  }
  if (e.category === "labor_rate") {
    if (e.key.startsWith("region")) return "元/小时";
    if (e.key.startsWith("logistics")) return "比率";
    return "元";
  }
  return "";
}

function isFresh(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 24 * 3600 * 1000;
}

export default function KnowledgeAdminPage() {
  const [tab, setTab] = useState<"manual" | "network">("manual");
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/knowledge-base");
      const data = await res.json();
      setEntries(data.entries || []);
    } catch (e: any) {
      setMsg({ kind: "err", text: "加载失败：" + (e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const manualEntries = entries.filter((e) => MANUAL_SOURCES.includes(e.source));
  const grouped = manualEntries.reduce<Record<string, KbEntry[]>>((acc, e) => {
    (acc[e.category] ||= []).push(e);
    return acc;
  }, {});

  const saveEntry = async (e: KbEntry, val: number, conf: number) => {
    setBusy(true);
    setMsg(null);
    try {
      let value: any = val;
      if (e.category === "material_price") {
        const [material, grammage] = e.key.split(":");
        value = { value: val, material, grammage, unit: "元/吨" };
      }
      const res = await fetch("/api/admin/knowledge-base", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: e.category,
          key: e.key,
          value,
          source: e.source,
          confidence: conf,
          tags: e.tags,
        }),
      });
      if (!res.ok) throw new Error("保存失败");
      setMsg({ kind: "ok", text: `已保存 ${e.key}，缓存已刷新` });
      await load();
    } catch (e: any) {
      setMsg({ kind: "err", text: "保存失败：" + (e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const reloadCache = async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reload" }),
      });
      setMsg({ kind: "ok", text: "内存缓存已刷新" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-brand-50">
      <header className="border-b border-brand-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Database className="h-7 w-7 text-brand-800" />
            <span className="text-lg font-semibold text-brand-900">
              知识库管理
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="btn-secondary"
              onClick={reloadCache}
              disabled={busy}
            >
              <RefreshCw className="mr-1 h-4 w-4" />
              刷新缓存
            </button>
            <Link href="/" className="btn-primary">
              <ArrowLeft className="mr-1 h-4 w-4" />
              返回首页
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {msg && (
          <div
            className={`mb-4 flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${
              msg.kind === "ok"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {msg.kind === "ok" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            {msg.text}
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-b border-brand-200">
          <button
            className={`px-4 py-2 text-sm font-medium ${
              tab === "manual"
                ? "border-b-2 border-brand-800 text-brand-900"
                : "text-brand-500"
            }`}
            onClick={() => setTab("manual")}
          >
            人工维护（需人更新）
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium ${
              tab === "network"
                ? "border-b-2 border-brand-800 text-brand-900"
                : "text-brand-500"
            }`}
            onClick={() => setTab("network")}
          >
            网络刷新（行情拉取）
          </button>
        </div>

        {tab === "manual" ? (
          <ManualZone
            loading={loading}
            grouped={grouped}
            busy={busy}
            onSave={saveEntry}
          />
        ) : (
          <NetworkZone
            busy={busy}
            onAdopted={async () => {
              setMsg({ kind: "ok", text: "已采纳为内部基准，已同步到人工维护区" });
              await load();
            }}
            setMsg={setMsg}
          />
        )}
      </div>
    </main>
  );
}

function ManualZone({
  loading,
  grouped,
  busy,
  onSave,
}: {
  loading: boolean;
  grouped: Record<string, KbEntry[]>;
  busy: boolean;
  onSave: (e: KbEntry, val: number, conf: number) => void;
}) {
  if (loading) return <p className="text-sm text-brand-500">加载中…</p>;
  const categories = Object.keys(grouped);
  if (categories.length === 0)
    return <p className="text-sm text-brand-500">暂无人工维护条目</p>;

  return (
    <div className="space-y-8">
      {categories.map((cat) => (
        <section key={cat}>
          <h2 className="mb-3 text-base font-semibold text-brand-900">
            {CATEGORY_LABELS[cat] || cat}
            <span className="ml-2 text-xs font-normal text-brand-400">
              {grouped[cat].length} 条
            </span>
          </h2>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-brand-50 text-brand-600">
                <tr>
                  <th className="px-4 py-2 text-left">键 (key)</th>
                  <th className="px-4 py-2 text-left">数值</th>
                  <th className="px-4 py-2 text-left">置信度</th>
                  <th className="px-4 py-2 text-left">来源</th>
                  <th className="px-4 py-2 text-left">操作</th>
                </tr>
              </thead>
              <tbody>
                {grouped[cat].map((e) => (
                  <Row key={e.id} e={e} busy={busy} onSave={onSave} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function Row({
  e,
  busy,
  onSave,
}: {
  e: KbEntry;
  busy: boolean;
  onSave: (e: KbEntry, val: number, conf: number) => void;
}) {
  const [val, setVal] = useState(String(primaryValue(e)));
  const [conf, setConf] = useState(String(e.confidence));

  return (
    <tr className="border-t border-brand-100">
      <td className="px-4 py-2 font-mono text-xs text-brand-700">{e.key}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <input
            className="input-field w-28"
            type="number"
            value={val}
            onChange={(ev) => setVal(ev.target.value)}
          />
          <span className="text-xs text-brand-400">{unitOf(e)}</span>
        </div>
      </td>
      <td className="px-4 py-2">
        <input
          className="input-field w-20"
          type="number"
          value={conf}
          onChange={(ev) => setConf(ev.target.value)}
        />
      </td>
      <td className="px-4 py-2">
        <span className="rounded bg-brand-100 px-2 py-0.5 text-xs text-brand-700">
          {e.source}
        </span>
      </td>
      <td className="px-4 py-2">
        <button
          className="btn-secondary px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onSave(e, Number(val), Number(conf))}
        >
          保存
        </button>
      </td>
    </tr>
  );
}

function NetworkZone({
  busy,
  onAdopted,
  setMsg,
}: {
  busy: boolean;
  onAdopted: () => void;
  setMsg: (m: { kind: "ok" | "err"; text: string } | null) => void;
}) {
  const [material, setMaterial] = useState("white_card");
  const [grammage, setGrammage] = useState("350");
  const [surface, setSurface] = useState("");
  const [result, setResult] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh-network",
          material,
          grammage,
          surfaceTreatment: surface || undefined,
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setMsg({ kind: "err", text: "刷新失败：" + (e?.message || e) });
    } finally {
      setRefreshing(false);
    }
  };

  const adopt = async () => {
    const paper = result?.entries?.find((x: any) => x.category === "paper");
    if (!paper) return;
    try {
      const res = await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adopt-network",
          material,
          grammage,
          price: paper.price,
        }),
      });
      if (!res.ok) throw new Error();
      onAdopted();
    } catch {
      setMsg({ kind: "err", text: "采纳失败" });
    }
  };

  const paper = result?.entries?.find((x: any) => x.category === "paper");
  const surfaceEntry = result?.entries?.find(
    (x: any) => x.category === "surface"
  );

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <h2 className="mb-1 text-base font-semibold text-brand-900">
          市场行情刷新
        </h2>
        <p className="mb-4 text-sm text-brand-500">
          从外部行情 API 拉取实时纸价（未配置 API 或失败时自动回退本地基准）。
          行情仅作参考，点「采用为内部基准」才写入人工维护区、生效到成本引擎。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">材料</label>
            <select
              className="input-field w-40"
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
            >
              {MATERIAL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">克重 (g)</label>
            <select
              className="input-field w-28"
              value={grammage}
              onChange={(e) => setGrammage(e.target.value)}
            >
              {GRAMMAGE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">表面处理</label>
            <select
              className="input-field w-32"
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
            >
              {SURFACE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-accent"
            onClick={refresh}
            disabled={refreshing || busy}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {refreshing ? "刷新中…" : "刷新行情"}
          </button>
        </div>
      </div>

      {result && (
        <div className="card p-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-brand-900">
              行情结果
            </h3>
            <span
              className={`flex items-center gap-1 text-xs ${
                result.hasFallback ? "text-amber-600" : "text-green-600"
              }`}
            >
              {result.hasFallback ? (
                <AlertTriangle className="h-3 w-3" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {result.hasFallback ? "已回退本地基准" : "实时行情获取"}
            </span>
          </div>
          <p className="mb-4 text-sm text-brand-500">{result.summary}</p>

          {paper && (
            <div className="mb-3 flex items-center justify-between rounded-lg bg-brand-50 px-4 py-3">
              <div>
                <div className="text-sm text-brand-600">
                  {paper.item} · 主材单价
                </div>
                <div className="text-2xl font-bold text-brand-900">
                  {paper.price} 元/吨
                </div>
                <div className="mt-1 text-xs text-brand-400">
                  来源：{paper.source} · 更新于{" "}
                  {new Date(paper.priceTimestamp).toLocaleString("zh-CN")}
                  {!isFresh(paper.priceTimestamp) && "（已过期，建议刷新）"}
                </div>
              </div>
              <button className="btn-primary" onClick={adopt} disabled={busy}>
                采用为内部基准
              </button>
            </div>
          )}

          {surfaceEntry && (
            <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
              {surfaceEntry.item}：{surfaceEntry.price} {surfaceEntry.unit} ·
              来源：{surfaceEntry.source}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
