/**
 * 真实案例偏差校准脚本（读 calibration-cases.json，走真实 Agent 路径）
 *
 * 用途：用户攒到 10–20 张真实工厂报价单后，跑第一轮校准——
 *   引擎估算 vs 工厂实际报价，输出：
 *     · 总单价偏差 / 总价偏差
 *     · 分维度金额偏差（引擎 vs 实际，每个维度元 + 百分比）
 *     · 分维度占比偏差（引擎占比% vs 实际占比%，百分点）
 *     · 越界项标红（金额偏差 |%| > 阈值 或 占比偏差 > 阈值）
 *     · **半拆解锚定**（材料自锚 + 残差隔离）：供应商不拆五维时，用外部纸价锚材料维，
 *       其余锚定项从总价扣除，残差即加工费，专门标定唯一公式风险维（process）。
 *
 * 方法学：
 *   - 引擎侧：直接调用真实 Agent（material/labor/process/design/finance），
 *     与线上报告同一计算路径，不重写公式。
 *   - 参照侧：case.actual 为用户提供的真实工厂报价拆解（五个维度金额 + 总价）；
 *     缺失维度不报错、不误报越界（amtDevPct/ratioDevPp=null）。
 *   - 半拆解锚定：锚（meta.paperPricePerTon 等）必须来自**独立外部参考**，
 *     不得用引擎自身查表，否则循环论证；缺失则退化引擎值并标记"未独立锚定"。
 *   - 越界判定：分维度 |金额偏差%| > DIM_AMT_THRESHOLD(默认15%) 或
 *     |占比偏差 pp| > RATIO_PP_THRESHOLD(默认8pp) 即视为越界，需复核对应常数。
 *
 * 运行：
 *   npm run test:calibration:real            # 读 calibration-cases.json（缺则回退 example 并提示）
 *   npm run test:calibration:real <path>     # 指定案例文件
 *
 * 输出：
 *   · 控制台摘要（越界项 ANSI 红色）
 *   · cost-calibration-real.md（含逐案例对照表 + 偏差解读与反向调参指引）
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  materialAgent,
  laborAgent,
  processAgent,
  designAgent,
  financeAgent,
} from "@/lib/agents/specialists";
import { deriveAnalysisContext } from "@/lib/agents/analysis-context";
import { getMaterialPrice } from "@/lib/knowledge-base";
import { LABOR_BASE_PER_PIECE } from "@/lib/cost-rules";
import type { AnalysisInput } from "@/types";

// ===== 阈值（可按需调整）=====
const DIM_AMT_THRESHOLD = 15; // 分维度金额偏差超 ±15% 视为越界
const RATIO_PP_THRESHOLD = 8; // 占比偏差超 ±8 个百分点视为越界
const TOTAL_TARGET = 10; // 总价目标收敛 ±10%

// ===== 五维顺序（与引擎 dimension 键一致）=====
const DIM_KEYS = [
  "material",
  "labor",
  "process",
  "design_plate",
  "finance_other",
] as const;
type DimKey = (typeof DIM_KEYS)[number];

interface ActualLabor {
  total: number;
  unit?: number;
  hours?: number;
  hourlyRate?: number;
  headcount?: number;
  setupHours?: number;
  note?: string;
}
interface CalCase {
  caseId: string;
  input: AnalysisInput;
  actual: Partial<Record<DimKey | "total", number>>;
  actualLabor?: ActualLabor;
  /**
   * 锚（ANCHOR）必须来自**独立外部参考**，不得用引擎自身查表，否则构成循环论证：
   *   - paperPricePerTon：纸商/纸价行情给你的实际纸价（元/吨），用于锚定材料维（占比最大）。
   *   - laborRatePerPiece：市场/该厂实际计件工价（元/个），用于锚定人工维。
   *   - plateCost：实际制版/刀模费（元），锚定 design_plate。
   *   - financeTotal：实际管理+利润+物流合计（元），锚定 finance_other。
   * 任一缺失 → 该维退化为"引擎自身值"（已标记未独立锚定，残差不计入该维校验）。
   */
  meta?: {
    supplier?: string;
    date?: string;
    note?: string;
    paperPricePerTon?: number;
    laborRatePerPiece?: number;
    plateCost?: number;
    financeTotal?: number;
  };
}

