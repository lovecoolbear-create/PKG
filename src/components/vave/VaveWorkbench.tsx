"use client";

import { useState } from "react";
import { TrendingDown, MessageSquare, Users, BarChart3, Sparkles, Scale, Database, GitBranch, BookMarked } from "lucide-react";
import type { AnalysisInput, AnalysisReport } from "@/types";
import { deriveProjectSummary } from "@/lib/project-store";
import { SensitivityPanel } from "./SensitivityPanel";
import { NegotiationPanel } from "./NegotiationPanel";
import { RolePanel } from "./RolePanel";
import { MultiViewPanel } from "./MultiViewPanel";
import { ScenarioPanel } from "./ScenarioPanel";
import { AiInsightPanel } from "./AiInsightPanel";
import { NegotiationSimPanel } from "./NegotiationSimPanel";
import { KnowledgeDistillPanel } from "./KnowledgeDistillPanel";
import { unitLabel } from "@/lib/units";
import { RuleClosurePanel } from "./RuleClosurePanel";
import { DictReviewPanel } from "@/components/parse/DictReviewPanel";

type Tab = "sensitivity" | "scenario" | "ai" | "negotiation" | "role" | "negotiation_sim" | "distill" | "multiview" | "rules" | "dict";

export function VaveWorkbench({
  report,
  input,
}: {
  report: AnalysisReport;
  input: AnalysisInput;
}) {
  const [tab, setTab] = useState<Tab>("sensitivity");
  const summary = deriveProjectSummary({
    id: "",
    name: "",
    createdAt: "",
    input,
    report,
  });
  const material = report.dimensions.find((d) => d.dimension === "material");

  const tabs = [
    { key: "sensitivity" as const, label: "敏感性分析", icon: TrendingDown },
    { key: "scenario" as const, label: "多情景对比", icon: BarChart3 },
    { key: "ai" as const, label: "AI 解读", icon: Sparkles },
    { key: "negotiation" as const, label: "谈判辅助", icon: MessageSquare },
    { key: "negotiation_sim" as const, label: "谈判模拟", icon: Scale },
    { key: "distill" as const, label: "知识沉淀", icon: Database },
    { key: "role" as const, label: "角色视角", icon: Users },
    { key: "multiview" as const, label: "多视角对比", icon: Users },
    { key: "rules" as const, label: "规则闭环", icon: GitBranch },
    { key: "dict" as const, label: "待审词典", icon: BookMarked },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* 成本基线摘要 + 双面积利用率卡 */}
      <div className="card p-6">
        <h2 className="text-lg font-bold text-brand-900">
          成本基线（VAVE 分析对象）
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <div>
            <p className="text-sm text-brand-500">
              {report.productType === "flat_print" ? "每册/张报价" : `单${unitLabel(report.productType)}报价`}
            </p>
            <p className="text-xl font-bold text-brand-900">
              ¥{report.totalCost.perUnit.max}
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-500">总成本</p>
            <p className="text-xl font-bold text-brand-900">
              ¥{report.totalCost.max.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-500">整体置信度</p>
            <p className="text-xl font-bold text-brand-900">
              {report.overallConfidence}%
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-500">主要成本驱动</p>
            <p className="text-xl font-bold text-brand-900">
              {summary.costDrivers[0]?.dimensionLabel ?? "—"}
            </p>
          </div>
        </div>

        {/* 理论使用面积占比（双面积模型，同步进 VAVE 视图） */}
        {material?.areaMetrics && (
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-sky-800">
                理论使用面积占比（材料利用率）
              </span>
              <span className="text-sm font-bold text-sky-700">
                {(material.areaMetrics.utilization * 100).toFixed(1)}%
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-sky-100">
              <div
                className="h-2.5 rounded-full bg-sky-500"
                style={{
                  width: `${Math.min(100, material.areaMetrics.utilization * 100)}%`,
                }}
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[11px] text-brand-500">理论面积</p>
                <p className="text-sm font-medium text-brand-800">
                  {material.areaMetrics.theoreticalAreaCm2.toFixed(0)} cm²
                </p>
              </div>
              <div>
                <p className="text-[11px] text-brand-500">理论使用占比</p>
                <p className="text-sm font-medium text-brand-800">
                  {(material.areaMetrics.utilization * 100).toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-[11px] text-brand-500">实际生产面积</p>
                <p className="text-sm font-medium text-brand-800">
                  {material.areaMetrics.productionAreaM2.toFixed(4)} m²
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-brand-500">
              {material.areaMetrics.sheetBased
                ? report.productType === "flat_print"
                  ? "按全张纸尺寸 × 每版页数真实计算，可直接向客户展示理论使用面积占比。"
                  : "按全张纸尺寸 × 每版只数真实计算，可直接向客户展示理论使用面积占比。"
                : report.productType === "flat_print"
                  ? "未填全张纸/每版页数，按默认开数拼版利用率估算（约 90%），填全张纸与每版页数可展示真实占比。"
                  : "未填全张纸/只数，按盒型默认拼版利用率估算（约 85%），填全张纸与只数可展示真实占比。"}
            </p>
          </div>
        )}
      </div>

      {/* Tab 导航 */}
      <div className="mt-6 flex gap-2 border-b border-brand-200">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium ${
                tab === t.key
                  ? "border-b-2 border-brand-700 text-brand-900"
                  : "text-brand-500 hover:text-brand-700"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        {tab === "sensitivity" && (
          <SensitivityPanel baseReport={report} baseInput={input} />
        )}
        {tab === "scenario" && (
          <ScenarioPanel baseReport={report} baseInput={input} productType={report.productType} />
        )}
        {tab === "ai" && <AiInsightPanel report={report} />}
        {tab === "negotiation" && <NegotiationPanel report={report} />}
        {tab === "negotiation_sim" && (
          <NegotiationSimPanel report={report} input={input} />
        )}
        {tab === "distill" && (
          <KnowledgeDistillPanel report={report} input={input} />
        )}
        {tab === "role" && <RolePanel report={report} />}
        {tab === "multiview" && <MultiViewPanel report={report} />}
        {tab === "rules" && <RuleClosurePanel />}
        {tab === "dict" && <DictReviewPanel />}
      </div>
    </div>
  );
}
