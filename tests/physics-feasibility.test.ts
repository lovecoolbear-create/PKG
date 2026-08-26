// ========== P-Physics 物理性能与工艺可行性确定性校验 — 单元测试 ==========
// 运行：tsx tests/physics-feasibility.test.ts
// 覆盖：McKee BCT 数值复算、湿敏衰减、ECT 估算、杠杆识别、缺口数据、
//       FEASIBILITY_FAILED（硬过滤）、吸盘抓取防踩坑、ranker 集成拦截。

import {
  mckeeBCT,
  wetAttenuation,
  estimateECT,
  assessScenarioFeasibility,
  assessBaseline,
  detectLevers,
  isCorrugated,
  toPhysicalInput,
  MCKEE_K,
} from "@/lib/physics/feasibility";
import { ruleFilter, type VaveScenario } from "@/lib/vave/ranker";
import type { AnalysisInput } from "@/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fail++;
    console.error("  ✗", msg);
  }
}
function approx(a: number, b: number, tol: number, msg: string) {
  assert(Math.abs(a - b) <= tol, `${msg}（期望≈${b}，实际 ${a.toFixed(3)}，容差 ${tol}）`);
}

// 单瓦 B 楞 牛皮 200g 面/里 + 150g 芯 的基础箱（无载荷数据，隔离 BCT 阈值）
const baseNoLoad: AnalysisInput = {
  fluteType: "B",
  linerMaterial: "kraft",
  linerGrammage: 200,
  fluteGrammage: 150,
  boardStructure: "single",
  length: 400,
  width: 300,
  height: 250,
  surfaceTreatment: "matte_laminate",
};

console.log("1) McKee BCT 数值复算（packwares 实例）");
{
  // ECT=22.0kN/m, P=140cm, t=2.5mm → 应≈779kgf
  const bct = mckeeBCT(22.0, 140, 2.5);
  approx(bct, 779, 3, "McKee BCT ≈ 779kgf");
  assert(MCKEE_K > 1.89 && MCKEE_K < 1.9, `MCKEE_K 应为 ~1.893（实际 ${MCKEE_K}）`);
}

console.log("2) 湿敏衰减系数");
{
  approx(wetAttenuation(50), 1.0, 1e-9, "50%RH = 1.0（标准实验室）");
  approx(wetAttenuation(90), 0.5, 1e-9, "90%RH = 0.5");
  approx(wetAttenuation(70), 0.75, 1e-9, "70%RH = 0.75");
  approx(wetAttenuation(100), 0.4, 1e-9, "100%RH 下限钳制到 0.4");
}

console.log("3) ECT 估算单调性");
{
  const e1 = estimateECT(toPhysicalInput(baseNoLoad));
  const e2 = estimateECT({ ...toPhysicalInput(baseNoLoad), linerGrammage: 300 });
  assert(e1 > 5 && e1 < 12, `基础箱 ECT 在合理区间（实际 ${e1.toFixed(2)}kN/m）`);
  assert(e2 > e1, `提高面纸克重应使 ECT 增大（${e1.toFixed(2)}→${e2.toFixed(2)}）`);
}

console.log("4) 杠杆识别（降克重/换纸/省印后/换楞）");
{
  const g = detectLevers(baseNoLoad, { linerGrammage: 150 } as AnalysisInput);
  assert(g.includes("reduce_grammage"), "降克重 → reduce_grammage");

  const p = detectLevers(baseNoLoad, { linerMaterial: "recycled" } as AnalysisInput);
  assert(p.includes("change_paper"), "换纸张材质 → change_paper");

  const s = detectLevers(baseNoLoad, { surfaceTreatment: "none" } as AnalysisInput);
  assert(s.includes("skip_postprint"), "省去印后（有处理→none）→ skip_postprint");

  const f = detectLevers(baseNoLoad, { fluteType: "E" } as AnalysisInput);
  assert(f.includes("change_flute"), "换楞型 → change_flute");
}

console.log("5) FEASIBILITY_FAILED — 降克重跌破 ECT 安全下限");
{
  const r = assessScenarioFeasibility({
    base: baseNoLoad,
    override: { linerGrammage: 90, fluteGrammage: 80 } as AnalysisInput,
  });
  assert(r.failed === true, "未通过（failed=true）");
  assert(r.passed === false, "确定性层 passed=false");
  assert(r.triggered.includes("ect_floor"), "触发 ect_floor 规则");
  assert(r.levers.includes("reduce_grammage"), "识别到 reduce_grammage 杠杆");
  assert((r.gaps.ectDeficit ?? 0) > 0, `附 ECT 缺口数据（${r.gaps.ectDeficit}kN/m）`);
  assert(!!r.reason && r.reason.includes("FEASIBILITY_FAILED"), "reason 标注 FEASIBILITY_FAILED");
}

console.log("6) 防踩坑 — 省印后 + 低克重 → 吸盘抓取异常");
{
  const r = assessScenarioFeasibility({
    base: baseNoLoad,
    override: { surfaceTreatment: "none", linerGrammage: 120 } as AnalysisInput,
  });
  assert(r.levers.includes("skip_postprint"), "识别到 skip_postprint 杠杆");
  assert(r.triggered.includes("pickup_risk"), "触发 pickup_risk 规则");
  assert(r.gaps.pickupRisk === true, "gaps.pickupRisk=true");
  assert(r.failed === true, "该方案被否决（failed=true）");
}

console.log("7) 非瓦楞结构直接放行（neutral）");
{
  const rigid: AnalysisInput = { productType: "rigid_box", boardStructure: "solid" };
  assert(isCorrugated(rigid) === false, "solid 彩盒非瓦楞");
  const r = assessScenarioFeasibility({ base: rigid, override: { linerGrammage: 50 } as AnalysisInput });
  assert(r.passed === true && r.failed === false && !r.touchedPhysics, "非瓦楞不触发物理门禁");
}

console.log("8) 基线评估 — 重堆码承压不足告警（warning，不否决设计）");
{
  const heavy: AnalysisInput = {
    ...baseNoLoad,
    boxWeightKg: 15,
    stackLayers: 10,
  };
  const r = assessBaseline(heavy);
  assert(r.triggered.includes("bct_threshold"), "触发 bct_threshold");
  assert((r.gaps.bctDeficit ?? 0) > 0, `附 BCT 缺口数据（${r.gaps.bctDeficit}kgf）`);
  assert(r.failed === true, "基线只作告警（failed=true 但估算阶段不拦截）");
}

console.log("9) 集成 — ranker.ruleFilter 物理否决后绝不进入 AI 排序");
{
  const good: VaveScenario = {
    id: "g",
    label: "原样",
    override: {},
    perUnit: 5,
    baselinePerUnit: 5,
  };
  const bad: VaveScenario = {
    id: "f",
    label: "过度降克重",
    override: { linerGrammage: 90, fluteGrammage: 80 } as Partial<AnalysisInput>,
    perUnit: 3.5,
    baselinePerUnit: 5,
  };
  const gf = ruleFilter(good, baseNoLoad);
  const bf = ruleFilter(bad, baseNoLoad);
  assert(gf.passed === true, "合规方案通过硬过滤");
  assert(bf.passed === false, "物理否决方案 passed=false（不进入 AI 软排序）");
  assert(bf.feasibility?.failed === true, "否决方案带 feasibility.failed=true（缺口数据可审计）");
  assert(!!bf.feasibility?.reason, "否决原因非空，严禁透传 LLM");
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
