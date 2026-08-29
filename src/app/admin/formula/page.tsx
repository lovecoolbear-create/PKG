"use client";

/**
 * 成本公式管理（F5 · 私密页）
 * ----------------------------------------------------------------
 * 不进任何导航，需显式访问 /admin/formula。
 * 鉴权 fail-closed：请求须带 x-admin-token，未配置 FORMULA_ADMIN_TOKEN 时服务端一律 403。
 *
 * 交互要点：
 *  - 按维度分组的配方表，每行 = 成本项 + 计算方式 + 参数 + 条件 + 权重 + 启停
 *  - **占比直接可改**：percent_of 项额外提供百分比数字框（用户决策）
 *  - **试算**：保存前先跑 9 个黄金用例与基线比对，看清影响再落地
 *  - 审计日志：每次改动留痕（谁/何时/前后值）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { validateCostItem, KIND_LABELS, REQUIRED_PARAMS } from "@/lib/cost-formula/schema";

interface CostItemRow {
  id: string;
  productType: string;
  dimension: string;
  name: string;
  kind: string;
  params: string;
  conditions: string | null;
  weight: number;
  sortOrder: number;
  enabled: boolean;
  status: string;
  note: string | null;
  /** 静态校验结果：null 表示健康，否则为错误描述（由服务端逐项算好） */
  health?: string | null;
}

interface CacheInfo {
  loadedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
  stale: boolean;
  groups: number;
}

interface AuditRow {
  id: string;
  costItemId: string;
  action: string;
  actor: string;
  before: string | null;
  after: string | null;
  reason: string | null;
  createdAt: string;
}

const PRODUCT_TYPES = [
  { code: "color_print_box", label: "彩印纸盒" },
  { code: "corrugated_box", label: "瓦楞纸箱" },
  { code: "flat_print", label: "平面彩印" },
];

const DIMENSIONS = [
  { key: "material", label: "材料" },
  { key: "labor", label: "人工" },
  { key: "process", label: "加工" },
  { key: "design_plate", label: "设计与制版" },
  { key: "finance_other", label: "财务与其他" },
];

const KINDS = [
  "flat",
  "unit_rate",
  "area_rate",
  "weight_rate",
  "ink_rate",
  "tiered",
  "stepped",
  "percent_of",
  "formula",
];

/**
 * 条件可用字段——与 src/lib/cost-formula/engine-bridge.ts 的 factsOf() 保持一致。
 * 改那边的字段时这里要同步，否则用户在页面上写出无效条件。
 */
const FACT_FIELDS = [
  "productType",
  "material",
  "grammage",
  "coverGrammage",
  "surface",
  "printMethod",
  "binding",
  "boxType",
  "fluteType",
  "boardStructure",
  "linerMaterial",
  "linerGrammage",
  "pages",
  "quantity",
  "needGluing",
  "provideReadyDesign",
  "urgency",
  "laborRegion",
  "delivery",
];

const TOKEN_KEY = "formula_admin_token";

