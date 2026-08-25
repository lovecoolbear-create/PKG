"use client";

import { useState } from "react";
import type { AnalysisInput, AnalysisReport } from "@/types";
import { getAiSettings } from "@/lib/config/ai-settings";
import type { NegotiationResult, NegotiationTurn } from "@/lib/vave/negotiation-agent";

const ROLE_COLOR: Record<string, string> = {
  buyer: "border-l-blue-400 bg-blue-50/60",
  supplier: "border-l-amber-400 bg-amber-50/60",
  cost_arbitrator: "border-l-emerald-400 bg-emerald-50/60",
};

export function NegotiationSimPanel({
  report,
  input,
}: {
  report: AnalysisReport;
  input: AnalysisInput;
}) {
  const unit = report.productType === "flat_print" ? "册/张" : "只";
  const [target, setTarget] = useState<string>(
    String(Math.round(report.totalCost.perUnit.max * 0.9 * 100) / 100)
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NegotiationResult | null>(null);
  const [err, setErr] = useState<string>("");

  async function run() {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/vave/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseInput: input,
          productType: report.productType,
          targetPerUnit: Number(target) || undefined,
          aiSettings: getAiSettings(),
        }),
      });
      if (!res.ok) throw new Error("模拟失败");
      setResult((await res.json()) as NegotiationResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "谈判模拟失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">多 Agent 谈判博弈（P6）</h3>
        <p className="mt-1 text-xs text-brand-500">
          采购方 / 供应方 / 成本仲裁三方角色扮演；每轮主张回引擎校验（保本锚 / 方案重算），数字守恒、可溯源。
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-brand-700">采购方目标价（元/{unit}）</span>
          <input
            type="number"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-32 rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
          <button
            onClick={run}
            disabled={loading}
            className="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "模拟中…" : "运行谈判模拟"}
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        {result && (
          <p className="mt-2 text-xs text-brand-500">
            报价 ¥{result.quotePerUnit} / {unit} · 保本价 ¥{result.breakEvenPerUnit} / {unit} ·
            来源：{result.source === "llm" ? "大模型博弈" : "确定性模板（未配置模型）"}
          </p>
        )}
      </div>

      {result && (
        <div className="space-y-3">
          {result.turns.map((t: NegotiationTurn, i) => (
            <div
              key={i}
              className={`rounded-r-lg border-l-4 p-4 ${
                ROLE_COLOR[t.role] || "border-l-brand-400 bg-brand-50/60"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-brand-900">{t.roleLabel}</span>
                {t.proposedPerUnit !== undefined && (
                  <span className="text-sm font-semibold text-brand-800">
                    主张 ¥{t.proposedPerUnit}/{unit}
                    {t.feasible === true && (
                      <span className="ml-1 text-green-600">✓ 可行</span>
                    )}
                    {t.feasible === false && (
                      <span className="ml-1 text-red-600">✗ 低于保本</span>
                    )}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-brand-700">{t.utterance}</p>
              {t.verifiedPerUnit !== undefined && (
                <p className="mt-1 text-xs text-emerald-700">
                  🔁 引擎验证单只成本 ¥{t.verifiedPerUnit}/{unit}（主张与引擎一致）
                </p>
              )}
              {t.dataPointer && (
                <p className="mt-1 text-xs text-brand-500">
                  📎 {t.dataPointer.label}：{t.dataPointer.value}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
