/**
 * 真实案例偏差校准脚本（读 calibration-cases.json，走真实 Agent 路径）
 *
 * 用途：用户攒到 10–20 张真实工厂报价单后，跑第一轮校准——
 *   引擎估算 vs 工厂实际报价，输出：
 *     · 总单价偏差 / 总价偏差
 *     · 分维度金额偏差（引擎 vs 实际，每个维度元 + 百分比）
 *     · 分维度占比偏差（引擎占比% vs 实际占比%，百分点）
 *     · 越界项标红（金额偏差 |%| > 阈值 或 占比偏差 > 阈值）
 *
 * 方法学：
 *   - 引擎侧：直接调用真实 Agent（material/labor/process/design/finance），
 *     与线上报告同一计算路径，不重写公式。
 *   - 参照侧：case.actual 为用户提供的真实工厂报价拆解（五个维度金额 + 总价）。
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
  meta?: { supplier?: string; date?: string; note?: string };
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