// ===== 跑引擎（与 calibration-test.ts 同源）=====
function runEngine(input: AnalysisInput) {
  const ctx = deriveAnalysisContext(input);
  const mat = materialAgent(ctx);
  const lab = laborAgent(ctx);
  const proc = processAgent(ctx);
  const des = designAgent(ctx);
  const fin = financeAgent(
    ctx,
    mat.estimatedAmount + lab.estimatedAmount + proc.estimatedAmount + des.estimatedAmount
  );
  const rows = [mat, lab, proc, des, fin];
  const total = rows.reduce((s, r) => s + r.estimatedAmount, 0);
  const qty = Number(input.quantity);
  const ratioOf = (a: number) => (total > 0 ? Math.round((a / total) * 1000) / 10 : 0);
  return {
    dims: rows.map((r) => ({
      dim: r.dimension as DimKey,
      label: r.dimensionLabel,
      amount: Math.round(r.estimatedAmount * 100) / 100,
      ratio: ratioOf(r.estimatedAmount),
    })),
    total: Math.round(total * 100) / 100,
    unit: Math.round((total / qty) * 10000) / 10000,
    qty,
  };
}

const pct = (a: number, b: number) =>
  b === 0 ? "—" : (((a - b) / b) * 100).toFixed(1) + "%";
const pctNum = (a: number, b: number) => (b === 0 ? NaN : ((a - b) / b) * 100);
const round2 = (a: number) => Math.round(a * 100) / 100;

// ===== ANSI 红 =====
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const red = (s: string) => `${RED}${s}${RESET}`;

// ===== 读取案例 =====
const argvPath = process.argv[2];
const root = process.cwd();
const userPath = argvPath ? resolve(root, argvPath) : resolve(root, "calibration-cases.json");
const examplePath = resolve(root, "calibration-cases.example.json");
let casePath = userPath;
if (!existsSync(userPath)) {
  if (!argvPath) {
    console.log(
      `⚠️ 未找到 calibration-cases.json（回退读取 example 模板）。\n` +
        `   请复制 calibration-cases.example.json 为 calibration-cases.json 并填入真实案例后重跑。\n`
    );
    casePath = examplePath;
  } else {
    console.error(`❌ 找不到案例文件：${userPath}`);
    process.exit(1);
  }
}
const raw = JSON.parse(readFileSync(casePath, "utf8")) as CalCase[];
if (!Array.isArray(raw) || raw.length === 0) {
  console.error("❌ 案例文件为空或格式错误");
  process.exit(1);
}

