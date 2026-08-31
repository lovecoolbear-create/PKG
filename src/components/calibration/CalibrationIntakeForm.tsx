"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProductTypeConfig } from "@/types";
import { validateCase, type CaseLike } from "@/lib/calibration/validate";

// 在 iframe 内嵌入（工作台）时，"返回主页"应回到工作台中心；独立打开才跳首页
function handleBack() {
  if (typeof window !== "undefined" && window.self !== window.top) {
    window.parent.postMessage({ type: "workbench:exit-to-center" }, "*");
  } else {
    window.location.href = "/";
  }
}

/** 上传/AI 解析后回灌表单的预填结构（部分字段即可，缺失靠用户确认补齐） */
export type IntakeInitial = {
  caseId?: string;
  supplier?: string;
  date?: string;
  note?: string;
  productType?: string;
  input?: Record<string, unknown>;
  actualTotal?: number | string;
  dims?: Record<string, string>;
  anchors?: Record<string, string>;
  actualLabor?: Record<string, string>;
};

/**
 * 轻量版报价单录入表单（无 LLM，纯规则）。
 * 目标：把"拿到供应商报价 → 填进 calibration-cases.json"从手写 schema 变成可视化表单。
 * 只填供应商实际给的：实际总价(必填) + 可拆五维 + 可选外部锚(纸价/工价/版费/财务)。
 * 绝不在此伪造维度拆解——未拆解的案例由 calibration-real.ts 半拆解锚定逻辑处理。
 */

const DIM_KEYS: { key: string; label: string }[] = [
  { key: "material", label: "材料" },
  { key: "labor", label: "人工" },
  { key: "process", label: "加工费(含设备)" },
  { key: "design_plate", label: "设计与制版" },
  { key: "finance_other", label: "财务与其他" },
];

const ANCHORS: { key: string; label: string; unit: string; hint: string }[] = [
  {
    key: "paperPricePerTon",
    label: "纸价锚",
    unit: "元/吨",
    hint: "纸商/行情当期实际纸价（独立外部参考，非引擎查表）",
  },
  {
    key: "laborRatePerPiece",
    label: "工价锚",
    unit: "元/个",
    hint: "该厂实际计件工价（独立外部参考）",
  },
  { key: "plateCost", label: "制版锚", unit: "元", hint: "实际制版/刀模费（独立外部参考）" },
  {
    key: "financeTotal",
    label: "财务锚",
    unit: "元",
    hint: "实际管理+利润+物流合计（独立外部参考）",
  },
];

const LABOR_FIELDS: { key: string; label: string; unit?: string }[] = [
  { key: "total", label: "人工合计" },
  { key: "unit", label: "单只工价", unit: "元/个" },
  { key: "hours", label: "总工时", unit: "h" },
  { key: "hourlyRate", label: "工时单价", unit: "元/h" },
  { key: "headcount", label: "人数" },
  { key: "setupHours", label: "换线/调机", unit: "h" },
  { key: "note", label: "备注" },
];

function isVisible(
  field: ProductTypeConfig["fields"][number],
  values: Record<string, unknown>
): boolean {
  const sw = field.showWhen;
  if (!sw) return true;
  const cur = values[sw.field];
  const targets = Array.isArray(sw.value) ? sw.value : [sw.value];
  return targets.includes(cur as any);
}

function initDefaults(fields: ProductTypeConfig["fields"]): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
  }
  return init;
}

