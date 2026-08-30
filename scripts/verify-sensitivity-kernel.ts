// VAVE 敏感性确定性内核验证（建议 #3）：断言所有 VAVE 数字由确定性函数计算，
// 不依赖 LLM；并验证 label 品类单位标签为「张」。
// 跑法：npx tsx scripts/verify-sensitivity-kernel.ts
import type { AnalysisReport } from "@/types";
import {
  computeConcession,
  computeTargetNegotiation,
} from "@/lib/vave/negotiation";
import {
  computePaperPriceImpact,
  buildVaveKernelFacts,
} from "@/lib/vave/sensitivity-kernel";
import { unitLabel } from "@/lib/units";

const report = {
  productType: "label",
  totalCost: { perUnit: { max: 1.2, min: 1.0 }, max: 6000, min: 5000 },
  dimensions: [
    { dimension: "material", dimensionLabel: "材料", estimatedAmount: 3000, ratio: 50 },
    { dimension: "labor", dimensionLabel: "人工", estimatedAmount: 600, ratio: 10 },
    { dimension: "process", dimensionLabel: "加工", estimatedAmount: 1500, ratio: 25 },
    { dimension: "design_plate", dimensionLabel: "设计制版", estimatedAmount: 500, ratio: 8 },
    { dimension: "finance_other", dimensionLabel: "财务其他", estimatedAmount: 400, ratio: 7 },
  ],
  overallConfidence: 90,
} as unknown as AnalysisReport;

const QTY = 5000;

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
  }
}

// 1. 让利空间（保本价 = min × 0.95）
{
  const c = computeConcession(report);
  check("保本价 = min×0.95", Math.abs(c.breakEvenPerUnit - 0.95) < 1e-9);
  check("最大可让利 = max-保本", Math.abs(c.maxConcessionPerUnit - 0.25) < 1e-9);
  check("让利率 ≈ 20.8%", Math.abs(c.maxConcessionRatio - 20.8) < 0.05);
}

// 2. 目标价反推可行性
{
  const t = computeTargetNegotiation(report, 1.08);
  check("目标≥保本→可行", t.feasible === true);
  check("gap = 当前-目标", Math.abs(t.gapPerUnit - 0.12) < 1e-9);
  // 各维压缩之和 ≈ gap
  const sumCut = t.perDimension.reduce((s, r) => s + r.suggestedCut, 0);
  check("各维压缩和≈gap", Math.abs(sumCut - 0.12) < 1e-6);
  const t2 = computeTargetNegotiation(report, 0.5);
  check("目标<保本→不可行", t2.feasible === false);
}

// 3. 纸价冲击线性近似（确定性）
{
  const up = computePaperPriceImpact(report, 20, QTY);
  check("纸价+20% 材料=3600", Math.abs(up.newMaterial - 3600) < 1e-9);
  check("纸价+20% 总=6600", Math.abs(up.newTotal - 6600) < 1e-9);
  check("纸价+20% 每单位=1.32", Math.abs(up.perUnit - 1.32) < 1e-9);
  const down = computePaperPriceImpact(report, -20, QTY);
  check("纸价-20% 每单位=1.08", Math.abs(down.perUnit - 1.08) < 1e-9);
  const flat = computePaperPriceImpact(report, 0, QTY);
  check("纸价0% 每单位=1.2", Math.abs(flat.perUnit - 1.2) < 1e-9);
}

// 4. 聚合只读事实 + label 单位标签
{
  const f = buildVaveKernelFacts(report, QTY);
  check("label 单位标签=张", f.unit === "张");
  check("facts 含让利空间", f.concession.maxConcessionPerUnit > 0);
  check("facts 含纸价±20%", f.paperImpactPlus20.perUnit > f.paperImpactMinus20.perUnit);
}

// 5. 单位标签映射正确性
{
  check("flat_print=册/张", unitLabel("flat_print") === "册/张");
  check("label=张", unitLabel("label") === "张");
  check("color_print_box=只", unitLabel("color_print_box") === "只");
  check("corrugated_box=只", unitLabel("corrugated_box") === "只");
}

console.log(`VAVE 敏感性内核验证：通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败用例：\n - " + fails.join("\n - "));
  process.exit(1);
} else {
  console.log("✅ 全部通过（VAVE 数字确定性、label 单位=张）");
}
