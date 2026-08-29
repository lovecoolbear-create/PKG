"use client";

import { useEffect, useState } from "react";

interface FieldOption {
  value: string;
  label: string;
}
interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: FieldOption[];
}
interface PendingItem {
  id: string;
  token: string;
  productType: string;
  scope: "header" | "material_text";
  suggestedField?: string;
  confidence?: number;
  createdAt: string;
  fields: FieldDef[];
}

export function DictReviewPanel() {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // 每个候选的临时选择：field / value
  const [pickField, setPickField] = useState<Record<string, string>>({});
  const [pickValue, setPickValue] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/dictionary");
      const data = await res.json();
      const list: PendingItem[] = data.pending ?? [];
      setItems(list);
      // 预填建议字段
      const init: Record<string, string> = {};
      for (const it of list) {
        if (it.suggestedField && it.fields.some((f) => f.key === it.suggestedField))
          init[it.id] = it.suggestedField;
      }
      setPickField(init);
      setPickValue({});
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function confirm(id: string) {
    const field = pickField[id];
    if (!field) {
      setMsg("请先为该词条选择目标字段");
      return;
    }
    const item = items.find((i) => i.id === id);
    // 仅 select 字段且提供了选项时，才需要确认规范值；否则以原始 token 作为值
    const value =
      item && item.fields.find((f) => f.key === field)?.type === "select"
        ? pickValue[id] || undefined
        : undefined;
    const res = await fetch("/api/dictionary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm", id, targetField: field, targetValue: value }),
    });
    const data = await res.json();
    if (data.ok) {
      setMsg(`已确认「${item?.token}」→ ${field}${value ? `=${value}` : ""}，下次同类表自动识别。`);
      load();
    } else setMsg("确认失败：" + (data.error ?? ""));
  }

  async function reject(id: string) {
    const res = await fetch("/api/dictionary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", id }),
    });
    const data = await res.json();
    if (data.ok) {
      setMsg("已拒审该词条。");
      load();
    } else setMsg("拒审失败：" + (data.error ?? ""));
  }

  const headerCount = items.filter((i) => i.scope === "header").length;
  const matCount = items.filter((i) => i.scope === "material_text").length;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-900">待审词典池（人工确认式学习闭环）</h3>
          <button
            onClick={load}
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white"
          >
            刷新
          </button>
        </div>
        <p className="mt-1 text-xs text-brand-500">
          导入报价表时，未被内置词典收录的「表头别名 / 材质描述词」会进此待审池。
          人工确认后落为覆盖，下次同类表自动识别。<strong>只学描述词映射，绝不碰价格/费率。</strong>
        </p>
        <div className="mt-3 flex gap-3 text-sm">
          <span className="rounded bg-brand-50 px-3 py-1 text-brand-700">待审：{items.length}</span>
          <span className="rounded bg-sky-50 px-3 py-1 text-sky-700">表头别名：{headerCount}</span>
          <span className="rounded bg-amber-50 px-3 py-1 text-amber-700">材质片段：{matCount}</span>
        </div>
        {msg && <p className="mt-2 text-sm text-brand-600">{msg}</p>}
      </div>

      <div className="card p-5">
        <h4 className="text-sm font-bold text-brand-900">待审词条</h4>
        {loading ? (
          <p className="mt-2 text-xs text-brand-500">加载中…</p>
        ) : items.length === 0 ? (
          <p className="mt-2 text-xs text-brand-500">
            暂无待审词条。上传客户报价表后，未收录的描述词会出现在这里。
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {items.map((it) => {
              const field = pickField[it.id] ?? "";
              const fieldDef = it.fields.find((f) => f.key === field);
              const conf = it.confidence ? `${Math.round(it.confidence * 100)}%` : "—";
              return (
                <div
                  key={it.id}
                  className="rounded-md border border-brand-200 bg-brand-50/40 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-brand-900">{it.token}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-[11px] ${
                        it.scope === "header"
                          ? "bg-sky-100 text-sky-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {it.scope === "header" ? "表头别名" : "材质片段"}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-brand-500">
                    品类 {it.productType} ·{" "}
                    {it.suggestedField ? (
                      <span>
                        建议字段：<span className="font-medium text-brand-700">{it.suggestedField}</span>（置信度 {conf}）
                      </span>
                    ) : (
                      <span>置信度 {conf}，请人工指定字段</span>
                    )}
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <select
                      value={field}
                      onChange={(e) =>
                        setPickField((p) => ({ ...p, [it.id]: e.target.value }))
                      }
                      className="rounded-md border border-brand-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400"
                    >
                      <option value="">选择目标字段…</option>
                      {it.fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}（{f.key}）
                        </option>
                      ))}
                    </select>
                    {fieldDef?.type === "select" && fieldDef.options.length > 0 && (
                      <select
                        value={pickValue[it.id] ?? ""}
                        onChange={(e) =>
                          setPickValue((p) => ({ ...p, [it.id]: e.target.value }))
                        }
                        className="rounded-md border border-brand-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400"
                      >
                        <option value="">选择规范值…</option>
                        {fieldDef.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}（{o.value}）
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => confirm(it.id)}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white"
                    >
                      确认
                    </button>
                    <button
                      onClick={() => reject(it.id)}
                      className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-600"
                    >
                      拒审
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
