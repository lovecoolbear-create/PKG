/**
 * 审阅层只读契约护栏（A3）
 * ----------------------------------------------------------------
 * 核心铁律：**数值对不对归公式，合不合理才问 AI。**
 * 审阅层（reviewer / consistency-gate）只产出 findings 与 warnings，
 * **绝不修改任何已算出的数字**。
 *
 * 这些断言是护栏——不是验证当前实现「现在是对的」（那已经人工核过），
 * 而是防止后人给审阅层加上"顺手修正一下数字"的逻辑而悄悄破坏
 * 可复现/可审计这一地基。
 */
import { reviewAnalysis } from "@/lib/agents/reviewer";
import { reconcileCrossLayer } from "@/lib/agents/consistency-gate";
import type { AnalysisContext } from "@/lib/agents/analysis-context";
import type { AgentResult, ProductTypeConfig } from "@/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

function makeResults(): AgentResult[] {
  const base = {
    amountRange: [0, 0] as [number, number],
    basis: [],
    assumptions: [],
    risks: [],
    confidence: 80,
  };
  return [
    { ...base, dimension: "material", dimensionLabel: "材料", estimatedAmount: 3838.76, ratio: 43 },
    { ...base, dimension: "labor", dimensionLabel: "人工", estimatedAmount: 389, ratio: 4 },
    { ...base, dimension: "process", dimensionLabel: "加工", estimatedAmount: 1752.79, ratio: 20 },
    { ...base, dimension: "design_plate", dimensionLabel: "设计制版", estimatedAmount: 2350, ratio: 26 },
    { ...base, dimension: "finance_other", dimensionLabel: "财务其他", estimatedAmount: 1516.17, ratio: 17 },
  ];
}

const config = {
  dimensions: [
    { key: "material", label: "材料" },
    { key: "labor", label: "人工" },
    { key: "process", label: "加工" },
    { key: "design_plate", label: "设计制版" },
    { key: "finance_other", label: "财务其他" },
  ],
} as unknown as ProductTypeConfig;

console.log("=== 审阅层只读契约（A3）===\n");

// ── 1. reviewAnalysis 不得改写传出的 results ─────────────────────────────
console.log("▸ 规格1：reviewAnalysis 不修改已算出的数值");
{
  const results = makeResults();
  const before = JSON.parse(JSON.stringify(results));
  const ctx = { surface: "foil", quantity: 5000 } as unknown as AnalysisContext;

  const review = reviewAnalysis(ctx, results, config);

  assert(
    JSON.stringify(results) === JSON.stringify(before),
    "reviewAnalysis 调用后 results 完全未被修改（只读）"
  );
  assert(review.findings.length > 0, "审阅产出 findings（烫金覆盖假设应被提示）");
  assert(typeof review.perUnitEstimated === "number", "单只估算成本已返回");
  const codes = review.findings.map((f) => f.code);
  assert(codes.includes("surface_local_coverage"), "烫金/凹凸覆盖率假设被提示（code=surface_local_coverage）");
}

// ── 2. 材料主导提示不改变数值 ────────────────────────────────────────────
console.log("\n▸ 规格2：材料占比过高只提示、不改数");
{
  const results = makeResults();
  results[0] = { ...results[0], ratio: 75, estimatedAmount: 9000 };
  const before = JSON.parse(JSON.stringify(results));
  const ctx = { surface: "none", quantity: 5000 } as unknown as AnalysisContext;

  const review = reviewAnalysis(ctx, results, config);

  assert(
    JSON.stringify(results) === JSON.stringify(before),
    "材料占比 75% 时 results 仍未被修改"
  );
  assert(
    review.findings.some((f) => f.code === "material_dominant"),
    "材料主导被提示（code=material_dominant）"
  );
}

// ── 3. 单只成本异常只提示、不改数 ────────────────────────────────────────
console.log("\n▸ 规格3：单只成本异常只提示、不改数");
{
  const results = makeResults();
  const before = JSON.parse(JSON.stringify(results));
  const ctx = { surface: "none", quantity: 500000 } as unknown as AnalysisContext;

  const review = reviewAnalysis(ctx, results, config);

  assert(JSON.stringify(results) === JSON.stringify(before), "单只成本异常时 results 仍未被修改");
  assert(
    review.findings.some((f) => f.code === "per_unit_low"),
    "单只成本过低被提示（code=per_unit_low）"
  );
}

// ── 4. reconcileCrossLayer 不得改写传入的 roleReports ────────────────────
console.log("\n▸ 规格4：reconcileCrossLayer 不修改传入的 roleReports");
{
  const roleReports = [
    { role: "client", roleLabel: "客户视角", headline: "方案无风险", points: ["完全可行，符合规范无问题"] },
    { role: "cost", roleLabel: "成本视角", headline: "成本可控", points: ["降本空间 8%"] },
  ];
  const before = JSON.parse(JSON.stringify(roleReports));

  const out = reconcileCrossLayer({ judgeHasError: true, roleReports });

  assert(
    JSON.stringify(roleReports) === JSON.stringify(before),
    "传入的 roleReports 未被就地修改（返回新对象而非改原数组）"
  );
  assert(out.warnings.length > 0, "判定层 error 冲突被跨层对账捕获并产出 warning");
  assert(
    out.reports[0].points.some((p) => p.includes("判定层")),
    "客户视角被追加「须以判定层确定性结论为准」提示"
  );
}

// ── 5. 无冲突时不做任何改写 ──────────────────────────────────────────────
console.log("\n▸ 规格5：无判定层 error 时原样返回、不产出告警");
{
  const roleReports = [
    { role: "client", roleLabel: "客户视角", headline: "方案可行", points: ["无风险"] },
  ];
  const out = reconcileCrossLayer({ judgeHasError: false, roleReports });
  assert(out.warnings.length === 0, "无 error 时不产出跨层告警");
  assert(out.reports === roleReports, "无 error 时原样返回同一引用（零改写）");
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