export function CalibrationIntakeForm({
  productTypes,
  initial,
  refreshToken = 0,
  onSaved,
}: {
  productTypes: ProductTypeConfig[];
  initial?: IntakeInitial;
  /** 外部（批量导入/删除）变更后递增，用于刷新已录入案例数 */
  refreshToken?: number;
  onSaved?: (count: number) => void;
}) {
  const initPt = initial?.productType || productTypes[0]?.code || "";
  const initCfg = productTypes.find((p) => p.code === initPt);
  const initInput = { ...initDefaults(initCfg?.fields ?? []), ...(initial?.input ?? {}) };

  const [productType, setProductType] = useState(initPt);
  const [input, setInput] = useState<Record<string, unknown>>(initInput);

  const [caseId, setCaseId] = useState(initial?.caseId ?? "");
  const [supplier, setSupplier] = useState(initial?.supplier ?? "");
  const [date, setDate] = useState(initial?.date ?? "");
  const [note, setNote] = useState(initial?.note ?? "");

  const [actualTotal, setActualTotal] = useState(
    initial?.actualTotal !== undefined ? String(initial.actualTotal) : ""
  );
  const [dims, setDims] = useState<Record<string, string>>(initial?.dims ?? {});
  const [anchors, setAnchors] = useState<Record<string, string>>(initial?.anchors ?? {});
  const [actualLabor, setActualLabor] = useState<Record<string, string>>(initial?.actualLabor ?? {});

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [caseCount, setCaseCount] = useState<number | null>(null);

  const cfg = useMemo(
    () => productTypes.find((p) => p.code === productType),
    [productTypes, productType]
  );

  // 注：切换品类时的参数重置改在 select onChange 处理，避免覆盖上传/AI 预填

  // 进入页面拉一次当前案例数；外部批量导入/删除后按 refreshToken 重新拉
  useEffect(() => {
    fetch("/api/calibration/cases")
      .then((r) => r.json())
      .then((d) => setCaseCount(d.count ?? 0))
      .catch(() => setCaseCount(null));
  }, [refreshToken]);

  const setInputVal = (key: string, v: unknown) =>
    setInput((prev) => ({ ...prev, [key]: v }));

  const renderField = (f: ProductTypeConfig["fields"][number]) => {
    const v = input[f.key];
    const common = "input input-bordered w-full text-sm";
    if (f.type === "select") {
      return (
        <select
          className={common}
          value={v === undefined ? "" : String(v)}
          onChange={(e) => setInputVal(f.key, e.target.value)}
        >
          <option value="">（未填）</option>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (f.type === "boolean") {
      return (
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={!!v}
          onChange={(e) => setInputVal(f.key, e.target.checked)}
        />
      );
    }
    if (f.type === "number") {
      return (
        <input
          type="number"
          className={common}
          placeholder={f.placeholder}
          value={v === undefined ? "" : String(v)}
          onChange={(e) =>
            setInputVal(f.key, e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      );
    }
    return (
      <input
        type="text"
        className={common}
        placeholder={f.placeholder}
        value={v === undefined ? "" : String(v)}
        onChange={(e) => setInputVal(f.key, e.target.value)}
      />
    );
  };

  const groups = useMemo(() => {
    if (!cfg) return [] as { group: string; fields: ProductTypeConfig["fields"] }[];
    const order: string[] = [];
    const map = new Map<string, ProductTypeConfig["fields"]>();
    for (const f of cfg.fields) {
      const g = f.group ?? "其他";
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(f);
    }
    return order.map((g) => ({ group: g, fields: map.get(g)! }));
  }, [cfg]);

  // 实时完整性自检：与 /api/calibration/batch 共用 validateCase，口径不分叉
  const liveCase: CaseLike = useMemo(() => {
    const actual: Record<string, unknown> = {};
    const t = Number(actualTotal);
    if (isFinite(t) && t > 0) actual.total = t;
    for (const d of DIM_KEYS) {
      const s = dims[d.key];
      if (s !== undefined && s !== "" && isFinite(Number(s))) actual[d.key] = Number(s);
    }
    const meta: Record<string, unknown> = {};
    if (supplier.trim()) meta.supplier = supplier.trim();
    if (date.trim()) meta.date = date.trim();
    if (note.trim()) meta.note = note.trim();
    for (const a of ANCHORS) {
      const s = anchors[a.key];
      if (s !== undefined && s !== "" && isFinite(Number(s))) meta[a.key] = Number(s);
    }
    return { caseId, productType, input: { ...input, productType }, actual, meta };
  }, [actualTotal, dims, anchors, supplier, date, note, caseId, productType, input]);

  const issues = useMemo(() => validateCase(liveCase), [liveCase]);
  const started = caseId.trim() !== "" || actualTotal !== "";

  async function handleSubmit() {
    setBusy(true);
    setMsg(null);
    // 校验规则统一来自 validateCase（与批量导入同一份），不在此另写一套
    if (issues.errors.length > 0) {
      setMsg({ ok: false, text: issues.errors.map((e) => e.message).join("；") });
      setBusy(false);
      return;
    }
    const total = Number(actualTotal);

    const actual: Record<string, unknown> = { total };
    for (const d of DIM_KEYS) {
      const s = dims[d.key];
      if (s !== undefined && s !== "" && isFinite(Number(s))) actual[d.key] = Number(s);
    }
    const meta: Record<string, unknown> = {};
    if (supplier.trim()) meta.supplier = supplier.trim();
    if (date.trim()) meta.date = date.trim();
    if (note.trim()) meta.note = note.trim();
    for (const a of ANCHORS) {
      const s = anchors[a.key];
      if (s !== undefined && s !== "" && isFinite(Number(s))) meta[a.key] = Number(s);
    }

    const al: Record<string, unknown> = {};
    for (const l of LABOR_FIELDS) {
      const s = actualLabor[l.key];
      if (s !== undefined && s !== "") {
        al[l.key] = l.key === "note" ? s : Number(s);
      }
    }

    const payload: Record<string, unknown> = {
      caseId: caseId.trim(),
      // 写入品类身份，确保校准脚本走对应 Agent 分支（否则瓦楞/平印会被误当彩盒估算）
      input: { ...input, productType },
      actual,
    };
    if (Object.keys(meta).length > 0) payload.meta = meta;
    if (Object.keys(al).length > 0) payload.actualLabor = al;

    try {
      const res = await fetch("/api/calibration/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMsg({ ok: false, text: data.error || "提交失败" });
      } else {
        setCaseCount(data.count);
        setMsg({
          ok: true,
          text: `已追加/覆盖案例「${data.caseId}」，当前共 ${data.count} 例。可跑 npm run test:calibration:real 查看偏差。`,
        });
        onSaved?.(data.count);
        if (Array.isArray(data.warnings) && data.warnings.length) {
          setMsg({
            ok: true,
            text: `已保存「${data.caseId}」，当前共 ${data.count} 例。提醒：${data.warnings.join("；")}`,
          });
        }
        // 清空表单（保留品类与已填参数，便于连续录入）
        setCaseId("");
        setSupplier("");
        setActualTotal("");
        setDims({});
        setAnchors({});
        setActualLabor({});
      }
    } catch (e) {
      setMsg({ ok: false, text: "网络错误：" + String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-900"
        >
          ← 返回主页
        </button>
      </div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-900">报价单录入（校准数据入口）</h1>
          <p className="mt-1 text-sm text-brand-600">
            把供应商报价填成校准案例。只填供应商实际给的——总价必填，五维/锚可选。
            不拆五维也能校准（脚本用外部纸价锚材料维、残差隔离加工费）。
          </p>
        </div>
        {caseCount !== null && (
          <span className="rounded-full bg-brand-100 px-3 py-1 text-sm font-medium text-brand-800">
            当前 {caseCount} 例
          </span>
        )}
      </div>

      {/* 案例标识 */}
      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-lg font-semibold text-brand-900">案例标识</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label-text text-brand-700">案例标识 caseId <span className="text-red-500">*</span></span>
            <input
              className="input input-bordered w-full"
              placeholder="如 2026-客户A-白卡彩盒"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label-text text-brand-700">供应商</span>
            <input
              className="input input-bordered w-full"
              placeholder="如 东莞某精品盒厂"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label-text text-brand-700">日期</span>
            <input
              className="input input-bordered w-full"
              placeholder="如 2026-08"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label-text text-brand-700">备注（口径/税/物流）</span>
            <input
              className="input input-bordered w-full"
              placeholder="含13%税；物流含在财务；烫金按整面"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
      </section>

      {/* 产品与参数 */}
      <section className="card mb-5 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-brand-900">产品与参数</h2>
          <label className="block">
            <span className="label-text text-brand-700">产品类别</span>
            <select
              className="select select-bordered select-sm"
              value={productType}
              onChange={(e) => {
                const np = e.target.value;
                setProductType(np);
                setInput(initDefaults(productTypes.find((p) => p.code === np)?.fields ?? []));
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
        {groups.map((g) => (
          <div key={g.group} className="mb-4">
            <h3 className="mb-2 text-sm font-medium text-brand-600">{g.group}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {g.fields
                .filter((f) => isVisible(f, input))
                .map((f) => (
                  <label key={f.key} className="block">
                    <span className="label-text text-brand-700">
                      {f.label}
                      {f.required && <span className="text-red-500"> *</span>}
                      {f.unit && <span className="text-brand-400"> ({f.unit})</span>}
                    </span>
                    {renderField(f)}
                    {f.impactHint && (
                      <span className="mt-0.5 block text-xs text-brand-400">{f.impactHint}</span>
                    )}
                  </label>
                ))}
            </div>
          </div>
        ))}
      </section>

      {/* 实际报价（黄金标准） */}
      <section className="card mb-5 p-5">
        <h2 className="mb-1 text-lg font-semibold text-brand-900">实际报价（黄金标准）</h2>
        <p className="mb-3 text-xs text-brand-500">
          供应商拆了五维就填对应项；只报总价就只填总价。引擎侧用真实 Agent 计算，不重写公式。
        </p>
        <label className="mb-3 block sm:w-1/2">
          <span className="label-text text-brand-700">实际总价 <span className="text-red-500">*</span>（元）</span>
          <input
            type="number"
            className="input input-bordered w-full"
            placeholder="如 9200"
            value={actualTotal}
            onChange={(e) => setActualTotal(e.target.value)}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-5">
          {DIM_KEYS.map((d) => (
            <label key={d.key} className="block">
              <span className="label-text text-brand-700">{d.label}</span>
              <input
                type="number"
                className="input input-bordered w-full"
                placeholder="可留空"
                value={dims[d.key] ?? ""}
                onChange={(e) => setDims((p) => ({ ...p, [d.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      </section>

      {/* 外部锚 */}
      <section className="card mb-5 p-5">
        <h2 className="mb-1 text-lg font-semibold text-brand-900">外部锚（独立参考，非引擎查表）</h2>
        <p className="mb-3 text-xs text-brand-500">
          来自纸商报价/市场工价等独立凭证。填了纸价锚即可半拆解——脚本用它在占比最大的材料维锚定，
          残差即加工费，专门标定唯一公式风险维。缺则退化引擎值、不校验。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {ANCHORS.map((a) => (
            <label key={a.key} className="block">
              <span className="label-text text-brand-700">
                {a.label}（{a.unit}）
              </span>
              <input
                type="number"
                className="input input-bordered w-full"
                placeholder="可留空"
                value={anchors[a.key] ?? ""}
                onChange={(e) => setAnchors((p) => ({ ...p, [a.key]: e.target.value }))}
              />
              <span className="mt-0.5 block text-xs text-brand-400">{a.hint}</span>
            </label>
          ))}
        </div>
      </section>

      {/* actualLabor 可选 */}
      <section className="card mb-5 p-5">
        <h2 className="mb-1 text-lg font-semibold text-brand-900">人工明细（可选）</h2>
        <p className="mb-3 text-xs text-brand-500">
          若供应商给了计件/计时混合的人工明细，可填此块，脚本原样透传供对照。全留空则跳过。
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {LABOR_FIELDS.map((l) => (
            <label key={l.key} className="block">
              <span className="label-text text-brand-700">
                {l.label}
                {l.unit && <span className="text-brand-400"> ({l.unit})</span>}
              </span>
              <input
                type={l.key === "note" ? "text" : "number"}
                className="input input-bordered w-full"
                placeholder="可留空"
                value={actualLabor[l.key] ?? ""}
                onChange={(e) => setActualLabor((p) => ({ ...p, [l.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      </section>

      {/* 提交前自检 */}
      {started && (issues.errors.length > 0 || issues.warnings.length > 0) && (
        <section className="card mb-5 p-5">
          <h2 className="mb-2 text-lg font-semibold text-brand-900">提交前自检</h2>
          {issues.errors.length > 0 && (
            <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-red-700">
              {issues.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          )}
          {issues.warnings.length > 0 && (
            <>
              <p className="mb-1 text-xs text-brand-500">
                以下不影响提交，但会削弱校准价值（能补就补）：
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700">
                {issues.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="flex items-center gap-4">
        <button className="btn btn-primary" onClick={handleSubmit} disabled={busy}>
          {busy ? "提交中…" : "生成并追加案例"}
        </button>
        <a className="btn btn-ghost" href="/api/calibration/cases" target="_blank" rel="noreferrer">
          查看当前案例 JSON
        </a>
      </div>

      {msg && (
        <div
          className={`mt-4 rounded-lg p-3 text-sm ${
            msg.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="mt-6 rounded-lg bg-brand-50 p-4 text-xs text-brand-600">
        <p className="font-medium">下一步：</p>
        <p>
          1. 攒满 10–20 例后，在终端运行{" "}
          <code className="rounded bg-white px-1">npm run test:calibration:real</code> 跑偏差校准。
        </p>
        <p>2. 越界维度 → 反推对应常数（见生成的 cost-calibration-real.md）→ 调后重跑向 ±10% 收敛。</p>
        <p>3. 半拆解：填了纸价锚的案例，残差即加工费校准信号；全无锚的案例仅参考、不报警。</p>
      </div>
    </div>
  );
}