// ===== 计算偏差 =====
interface DimRow {
  dim: DimKey;
  label: string;
  engAmt: number;
  actAmt: number | null;
  amtDevPct: number | null;
  engRatio: number;
  actRatio: number | null;
  ratioDevPp: number | null;
  out: boolean;
}
const cases = raw.map((c) => {
  const eng = runEngine(c.input);
  const actTotal = c.actual.total ?? NaN;
  const actUnit = isNaN(actTotal) ? NaN : actTotal / eng.qty;

  const dims: DimRow[] = DIM_KEYS.map((k) => {
    const engRow = eng.dims.find((d) => d.dim === k)!;
    const actAmt = c.actual[k];
    const engAmt = engRow.amount;
    const amtDevPct =
      typeof actAmt === "number" && actAmt !== 0 ? pctNum(engAmt, actAmt) : null;
    const actRatio =
      typeof actAmt === "number" && !isNaN(actTotal) && actTotal !== 0
        ? Math.round((actAmt / actTotal) * 1000) / 10
        : null;
    const ratioDevPp =
      actRatio !== null ? Math.round((engRow.ratio - actRatio) * 10) / 10 : null;
    const out =
      (amtDevPct !== null && Math.abs(amtDevPct) > DIM_AMT_THRESHOLD) ||
      (ratioDevPp !== null && Math.abs(ratioDevPp) > RATIO_PP_THRESHOLD);
    return {
      dim: k,
      label: engRow.label,
      engAmt,
      actAmt: typeof actAmt === "number" ? actAmt : null,
      amtDevPct: amtDevPct === null ? null : Math.round(amtDevPct * 10) / 10,
      engRatio: engRow.ratio,
      actRatio,
      ratioDevPp,
      out,
    };
  });

  const totalDevPct = isNaN(actTotal) ? null : pctNum(eng.total, actTotal);
  const unitDevPct = isNaN(actUnit) ? null : pctNum(eng.unit, actUnit);
  const totalInTarget =
    totalDevPct !== null && Math.abs(totalDevPct) <= TOTAL_TARGET;
  const outDims = dims.filter((d) => d.out).map((d) => d.label);

  // ===== 半拆解锚定：材料自锚 + 残差隔离（仅标定 process 这一维公式风险）=====
  // 前提：锚来自**独立外部参考**（纸商报价/市场工价），不得用引擎自身查表，否则循环论证。
  const dimAmt = (k: DimKey) => eng.dims.find((d) => d.dim === k)!.amount;
  const engMat = dimAmt("material");
  const engLab = dimAmt("labor");
  const engDes = dimAmt("design_plate");
  const engFin = dimAmt("finance_other");
  const engProc = dimAmt("process");

  // 材料锚：外部纸价 / KB纸价 缩放引擎材料（面积/损耗与价格无关，线性缩放精确）
  const kbPrice =
    getMaterialPrice(String(c.input.material ?? ""), String(c.input.grammage ?? "")).value || 1;
  const paperPrice = c.meta?.paperPricePerTon;
  const anchorMaterial = paperPrice ? round2(engMat * (paperPrice / kbPrice)) : engMat;
  const materialAnchored = typeof paperPrice === "number";
  // 人工锚：外部工价 / 基准工价 缩放（近似，不含独立糊盒/换线项，仅作量级锚）
  const laborRate = c.meta?.laborRatePerPiece;
  const anchorLabor = laborRate ? round2(engLab * (laborRate / LABOR_BASE_PER_PIECE)) : engLab;
  const laborAnchored = typeof laborRate === "number";
  // 设计/财务锚（若提供外部凭证）
  const plateCost = c.meta?.plateCost;
  const anchorDesign = typeof plateCost === "number" ? plateCost : engDes;
  const designAnchored = typeof plateCost === "number";
  const financeTotal = c.meta?.financeTotal;
  const anchorFinance = typeof financeTotal === "number" ? financeTotal : engFin;
  const financeAnchored = typeof financeTotal === "number";

  // 残差隔离：实际总价 − 已锚定项 = 加工费残差（标定的就是 process 这一维）
  let residualProcess: number | null = null;
  let processDevPct: number | null = null;
  if (!isNaN(actTotal)) {
    const anchoredSum = anchorMaterial + anchorLabor + anchorDesign + anchorFinance;
    residualProcess = round2(actTotal - anchoredSum);
    processDevPct = pctNum(residualProcess, engProc);
  }
  const anchoredCount =
    [materialAnchored, laborAnchored, designAnchored, financeAnchored].filter(Boolean).length;
  // 残差仅在"足够多维被外部锚定"时才隔离出干净的加工费信号；否则残差含未锚定维误差，
  // 甚至（全无锚时）等于"引擎加工费 + 总价估算误差"，不可作加工费校准信号。
  const processIsolated = anchoredCount >= 3;

  return {
    caseId: c.caseId,
    meta: c.meta,
    eng,
    actTotal,
    actUnit,
    totalDevPct: totalDevPct === null ? null : Math.round(totalDevPct * 10) / 10,
    unitDevPct: unitDevPct === null ? null : Math.round(unitDevPct * 10) / 10,
    totalInTarget,
    dims,
    outDims,
    anchor: {
      material: anchorMaterial,
      labor: anchorLabor,
      design: anchorDesign,
      finance: anchorFinance,
      residualProcess,
      processDevPct: processDevPct === null ? null : Math.round(processDevPct * 10) / 10,
      materialAnchored,
      laborAnchored,
      designAnchored,
      financeAnchored,
      anchoredCount,
      processIsolated,
    },
  };
});

