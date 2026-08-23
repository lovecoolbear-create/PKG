/**
 * 成本计算引擎优化前后对比测试
 * - 新逻辑：调用真实 Agent 函数（已含拼版利用率/动态损耗/印刷起步价/局部覆盖率/完稿减免）
 * - 旧逻辑：内联复现优化前的公式（固定8%损耗、无利用率、无起步价、全面积表面处理、设计费恒800）
 * 材料价格统一用静态参考表（不触发随机网络抓取），保证对比确定性。
 */
import {
  materialAgent,
  processAgent,
  designAgent,
  financeAgent,
} from "@/lib/agents/specialists";
import { deriveAnalysisContext } from "@/lib/agents/analysis-context";
import {
  MATERIAL_PRICES,
  calculateExpandedArea,
  getQuantityDiscount,
  PRINT_BASE_RATES,
  SURFACE_TREATMENT_RATES,
  PLATE_COST_PER_COLOR,
} from "@/lib/cost-rules";
import type { AnalysisInput } from "@/types";

const sum4 = (m: number, p: number, d: number, f: number) => m + p + d + f;

// —— 旧逻辑复现（优化前）——
function oldMaterial(input: AnalysisInput): number {
  const qty = Number(input.quantity);
  const area = calculateExpandedArea(
    Number(input.length),
    Number(input.width),
    Number(input.height)
  );
  const grammage = Number(input.grammage);
  const weightPerPiece = ((area / 1_000_000) * grammage) / 1000;
  const weight = weightPerPiece * qty * 1.08; // 固定 8% 损耗，无利用率
  const material = String(input.material ?? "white_card");
  const pricePerTon = MATERIAL_PRICES[material]?.[String(input.grammage)] ?? 5500;
  const discount = getQuantityDiscount(qty);
  return (weight * pricePerTon) / 1000 * discount;
}
function oldProcess(input: AnalysisInput): number {
  const qty = Number(input.quantity);
  const area = calculateExpandedArea(
    Number(input.length),
    Number(input.width),
    Number(input.height)
  );
  const areaM2Total = (area / 1_000_000) * qty;
  const colorCount = String(input.colorCount ?? "4");
  const colors = colorCount.startsWith("4+")
    ? 4 + Number(colorCount.split("+")[1])
    : Number(colorCount);
  const printMethod = String(input.printMethod ?? "offset");
  const printRate = PRINT_BASE_RATES[printMethod] ?? 35;
  const printCost = (areaM2Total / qty) * (qty / 1000) * printRate * colors; // 无起步价
  const surface = String(input.surfaceTreatment ?? "none");
  const surfaceRate = SURFACE_TREATMENT_RATES[surface] ?? 0;
  const surfaceCost = areaM2Total * surfaceRate; // 全面积，无局部覆盖率
  const dieCut = qty * 0.015;
  const needGluing = input.needGluing !== false;
  const gluing = needGluing ? qty * 0.025 : 0;
  return printCost + surfaceCost + dieCut + gluing;
}
function oldDesign(input: AnalysisInput): number {
  const colorCount = String(input.colorCount ?? "4");
  const colors = colorCount.startsWith("4+")
    ? 4 + Number(colorCount.split("+")[1])
    : Number(colorCount);
  const printMethod = String(input.printMethod ?? "offset");
  let plateCost = colors * PLATE_COST_PER_COLOR;
  if (printMethod === "digital") plateCost = 0;
  const designCost = 800; // 恒为 800
  const qty = Number(input.quantity);
  const proofing = qty < 5000 ? 300 : 150;
  return plateCost + designCost + proofing;
}

function calcNew(input: AnalysisInput) {
  const mat = materialAgent(deriveAnalysisContext(input)).estimatedAmount;
  const proc = processAgent(deriveAnalysisContext(input)).estimatedAmount;
  const des = designAgent(deriveAnalysisContext(input)).estimatedAmount;
  const fin = financeAgent(deriveAnalysisContext(input), mat + proc + des).estimatedAmount;
  return { mat, proc, des, fin, total: sum4(mat, proc, des, fin) };
}
function calcOld(input: AnalysisInput) {
  const mat = oldMaterial(input);
  const proc = oldProcess(input);
  const des = oldDesign(input);
  const fin = financeAgent(deriveAnalysisContext(input), mat + proc + des).estimatedAmount;
  return { mat, proc, des, fin, total: sum4(mat, proc, des, fin) };
}

