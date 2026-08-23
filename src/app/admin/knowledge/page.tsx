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
  const [status, setStatus] = useState<any>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/knowledge-base?view=network");
      const data = await res.json();
      setStatus(data);
    } catch (e: any) {
      setMsg({ kind: "err", text: "加载行情状态失败：" + (e?.message || e) });
    }
  }, [setMsg]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const baselineMap: Record<string, number> = {};
  (status?.baselineEntries || []).forEach((e: any) => {
    const v = typeof e.value === "number" ? e.value : e.value?.value;
    if (typeof v === "number") baselineMap[e.key] = v;
  });
  const marketMap: Record<string, any> = {};
  (status?.marketEntries || []).forEach((e: any) => {
    marketMap[e.key] = e;
  });
  const materialLabel = (m: string) =>
    MATERIAL_OPTIONS.find((x) => x.value === m)?.label || m;

  const refreshPair = async (material: string, grammage: string) => {
    try {
      const res = await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh-network-pair",
          material,
          grammage,
        }),
      });
      const data = await res.json();
      if (data.stored)
        setMsg({ kind: "ok", text: `已刷新 ${material}:${grammage} 市场行情` });
      else
        setMsg({
          kind: "err",
          text: `未获取到真实行情（${data.summary || "回退本地基准"}），未写入`,
        });
      await loadStatus();
    } catch (e: any) {
      setMsg({ kind: "err", text: "刷新失败：" + (e?.message || e) });
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      const res = await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-network-all" }),
      });
      const data = await res.json();
      setMsg({
        kind: data.updated > 0 ? "ok" : "err",
        text: `刷新完成：更新 ${data.updated} 条，跳过 ${data.skipped} 条（共 ${data.total}）${data.apiConfigured ? "" : "；当前未配置外部行情 API"}`,
      });
      await loadStatus();
    } catch (e: any) {
      setMsg({ kind: "err", text: "刷新失败：" + (e?.message || e) });
    } finally {
      setRefreshingAll(false);
    }
  };

  const adopt = async (material: string, grammage: string, price: number) => {
    try {
      const res = await fetch("/api/admin/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adopt-network",
          material,
          grammage,
          price,
        }),
      });
      if (!res.ok) throw new Error();
      onAdopted();
      await loadStatus();
    } catch {
      setMsg({ kind: "err", text: "采纳失败" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-brand-900">
              市场行情（定时自动刷新）
            </h2>
            <p className="mt-1 text-sm text-brand-500">
              自动从外部行情 API 拉取纸价写入「市场行情」列（仅作参考，不影响成本引擎）。
              配了 API 即按间隔自动跑；无 API 时优雅空转、绝不写假数据。
            </p>
          </div>
          <button
            className="btn-accent"
            onClick={refreshAll}
            disabled={refreshingAll || busy}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {refreshingAll ? "刷新中…" : "立即刷新全部"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-brand-500">
          <span>
            自动刷新间隔：
            <b className="text-brand-700">{status?.intervalMinutes ?? "-"}</b> 分钟
          </span>
          <span>
            外部行情源：
            {status?.apiConfigured ? (
              <span className="text-green-600">已配置</span>
            ) : (
              <span className="text-amber-600">
                未配置（不会写入市场行情）
              </span>
            )}
          </span>
          <span>监控组合：{status?.pairs?.length ?? 0} 个（材料×克重）</span>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-brand-50 text-brand-600">
            <tr>
              <th className="px-4 py-2 text-left">材料</th>
              <th className="px-4 py-2 text-left">克重</th>
              <th className="px-4 py-2 text-left">内部基准（人工）</th>
              <th className="px-4 py-2 text-left">市场行情（行情源）</th>
              <th className="px-4 py-2 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {(status?.pairs || []).map((p: any) => {
              const key = `${p.material}:${p.grammage}`;
              const market = marketMap[key];
              const mVal =
                market?.value?.value ?? (typeof market?.value === "number" ? market.value : undefined);
              const fetchedAt = market?.value?.fetchedAt || market?.updatedAt;
              const fresh = isFresh(fetchedAt);
              return (
                <tr key={key} className="border-t border-brand-100">
                  <td className="px-4 py-2">{materialLabel(p.material)}</td>
                  <td className="px-4 py-2">{p.grammage}g</td>
                  <td className="px-4 py-2">
                    {baselineMap[key] != null
                      ? `${baselineMap[key]} 元/吨`
                      : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {mVal != null ? (
                      <div>
                        <div className="font-medium text-brand-900">
                          {mVal} 元/吨
                        </div>
                        <div className="text-xs text-brand-400">
                          {market.source} ·{" "}
                          {fetchedAt
                            ? new Date(fetchedAt).toLocaleString("zh-CN")
                            : ""}
                          {!fresh && "（已过期）"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-brand-400">未拉取</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <button
                        className="btn-secondary px-3 py-1.5 text-xs"
                        disabled={busy}
                        onClick={() => refreshPair(p.material, p.grammage)}
                      >
                        刷新
                      </button>
                      <button
                        className="btn-primary px-3 py-1.5 text-xs"
                        disabled={busy || mVal == null}
                        onClick={() => adopt(p.material, p.grammage, mVal)}
                      >
                        采用
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
