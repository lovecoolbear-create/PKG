"use client";

import { Sparkles, ShieldCheck, AlertTriangle, Link2 } from "lucide-react";
import type { AnalysisReport } from "@/types";

const ROLE_ACCENT: Record<string, string> = {
  procurement: "border-indigo-200 bg-indigo-50/50",
  supplier: "border-amber-200 bg-amber-50/50",
  cost: "border-sky-200 bg-sky-50/50",
  client: "border-emerald-200 bg-emerald-50/50",
};

export function AiInsightPanel({ report }: { report: AnalysisReport }) {
  const roles = report.roleReports ?? [];
  const judge = report.judgeExplanation;

  if (roles.length === 0 && !judge) {
    return (
      <div className="card p-6 text-sm text-brand-500">
        暂无可展示的 AI 解读。请先在「成本分析」中运行一次测算，结果会自动生成多角色表达与判定解释。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* P1 多角色表达 */}
      <section>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-600" />
          <h3 className="text-base font-bold text-brand-900">多角色 AI 表达</h3>
          {roles[0] && (
            <span className="text-xs text-brand-400">
              （基于本地基准价 asOf {roles[0].asOf} ·{" "}
              {roles[0].source === "llm" ? "大模型生成" : "确定性模板"}）
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-brand-500">
          同一份成本数据，从采购 / 供应 / 成本 / 客户四种视角综合表达。带
          <Link2 className="mx-0.5 inline h-3 w-3" />
          标记的数字可点开溯源至引擎原始计算。
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {roles.map((r) => (
            <div
              key={r.role}
              className={`rounded-lg border p-4 ${
                ROLE_ACCENT[r.role] || "border-brand-200 bg-white"
              }`}
            >
              <p className="text-sm font-bold text-brand-900">{r.roleLabel}</p>
              <p className="mt-1 text-sm font-semibold text-brand-800">
                {r.headline}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-brand-700">
                {r.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              {r.pointers.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.pointers.map((p, i) => (
                    <span
                      key={i}
                      title={`数据来源：${p.fieldPath} = ${p.value}`}
                      className="inline-flex items-center gap-1 rounded bg-white/70 px-1.5 py-0.5 text-[11px] text-brand-600 ring-1 ring-brand-200"
                    >
                      <Link2 className="h-2.5 w-2.5" />
                      {p.label} {p.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* P2 判定解释 */}
      {judge && (
        <section className="card p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand-600" />
            <h3 className="text-base font-bold text-brand-900">判定解释</h3>
            <span className="text-xs text-brand-400">
              （{judge.source === "llm" ? "大模型生成" : "确定性模板"} · asOf{" "}
              {judge.asOf}）
            </span>
          </div>
          <p className="mt-2 text-sm text-brand-800">{judge.overview}</p>

          {judge.findings.length > 0 ? (
            <div className="mt-3 space-y-2">
              {judge.findings.map((f, i) => (
                <div
                  key={i}
                  className={`rounded-lg border p-3 ${
                    f.severity === "error"
                      ? "border-rose-200 bg-rose-50/50"
                      : "border-amber-200 bg-amber-50/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {f.severity === "error" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    )}
                    <span
                      className={`text-[11px] font-semibold uppercase ${
                        f.severity === "error" ? "text-rose-700" : "text-amber-700"
                      }`}
                    >
                      {f.severity}
                    </span>
                    <span className="text-[11px] text-brand-400">{f.type}</span>
                  </div>
                  <p className="mt-1 text-xs text-brand-800">
                    <span className="font-semibold">为什么：</span>
                    {f.why}
                  </p>
                  <p className="mt-0.5 text-xs text-brand-700">
                    <span className="font-semibold">建议：</span>
                    {f.fix}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-brand-500">
              校验通过：未发现冲突或占比越界，成本结构自洽。
            </p>
          )}
        </section>
      )}
    </div>
  );
}
