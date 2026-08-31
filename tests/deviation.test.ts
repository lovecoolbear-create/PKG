/**
 * 五维偏差热力图计算层单测
 * ----------------------------------------------------------------
 * 这一层的定位是「确定性数值」，和 5 个 specialist 一样不允许交给 AI，
 * 所以必须有可复现的断言：偏差口径、色阶分级、同批中位数、降级返回 null。
 */
import {
  buildDeviationHeatmap,
  amountLevel,
  customerUnitPrice,
  COHORT_MIN_ROWS,
} from "@/lib/import/deviation";
import type { ImportProductRow } from "@/lib/parse/import-shared";
import type { ProductTypeConfig } from "@/types";

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
function eq(a: unknown, b: unknown, msg: string) {
  assert(a === b, `${msg}（实际 ${String(a)}，期望 ${String(b)}）`);
}

type DimSpec = { key: string; amount: number; ratio: number };

function row(
  index: number,
  dims: DimSpec[],
  opts: {
    name?: string;
    quantity?: number;
    unitPrice?: number;
    totalPrice?: number;
    missing?: string[];
  } = {}
): ImportProductRow {
  return {
    index,
    name: opts.name ?? `产品${index + 1}`,
    input: { quantity: opts.quantity ?? 1000 } as ImportProductRow["input"],
    price:
      opts.unitPrice != null || opts.totalPrice != null
        ? { unitPrice: opts.unitPrice, totalPrice: opts.totalPrice, currency: "CNY" }
        : undefined,
    unmatched: [],
    notes: [],
    estimate: {
      perUnitMin: 4,
      perUnitMax: 6,
      perUnit: 5,
      totalMin: 4000,
      totalMax: 6000,
      confidence: 70,
      missingFields: opts.missing ?? [],
      dimensions: dims.map((d) => ({
        dimension: d.key,
        dimensionLabel: LABEL[d.key] ?? d.key,
        amount: d.amount,
        ratio: d.ratio,
      })),
    },
  };
}

const LABEL: Record<string, string> = {
  material: "材料成本",
  labor: "人工成本",
  process: "加工费（含设备）",
  design_plate: "设计与制版成本",
  finance_other: "财务与其他成本",
};

function cfg(
  dims: { key: string; label?: string; range?: [number, number]; order?: number }[]
): ProductTypeConfig {
  return {
    code: "t",
    name: "测试品类",
    dimensions: dims.map((d, i) => ({
      key: d.key,
      label: d.label ?? LABEL[d.key] ?? d.key,
      order: d.order ?? i + 1,
      expectedRatioRange: d.range,
    })),
  } as unknown as ProductTypeConfig;
}

const FULL_RANGES = [
  { key: "material", range: [35, 55] as [number, number] },
  { key: "labor", range: [10, 20] as [number, number] },
  { key: "process", range: [15, 30] as [number, number] },
  { key: "design_plate", range: [2, 8] as [number, number] },
  { key: "finance_other", range: [3, 10] as [number, number] },
];

const D = (key: string, amount: number, ratio: number): DimSpec => ({ key, amount, ratio });

console.log("1) 降级：无可用数据/无基准时不画");
{
  assert(buildDeviationHeatmap([], cfg(FULL_RANGES)) === null, "空行列表返回 null");

  const noEstimate = [{ ...row(0, [D("material", 100, 50)]), estimate: undefined }];
  assert(buildDeviationHeatmap(noEstimate, cfg(FULL_RANGES)) === null, "无估算结果返回 null");

  // 无预期区间 + 只有 2 行（不够同批中位数）→ 无基准，返回 null
  const noRange = cfg(FULL_RANGES.map((d) => ({ key: d.key })));
  const twoRows = [row(0, [D("material", 100, 50)]), row(1, [D("material", 200, 60)])];
  assert(
    buildDeviationHeatmap(twoRows, noRange) === null,
    `既无预期区间又不足 ${COHORT_MIN_ROWS} 行时返回 null`,
  );
  assert(
    buildDeviationHeatmap(twoRows, undefined) === null,
    "无品类配置且样本不足时返回 null",
  );
}

console.log("2) 基准选择：预期区间优先，缺失时退回同批中位数");
{
  const one = [row(0, [D("material", 100, 50), D("labor", 40, 20)])];
  const m1 = buildDeviationHeatmap(one, cfg(FULL_RANGES));
  eq(m1?.basis, "expected", "单行也能用预期区间作基准");
  eq(m1?.rows.length, 1, "单行模型有一行");
  eq(m1?.dimensions.length, 5, "维度列取品类配置全集（5 维）");

  const three = [
    row(0, [D("material", 100, 50)]),
    row(1, [D("material", 200, 60)]),
    row(2, [D("material", 300, 70)]),
  ];
  const m2 = buildDeviationHeatmap(three, cfg(FULL_RANGES.map((d) => ({ key: d.key }))));
  eq(m2?.basis, "cohort", "无预期区间且样本 >= 3 行时用同批中位数");
  eq(m2?.rows[0].cells[0].cohortMedian, 60, "同批中位数取中间值 60");
  eq(m2?.rows[2].cells[0].deviation, 10, "70% 相对中位 60% → +10pp");
  eq(m2?.rows[0].cells[0].deviation, -10, "50% 相对中位 60% → -10pp");
}