export default function FormulaAdminPage() {
  const [token, setToken] = useState("");
  const [productType, setProductType] = useState("color_print_box");
  const [items, setItems] = useState<CostItemRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, Partial<CostItemRow>>>({});
  /** 各维度「新增成本项」输入框的名称 */
  const [newName, setNewName] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tryRun, setTryRun] = useState<{
    /** 本次试算是否套用了未保存草稿（服务端回报，避免前端自说自话） */
    withDraft?: boolean;
    summary: { total: number; passed: number; failed: number };
    results: Array<{
      id: string;
      name: string;
      passed: boolean;
      totalMin: number;
      baselineMin: number;
      driftPct: number;
      dims: Array<{ dim: string; actual: number; expected: number; driftPct: number }>;
    }>;
  } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
  }, []);

  const authHeaders = useMemo(
    () => ({ "Content-Type": "application/json", "x-admin-token": token }),
    [token]
  );

  const load = useCallback(
    async (opts?: { keepMsg?: boolean }) => {
      if (!token) return;
      setBusy(true);
      // keepMsg：保存成功后会立刻 reload 刷新列表，此时不能把成功提示擦掉
      if (!opts?.keepMsg) setMsg(null);
      try {
        const res = await fetch(`/api/admin/formula?productType=${productType}`, {
          headers: authHeaders,
        });
        const data = await res.json();
        if (!res.ok) {
          setMsg({ kind: "err", text: data?.error ?? `读取失败（${res.status}）` });
          setItems([]);
          return;
        }
        setItems(data.items ?? []);
        setAudit(data.audit ?? []);
        if (data.cache) setCache(data.cache);
      } catch (e) {
        setMsg({ kind: "err", text: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [token, productType, authHeaders]
  );

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  /** 手动刷新配方缓存（直接改库、或缓存显示已过期时用） */
  async function refreshCache() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/formula", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ action: "reload" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data?.error ?? "刷新失败" });
        return;
      }
      setMsg({ kind: "ok", text: "配方缓存已刷新" });
      await load({ keepMsg: true });
    } finally {
      setBusy(false);
    }
  }

  /** 把某一行恢复成库里的值（丢弃未保存的草稿） */
  function revert(id: string) {
    setDraft((d) => {
      const n = { ...d };
      delete n[id];
      return n;
    });
  }

  function patch(id: string, p: Partial<CostItemRow>) {
    setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...p } }));
  }

  /** percent_of 的百分比快捷编辑（占比直接可改） */
  function patchRate(id: string, rate: number) {
    const row = items.find((i) => i.id === id);
    if (!row) return;
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params || "{}");
    } catch {
      params = {};
    }
    params.rate = rate;
    patch(id, { params: JSON.stringify(params) } as Partial<CostItemRow>);
  }

  async function save(id: string) {
    const p = draft[id];
    if (!p || Object.keys(p).length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/formula", {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ id, patch: p }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data?.error ?? "保存失败" });
        return;
      }
      setDraft((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
      setMsg({ kind: "ok", text: "已保存并刷新配方缓存" });
      // keepMsg：否则 load() 会把刚设的成功提示擦掉，用户永远看不到"保存成功"
      await load({ keepMsg: true });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 试算。**带上未保存的草稿**——这才是"保存前先看影响"。
   *
   * 早期实现只发 { action:"try-run" }，服务端跑的是已保存状态，流程被迫变成
   * 「改 → 保存（已生效）→ 试算 → 发现偏了 → 手动改回」，正好是最该避免的顺序。
   */
  async function runTryRun() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/formula", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ action: "try-run", draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data?.error ?? "试算失败" });
        return;
      }
      setTryRun(data);
    } finally {
      setBusy(false);
    }
  }

  /** 丢弃全部未保存改动 */
  function revertAll() {
    setDraft({});
    setMsg({ kind: "ok", text: "已丢弃全部未保存改动" });
  }

  /** 统一的 POST 动作（新增 / 归档 / 回滚） */
  async function act(payload: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/formula", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data?.error ?? "操作失败" });
        return false;
      }
      setMsg({ kind: "ok", text: data?.hint ? `${okText}：${data.hint}` : okText });
      await load({ keepMsg: true });
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function createItem(dimension: string) {
    const name = newName[dimension]?.trim();
    if (!name) {
      setMsg({ kind: "err", text: "先填成本项名再新增" });
      return;
    }
    const ok = await act(
      {
        action: "create",
        item: {
          productType,
          dimension,
          name,
          kind: "flat",
          params: JSON.stringify({ amount: 0 }),
        },
      },
      "已新增"
    );
    if (ok) setNewName((s) => ({ ...s, [dimension]: "" }));
  }

  function rowOf(r: CostItemRow): CostItemRow {
    return { ...r, ...(draft[r.id] ?? {}) };
  }

  const dirtyCount = Object.keys(draft).length;

  return (
    <main className="mx-auto max-w-[1180px] p-6 text-sm">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-base font-medium">成本公式管理</h1>
        <span className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">
          私有 · 不入公网
        </span>
      </div>

      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        此页直接改成本算法，改错会让报价算错钱。<b>改完务必点「试算」</b>，确认 9 个黄金用例没有意外偏离再交付。
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">管理令牌（x-admin-token）</span>
          <input
            type="password"
            className="w-64 rounded border border-slate-300 px-2 py-1 text-xs"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              localStorage.setItem(TOKEN_KEY, e.target.value);
            }}
            placeholder="FORMULA_ADMIN_TOKEN"
          />
          <span className="text-[11px] text-slate-400">
            令牌在项目根目录 <code className="rounded bg-slate-100 px-1">.env</code> 的{" "}
            <code className="rounded bg-slate-100 px-1">FORMULA_ADMIN_TOKEN</code>；未配置时服务端一律拒绝。
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">品类</span>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            value={productType}
            onChange={(e) => setProductType(e.target.value)}
          >
            {PRODUCT_TYPES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
          onClick={() => load()}
          disabled={!token || busy}
        >
          读取
        </button>
        <button
          className={`rounded px-3 py-1 text-xs ${
            dirtyCount > 0
              ? "bg-sky-600 text-white hover:bg-sky-700"
              : "border border-slate-300 hover:bg-slate-50"
          }`}
          onClick={runTryRun}
          disabled={!token || busy}
          title={
            dirtyCount > 0
              ? "带上未保存的改动一起跑，不写库"
              : "用当前已保存的配方跑 9 个黄金用例"
          }
        >
          {dirtyCount > 0
            ? `试算（含 ${dirtyCount} 项未保存改动）`
            : "试算（跑 9 个黄金用例）"}
        </button>
        {dirtyCount > 0 && (
          <button
            className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            onClick={revertAll}
            disabled={busy}
          >
            丢弃全部改动（{dirtyCount}）
          </button>
        )}
        <button
          className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
          onClick={refreshCache}
          disabled={!token || busy}
          title="直接改了数据库、或缓存已过期时用它强制重取"
        >
          刷新缓存
        </button>
        {cache && (
          <div className="ml-auto text-[11px] text-slate-500">
            配方缓存：
            {cache.loadedAt == null ? (
              <span className="text-amber-700">未加载</span>
            ) : (
              <>
                <span className={cache.stale ? "text-amber-700" : "text-emerald-700"}>
                  {cache.ageMs != null && Math.round(cache.ageMs / 1000)}s 前加载
                  {cache.stale ? "（已过期，下次读取自动重取）" : ""}
                </span>
                <span className="ml-2">{cache.groups} 个维度组</span>
              </>
            )}
          </div>
        )}
      </div>

      {msg && (
        <div
          className={`mb-4 rounded px-3 py-2 text-xs ${
            msg.kind === "ok"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      {tryRun && (
        <div className="mb-5 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 text-xs font-medium">
            试算结果：{tryRun.summary.passed} / {tryRun.summary.total} 通过
            {tryRun.summary.failed > 0 && (
              <span className="ml-2 text-red-600">{tryRun.summary.failed} 项偏离</span>
            )}
            {tryRun.withDraft ? (
              <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-normal text-sky-700">
                已套用未保存改动 · 数据库未写入
              </span>
            ) : (
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500">
                当前已保存配方
              </span>
            )}
            <span className="ml-2 font-normal text-slate-400">
              偏离 = 与 scripts/golden-baseline.json 比对（容差 0.5%）
            </span>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 text-left">用例</th>
                  <th className="py-1 text-right">当前总额</th>
                  <th className="py-1 text-right">基线</th>
                  <th className="py-1 text-right">偏离</th>
                  <th className="py-1 pl-3 text-left">是谁偏的（维度归因）</th>
                </tr>
              </thead>
              <tbody>
                {tryRun.results.map((r) => {
                  const bad = r.dims.filter((d) => Math.abs(d.driftPct) > 0.5);
                  return (
                    <tr key={r.id} className="border-t border-slate-100 align-top">
                      <td className="py-1">{r.name}</td>
                      <td className="py-1 text-right">¥{r.totalMin}</td>
                      <td className="py-1 text-right text-slate-500">¥{r.baselineMin}</td>
                      <td
                        className={`py-1 text-right ${
                          r.passed ? "text-emerald-600" : "text-red-600"
                        }`}
                      >
                        {r.driftPct > 0 ? "+" : ""}
                        {r.driftPct}%
                      </td>
                      {/* 维度归因：API 一直返回 dims[]，早期前端没渲染，
                          用户只看到"偏了 0.91%"却不知道该去改哪一项 */}
                      <td className="py-1 pl-3 text-[11px]">
                        {bad.length === 0 ? (
                          <span className="text-slate-400">各维度均在容差内</span>
                        ) : (
                          bad.map((d) => (
                            <div key={d.dim} className="text-red-600">
                              {d.dim}：{d.expected} → {d.actual}（
                              {d.driftPct > 0 ? "+" : ""}
                              {d.driftPct}%）
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <details className="mb-5 rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            参数怎么写？（计算方式 / 数值写法 / 可用条件字段）
          </summary>
          <div className="mt-3 space-y-3 text-[11px] leading-relaxed text-slate-600">
            <div>
              <div className="mb-1 font-medium text-slate-700">计算方式</div>
              <table className="w-full border-collapse">
                <tbody>
                  {(Object.keys(KIND_LABELS) as string[]).map((k) => (
                    <tr key={k} className="border-t border-slate-100">
                      <td className="w-40 py-0.5 font-mono text-slate-700">{k}</td>
                      <td className="py-0.5">{KIND_LABELS[k]}</td>
                      <td className="py-0.5 text-slate-400">
                        必填：
                        {(REQUIRED_PARAMS[k] ?? []).length
                          ? REQUIRED_PARAMS[k].join("、")
                          : "无"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <div className="mb-1 font-medium text-slate-700">
                数值的四种写法（价格/费率尽量走 KB，别写死）
              </div>
              <ul className="ml-4 list-disc space-y-0.5">
                <li>
                  <code className="rounded bg-slate-100 px-1">350</code> 直接给数字
                </li>
                <li>
                  <code className="rounded bg-slate-100 px-1">
                    {'{"kb":"process_rate:plate_cmyk","fallback":350}'}
                  </code>{" "}
                  查知识库，查不到用 fallback；支持占位符{" "}
                  <code className="rounded bg-slate-100 px-1">
                    labor_rate:logistics:{'{delivery}'}
                  </code>
                </li>
                <li>
                  <code className="rounded bg-slate-100 px-1">{'{"ctx":"cmykColors"}'}</code>{" "}
                  取上下文标量（色数、数量等由输入决定的量）
                </li>
                <li>
                  <code className="rounded bg-slate-100 px-1">
                    {'{"by":"urgency","map":{"standard":0,"urgent":7.5},"fallback":0}'}
                  </code>{" "}
                  按字段查表（档位类）
                </li>
              </ul>
            </div>

            <div>
              <div className="mb-1 font-medium text-slate-700">
                条件可用字段（op：== != in not_in &gt; &gt;= &lt; &lt;=）
              </div>
              <div className="flex flex-wrap gap-1">
                {FACT_FIELDS.map((f) => (
                  <code
                    key={f}
                    className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-600"
                  >
                    {f}
                  </code>
                ))}
              </div>
            </div>

            <div className="text-slate-400">
              存库前会自动校验：JSON 是否合法、kind 是否认识、必填参数是否在。
              校验不通过的项<b className="text-red-600">无法保存</b>
              ——这是刻意的，坏参数会让成本项静默算成 0，报价直接少算。
            </div>
          </div>
        </details>
      )}

      {DIMENSIONS.map((dim) => {
        const rows = items.filter((i) => i.dimension === dim.key);
        // 未纳管的维度不能整段消失——否则使用者会误以为全部已由配方驱动
        if (!rows.length) {
          return (
            <section key={dim.key} className="mb-4">
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                {dim.label}（{dim.key}）·{" "}
                <span className="text-slate-600">尚未纳管，仍走内置硬编码算法</span>
                <span className="ml-1 text-slate-400">
                  （把该维度的成本项迁进配方表后，这里才可编辑）
                </span>
              </div>
            </section>
          );
        }
        return (
          <section key={dim.key} className="mb-6">
            <div className="mb-2 text-xs font-medium text-slate-600">
              {dim.label}（{dim.key}）· {rows.length} 项
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">成本项</th>
                    <th className="px-2 py-1.5 text-left">计算方式</th>
                    <th className="px-2 py-1.5 text-left">参数（JSON）</th>
                    <th className="px-2 py-1.5 text-left">条件（JSON）</th>
                    <th className="px-2 py-1.5 text-right">占比/权重</th>
                    <th className="px-2 py-1.5 text-center">启</th>
                    <th className="px-2 py-1.5 text-left">状态</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const v = rowOf(r);
                    const dirty = !!draft[r.id];
                    // 客户端实时校验：改完 JSON 立刻看到红字，不必等保存被服务端拒
                    // （schema.ts 是纯逻辑、无服务端依赖，可安全进浏览器 bundle）
                    const err = validateCostItem(v);
                    let rate: number | null = null;
                    if (v.kind === "percent_of") {
                      try {
                        const p = JSON.parse(v.params || "{}");
                        if (typeof p.rate === "number") rate = p.rate;
                      } catch {
                        rate = null;
                      }
                    }
                    return (
                      <tr
                        key={r.id}
                        className={`border-t ${err ? "bg-red-50" : "border-slate-100"}`}
                      >
                        <td className="px-2 py-1">
                          <input
                            className={`w-32 rounded border px-1 py-0.5 ${
                              err ? "border-red-300" : "border-slate-200"
                            }`}
                            value={v.name}
                            onChange={(e) => patch(r.id, { name: e.target.value })}
                          />
                          {err && (
                            <div className="mt-1 text-[11px] text-red-600">
                              ⚠ {err}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            className="rounded border border-slate-200 px-1 py-0.5"
                            value={v.kind}
                            onChange={(e) => patch(r.id, { kind: e.target.value })}
                          >
                            {KINDS.map((k) => (
                              <option key={k} value={k}>
                                {KIND_LABELS[k] ?? k} · {k}
                              </option>
                            ))}
                          </select>
                          {(REQUIRED_PARAMS[v.kind]?.length ?? 0) > 0 && (
                            <div className="mt-1 text-[11px] text-slate-400">
                              必填：{REQUIRED_PARAMS[v.kind].join("、")}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <textarea
                            className={`w-72 rounded border px-1 py-0.5 font-mono text-[11px] ${
                              err ? "border-red-300 bg-red-50" : "border-slate-200"
                            }`}
                            rows={2}
                            value={v.params}
                            onChange={(e) => patch(r.id, { params: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <textarea
                            className="w-56 rounded border border-slate-200 px-1 py-0.5 font-mono text-[11px]"
                            rows={2}
                            value={v.conditions ?? ""}
                            onChange={(e) =>
                              patch(r.id, { conditions: e.target.value || null })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          {v.kind === "percent_of" ? (
                            rate !== null ? (
                              // 占比直接可改（用户决策）：改数字即改写 params.rate
                              <div className="flex items-center justify-end gap-1">
                                <span className="text-[11px] text-slate-400">占比</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  className="w-16 rounded border border-amber-300 px-1 py-0.5 text-right"
                                  value={rate}
                                  onChange={(e) =>
                                    patchRate(r.id, Number(e.target.value))
                                  }
                                />
                                <span className="text-[11px] text-slate-400">%</span>
                              </div>
                            ) : (
                              // rate 是 {by,map} 查表（如加急档位）时无法用单个数字表达
                              <div className="text-[11px] text-slate-400">
                                按档位取占比
                                <br />
                                <span className="text-[10px]">
                                  （rate 为查表，请在参数里改）
                                </span>
                              </div>
                            )
                          ) : (
                            <input
                              type="number"
                              step="0.1"
                              className="w-16 rounded border border-slate-200 px-1 py-0.5 text-right"
                              value={v.weight}
                              onChange={(e) =>
                                patch(r.id, { weight: Number(e.target.value) })
                              }
                            />
                          )}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                          />
                        </td>
                        {/* 状态必须可见且可改：新增项落库是 draft（引擎不采用），
                            若页面看不出状态，用户会以为"加了没生效是 bug" */}
                        <td className="px-2 py-1">
                          <select
                            className={`rounded border px-1 py-0.5 ${
                              v.status === "active"
                                ? "border-emerald-300 text-emerald-700"
                                : "border-amber-300 text-amber-700"
                            }`}
                            value={v.status}
                            onChange={(e) => patch(r.id, { status: e.target.value })}
                          >
                            <option value="active">生效中</option>
                            <option value="draft">草稿（引擎不采用）</option>
                            <option value="archived">已归档</option>
                          </select>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1">
                          {err ? (
                            <span
                              className="rounded border border-red-200 px-2 py-1 text-[11px] text-red-500"
                              title={err}
                            >
                              待修正
                            </span>
                          ) : (
                            <button
                              className={`rounded px-2 py-1 text-[11px] ${
                                dirty
                                  ? "bg-amber-500 text-white"
                                  : "border border-slate-200 text-slate-400"
                              }`}
                              onClick={() => save(r.id)}
                              disabled={!dirty || busy}
                            >
                              {dirty ? "保存" : "未修改"}
                            </button>
                          )}
                          {dirty && (
                            <button
                              className="ml-1 rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-50"
                              onClick={() => revert(r.id)}
                              title="丢弃改动，恢复成库里的值"
                            >
                              撤销
                            </button>
                          )}
                          {r.status !== "archived" && (
                            <button
                              className="ml-1 rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-500 hover:bg-red-50 hover:text-red-600"
                              onClick={() => {
                                if (
                                  confirm(
                                    `归档「${r.name}」？归档后引擎不再采用该项，报价会相应减少。数据保留可追溯。`
                                  )
                                ) {
                                  void act({ action: "archive", id: r.id }, "已归档");
                                }
                              }}
                              title="软删除：引擎不再采用，但数据保留以便追溯"
                            >
                              归档
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <input
                className="w-48 rounded border border-slate-300 px-2 py-1 text-xs"
                placeholder={`新增${dim.label}成本项名称`}
                value={newName[dim.key] ?? ""}
                onChange={(e) =>
                  setNewName((s) => ({ ...s, [dim.key]: e.target.value }))
                }
              />
              <button
                className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                onClick={() => void createItem(dim.key)}
                disabled={busy || !(newName[dim.key] ?? "").trim()}
              >
                + 新增
              </button>
              <span className="text-[11px] text-slate-400">
                新增后为「草稿」，先试算确认影响，再改成「生效中」
              </span>
            </div>
          </section>
        );
      })}

      {audit.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 text-xs font-medium text-slate-600">变更审计（最近 50 条）</div>
          <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 text-left">时间</th>
                  <th className="px-2 py-1.5 text-left">动作</th>
                  <th className="px-2 py-1.5 text-left">操作人</th>
                  <th className="px-2 py-1.5 text-left">项</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => {
                  let name = a.costItemId;
                  try {
                    const after = a.after ? JSON.parse(a.after) : null;
                    if (after?.name) name = `${after.productType}/${after.dimension} · ${after.name}`;
                  } catch {
                    /* 忽略解析失败 */
                  }
                  return (
                    <tr key={a.id} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-slate-500">
                        {new Date(a.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="px-2 py-1">{a.action}</td>
                      <td className="px-2 py-1 text-slate-500">{a.actor}</td>
                      <td className="px-2 py-1">{name}</td>
                      {/* 按审计快照回滚：比"恢复出厂默认"实用——审计里存的是
                          每次改动前的完整状态，可以精确退回任意一步之前 */}
                      <td className="whitespace-nowrap px-2 py-1 text-right">
                        {a.before ? (
                          <button
                            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-amber-50 hover:text-amber-700"
                            onClick={() => {
                              if (confirm(`把「${name}」回滚到这次改动之前？`)) {
                                void act({ action: "rollback", auditId: a.id }, "已回滚");
                              }
                            }}
                            disabled={busy}
                          >
                            回滚到此前
                          </button>
                        ) : (
                          <span className="text-[11px] text-slate-300">新增</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
