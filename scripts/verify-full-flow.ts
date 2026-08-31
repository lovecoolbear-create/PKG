/**
 * 全流程引擎测试（不变量 + 装订档位 + 单调性 + 边界）
 * ----------------------------------------------------------------
 * 目的：黄金基线只锁「数值不变」，无法发现「结构性问题」——
 *   NaN/Infinity 泄漏、min>max、占比合计≠100%、总价≠五维之和、
 *   装订档位静默归零、规模效应反向、非法输入抛异常、单位标签错。
 * 本脚本跑真实引擎（runOrchestrator），逐条断言这些不变量。
 *
 * 确定性前提：aiSettings 强制 disabled（同 golden-regression），不联网不调 LLM。
 *
 * 用法：npx tsx scripts/verify-full-flow.ts
 */
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { runInputGuardrail } from "@/lib/agents/input-guardrail";
import { unitLabel } from "@/lib/units";
import type { AiSettings } from "@/lib/config/ai-settings";
import type { AnalysisInput, AnalysisReport } from "@/types";

const AI_OFF: AiSettings = { provider: "disabled", baseUrl: "", apiKey: "", modelName: "" };

const DIMS = ["material", "process", "labor", "design_plate", "finance_other"];

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else {
    fail++;
    fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`);
}

/** 深描整个报告对象，找出任何 NaN / Infinity / null-where-number-expected */
function deepScanBadNumbers(node: unknown, path = "", out: string[] = []): string[] {
  if (typeof node === "number") {
    if (!Number.isFinite(node)) out.push(`${path} = ${node}`);
    return out;
  }
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => deepScanBadNumbers(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      deepScanBadNumbers(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

async function run(productType: string, input: AnalysisInput, id: string): Promise<AnalysisReport> {
  const config = getProductConfig(productType)!;
  return runOrchestrator({
    sessionId: `ff-${id}`,
    config,
    input,
    skippedKeys: [],
    aiSettings: AI_OFF,
  });
}

const BOX: AnalysisInput = {
  quantity: 5000,
  length: 200,
  width: 150,
  height: 80,
  material: "white_card",
  grammage: 350,
  boxType: "tuck_end",
  printMethod: "offset",
  colorCount: 4,
  spotColorCount: 0,
  surfaceTreatment: "matte_laminate",
  provideReadyDesign: false,
  deliveryLocation: "east_china",
  targetDelivery: "standard",
} as unknown as AnalysisInput;

const CORR: AnalysisInput = {
  quantity: 3000,
  length: 400,
  width: 300,
  height: 250,
  fluteType: "B",
  wallType: "single",
  linerMaterial: "kraft",
  linerGrammage: 175,
  boxStyle: "RSC",
  printMethod: "flexo",
  colorCount: 1,
  deliveryLocation: "east_china",
  targetDelivery: "standard",
} as unknown as AnalysisInput;

const FLAT: AnalysisInput = {
  quantity: 1000,
  length: 210,
  width: 285,
  pages: 32,
  material: "coated_paper",
  grammage: 157,
  coverGrammage: 250,
  printMethod: "offset",
  colorCount: 4,
  spotColorCount: 0,
  surfaceTreatment: "matte_laminate",
  binding: "perfect",
  provideReadyDesign: false,
  deliveryLocation: "east_china",
  targetDelivery: "standard",
} as unknown as AnalysisInput;

const LABEL: AnalysisInput = {
  quantity: 5000,
  length: 50,
  width: 30,
  material: "coated_paper",
  grammage: 80,
  printMethod: "offset",
  colorCount: 4,
  spotColorCount: 0,
  deliveryLocation: "east_china",
  targetDelivery: "standard",
} as unknown as AnalysisInput;

const CASES: { id: string; name: string; productType: string; unit: string; input: AnalysisInput }[] = [
  { id: "box", name: "彩印纸盒", productType: "color_print_box", unit: "只", input: BOX },
  { id: "corr", name: "瓦楞纸箱", productType: "corrugated_box", unit: "只", input: CORR },
  { id: "flat", name: "平印画册", productType: "flat_print", unit: "册/张", input: FLAT },
  { id: "label", name: "不干胶标签", productType: "label", unit: "张", input: LABEL },
];

async function main() {
  // ========== A. 四品类报告不变量 ==========
  section("A. 四品类报告不变量");
  for (const c of CASES) {
    const r = await run(c.productType, c.input, c.id);

    const codes = r.dimensions.map((d) => d.dimension);
    check(`${c.name}·五维齐全`, DIMS.every((d) => codes.includes(d)), codes.join(","));

    const badAmount = r.dimensions.filter((d) => !Number.isFinite(d.estimatedAmount) || d.estimatedAmount < 0);
    check(`${c.name}·五维金额有限且非负`, badAmount.length === 0, badAmount.map((d) => `${d.dimension}=${d.estimatedAmount}`).join(","));

    const ratioSum = r.dimensions.reduce((s, d) => s + d.ratio, 0);
    check(`${c.name}·占比合计≈100%`, Math.abs(ratioSum - 100) <= 1.5, `实际 ${ratioSum.toFixed(2)}%`);

    check(`${c.name}·总价 min>0 且 min≤max`, r.totalCost.min > 0 && r.totalCost.max >= r.totalCost.min, `${r.totalCost.min}~${r.totalCost.max}`);
    check(`${c.name}·单价 min>0 且 min≤max`, r.totalCost.perUnit.min > 0 && r.totalCost.perUnit.max >= r.totalCost.perUnit.min, `${r.totalCost.perUnit.min}~${r.totalCost.perUnit.max}`);

    const sumMin = r.dimensions.reduce((s, d) => s + d.amountRange[0], 0);
    const sumMax = r.dimensions.reduce((s, d) => s + d.amountRange[1], 0);
    check(
      `${c.name}·五维下区间之和=总价下限`,
      Math.abs(sumMin - r.totalCost.min) <= 0.5,
      `${sumMin.toFixed(2)} vs ${r.totalCost.min.toFixed(2)}`
    );
    check(
      `${c.name}·五维上区间之和=总价上限`,
      Math.abs(sumMax - r.totalCost.max) <= 0.5,
      `${sumMax.toFixed(2)} vs ${r.totalCost.max.toFixed(2)}`
    );
    const outOfRange = r.dimensions.filter((d) => d.estimatedAmount < d.amountRange[0] - 0.01 || d.estimatedAmount > d.amountRange[1] + 0.01);
    check(`${c.name}·点估计落在自身区间内`, outOfRange.length === 0, outOfRange.map((d) => d.dimension).join(","));

    const qty = Number(c.input.quantity);
    const perUnitFromTotal = r.totalCost.max / qty;
    check(
      `${c.name}·单价≈总价/数量`,
      Math.abs(perUnitFromTotal - r.totalCost.perUnit.max) <= Math.max(0.001, r.totalCost.perUnit.max * 0.02),
      `${perUnitFromTotal.toFixed(4)} vs ${r.totalCost.perUnit.max.toFixed(4)}`
    );

    check(`${c.name}·置信度∈[0,100]`, r.overallConfidence >= 0 && r.overallConfidence <= 100, String(r.overallConfidence));

    const bad = deepScanBadNumbers(r);
    check(`${c.name}·全报告无 NaN/Infinity`, bad.length === 0, bad.slice(0, 3).join("; "));

    check(`${c.name}·优化提示非空（§6④）`, (r.optimizationHints?.length ?? 0) > 0, `${r.optimizationHints?.length ?? 0} 条`);
    // 注意：totalCost.unit 是**总价的货币单位**（"元"），不是件单位；
    // 件单位由 unitLabel(productType) 提供（历史 bug：LeftNav 曾把 "元" 当件单位显示成「¥x/元」）
    check(`${c.name}·总价货币单位=元`, r.totalCost.unit === "元", r.totalCost.unit);
    check(`${c.name}·件单位 unitLabel=${c.unit}`, unitLabel(c.productType) === c.unit, unitLabel(c.productType));
  }

  // ========== B. 装订 8 档价格确实生效 ==========
  section("B. 平印装订 8 档（防静默归零复发）");
  const tierPrices: Record<string, number> = {};
  for (const b of ["none", "saddle", "perfect", "thread_sewn", "hardcover", "spiral", "accordion", "fold"]) {
    const r = await run("flat_print", { ...FLAT, binding: b } as AnalysisInput, `bind-${b}`);
    tierPrices[b] = r.totalCost.max;
    console.log(`  ${b.padEnd(12)} 总价 ¥${r.totalCost.max.toFixed(2)} · 单价 ¥${r.totalCost.perUnit.max.toFixed(4)}`);
  }
  for (const b of ["saddle", "perfect", "thread_sewn", "hardcover", "spiral", "accordion", "fold"]) {
    check(`装订 ${b} 价格 > none`, tierPrices[b] > tierPrices.none + 0.01, `${tierPrices[b].toFixed(2)} vs ${tierPrices.none.toFixed(2)}`);
  }
  check("精装 > 无线胶装", tierPrices.hardcover > tierPrices.perfect, `${tierPrices.hardcover.toFixed(2)} vs ${tierPrices.perfect.toFixed(2)}`);
  check("锁线胶装 > 无线胶装", tierPrices.thread_sewn > tierPrices.perfect, `${tierPrices.thread_sewn.toFixed(2)} vs ${tierPrices.perfect.toFixed(2)}`);
  check("无线胶装 > 骑马钉", tierPrices.perfect > tierPrices.saddle, `${tierPrices.perfect.toFixed(2)} vs ${tierPrices.saddle.toFixed(2)}`);

  // ========== C. 规模效应单调性 ==========
  section("C. 数量↑ → 单价↓（规模效应）");
  for (const c of CASES.slice(0, 3)) {
    const perUnits: number[] = [];
    for (const q of [500, 2000, 10000, 50000]) {
      const r = await run(c.productType, { ...c.input, quantity: q } as AnalysisInput, `q-${c.id}-${q}`);
      perUnits.push(r.totalCost.perUnit.max);
    }
    const monotone = perUnits.every((v, i) => i === 0 || v <= perUnits[i - 1] * 1.02);
    check(`${c.name}·单价随数量单调不升`, monotone, perUnits.map((v) => v.toFixed(4)).join(" → "));
    console.log(`  ${c.name}: ${perUnits.map((v) => v.toFixed(4)).join(" → ")}`);
  }

  // ========== D. 非法/边界输入不应抛异常 ==========
  section("D. 非法与边界输入（不崩溃 + guardrail 生效）");
  const badInputs: { name: string; productType: string; input: AnalysisInput }[] = [
    { name: "数量=0", productType: "color_print_box", input: { ...BOX, quantity: 0 } as AnalysisInput },
    { name: "尺寸=0", productType: "color_print_box", input: { ...BOX, length: 0 } as AnalysisInput },
    { name: "尺寸非数字", productType: "color_print_box", input: { ...BOX, width: "abc" } as unknown as AnalysisInput },
    { name: "克重越界", productType: "color_print_box", input: { ...BOX, grammage: 9999 } as AnalysisInput },
    { name: "专色=20", productType: "color_print_box", input: { ...BOX, spotColorCount: 20 } as AnalysisInput },
    { name: "超大数量", productType: "corrugated_box", input: { ...CORR, quantity: 10_000_000 } as AnalysisInput },
    { name: "极小数量", productType: "label", input: { ...LABEL, quantity: 1 } as AnalysisInput },
    { name: "海量大尺寸", productType: "corrugated_box", input: { ...CORR, length: 5000, width: 5000, height: 5000 } as AnalysisInput },
    { name: "平印页数=0", productType: "flat_print", input: { ...FLAT, pages: 0 } as AnalysisInput },
    // 注：页数=1（海报）合法不拦；页数=9999 为 warn 非 block，二者在下方专项断言
  ];
  for (const b of badInputs) {
    let threw = false;
    let msg = "";
    try {
      await run(b.productType, b.input, `bad-${b.name}`);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check(`非法输入不抛异常：${b.name}`, !threw, msg);

    const g = runInputGuardrail(b.input, getProductConfig(b.productType)!);
    // 「超大数量/极小数量/海量大尺寸」为合法但极端输入，guardrail 不拦属预期；
    // 其余为非法输入，必须拦。
    const isExtreme = b.name.startsWith("超大") || b.name.startsWith("极小") || b.name.startsWith("海量");
    if (!isExtreme) {
      check(`guardrail 应拦：${b.name}`, g.hasBlocker, g.blockers.map((i) => i.code).join(",") || "未拦");
    } else {
      check(`极端输入不误拦：${b.name}`, !g.hasBlocker, g.blockers.map((i) => i.code).join(","));
    }
  }
  // 页数边界（平印专用，2026-08-30 补）
  {
    const flat = getProductConfig("flat_print")!;
    check("页数=0 应 block", runInputGuardrail({ ...FLAT, pages: 0 } as AnalysisInput, flat).hasBlocker);
    check(
      "页数=9999 应 warn（疑似印数误填）",
      runInputGuardrail({ ...FLAT, pages: 9999 } as AnalysisInput, flat).warnings.some((i) => i.code === "pages_oversize")
    );
    check(
      "页数=32 不应误报",
      !runInputGuardrail({ ...FLAT, pages: 32 } as AnalysisInput, flat).issues.length
    );
  }

  // ========== E. 报告 JSON 可序列化（无循环引用 / BigInt） ==========
  section("E. 报告可 JSON 序列化");
  for (const c of CASES) {
    const r = await run(c.productType, c.input, `ser-${c.id}`);
    let ok = true;
    let err = "";
    try {
      JSON.stringify(r);
    } catch (e) {
      ok = false;
      err = (e as Error).message;
    }
    check(`${c.name}·可序列化`, ok, err);
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fails.length) {
    console.log("\n失败项：");
    fails.forEach((f) => console.log("  ❌ " + f));
    process.exit(1);
  } else {
    console.log("✅ 全流程引擎测试全部通过");
  }
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