console.log("3) 偏差口径：以预期区间为界的单向偏离");
{
  const rows = [
    row(0, [
      D("material", 6000, 62), // 超上限 55 → +7
      D("labor", 1000, 10), // 恰在下限 → 0
      D("process", 1500, 15), // 恰在区间的下限 → 0
      D("design_plate", 300, 3), // 区间内 → 0
      D("finance_other", 1000, 10), // 恰在上限 → 0
    ]),
  ];
  const m = buildDeviationHeatmap(rows, cfg(FULL_RANGES))!;
  const byKey = Object.fromEntries(m.rows[0].cells.map((c) => [c.dimension, c]));
  eq(byKey.material.deviation, 7, "62% 超上限 55% → +7pp");
  eq(byKey.material.level, 2, "+7pp 落在 [5,10) 档 → level 2");
  eq(byKey.labor.deviation, 0, "贴下限不算偏差");
  eq(byKey.finance_other.deviation, 0, "贴上限不算偏差");
  eq(m.maxAbsDeviation, 7, "最大绝对偏差取全表最大");

  const low = [
    row(0, [
      D("material", 1000, 20), // 低于下限 35 → -15
      D("labor", 1000, 10),
      D("process", 1000, 15),
      D("design_plate", 1000, 3),
      D("finance_other", 1000, 10),
    ]),
  ];
  const m2 = buildDeviationHeatmap(low, cfg(FULL_RANGES))!;
  eq(m2.rows[0].cells[0].deviation, -15, "20% 低于下限 35% → -15pp");
  eq(m2.rows[0].cells[0].level, -3, "-15pp → level -3");
}

console.log("4) 色阶分级边界");
{
  const mk = (ratio: number) =>
    buildDeviationHeatmap(
      [
        row(0, [
          D("material", 1000, ratio),
          D("labor", 1000, 10),
          D("process", 1000, 15),
          D("design_plate", 1000, 3),
          D("finance_other", 1000, 10),
        ]),
      ],
      cfg(FULL_RANGES)
    )!.rows[0].cells[0];
  eq(mk(56.9).level, 0, "+1.9pp 视为噪声 → level 0");
  eq(mk(57.1).level, 1, "+2.1pp → level 1");
  eq(mk(60).level, 2, "+5pp → level 2");
  eq(mk(65).level, 3, "+10pp → level 3");
  eq(mk(33).level, -1, "-2pp → level -1");
  eq(mk(25).level, -3, "-10pp → level -3");
}

console.log("5) 单只金额 = 维度总量 / 数量，缺数量时按 1 只算");
{
  const m = buildDeviationHeatmap(
    [row(0, [D("material", 5000, 50)], { quantity: 2000 })],
    cfg(FULL_RANGES)
  )!;
  eq(m.rows[0].cells[0].perUnit, 2.5, "5000 元 / 2000 只 = 2.5 元/只");
  eq(m.rows[0].quantity, 2000, "数量透传");

  const bad = { ...row(0, [D("material", 5000, 50)]), input: { quantity: 0 } as never };
  const m2 = buildDeviationHeatmap([bad], cfg(FULL_RANGES))!;
  eq(m2.rows[0].cells[0].perUnit, 5000, "数量为 0 时按 1 只折算，不除零");
}

console.log("6) 缺失维度不参与异常排序");
{
  const rows = [
    row(0, [D("material", 3000, 60), D("labor", 1000, 20)]), // 少了 3 个维度
    row(1, [
      D("material", 3000, 40),
      D("labor", 1000, 12),
      D("process", 1000, 25),
      D("design_plate", 1000, 5),
      D("finance_other", 1000, 8),
    ]),
  ];
  const m = buildDeviationHeatmap(rows, cfg(FULL_RANGES))!;
  const r0 = m.rows[0].cells;
  eq(r0.find((c) => c.dimension === "process")?.absent, true, "缺失维度标记 absent");
  eq(r0.find((c) => c.dimension === "process")?.level, 0, "缺失维度不着色");
  assert(
    m.outliers.every((o) => o.dimension !== "process" || o.rowIndex !== 0),
    "缺失维度不进 Top 异常",
  );
}