// ===== 控制台输出 =====
console.log("\n########## 真实案例偏差校准（引擎估算 vs 工厂实际报价） ##########");
console.log(`案例文件：${casePath}`);
console.log(`案例数：${cases.length}  阈值：金额±${DIM_AMT_THRESHOLD}% / 占比±${RATIO_PP_THRESHOLD}pp / 总价目标±${TOTAL_TARGET}%\n`);

for (const c of cases) {
  console.log(`【${c.caseId}】`);
  const tShow =
    c.totalDevPct === null
      ? "实际总价缺失"
      : `总价偏差 ${pct(c.eng.total, c.actTotal)}` +
        (c.totalInTarget ? "  ✅" : red("  ❌超目标"));
  console.log(
    `  引擎总价 ¥${c.eng.total} / 单价 ¥${c.eng.unit}` +
      (isNaN(c.actTotal) ? "" : `  | 实际总价 ¥${c.actTotal} / 单价 ¥${c.actUnit}`) +
      `  | ${tShow}`
  );
  for (const d of c.dims) {
    const actAmtStr = d.actAmt === null ? "—" : `¥${d.actAmt}`;
    const amtDevStr = d.amtDevPct === null ? "—" : pct(d.engAmt, d.actAmt ?? NaN);
    const ratioStr =
      d.actRatio === null
        ? `引擎${d.engRatio}% / 实际—`
        : `引擎${d.engRatio}% / 实际${d.actRatio}% (Δ${d.ratioDevPp}pp)`;
    const line = `    · ${d.label.padEnd(10)} 引擎¥${d.engAmt} / 实际${actAmtStr}  金额偏差 ${amtDevStr}  | ${ratioStr}`;
    console.log(d.out ? red(line + "  ⚠️越界") : line);
  }
  // 半拆解锚定展示（材料自锚 + 残差隔离）
  const a = c.anchor;
  const engProcAmt = c.eng.dims.find((d) => d.dim === "process")!.amount;
  const ancFlag =
    a.anchoredCount > 0 ? `（已独立锚定 ${a.anchoredCount}/4 维）` : "（未做独立锚定，残差不校验）";
  console.log(`  ─ 半拆解锚定 ${ancFlag}`);
  console.log(
    `    材料锚 ¥${a.material}${a.materialAnchored ? " ✓外部纸价" : " ✗引擎值"} | 人工锚 ¥${a.labor}${a.laborAnchored ? " ✓" : " ✗"} | 设计锚 ¥${a.design}${a.designAnchored ? " ✓" : " ✗"} | 财务锚 ¥${a.finance}${a.financeAnchored ? " ✓" : " ✗"}`
  );
  if (a.residualProcess !== null) {
    const rpLine = `    加工费残差 ¥${a.residualProcess}  vs 引擎加工费 ¥${engProcAmt}`;
    if (!a.processIsolated) {
      const reason =
        a.anchoredCount === 0
          ? "=引擎值+总价误差，不反映加工费"
          : `仅锚定 ${a.anchoredCount}/4 维，含未锚定维误差，仅参考`;
      console.log(`${rpLine}  （未隔离：${reason}）`);
    } else {
      const rpWithDev =
        a.processDevPct === null
          ? rpLine
          : rpLine + `  偏差 ${(a.processDevPct > 0 ? "+" : "") + a.processDevPct}%`;
      console.log(
        a.processDevPct !== null && Math.abs(a.processDevPct) > DIM_AMT_THRESHOLD
          ? red(rpWithDev + "  ⚠️加工费常数待标定")
          : rpWithDev
      );
    }
  } else {
    console.log("    加工费残差：实际总价缺失，无法隔离");
  }
  console.log("");
}

