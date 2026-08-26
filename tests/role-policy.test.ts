// RolePolicy 重构 + 多视角对比 确定性测试（无 LLM、无 fs）
import {
  buildRolePolicy,
  selectVisibleDimensions,
  INVIOLABLE_INDICATORS,
  type RoleDept,
} from "@/lib/vave/role-policy";
import { buildQaFraming } from "@/lib/vave/qa-framing";
import { generateMultiViewReport } from "@/lib/vave/multi-view";
import type { AnalysisReport } from "@/types";
import type { FeasibilityResult } from "@/lib/physics/feasibility";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ FAIL:", msg);
  }
}
function section(name: string) {
  console.log(`\n▸ ${name}`);
}

// ---------- 测试夹具 ----------
const DIMS = [
  { dimension: "material", dimensionLabel: "材料", estimatedAmount: 100, ratio: 50 },
  { dimension: "process", dimensionLabel: "工艺", estimatedAmount: 40, ratio: 20 },
  { dimension: "design_plate", dimensionLabel: "设计制版", estimatedAmount: 30, ratio: 15 },
  { dimension: "labor", dimensionLabel: "人工", estimatedAmount: 20, ratio: 10 },
  { dimension: "finance_other", dimensionLabel: "商业其他", estimatedAmount: 10, ratio: 5 },
];

function makePhysics(
  requiredBCT: number,
  redundancyPct: number
): FeasibilityResult {
  const effectiveBCT = requiredBCT * (1 + redundancyPct / 100);
  return {
    passed: true,
    metrics: {
      ectKNm: 8,
      caliperMm: 2.5,
      perimeterCm: 140,
      bctKg: effectiveBCT,
      wetFactor: 1,
      effectiveBCT,
      requiredBCT,
      hasLoadData: true,
    },
    gaps: {},
    triggered: [],
    levers: [],
    touchedPhysics: true,
  };
}

function makeReport(opts: {
  withPhysics?: boolean;
  requiredBCT?: number;
  redundancyPct?: number;
} = {}): AnalysisReport {
  const total = DIMS.reduce((s, d) => s + d.estimatedAmount, 0);
  const report: any = {
    productType: "color_box",
    productTypeName: "彩盒",
    overallConfidence: 85,
    totalCost: {
      min: total - 10,
      max: total,
      unit: "元",
      perUnit: { min: (total - 10) / 100, max: total / 100 },
    },
    dimensions: DIMS.map((d) => ({ ...d, amountRange: [d.estimatedAmount, d.estimatedAmount], basis: [], assumptions: [], confidence: 85, risks: [] })),
    validationIssues: [],
    physicalFeasibility: opts.withPhysics
      ? makePhysics(opts.requiredBCT ?? 500, opts.redundancyPct ?? 35)
      : undefined,
  };
  return report as unknown as AnalysisReport;
}

// ========== 规格1：RolePolicy 仅控粒度/重点，无 hide/soften ==========
section("规格1：RolePolicy 纯展示控制层（无 hide/soften/reframe）");
{
  const policy = buildRolePolicy("quality" as RoleDept, "manager");
  assert(!("suppressRules" in policy), "RolePolicy 不应再含 suppressRules 字段");
  assert(
    policy.granularity === "standard",
    "quality 角色粒度应为 standard"
  );
  assert(
    Array.isArray(policy.emphasisDimensions) &&
      policy.emphasisDimensions.length > 0,
    "emphasisDimensions 仍生效"
  );
  // 不可侵犯清单存在且覆盖物理/基线
  assert(
    INVIOLABLE_INDICATORS.some((s) => s.includes("physicalFeasibility")),
    "不可侵犯清单含 physicalFeasibility"
  );
  assert(
    INVIOLABLE_INDICATORS.some((s) => s.includes("totalCost")),
    "不可侵犯清单含 totalCost"
  );
}