function fmt(n: number) {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function pct(newV: number, oldV: number) {
  if (oldV === 0) return "—";
  return (((newV - oldV) / oldV) * 100).toFixed(1) + "%";
}

function compare(title: string, input: AnalysisInput) {
  const qty = Number(input.quantity);
  const n = calcNew(input);
  const o = calcOld(input);
  const unitN = n.total / qty;
  const unitO = o.total / qty;
  console.log(`\n===== ${title} =====`);
  console.log(
    `维度           优化前(元)      优化后(元)      变化`
  );
  const rows: [string, number, number][] = [
    ["材料", o.mat, n.mat],
    ["加工费", o.proc, n.proc],
    ["设计", o.des, n.des],
    ["财务", o.fin, n.fin],
    ["合计", o.total, n.total],
  ];
  for (const [name, a, b] of rows) {
    console.log(
      `${name.padEnd(8)}  ${fmt(a).padStart(14)}  ${fmt(b).padStart(14)}  ${pct(b, a).padStart(8)}`
    );
  }
  console.log(`订单数量        : ${qty}`);
  console.log(`优化前 单件单价 : ¥${fmt(unitO)}`);
  console.log(`优化后 单件单价 : ¥${fmt(unitN)}`);
  console.log(`单件单价变化    : ${pct(unitN, unitO)}`);
}

// 典型彩盒参数：200×150×80mm 白卡350g 胶印4色 哑膜 需糊盒 华东 标准交期
const base = (qty: number, extra: Partial<AnalysisInput> = {}): AnalysisInput => ({
  quantity: qty,
  length: 200,
  width: 150,
  height: 80,
  material: "white_card",
  grammage: "350",
  printMethod: "offset",
  colorCount: "4",
  surfaceTreatment: "matte_laminate",
  needGluing: true,
  laborRegion: "east_china",
  deliveryLocation: "east_china",
  targetDelivery: "standard",
  ...extra,
});

console.log("########## 成本计算引擎：优化前 vs 优化后 ##########");
compare("用例1：彩盒 ×1,000（哑膜）", base(1000));
compare("用例2：彩盒 ×50,000（哑膜）", base(50000));
compare(
  "用例3：彩盒 ×10,000（烫金，验证局部8%覆盖率）",
  base(10000, { surfaceTreatment: "foil" })
);
compare(
  "用例4：彩盒 ×1,000（客户提供完稿，验证设计费=0）",
  base(1000, { provideReadyDesign: true })
);

// ========== 新增：盒型 / 裱坑 / 专色 分项成本明细 ==========
function breakdownCase(title: string, input: AnalysisInput) {
  const mat = materialAgent(deriveAnalysisContext(input));
  const proc = processAgent(deriveAnalysisContext(input));
  const des = designAgent(deriveAnalysisContext(input));
  const fin = financeAgent(deriveAnalysisContext(input), mat.estimatedAmount + proc.estimatedAmount + des.estimatedAmount);
  const rows = [mat, proc, des, fin];
  const total = rows.reduce((s, r) => s + r.estimatedAmount, 0);

  console.log(`\n########## ${title} ##########`);
  for (const r of rows) {
    console.log(`\n[${r.dimensionLabel}] 合计 ¥${fmt(r.estimatedAmount)}`);
    for (const b of r.breakdown || []) {
      console.log(
        `   - ${b.label.padEnd(28)} ¥${fmt(b.amount)}${b.note ? `  （${b.note}）` : ""}`
      );
    }
  }
  console.log(`\n订单数量        : ${Number(input.quantity)}`);
  console.log(`分项合计        : ¥${fmt(total)}`);
  console.log(`单件单价        : ¥${fmt(total / Number(input.quantity))}`);
}

console.log("\n\n########## 盒型 / 裱坑 / 专色 分项成本明细 ##########");
breakdownCase(
  "天地盖精品盒（白卡350g 胶印4色 哑膜 ×3,000）",
  base(3000, {
    boxType: "rigid_cover",
    colorCount: "4",
    surfaceTreatment: "matte_laminate",
  })
);
breakdownCase(
  "白卡+E坑裱纸盒（面纸350g + E坑 胶印4色 哑膜 ×5,000）",
  base(5000, {
    boxType: "tuck_end",
    fluteType: "E_flute",
    colorCount: "4",
    surfaceTreatment: "matte_laminate",
  })
);
breakdownCase(
  "异形开窗盒 + 1专色（白卡350g 胶印4+1专色 哑膜 ×2,000）",
  base(2000, {
    boxType: "special_window",
    colorCount: "4",
    spotColorCount: 1,
    surfaceTreatment: "matte_laminate",
  })
);

// ========== 新增：LLM 回退分支断言（无 API Key 时必须确定性兜底） ==========
async function llmFallbackChecks() {
  console.log("\n\n########## LLM 回退分支断言（无 API Key / 离线） ##########");

  const { parseNaturalLanguage } = await import("@/lib/agents/nlp-parser");
  const { generateSqeDiagnosis } = await import("@/lib/agents/llm-analyst");

  // 1) 自然语言解析：无 Key 时回退规则解析，仍产出结构化入参
  const nl = await parseNaturalLanguage(
    "我要做 3000 个海鲜礼盒，要防水，做高级一点的天地盖"
  );
  const okNl =
    nl.source === "rule" &&
    Number(nl.input.quantity) === 3000 &&
    nl.input.boxType === "rigid_cover";
  console.log(
    `[自然语言解析回退] source=${nl.source} qty=${nl.input.quantity} boxType=${nl.input.boxType} => ${okNl ? "PASS" : "FAIL"}`
  );

  // 2) SQE 诊断：无 Key 时回退模板段落，source=template
  const mockReport = {
    productTypeName: "彩印纸盒",
    totalCost: { min: 3000, max: 3600, perUnit: { min: 3, max: 3.6 } },
    overallConfidence: 78,
    defaultAssumptions: [],
    dimensions: [
      { dimension: "material", dimensionLabel: "材料成本", estimatedAmount: 1500, ratio: 45, breakdown: [] },
      { dimension: "process", dimensionLabel: "工艺加工成本", estimatedAmount: 900, ratio: 27, breakdown: [] },
      { dimension: "design_plate", dimensionLabel: "设计与制版成本", estimatedAmount: 600, ratio: 18, breakdown: [] },
    ],
  } as unknown as import("@/types").AnalysisReport;
  const sqe = await generateSqeDiagnosis(mockReport);
  const okSqe =
    sqe.source === "template" &&
    sqe.text.length >= 30 &&
    sqe.text.includes("VAVE");
  console.log(
    `[SQE 诊断回退] source=${sqe.source} len=${sqe.text.length} => ${okSqe ? "PASS" : "FAIL"}`
  );

  const allPass = okNl && okSqe;
  console.log(`\n回退分支断言：${allPass ? "全部 PASS ✅" : "存在 FAIL ❌"}`);
}

llmFallbackChecks().catch((e) => {
  console.error("LLM 回退测试异常:", e);
  process.exit(1);
});