// 汇总越界维度
const offCount: Record<string, number> = {};
for (const c of cases) for (const d of c.dims) if (d.out) offCount[d.label] = (offCount[d.label] || 0) + 1;
const inTargetCount = cases.filter((c) => c.totalInTarget).length;
console.log("===== 汇总 =====");
console.log(`总价落入 ±${TOTAL_TARGET}% 目标：${inTargetCount}/${cases.length} 例`);
console.log("分维度越界频次（按频率）：");
const sortedOff = Object.entries(offCount).sort((a, b) => b[1] - a[1]);
if (sortedOff.length === 0) console.log("  （无系统性越界维度）");
else for (const [label, n] of sortedOff) console.log(red(`  ${label}: ${n}/${cases.length} 例越界`));

// 半拆解锚定汇总
const anchoredCases = cases.filter((c) => c.anchor.anchoredCount > 0);
const matAnchoredCases = cases.filter((c) => c.anchor.materialAnchored);
console.log("");
console.log("===== 半拆解锚定汇总（材料自锚 + 残差隔离）=====");
console.log(`做过独立锚定的案例：${anchoredCases.length}/${cases.length} 例`);
console.log(`其中材料维用外部纸价锚定：${matAnchoredCases.length}/${cases.length} 例`);
if (matAnchoredCases.length === 0) {
  console.log(
    red(
      "  ⚠️ 无任何案例提供外部纸价锚（meta.paperPricePerTon）。当前残差=引擎值，校验不成立——请至少补纸价锚。"
    )
  );
}
const procOut = cases.filter(
  (c) =>
    c.anchor.processIsolated &&
    c.anchor.processDevPct !== null &&
    Math.abs(c.anchor.processDevPct) > DIM_AMT_THRESHOLD
);
if (procOut.length > 0) {
  console.log(red(`  加工费残差超 ±${DIM_AMT_THRESHOLD}% 待标定（已隔离案例）：${procOut.map((c) => c.caseId).join("、")}`));
} else if (anchoredCases.length > 0) {
  console.log(`  加工费残差均在 ±${DIM_AMT_THRESHOLD}% 内（已隔离案例）。`);
}

// ===== 生成 Markdown 报告 =====
const RED_HTML = '<span style="color:#d23;font-weight:600">';
const CLOSE = "</span>";
const redCell = (s: string) => `${RED_HTML}${s}${CLOSE}`;
const cell = (s: string, out: boolean) => (out ? redCell(s) : s);

const L: string[] = [];
L.push(`# 真实案例偏差校准报告（引擎估算 vs 工厂实际报价）\n`);
L.push(`> 生成时间：${new Date().toISOString().slice(0, 19).replace("T", " ")}  `);
L.push(`> 案例文件：${casePath.replace(resolve(root), ".")}（共 ${cases.length} 例）`);
L.push(
  `> 阈值：分维度金额偏差 ±${DIM_AMT_THRESHOLD}% 或 占比偏差 ±${RATIO_PP_THRESHOLD}pp 视为越界；总价目标收敛 ±${TOTAL_TARGET}%。`
);
L.push(`> 引擎侧走**真实 Agent 计算路径**（与线上报告一致），不重写公式。\n`);

L.push(`## 总览\n`);
L.push(`- 校准案例数：**${cases.length}**`);
L.push(`- 总价落入 ±${TOTAL_TARGET}% 目标：**${inTargetCount}/${cases.length}** 例`);
L.push(
  `- 系统性越界维度：${
    sortedOff.length === 0
      ? "无"
      : sortedOff.map(([l, n]) => `${l}(${n}例)`).join("、")
  }`
);
L.push(
  `- 说明：越界 = 引擎与实际在该维度偏差超阈值，提示**该维度常数需复核**；越界次数高仅代表该维度系统性偏离，不直接等于"引擎错"。\n`
);

L.push(`## 逐案例总览\n`);
L.push(
  `| 案例 | 引擎总价 | 实际总价 | 总价偏差 | 引擎单价 | 实际单价 | 单价偏差 | 越界维度 |`
);
L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const c of cases) {
  const tDev = c.totalDevPct === null ? "—" : pct(c.eng.total, c.actTotal);
  const uDev = c.unitDevPct === null ? "—" : pct(c.eng.unit, c.actUnit);
  const outCell = c.outDims.length ? redCell(c.outDims.join("、")) : "—";
  L.push(
    `| ${c.caseId} | ¥${c.eng.total} | ${
      isNaN(c.actTotal) ? "—" : "¥" + c.actTotal
    } | ${tDev} | ¥${c.eng.unit} | ${
      isNaN(c.actUnit) ? "—" : "¥" + c.actUnit
    } | ${uDev} | ${outCell} |`
  );
}
L.push("");

