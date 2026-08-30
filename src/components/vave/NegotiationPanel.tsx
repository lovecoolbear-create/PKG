"use client";

import { useState } from "react";
import {
  computeTargetNegotiation,
  computeConcession,
  buildNegotiationScripts,
} from "@/lib/vave/negotiation";
import type { AnalysisReport } from "@/types";
import { unitLabel } from "@/lib/units";

export function NegotiationPanel({ report }: { report: AnalysisReport }) {
  const unit = unitLabel(report.productType);
  const [target, setTarget] = useState<string>(
    String(Math.round(report.totalCost.perUnit.max * 0.9 * 100) / 100)
  );
  const concession = computeConcession(report);
  const targetNum = Number(target) || 0;
  const targetRes = computeTargetNegotiation(report, targetNum);
  const scripts = buildNegotiationScripts(report);

  return (
    <div className="space-y-6">
      {/* 目标价反推 */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">目标价反推</h3>
        <p className="mt-1 text-xs text-brand-500">
          给定客户目标价，按各维金额占比拆解可压缩空间。
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-brand-700">客户目标价（元/{unit}）</span>
          <input
            type="number"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-32 rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
        </div>
        <p className="mt-2 text-sm text-brand-600">
          当前报价 ¥{targetRes.currentPerUnit} /{unit}，需下降 ¥{targetRes.gapPerUnit} /{unit}
          <span
            className={
              targetRes.feasible
                ? " ml-2 text-green-700"
                : " ml-2 text-red-600"
            }
          >
            （
            {targetRes.feasible
              ? "目标在可让利范围内"
              : "目标低于保本价，需结构/材料级降本"}
            ）
          </span>
        </p>
        <div className="mt-4 space-y-2">
          {targetRes.perDimension.map((row) => (
            <div
              key={row.dimension}
              className="flex items-center justify-between rounded-md border border-brand-100 px-3 py-2 text-sm"
            >
              <span className="text-brand-800">{row.label}</span>
              <span className="text-brand-500">
                现 ¥{row.current} → 压 ¥{row.suggestedCut} → 余 ¥{row.remaining}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 让利空间 */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">让利空间</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">报价（每{unit}上限）</p>
            <p className="text-lg font-bold text-brand-900">
              ¥{concession.quotePerUnit}
            </p>
          </div>
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">保本价（约 5% 利润底线）</p>
            <p className="text-lg font-bold text-brand-900">
              ¥{concession.breakEvenPerUnit}
            </p>
          </div>
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-xs text-brand-500">最大可让利</p>
            <p className="text-lg font-bold text-brand-900">
              ¥{concession.maxConcessionPerUnit}（{concession.maxConcessionRatio}%）
            </p>
          </div>
        </div>
      </div>

      {/* 话术 */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          谈判话术（模板）
        </h3>
        <ul className="mt-3 space-y-2">
          {scripts.map((s, i) => (
            <li
              key={i}
              className="rounded-md bg-brand-50/60 px-3 py-2 text-sm text-brand-700"
            >
              • {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
