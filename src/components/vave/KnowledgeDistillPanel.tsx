"use client";

import { useState } from "react";
import type { AnalysisInput, AnalysisReport } from "@/types";
import { getAiSettings } from "@/lib/config/ai-settings";
import {
  addPendingRules,
  listPendingRules,
  confirmPendingRule,
  rejectPendingRule,
  listKbOverrides,
} from "@/lib/vave/pending-rules";

export function KnowledgeDistillPanel({
  report,
  input,
}: {
  report: AnalysisReport;
  input: AnalysisInput;
}) {
  const unit = report.productType === "flat_print" ? "册/张" : "只";
  const [actual, setActual] = useState<string>("");
  const [choices, setChoices] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [pending, setPending] = useState(listPendingRules());
  const [overrides, setOverrides] = useState(listKbOverrides());

  function refresh() {
    setPending(listPendingRules());
    setOverrides(listKbOverrides());
  }

  async function generate() {
    setLoading(true);
    setMsg("");
    try {
      const res = await fetch("/api/vave/distill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseInput: input,
          productType: report.productType,
          actualPerUnit: Number(actual),
          actualChoices: choices,
          aiSettings: getAiSettings(),
        }),
      });
      if (!res.ok) throw new Error("反推失败");
      const rules = (await res.json()) as Parameters<typeof addPendingRules>[0];
      addPendingRules(rules); // AI 提案 → 待审核池（唯一允许 AI 触发的写入）
      refresh();
      setMsg(`已生成 ${rules.length} 条待审核规则，请人工核对后确认固化。`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "反推失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">真实案例 → 知识沉淀（P7）</h3>
        <p className="mt-1 text-xs text-brand-500">
          对比「引擎估算 ¥{report.totalCost.perUnit.max}/{unit}」与「实际成交」，
          AI 反推应调整的知识库参数。<span className="text-amber-700">AI 仅提案，须经你确认才固化。</span>
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm text-brand-700">实际成交单只成本（元/{unit}）</label>
            <input
              type="number"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              placeholder={String(report.totalCost.perUnit.max)}
              className="mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
          </div>
          <div>
            <label className="text-sm text-brand-700">实际采用方案/工艺（可选）</label>
            <input
              type="text"
              value={choices}
              onChange={(e) => setChoices(e.target.value)}
              placeholder="如：实际用 128g + 双坑降单坑"
              className="mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
          </div>
        </div>
        <button
          onClick={generate}
          disabled={loading || !actual}
          className="mt-3 rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "反推中…" : "生成待审核规则"}
        </button>
        {msg && <p className="mt-2 text-sm text-brand-600">{msg}</p>}
      </div>

      {/* 待审核规则池 */}
      <div className="card p-5">
        <h4 className="text-sm font-bold text-brand-900">
          待审核规则池（Pending，AI 提案）
        </h4>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-brand-500">暂无待审核规则。</p>
        ) : (
          <div className="mt-3 space-y-2">
            {pending.map((r) => (
              <div
                key={r.id}
                className={`rounded-md border p-3 text-sm ${
                  r.status === "confirmed"
                    ? "border-emerald-200 bg-emerald-50/50"
                    : r.status === "rejected"
                    ? "border-red-200 bg-red-50/40 opacity-70"
                    : "border-amber-200 bg-amber-50/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-brand-900">{r.title}</span>
                  <span className="text-xs text-brand-500">
                    {r.source === "ai" ? "AI 反推" : "确定性对比"} · 置信 {r.confidence}%
                  </span>
                </div>
                <p className="mt-1 text-brand-700">{r.description}</p>
                <p className="mt-1 text-xs text-brand-600">建议值：{r.proposedValue}</p>
                <p className="mt-1 text-xs text-brand-500">依据：{r.evidence}</p>
                {r.status === "pending" && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => {
                        confirmPendingRule(r.id); // 人工确认 → 转 KB override
                        refresh();
                      }}
                      className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white"
                    >
                      确认固化
                    </button>
                    <button
                      onClick={() => {
                        rejectPendingRule(r.id);
                        refresh();
                      }}
                      className="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white"
                    >
                      拒审
                    </button>
                  </div>
                )}
                {r.status !== "pending" && (
                  <p className="mt-2 text-xs text-brand-500">
                    {r.status === "confirmed" ? "✓ 已固化进 KB override" : "✗ 已拒审"}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 已固化 override */}
      <div className="card p-5">
        <h4 className="text-sm font-bold text-brand-900">已固化 KB Override（人工确认产物）</h4>
        {overrides.length === 0 ? (
          <p className="mt-2 text-xs text-brand-500">尚未确认任何规则。</p>
        ) : (
          <div className="mt-3 space-y-2">
            {overrides.map((o) => (
              <div key={o.id} className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
                <div className="font-semibold text-brand-900">{o.title}</div>
                <p className="mt-1 text-xs text-brand-600">建议值：{o.proposedValue}</p>
                <p className="mt-1 text-xs text-brand-500">
                  确认于 {new Date(o.confirmedAt).toLocaleString("zh-CN")}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
