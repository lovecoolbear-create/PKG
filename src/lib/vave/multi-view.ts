// ========== 多视角报告对比（需求规格3） ==========
// 以 AnalysisReport 的 dimensions + totalCost 为「唯一真相源」，确定性投影出
// 采购(谈判拆分表) / 研发(结构图谱) / 高管(ROI 摘要) / 质量 四视角。
//
// 铁律：
// - 每个视角的货币行项目都是同一组 canonical 数字的划分，Σ行项目 ≡ 主报告总额
//   （reconcile() 断言 variance≈0，UI 展示「三视角汇总已对齐 ✅」）。
// - 物理风险 / error 级校验作为 invariants 永远渲染，任何角色都不许隐藏（规格1）。
// - 纯函数、无 LLM、无 fs，服务端 / 客户端通用。

import type {
  AnalysisReport,
  StakeholderView,
  ViewLineItem,
  InvariantIndicator,
  MultiViewReport,
  MultiViewReconciliation,
  RolePolicy,
} from "@/types";
import { buildRolePolicy, selectVisibleDimensions } from "./role-policy";
import { buildQaFraming } from "./qa-framing";

const EPSILON = 0.01;

/** 维度→所属成本组（制造 / 商业） */
function groupOf(dimension: string): string {
  return dimension === "finance_other" ? "commercial" : "manufacturing";
}

function ratioOf(report: AnalysisReport, dimension: string): number {
  return report.dimensions.find((d) => d.dimension === dimension)?.ratio ?? 0;
}

/** 全部维度 → 货币行项目（canonical） */
function allLineItems(report: AnalysisReport): ViewLineItem[] {
  return report.dimensions.map((d) => ({
    key: d.dimension,
    label: d.dimensionLabel,
    amount: d.estimatedAmount,
    ratio: d.ratio,
    group: groupOf(d.dimension),
  }));
}

/**
 * 按角色策略构建货币行项目：
 * coarse 粒度下非强调维度折叠为「其他成本项」汇总行（金额不删减、总额守恒）。
 */
function buildLineItems(report: AnalysisReport, policy: RolePolicy): ViewLineItem[] {
  const visible = selectVisibleDimensions(
    allLineItems(report).map((l) => ({
      dimension: l.key,
      dimensionLabel: l.label,
      estimatedAmount: l.amount,
      ratio: l.ratio,
    })),
    policy
  );
  return visible.map((v) => ({
    key: v.dimension,
    label: v.dimensionLabel,
    amount: v.estimatedAmount,
    ratio: v.ratio,
    group: groupOf(v.dimension),
    note: v.rolledUp ? "非强调维度已折叠汇总，金额未删减" : undefined,
  }));
}

/** 不可侵犯硬指标：物理风险 + error 级校验，永远渲染（规格1） */
export function buildInvariants(report: AnalysisReport): InvariantIndicator[] {
  const out: InvariantIndicator[] = [];
  const phys = report.physicalFeasibility;
  if (phys?.metrics) {
    const m = phys.metrics;
    out.push({
      label: "边压强度 ECT",
      value: `${m.ectKNm?.toFixed(2) ?? "—"} kN/m`,
      severity: phys.failed ? "error" : "info",
    });
    out.push({
      label: "抗压强度 BCT（有效 / 安全阈值）",
      value: `${m.effectiveBCT?.toFixed(0) ?? "—"} / ${m.requiredBCT?.toFixed(0) ?? "—"} kgf`,
      severity: m.requiredBCT > 0 && m.effectiveBCT < m.requiredBCT ? "error" : "info",
    });
    if (phys.triggered.length) {
      out.push({ label: "物理可行性", value: phys.reason ?? "未通过", severity: "error" });
    }
  }
  for (const v of report.validationIssues ?? []) {
    if (v.severity === "error") {
      out.push({ label: "校验告警", value: v.message, severity: "error" });
    }
  }
  return out;
}

function sumAmount(items: ViewLineItem[]): number {
  return items.reduce((s, l) => s + l.amount, 0);
}