console.log("7) 异常 Top3 按 |偏差| 降序、同偏差按金额降序");
{
  const rows = [
    row(0, [
      D("material", 3000, 90), // +35
      D("labor", 100, 1), // -9
      D("process", 100, 1),
      D("design_plate", 100, 1),
      D("finance_other", 100, 1),
    ]),
    row(1, [
      D("material", 1000, 40),
      D("labor", 1000, 25), // +5
      D("process", 1000, 15),
      D("design_plate", 1000, 5),
      D("finance_other", 1000, 5),
    ]),
  ];
  const m = buildDeviationHeatmap(rows, cfg(FULL_RANGES))!;
  assert(m.outliers.length <= 3, `异常最多 3 条（实际 ${m.outliers.length}）`);
  eq(m.outliers[0].dimension, "material", "最大偏差是材料维度");
  eq(m.outliers[0].rowIndex, 0, "最大偏差来自第 1 行");
  eq(m.outliers[0].direction, "high", "方向为高于基准");
  assert(
    m.outliers.every(
      (o, i, arr) => i === 0 || Math.abs(arr[i - 1].deviation) >= Math.abs(o.deviation)
    ),
    "异常列表按 |偏差| 降序",
  );
}

console.log("7.5) 同一维度只出一条异常 + 整批同向偏离提示");
{
  const rows = [
    row(0, [
      D("material", 3000, 90), // +35
      D("labor", 100, 1), // -9
      D("process", 100, 1), // -14
      D("design_plate", 100, 3),
      D("finance_other", 100, 5),
    ]),
    row(1, [
      D("material", 3000, 70), // +15
      D("labor", 100, 15),
      D("process", 100, 20),
      D("design_plate", 100, 5),
      D("finance_other", 100, 5),
    ]),
  ];
  const m = buildDeviationHeatmap(rows, cfg(FULL_RANGES))!;
  const dims = m.outliers.map((o) => o.dimension);
  eq(new Set(dims).size, dims.length, "Top 异常不含重复维度");
  eq(dims[0], "material", "最极端的维度排第一");
  eq(m.outliers.find((o) => o.dimension === "material")?.deviation, 35, "同维度取最极端的一条");

  const skew = m.cohortSkew.find((s) => s.dimension === "material");
  eq(skew?.direction, "high", "两行材料占比都超上限 → 判定为整批偏高");
  eq(skew?.count, 2, "统计参与行数");
  eq(skew?.avgDeviation, 25, "平均偏差 = (35+15)/2");
  assert(
    !m.cohortSkew.some((s) => s.dimension === "labor"),
    "不同向的维度不列为整批偏离",
  );

  // 两行反向 → 不列入整批偏离
  const mixed = buildDeviationHeatmap(
    [rows[0], row(1, [
      D("material", 3000, 20), // -15
      D("labor", 100, 15),
      D("process", 100, 20),
      D("design_plate", 100, 5),
      D("finance_other", 100, 5),
    ])],
    cfg(FULL_RANGES)
  )!;
  assert(
    !mixed.cohortSkew.some((s) => s.dimension === "material"),
    "两行反向偏离时不下「整批同向」结论",
  );
}

console.log("8) 客户单价与毛利率");
{
  eq(customerUnitPrice(row(0, [], { unitPrice: 6 })), 6, "优先取单价列");
  eq(
    customerUnitPrice({ ...row(0, [], { totalPrice: 6000 }), input: { quantity: 1200 } as never }),
    5,
    "无单价时按总价/数量折算",
  );
  eq(customerUnitPrice(row(0, [])), undefined, "无价格返回 undefined");

  const m = buildDeviationHeatmap(
    [row(0, [D("material", 3000, 50)], { unitPrice: 10, quantity: 1000 })],
    cfg(FULL_RANGES)
  )!;
  eq(m.rows[0].customerUnit, 10, "客户单价进模型");
  eq(m.rows[0].ourUnit, 5, "我方单只取区间中值");
  eq(m.rows[0].delta, 5, "差额 = 客户价 − 我方");
  eq(m.rows[0].margin, 50, "毛利率 = 差额 / 客户价");
}

console.log("9) 金额口径色阶");
{
  eq(amountLevel(0, 10), 0, "0 元不着色");
  eq(amountLevel(0.9, 3), 0, "低于 1/3 阈值 → level 0");
  eq(amountLevel(0.98, 3), 0, "0.33 阈值以下 → level 0");
  eq(amountLevel(1, 3), 1, "达到 1/3 → level 1");
  eq(amountLevel(1.1, 3), 1, "略超 1/3 → level 1");
  eq(amountLevel(2, 3), 2, "2/3 → level 2");
  eq(amountLevel(3, 3), 3, "取该列最大值 → level 3");
  eq(amountLevel(5, 0), 0, "全列为 0 时不做归一化（除零保护）");
}

console.log("10) 确定性：同输入两次结果完全一致");
{
  const rows = [
    row(0, [
      D("material", 3000, 58),
      D("labor", 900, 18),
      D("process", 1200, 14),
      D("design_plate", 300, 6),
      D("finance_other", 200, 4),
    ]),
    row(1, [
      D("material", 2500, 46),
      D("labor", 1000, 19),
      D("process", 1500, 25),
      D("design_plate", 300, 6),
      D("finance_other", 200, 4),
    ]),
  ];
  const a = buildDeviationHeatmap(rows, cfg(FULL_RANGES));
  const b = buildDeviationHeatmap(rows, cfg(FULL_RANGES));
  assert(JSON.stringify(a) === JSON.stringify(b), "两次构建结果逐字节一致");
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
