"use client";

import type { AnalysisReport, StakeholderView } from "@/types";

function ViewCard({ v }: { v: StakeholderView }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-brand-900">{v.viewLabel}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            v.matchesMaster ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          {v.matchesMaster ? "总额对齐 ✅" : "总额偏差 ⚠️"}
        </span>
      </div>
      <p className="mt-2 text-sm text-brand-700">{v.headline}</p>

      {/* 货币行项目（确定性，求和≡主报告） */}
      <div className="mt-3 overflow-hidden rounded-lg border border-brand-200">
        <table className="w-full text-sm">
          <thead className="bg-brand-50 text-brand-600">
            <tr>
              <th className="px-3 py-2 text-left">项目</th>
              <th className="px-3 py-2 text-right">金额(¥)</th>
              <th className="px-3 py-2 text-right">占比</th>
            </tr>
          </thead>
          <tbody>
            {v.lineItems.map((li) => (
              <tr key={li.key} className="border-t border-brand-100">
                <td className="px-3 py-2 text-brand-800">
                  {li.label}
                  {li.note && (
                    <span className="ml-1 text-xs text-brand-400">{li.note}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-brand-900">
                  {li.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-brand-500">
                  {li.ratio}%
                </td>
              </tr>
            ))}
            <tr className="border-t border-brand-200 bg-brand-50/60 font-semibold">
              <td className="px-3 py-2 text-brand-900">合计</td>
              <td className="px-3 py-2 text-right tabular-nums text-brand-900">
                {v.totalAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </td>
              <td className="px-3 py-2 text-right text-brand-500">100%</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* QA 受控表述（规格2） */}
      {v.qaFraming && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            v.qaFraming.applied && v.qaFraming.marginRetained
              ? "bg-brand-50 text-brand-800"
              : "bg-amber-50 text-amber-800"
          }`}
        >
          <p className="font-semibold">
            QA 语境表述：
            {v.qaFraming.applied
              ? `「${v.qaFraming.original}」→「${v.qaFraming.reframed}」`
              : `禁止改写「${v.qaFraming.original}」`}
          </p>
          {v.qaFraming.physicalMargin && (
            <p className="mt-1">
              已保留物理余量：{v.qaFraming.physicalMargin}
            </p>
          )}
          {v.qaFraming.rejectReason && (
            <p className="mt-1 text-amber-700">原因：{v.qaFraming.rejectReason}</p>
          )}
        </div>
      )}

      {/* 不可侵犯硬指标 */}
      {v.invariants.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {v.invariants.map((inv, i) => (
            <li
              key={i}
              className={`rounded px-2 py-1 ${
                inv.severity === "error"
                  ? "bg-red-50 text-red-800"
                  : "bg-slate-50 text-brand-700"
              }`}
            >
              <span className="font-semibold">{inv.label}：</span>
              {inv.value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MultiViewPanel({ report }: { report: AnalysisReport }) {
  const mv = report.multiView;
  if (!mv) {
    return (
      <div className="card p-5 text-sm text-brand-400">
        多视角对比报告未生成（需先完成成本估算）。
      </div>
    );
  }
  const { reconciled, variance, masterTotal } = mv.reconciliation;
  return (
    <div className="space-y-6">
      {/* 汇总对齐校验横幅（规格3） */}
      <div
        className={`card p-4 ${
          reconciled ? "bg-green-50" : "bg-amber-50"
        }`}
      >
        <p
          className={`text-sm font-semibold ${
            reconciled ? "text-green-800" : "text-amber-800"
          }`}
        >
          {reconciled
            ? "✅ 采购 / 研发 / 高管 / 质量 四视角汇总金额已完全对齐"
            : `⚠️ 视角汇总与主报告存在偏差 ¥${variance.toFixed(2)}`}
        </p>
        <p className="mt-1 text-xs text-brand-500">
          主报告总额 ¥{masterTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          （四视角行项目均取自主报告同一真相源，确定性求和 ≡ 主报告总额）
        </p>
      </div>

      {mv.views.map((v) => (
        <ViewCard key={v.view} v={v} />
      ))}
    </div>
  );
}