L.push(`## 分维度对照（引擎 vs 实际）\n`);
for (const c of cases) {
  L.push(`### ${c.caseId}${c.meta?.supplier ? `（${c.meta.supplier}）` : ""}\n`);
  L.push(
    `| 维度 | 引擎(¥) | 实际(¥) | 金额偏差 | 引擎占比 | 实际占比 | 占比偏差(pp) |`
  );
  L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const d of c.dims) {
    const amtDev = d.amtDevPct === null ? "—" : pct(d.engAmt, d.actAmt ?? NaN);
    const ratioDev = d.ratioDevPp === null ? "—" : `${d.ratioDevPp > 0 ? "+" : ""}${d.ratioDevPp}`;
    const amtCell = cell(`¥${d.engAmt} / ${d.actAmt === null ? "—" : "¥" + d.actAmt}`, d.out);
    const devCell = cell(`${amtDev}`, d.out);
    const ratioCell = cell(
      `${d.engRatio}% / ${d.actRatio === null ? "—" : d.actRatio + "%"} (Δ${ratioDev})`,
      d.out
    );
    L.push(
      `| ${d.label} | ¥${d.engAmt} | ${d.actAmt === null ? "—" : "¥" + d.actAmt} | ${devCell} | ${d.engRatio}% | ${
        d.actRatio === null ? "—" : d.actRatio + "%"
      } | ${ratioCell} |`
    );
  }
  L.push("");
}

L.push(`## 半拆解校准（材料自锚 + 残差隔离）\n`);
L.push(
  `> 解决"供应商报价不拆五维"的校准缺口：**材料维用外部纸价锚定**（面积/损耗与价格无关，线性缩放精确），其余已锚定项从实际总价扣除，剩余即**加工费残差**——专门标定唯一公式风险维（process）。\n`
);
L.push(
  `> **前提（防循环论证）**：锚（paperPricePerTon / laborRatePerPiece / plateCost / financeTotal）必须来自**独立外部参考**（纸商报价/市场工价），不得用引擎自身查表。缺失则退化引擎值并标记"未独立锚定"，该维不计入残差校验。\n`
);
L.push(
  `| 案例 | 材料锚(¥) | 人工锚(¥) | 设计锚(¥) | 财务锚(¥) | 加工费残差(¥) | 引擎加工费(¥) | 残差偏差 | 锚定维度 |`
);
L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const c of cases) {
  const a = c.anchor;
  const dev = a.processDevPct === null ? "—" : `${a.processDevPct > 0 ? "+" : ""}${a.processDevPct}%`;
  const devCell =
    a.processIsolated && a.processDevPct !== null && Math.abs(a.processDevPct) > DIM_AMT_THRESHOLD
      ? redCell(dev)
      : dev;
  const anchoredTags = [
    a.materialAnchored ? "材料✓" : "材料✗",
    a.laborAnchored ? "人工✓" : "人工✗",
    a.designAnchored ? "设计✓" : "设计✗",
    a.financeAnchored ? "财务✓" : "财务✗",
  ].join(" ");
  const resCell = a.residualProcess === null ? "—" : `¥${a.residualProcess}`;
  L.push(
    `| ${c.caseId} | ¥${a.material} | ¥${a.labor} | ¥${a.design} | ¥${a.finance} | ${resCell} | ¥${c.eng.dims.find((d) => d.dim === "process")!.amount} | ${devCell} | ${anchoredTags} |`
  );
}
L.push("");
L.push(
  `> 读表：加工费残差偏差超 ±${DIM_AMT_THRESHOLD}% → 引擎加工费常数系统性偏离，优先复核印刷/表面/刀模费率（见下节）。**残差仅在锚定≥3/4维时才隔离出干净加工费信号**：锚定<3维时残差含未锚定维误差（仅参考）；全无锚时残差=引擎值+总价误差，**该行不具校验意义**。\n`
);

