"use client";

import { useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  Share2,
  Loader2,
  Copy,
  Check,
  Sparkles,
  Info,
} from "lucide-react";
import type { AnalysisReport } from "@/types";
import { generatePDFReport, downloadPDF } from "@/lib/pdf/export";
import { SECTION_TITLES, confidenceLabel } from "@/lib/report-copy";
import { cn } from "@/lib/utils";

const COLORS = [
  "#243b53",
  "#486581",
  "#627d98",
  "#829ab1",
  "#f97316",
  "#10b981",
];

/** 加工费维度按 kind 分组渲染：纯工艺加工费 / 设备·开机相关费用，其余维度原样渲染 */
function renderBreakdownRows(dim: AnalysisReport["dimensions"][number]) {
  if (dim.dimension !== "process" || !dim.breakdown) {
    return dim.breakdown?.map((b, i) => (
      <tr key={i} className="border-b border-brand-50 align-top">
        <td className="py-1.5 text-brand-800">{b.label}</td>
        <td className="py-1.5 text-right font-medium text-brand-900">
          ¥{b.amount.toLocaleString()}
        </td>
        <td className="py-1.5 text-right text-brand-500">
          {dim.estimatedAmount > 0
            ? ((b.amount / dim.estimatedAmount) * 100).toFixed(1)
            : "0.0"}
          %
        </td>
        <td className="py-1.5 pl-3 text-xs text-brand-500">{b.note ?? "—"}</td>
      </tr>
    ));
  }

  const processItems = dim.breakdown.filter((b) => b.kind !== "equipment");
  const equipItems = dim.breakdown.filter((b) => b.kind === "equipment");
  const sum = (arr: typeof processItems) =>
    Math.round(arr.reduce((s, b) => s + b.amount, 0) * 100) / 100;

  const renderGroup = (
    title: string,
    items: typeof processItems,
    accent: string
  ) => (
    <>
      <tr className="bg-brand-50/60">
        <td colSpan={4} className={`py-1.5 pl-1 text-xs font-semibold ${accent}`}>
          {title}
          <span className="ml-2 font-normal text-brand-500">
            小计 ¥{sum(items).toLocaleString()}
          </span>
        </td>
      </tr>
      {items.map((b, i) => (
        <tr key={i} className="border-b border-brand-50 align-top">
          <td className="py-1.5 pl-3 text-brand-800">{b.label}</td>
          <td className="py-1.5 text-right font-medium text-brand-900">
            ¥{b.amount.toLocaleString()}
          </td>
          <td className="py-1.5 text-right text-brand-500">
            {dim.estimatedAmount > 0
              ? ((b.amount / dim.estimatedAmount) * 100).toFixed(1)
              : "0.0"}
            %
          </td>
          <td className="py-1.5 pl-3 text-xs text-brand-500">{b.note ?? "—"}</td>
        </tr>
      ))}
    </>
  );

  return (
    <>
      {renderGroup("纯工艺加工费", processItems, "text-brand-700")}
      {equipItems.length > 0 ? (
        renderGroup("设备 · 开机相关费用", equipItems, "text-orange-700")
      ) : (
        <tr className="bg-orange-50/60">
          <td colSpan={4} className="py-1.5 pl-1 text-xs text-orange-700">
            设备 · 开机相关费用
            <span className="ml-2 font-normal text-brand-500">
              本单无独立设备/开机固定费（开机费已含入印刷运行费，未单独拆分）
            </span>
          </td>
        </tr>
      )}
    </>
  );
}

interface ReportStepProps {
  report: AnalysisReport;
  sessionId: string;
}