// ========== 规格1：coarse 折叠不删减（总额守恒） ==========
section("规格1：coarse 粒度折叠非强调维度（金额不删减）");
{
  const policy = buildRolePolicy("finance", "director"); // coarse
  const visible = selectVisibleDimensions(
    DIMS.map((d) => ({ ...d })),
    policy
  );
  const sum = visible.reduce((s, v) => s + v.estimatedAmount, 0);
  const origSum = DIMS.reduce((s, d) => s + d.estimatedAmount, 0);
  assert(sum === origSum, `coarse 折叠后金额应守恒（${sum} === ${origSum}）`);
  assert(
    visible.some((v) => v.rolledUp),
    "coarse 应产生「其他成本项」汇总行"
  );
  assert(
    visible.every((v) => v.estimatedAmount >= 0),
    "coarse 不得出现负金额（无删除）"
  );
}

// ========== 规格2：QA 受控表述，强制保留物理余量 ==========
section("规格2：QA 语境改写必须保留物理余量");
{
  // 有正冗余度 → 允许改写且保留余量
  const withMargin = makeReport({ withPhysics: true, requiredBCT: 500, redundancyPct: 35 });
  const qaOk = buildQaFraming(withReport(withMargin));
  assert(qaOk.applied === true, "有正冗余度时应允许改写");
  assert(qaOk.marginRetained === true, "改写必须保留物理余量");
  assert(
    !!qaOk.physicalMargin && qaOk.physicalMargin.includes("抗压冗余度"),
    `physicalMargin 应含「抗压冗余度」(${qaOk.physicalMargin})`
  );
  assert(
    !!qaOk.physicalMargin && qaOk.physicalMargin.includes("+35%"),
    `physicalMargin 应量化 +35% (${qaOk.physicalMargin})`
  );

  // 缺物理可行性 → 拒绝改写（不掩盖隐患）
  const noPhys = makeReport({ withPhysics: false });
  const qaNo = buildQaFraming(noPhys);
  assert(qaNo.applied === false, "缺物理数据时禁止改写");
  assert(qaNo.marginRetained === false, "缺物理数据时余量未保留 → 改写被拒");
  assert(!!qaNo.rejectReason, "应给出拒绝原因");

  // 冗余度≤0 → 拒绝改写（无真实可优化冗余）
  const neg = makeReport({ withPhysics: true, requiredBCT: 500, redundancyPct: 0 });
  const qaNeg = buildQaFraming(neg);
  assert(qaNeg.applied === false, "冗余度≤0 时禁止改写为结构冗余优化");
  assert(qaNeg.marginRetained === true, "负冗余度仍保留余量数据用于展示隐患");
  assert(!!qaNeg.rejectReason, "负冗余度应给出拒绝原因");
}

// ========== 规格3：多视角汇总金额完全对齐 ==========
section("规格3：采购/研发/高管/质量 四视角汇总金额对齐");
{
  const report = makeReport({ withPhysics: true, requiredBCT: 500, redundancyPct: 35 });
  const mv = generateMultiViewReport(report);
  assert(mv.views.length === 4, "应生成 4 个视角");
  const masterTotal = report.totalCost.max;
  for (const v of mv.views) {
    assert(
      Math.abs(v.totalAmount - masterTotal) < 0.01,
      `${v.viewLabel} 总额应等于主报告总额 (${v.totalAmount} vs ${masterTotal})`
    );
    assert(v.matchesMaster === true, `${v.viewLabel} matchesMaster 应为 true`);
    // 行项目求和 = 该视角总额
    const lineSum = v.lineItems.reduce((s, l) => s + l.amount, 0);
    assert(
      Math.abs(lineSum - v.totalAmount) < 0.01,
      `${v.viewLabel} 行项目求和应等于其总额`
    );
  }
  assert(mv.reconciliation.reconciled === true, "reconcile 应为 reconciled=true");
  assert(mv.reconciliation.variance < 0.01, "variance 应≈0");
  // 四视角彼此对齐（同一真相源）
  const totals = mv.views.map((v) => v.totalAmount);
  assert(
    totals.every((t) => Math.abs(t - totals[0]) < 0.01),
    "四视角总额彼此一致"
  );
  // QA 视角应带受控表述
  const qaView = mv.views.find((v) => v.view === "quality")!;
  assert(!!qaView.qaFraming, "质量视角应含 qaFraming");
  assert(qaView.qaFraming!.applied === true, "质量视角 QA 改写应已应用（正冗余度）");
}

// 小工具：带物理的报告
function withReport(r: AnalysisReport): AnalysisReport {
  return r;
}

console.log(`\n=== RolePolicy/多视角测试：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