L.push(`## 偏差解读与反向调参指引\n`);
L.push(
  `> 目标：把估算从「经验合理」收敛到「可报价级准确」（总价 ±10%）。越界维度 → 定位对应常数 → 调后重跑。\n`
);
L.push(`### 逐维度对应常数（越界时改这里）\n`);
L.push(`| 维度 | 引擎偏差含义 | 优先复核常数（位置：src/lib/cost-rules、knowledge-base） |`);
L.push(`| --- | --- | --- |`);
L.push(
  `| 材料成本 | 引擎占比/金额偏高→纸价表或克重映射/油墨系数偏高；偏低→反之 | \`MATERIAL_PRICES\` / \`getMaterialPrice\`、克重档位映射、\`getDynamicLossRate\` 损耗率、**油墨 \`INK_CMYK_*\`/\`INK_SPOT_*\`（经知识库 \`ink:*\` 覆盖，现计入材料维度）** |`
);
L.push(
  `| 人工成本 | 偏高→基准单价或地域系数高；偏低→反之 | \`LABOR_BASE_PER_PIECE\`、\`LABOR_GLUING_PER_PIECE\`、\`LABOR_SETUP_HOURS\`（换线）、\`getRegionMultiplier\`（地域系数，仅作用于人工） |`
);
L.push(
  `| 加工费（含设备） | 偏高→印刷/表面/刀模系数高；偏低→反之 | 印刷 \`PRINT_MIN_CHARGE\`（开机托底）、表面 \`SURFACE_TREATMENT_RATES\`、\`DIE_FORM_COST\`、烫金覆盖率 \`SURFACE_COVERAGE_LEVELS\`、设备开机/专色洗车项（油墨已移至材料维度） |`
);
L.push(
  `| 设计与制版成本 | 占比高多为**固定费正常现象**（小批量尤甚）；仅当绝对值偏离该厂实际时调 | 设计费基数、版费（刀模/烫金版）、打样费；\`provideReadyDesign\` 减免逻辑 |`
);
L.push(
  `| 财务与其他成本 | 偏高→管理/利润/物流率高；偏低→反之 | 管理费率、利润率、\`LOGISTICS_RATES\`（当前按 subtotal%，未按体积重/实重）、包装辅材费率 |`
);
L.push("");
L.push(`### 怎么读这张表（三步）\n`);
L.push(
  `1. **先看总价偏差**：≤ ±10% 即达到可报价级，不必逐维度纠结。多数维度此消彼长，总价对即可接受。`
);
L.push(
  `2. **总价超标再看"越界维度"**：红色单元格 = 该维度引擎与实际偏差超阈值。集中在某一维度 → 该维度常数是主因。`
);
L.push(
  `3. **反推方向**：引擎金额 > 实际 → 该维度常数偏大，下调；引擎金额 < 实际 → 常数偏小，上调。用 \`金额偏差%\` 量级估调整幅度（如偏高 +25%，先把对应常数 ×0.8 试跑）。`
);
L.push("");
L.push(
  `> 提示：设计/制版是固定费，小批量下占比天然高（15–35% 正常），勿误判为越界；真实差距在**绝对额**是否贴合该厂。\n`
);

L.push(`## 下一步\n`);
L.push(
  `1. 攒满 10–20 例覆盖 彩盒/瓦楞/精品盒/不同地域，重跑本脚本取系统性偏差。`
);
L.push(`2. 越界维度集中 → 调对应常数 → 重跑直到总价 ±10%。`);
L.push(`3. 长期（路线图三期）：用真实纸价 API、多地域费率、企业成交价库替换静态假设，消除残余偏差。`);
L.push("");

const md = L.join("\n");
const outMd = resolve(root, "cost-calibration-real.md");
writeFileSync(outMd, md, "utf8");
console.log(`\n报告已写入：${outMd}`);