export function ReportStep({ report, sessionId }: ReportStepProps) {
  const [expandedHint, setExpandedHint] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [appendixOpen, setAppendixOpen] = useState(false);

  const chartData = report.dimensions.map((d) => ({
    name: d.dimensionLabel,
    value: d.estimatedAmount,
    ratio: d.ratio,
  }));

  // 材料数据源状态（用于成本拆解明细旁标注）
  const matSrc = report.materialPriceSources;
  const matPaperEntry = matSrc?.entries.find((e) => e.category === "paper");
  const matIsLive = matPaperEntry?.live === true; // 实时检索
  const matIsEstimate = !!matSrc && !matSrc.hasFallback && !matIsLive; // 模型估算
  const matIsFallback = matSrc ? matSrc.hasFallback : false;
  const matTime = matSrc
    ? new Date(matSrc.fetchedAt).toLocaleString("zh-CN")
    : "";

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const blob = await generatePDFReport(report);
      downloadPDF(blob, `成本分析报告_${report.productTypeName}_${new Date().toLocaleDateString("zh-CN")}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  const handleShare = async () => {
    setSharing(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: 7 }),
      });
      const data = await res.json();
      if (res.ok) {
        setShareUrl(data.url);
        // 生成后自动复制到剪贴板，失败则保留手动复制按钮
        try {
          await navigator.clipboard.writeText(data.url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }
    } finally {
      setSharing(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  // 派生：成本驱动焦点卡、小批量提示
  const drivers = report.costDrivers ?? [];
  const smallBatch = report.smallBatchNote;
  const ctaCopy = report.ctaCopy ?? "如需进一步沟通，欢迎联系。";

  return (
    <div className="space-y-6">
      {/* 顶部免责声明 banner（与底部呼应） */}
      <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-center">
        <p className="text-sm font-medium text-orange-800">
          ⚠ {report.disclaimer}
        </p>
      </div>

      {/* Header actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-bold text-brand-900">成本分析报告</h2>
        <div className="flex gap-2">
          <button
            onClick={handleExportPDF}
            disabled={exporting}
            className="btn-secondary"
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导出 PDF
          </button>
          <button
            onClick={handleShare}
            disabled={sharing}
            className="btn-secondary"
          >
            {sharing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="mr-2 h-4 w-4" />
            )}
            生成分享链接
          </button>
        </div>
      </div>

      {/* Share URL */}
      {shareUrl && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-200 bg-white p-3">
          <input
            readOnly
            value={shareUrl}
            className="flex-1 bg-transparent text-sm text-brand-700 outline-none"
          />
          <button onClick={copyLink} className="btn-secondary py-1.5 px-3">
            {copied ? (
              <>
                <Check className="h-4 w-4 text-accent-green" />
                <span className="ml-1 text-accent-green">已复制</span>
              </>
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
      {shareUrl && !copied && (
        <p className="text-xs text-brand-400">
          链接已生成（7 天有效），如未自动复制可点击右侧按钮手动复制
        </p>
      )}

      {/* ===== 模块 1 · 总成本区间（Hero 横幅） ===== */}
      <div className="card p-6">
        <h3 className="mb-4 text-base font-bold text-brand-900">
          {SECTION_TITLES.total_range}
        </h3>
        <div className="grid gap-6 sm:grid-cols-3">
          <div>
            <p className="text-sm text-brand-500">总成本区间</p>
            <p className="mt-1 text-2xl font-bold text-brand-900">
              ¥{report.totalCost.min.toLocaleString()} - ¥
              {report.totalCost.max.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-500">单只价格区间</p>
            <p className="mt-1 text-2xl font-bold text-brand-900">
              ¥{report.totalCost.perUnit.min} - ¥{report.totalCost.perUnit.max}
              <span className="text-sm font-normal text-brand-500"> /个</span>
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-500">整体置信度</p>
            <div className="mt-1 flex items-center gap-3">
              <p className="text-2xl font-bold text-brand-900">
                {report.overallConfidence}%
              </p>
              <ConfidenceBadge value={report.overallConfidence} />
            </div>
          </div>
        </div>

        {/* Cost groups */}
        <div className="mt-6 grid gap-4 border-t border-brand-100 pt-6 sm:grid-cols-2">
          <div className="rounded-lg bg-brand-50 p-4">
            <p className="text-sm font-medium text-brand-700">制造成本</p>
            <p className="mt-1 text-lg font-bold text-brand-900">
              ¥{report.manufacturingCost.total.toLocaleString()}
              <span className="ml-2 text-sm font-normal text-brand-500">
                ({report.manufacturingCost.ratio}%)
              </span>
            </p>
          </div>
          <div className="rounded-lg bg-brand-50 p-4">
            <p className="text-sm font-medium text-brand-700">
              商业与财务成本
            </p>
            <p className="mt-1 text-lg font-bold text-brand-900">
              ¥{report.commercialCost.total.toLocaleString()}
              <span className="ml-2 text-sm font-normal text-brand-500">
                ({report.commercialCost.ratio}%)
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* ===== 模块 2 · 五维成本结构占比 ===== */}
      <div className="card p-5">
        <h3 className="mb-4 text-base font-bold text-brand-900">
          {SECTION_TITLES.structure}
        </h3>
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    dataKey="value"
                    label={({ name, ratio }) => `${name} ${ratio}%`}
                    labelLine={false}
                  >
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => `¥${value.toLocaleString()}`}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-brand-200 text-left text-xs text-brand-500">
                  <th className="py-2 font-medium">维度</th>
                  <th className="py-2 text-right font-medium">金额(元)</th>
                  <th className="py-2 text-right font-medium">占比</th>
                </tr>
              </thead>
              <tbody>
                {report.dimensions.map((d) => (
                  <tr key={d.dimension} className="border-b border-brand-50">
                    <td className="py-2 text-brand-800">{d.dimensionLabel}</td>
                    <td className="py-2 text-right font-medium text-brand-900">
                      ¥{d.estimatedAmount.toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-brand-500">
                      {d.ratio}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ===== 模块 3 · 主要成本驱动点 ===== */}
      <div className="card p-5">
        <h3 className="mb-4 text-base font-bold text-brand-900">
          {SECTION_TITLES.drivers}
        </h3>
        {drivers.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-3">
            {drivers.map((d) => (
              <div
                key={d.dimension}
                className="rounded-lg border border-brand-100 bg-brand-50/40 p-4"
              >
                <p className="text-sm font-medium text-brand-700">
                  {d.dimensionLabel}
                </p>
                <p className="mt-1 text-xl font-bold text-brand-900">
                  ¥{d.amount.toLocaleString()}
                </p>
                <p className="text-sm text-brand-500">占总额 {d.ratio}%</p>
                <p className="mt-2 text-xs leading-relaxed text-brand-600">
                  {d.reason || "—"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-brand-500">暂无显著成本驱动项。</p>
        )}
      </div>

      {/* ===== 模块 4 · 信息完整度 + 默认假设（琥珀卡，透明展示） ===== */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-amber-800">
            {SECTION_TITLES.completeness}
          </h3>
          <span className="rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-white">
            信息完整度 {report.completeness}%
          </span>
        </div>

        {/* 默认假设清单（透明） */}
        {report.defaultAssumptions && report.defaultAssumptions.length > 0 ? (
          <>
            <p className="mt-3 text-xs text-amber-700">
              以下字段未由您提供，系统已套用合理默认并据此估算。相关维度置信度已相应下调
              {typeof report.defaultConfidencePenalty === "number" &&
                report.defaultConfidencePenalty > 0 &&
                `（整体约 ${report.defaultConfidencePenalty} 分）`}
              ，正式数据回填后结果将更可靠。
            </p>
            <ul className="mt-3 space-y-2">
              {report.defaultAssumptions.map((a, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-md bg-white/70 px-3 py-2 text-sm text-brand-700"
                >
                  <span className="mt-0.5 shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                    默认
                  </span>
                  <span>
                    <strong>{a.label}</strong>：{a.assumedValue} —{" "}
                    <span className="text-brand-500">{a.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-sm text-amber-700">
            本次分析所需关键信息已齐备，未使用默认假设，结果可靠性较高。
          </p>
        )}
      </div>

      {/* ===== 模块 5 · 置信度说明 ===== */}
      <div className="card p-5">
        <h3 className="mb-4 text-base font-bold text-brand-900">
          {SECTION_TITLES.confidence}
        </h3>
        <div className="flex items-center gap-3 rounded-lg bg-brand-50 px-4 py-3">
          <span className="text-sm text-brand-600">整体置信度</span>
          <span className="text-2xl font-bold text-brand-900">
            {report.overallConfidence}%
          </span>
          <span className="text-sm text-brand-500">
            （{confidenceLabel(report.overallConfidence)}）
          </span>
        </div>
        <p className="mt-2 text-xs text-brand-500">
          置信度反映输入信息完整度与所套用默认假设对精度的影响；各维度如下：
        </p>
        <div className="mt-4 space-y-2">
          {report.dimensions.map((dim) => (
            <div
              key={dim.dimension}
              className="flex items-center justify-between rounded-md border border-brand-100 px-3 py-2 text-sm"
            >
              <span className="text-brand-800">{dim.dimensionLabel}</span>
              <div className="flex items-center gap-3">
                <span className="text-brand-500">{dim.ratio}%</span>
                <span className="flex items-center gap-2">
                  <span className="font-medium text-brand-900">
                    {dim.confidence}%
                  </span>
                  <ConfidenceBadge value={dim.confidence} small />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ===== 模块 6 · 小批量提示（真实成本特征，非错误） ===== */}
      {smallBatch?.visible && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-5">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
            <div className="flex-1">
              <h3 className="text-base font-bold text-blue-800">
                {SECTION_TITLES.small_batch}
                <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                  真实成本特征
                </span>
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-blue-700">
                {smallBatch.message}
              </p>
            </div>
          </div>

          {/* 三段式明细：固定费 / 当前批量正常现象 / 数量提升提示 */}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-white/70 p-3">
              <p className="text-xs font-medium text-blue-600">① 一次性固定费用</p>
              <p className="mt-1 text-sm text-blue-800">
                本项合计 ¥{smallBatch.fixedFee.toLocaleString()}，含制版费、设计费、打样费，
                <span className="font-medium">不随数量按件计算</span>。
              </p>
            </div>
            <div className="rounded-md bg-white/70 p-3">
              <p className="text-xs font-medium text-blue-600">② 当前批量正常现象</p>
              <p className="mt-1 text-sm text-blue-800">
                当前摊到单只约 ¥{smallBatch.currentPerPiece}，占比 {smallBatch.ratio}%
                （常规 {smallBatch.expectedMin}%-{smallBatch.expectedMax}%），
                <span className="font-medium">小批量下偏高属正常</span>。
              </p>
            </div>
            <div className="rounded-md bg-white/70 p-3">
              <p className="text-xs font-medium text-blue-600">③ 数量提升即摊薄</p>
              <p className="mt-1 text-sm text-blue-800">
                {smallBatch.suggestions.length > 0 ? (
                  <>
                    若数量提升至 {smallBatch.suggestions[0].quantity.toLocaleString()} 个，单只约降至 ¥
                    {smallBatch.suggestions[0].perPiece}；
                    {smallBatch.suggestions[1] && (
                      <>
                        {" "}
                        提升至 {smallBatch.suggestions[1].quantity.toLocaleString()} 个，约降至 ¥
                        {smallBatch.suggestions[1].perPiece}。
                      </>
                    )}
                  </>
                ) : (
                  "——"
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ===== 模块 7 · 初步优化方向（埋钩，不给完整方案） ===== */}
      {report.optimizationHints.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-4 text-base font-bold text-brand-900">
            {SECTION_TITLES.optimization}
          </h3>
          <div className="space-y-3">
            {report.optimizationHints.map((hint) => (
              <div
                key={hint.id}
                className="rounded-lg border border-green-200 bg-green-50"
              >
                <button
                  className="flex w-full items-center justify-between p-4 text-left"
                  onClick={() =>
                    setExpandedHint(
                      expandedHint === hint.id ? null : hint.id
                    )
                  }
                >
                  <div>
                    <p className="text-sm font-medium text-green-800">
                      {hint.title}
                    </p>
                    <p className="mt-0.5 text-xs text-green-600">
                      潜在节约：{hint.potentialSaving}（可进一步评估）
                    </p>
                  </div>
                  {expandedHint === hint.id ? (
                    <ChevronUp className="h-4 w-4 text-green-600" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-green-600" />
                  )}
                </button>
                {expandedHint === hint.id && (
                  <div className="border-t border-green-200 px-4 pb-4">
                    <p className="text-sm text-green-700">{hint.detail}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== 模块 8 · 免责声明 ===== */}
      <div className="rounded-lg border border-orange-300 bg-orange-50 px-5 py-4 text-center">
        <p className="text-sm font-semibold text-orange-800">
          ⚠ {report.disclaimer}
        </p>
        <p className="mt-1 text-xs text-orange-600">
          本报告基于行业基准规则与公开/估算行情生成，实际价格以工厂正式报价与合同约定为准。
        </p>
      </div>

      {/* ===== 模块 9 · 转化入口 ===== */}
      <div className="rounded-lg bg-brand-900 p-6 text-center text-white">
        <p className="text-lg font-semibold">进一步沟通</p>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-brand-300">
          {ctaCopy}
        </p>
        <button className="btn-accent mt-4">联系我们</button>
      </div>

      {/* ===== 附录：技术明细（供专业核对，折叠） ===== */}
      <details
        className="rounded-lg border border-brand-200 bg-white"
        open={appendixOpen}
      >
        <summary
          className="cursor-pointer list-none px-5 py-3 text-sm font-semibold text-brand-800"
          onClick={() => setAppendixOpen(!appendixOpen)}
        >
          技术明细（供专业核对：专家诊断 / 材料来源 / 成本拆解 / 维度说明）
        </summary>
        <div className="space-y-5 border-t border-brand-100 p-5">
          {/* AI 包装 SQE 专家诊断 */}
          {report.sqeDiagnosis && (
            <div className="rounded-lg border-2 border-violet-300 bg-gradient-to-br from-violet-50 to-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-violet-600" />
                  <h4 className="text-sm font-bold text-violet-900">
                    AI 包装 SQE 专家诊断
                  </h4>
                </div>
                <span
                  className={
                    report.sqeDiagnosis.source === "llm"
                      ? "rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-700"
                      : "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
                  }
                >
                  {report.sqeDiagnosis.source === "llm"
                    ? "大模型实时生成"
                    : "模板诊断（未配置大模型）"}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-brand-700">
                {report.sqeDiagnosis.text}
              </p>
            </div>
          )}

          {/* 材料价格来源 */}
          {report.materialPriceSources && (
            <div>
              <h4 className="text-sm font-semibold text-brand-800">
                材料价格来源
              </h4>
              <p className="mt-1 text-xs text-brand-500">
                {report.materialPriceSources.summary}（获取时间：
                {new Date(
                  report.materialPriceSources.fetchedAt
                ).toLocaleString("zh-CN")}
                ）
              </p>
              <div className="mt-3 space-y-2">
                {report.materialPriceSources.entries.map((e, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-brand-900">
                        {e.item}
                      </span>
                      <span className="rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-600">
                        {e.category === "paper"
                          ? "纸板"
                          : e.category === "ink"
                            ? "油墨"
                            : e.category === "surface"
                              ? "表面处理"
                              : e.category === "foil"
                                ? "烫金箔"
                                : e.category}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold text-brand-800">
                        {e.price}
                        <span className="text-xs font-normal text-brand-500">
                          {" "}
                          {e.unit}
                        </span>
                      </span>
                      {e.isFallback ? (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-700">
                          回退默认
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                          实时获取
                        </span>
                      )}
                      <span className="max-w-[220px] truncate text-xs text-brand-400">
                        来源：{e.source}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 成本拆解明细 (Cost Breakdown) */}
          <div>
            <h4 className="text-sm font-semibold text-brand-800">
              成本拆解明细 (Cost Breakdown)
            </h4>
            <div className="mt-3 space-y-4">
              {report.dimensions.map((dim) => {
                if (!dim.breakdown || dim.breakdown.length === 0) return null;
                const isMaterial = dim.dimension === "material";
                return (
                  <div
                    key={dim.dimension}
                    className="rounded-lg border border-brand-100 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h5 className="font-medium text-brand-900">
                          {dim.dimensionLabel}
                        </h5>
                        {isMaterial && matSrc && (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs",
                              matIsLive
                                ? "bg-green-100 text-green-700"
                                : matIsEstimate
                                  ? "bg-violet-100 text-violet-700"
                                  : "bg-orange-100 text-orange-700"
                            )}
                            title="材料单价数据源状态"
                          >
                            {matIsLive
                              ? "行情实时检索"
                              : matIsEstimate
                                ? "AI 模型估算"
                                : `本地权威基准 · 更新 ${matTime}`}
                          </span>
                        )}
                      </div>
                      <span className="font-semibold text-brand-800">
                        ¥{dim.estimatedAmount.toLocaleString()}
                      </span>
                    </div>
                    <table className="mt-3 w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-brand-200 text-left text-xs text-brand-500">
                          <th className="py-1.5 font-medium">分项</th>
                          <th className="py-1.5 text-right font-medium">
                            金额(元)
                          </th>
                          <th className="py-1.5 text-right font-medium">
                            占维度
                          </th>
                          <th className="py-1.5 pl-3 font-medium">说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {renderBreakdownRows(dim)}
                      </tbody>
                    </table>
                    {dim.dimension === "process" && (
                      <p className="mt-2 text-xs text-brand-500">
                        加工费含设备相关分摊：设备/开机相关费用（开机托底 + 专色调色洗车 +
                        刀模费）已单列；印刷运行与模切的按件设备运行成本并入「纯工艺加工费」。
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 各维度详细说明 */}
          <div>
            <h4 className="text-sm font-semibold text-brand-800">
              各维度详细说明
            </h4>
            <div className="mt-3 space-y-4">
              {report.dimensions.map((dim) => (
                <div
                  key={dim.dimension}
                  className="rounded-lg border border-brand-100 p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h5 className="font-medium text-brand-900">
                        {dim.dimensionLabel}
                      </h5>
                      {dim.dimension === "labor" && report.laborRegion && (
                        <span
                          className={
                            report.laborRegion.isDefault
                              ? "rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-600"
                              : "rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700"
                          }
                          title={
                            report.laborRegion.isDefault
                              ? "未选择地域，已用默认华东地区"
                              : "已按所选地域估算"
                          }
                        >
                          地域：{report.laborRegion.label}
                          {report.laborRegion.isDefault ? "（默认）" : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="font-semibold text-brand-800">
                        ¥{dim.estimatedAmount.toLocaleString()}
                      </span>
                      <span className="text-brand-500">{dim.ratio}%</span>
                      <ConfidenceBadge value={dim.confidence} small />
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-brand-500">
                        计算依据
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {dim.basis.map((b, i) => (
                          <li key={i} className="text-xs text-brand-600">
                            • {b}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-brand-500">
                        假设条件
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {dim.assumptions.map((a, i) => (
                          <li key={i} className="text-xs text-brand-600">
                            • {a}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {dim.risks.length > 0 && (
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-orange-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {dim.risks.join("；")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 校验提示 */}
          {report.validationIssues.length > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
              <h4 className="text-sm font-semibold text-yellow-800">
                校验提示
              </h4>
              <ul className="mt-2 space-y-1">
                {report.validationIssues.map((issue, i) => (
                  <li key={i} className="text-sm text-yellow-700">
                    • {issue.message}
                    {issue.suggestion && (
                      <span className="text-yellow-600">
                        {" "}
                        — {issue.suggestion}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 信息完整度影响说明 */}
          {report.missingFields.length > 0 && (
            <div className="rounded-lg border border-brand-100 p-4">
              <h4 className="text-sm font-semibold text-brand-800">
                信息完整度影响说明
              </h4>
              <ul className="mt-2 space-y-2">
                {report.missingFields.map((f) => (
                  <li
                    key={f.key}
                    className="flex items-start gap-2 text-sm text-brand-700"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                    <span>
                      <strong>{f.label}</strong>：{f.impact}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function ConfidenceBadge({ value, small }: { value: number; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        small ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs",
        value >= 75
          ? "bg-green-100 text-green-800"
          : value >= 60
            ? "bg-yellow-100 text-yellow-800"
            : "bg-red-100 text-red-800"
      )}
    >
      {value >= 75 ? "高" : value >= 60 ? "中" : "低"}
    </span>
  );
}