/** 采购：谈判拆分表（细粒度、强调材料/加工/商业） */
function buildProcurementView(report: AnalysisReport): StakeholderView {
  const policy = buildRolePolicy("procurement", "manager");
  const lineItems = buildLineItems(report, policy);
  const total = sumAmount(lineItems);
  return {
    view: "procurement",
    viewLabel: "采购谈判拆分表",
    policy,
    headline: `单只 ¥${report.totalCost.perUnit.max.toFixed(4)}；材料占 ${ratioOf(report, "material")}%、加工占 ${ratioOf(report, "process")}%，谈判优先压材料与表面处理`,
    lineItems,
    invariants: buildInvariants(report),
    totalAmount: total,
    matchesMaster: Math.abs(total - report.totalCost.max) < EPSILON,
  };
}

/** 研发：结构图谱（细粒度、强调材料/设计/工艺结构） */
function buildRdView(report: AnalysisReport): StakeholderView {
  const policy = buildRolePolicy("rd", "manager");
  const lineItems = buildLineItems(report, policy);
  const total = sumAmount(lineItems);
  return {
    view: "rd",
    viewLabel: "研发结构图谱",
    policy,
    headline: `结构成本：材料 ${ratioOf(report, "material")}%、设计制版 ${ratioOf(report, "design_plate")}%、工艺 ${ratioOf(report, "process")}%，VAVE 从克重/盒型/工艺三处切入`,
    lineItems,
    invariants: buildInvariants(report),
    totalAmount: total,
    matchesMaster: Math.abs(total - report.totalCost.max) < EPSILON,
  };
}

/** 高管：ROI 摘要（粗粒度、重总额与战略） */
function buildExecView(report: AnalysisReport): StakeholderView {
  const policy = buildRolePolicy("exec", "director");
  const lineItems = buildLineItems(report, policy);
  const total = sumAmount(lineItems);
  const topDriver = [...report.dimensions].sort((a, b) => b.estimatedAmount - a.estimatedAmount)[0];
  return {
    view: "exec",
    viewLabel: "高管 ROI 摘要",
    policy,
    headline: `单只总成本 ¥${report.totalCost.perUnit.max.toFixed(4)}（置信度 ${report.overallConfidence}%）；最大成本驱动为「${topDriver?.dimensionLabel ?? "—"}」占 ${topDriver?.ratio ?? 0}%`,
    lineItems,
    invariants: buildInvariants(report),
    totalAmount: total,
    matchesMaster: Math.abs(total - report.totalCost.max) < EPSILON,
  };
}

/** 质量：受控表述 + 强制物理余量（规格2） */
function buildQualityView(report: AnalysisReport): StakeholderView {
  const policy = buildRolePolicy("quality", "manager");
  const lineItems = buildLineItems(report, policy);
  const total = sumAmount(lineItems);
  const qa = buildQaFraming(report);
  const headline = qa.applied
    ? `存在可量化结构冗余（${qa.physicalMargin}），可在不牺牲抗压前提下做结构优化`
    : `当前无可量化结构冗余，严禁以「结构冗余优化」表述；真实质量隐患见物理余量`;
  return {
    view: "quality",
    viewLabel: "质量 / QA 视角",
    policy,
    headline,
    lineItems,
    invariants: buildInvariants(report),
    qaFraming: qa,
    totalAmount: total,
    matchesMaster: Math.abs(total - report.totalCost.max) < EPSILON,
  };
}

/** 汇总对齐校验（规格3 核心保证） */
function reconcile(
  views: StakeholderView[],
  masterTotal: number
): MultiViewReconciliation {
  const perView: MultiViewReconciliation["perView"] = {};
  let maxVar = 0;
  for (const v of views) {
    const variance = Math.abs(v.totalAmount - masterTotal);
    perView[v.view] = { total: v.totalAmount, matches: variance < EPSILON };
    maxVar = Math.max(maxVar, variance);
  }
  return {
    reconciled: maxVar < EPSILON,
    variance: maxVar,
    masterTotal,
    perView,
  };
}

/**
 * 生成主报告 + 多视角对比。所有视角行项目均来自同一 report，
 * 故三视角汇总金额必然对齐（reconcile.reconciled 应为 true）。
 */
export function generateMultiViewReport(report: AnalysisReport): MultiViewReport {
  const views = [
    buildProcurementView(report),
    buildRdView(report),
    buildExecView(report),
    buildQualityView(report),
  ];
  return {
    master: {
      totalCostMin: report.totalCost.min,
      totalCostMax: report.totalCost.max,
      perUnitMax: report.totalCost.perUnit.max,
    },
    views,
    reconciliation: reconcile(views, report.totalCost.max),
    generatedAt: new Date().toISOString(),
  };
}
