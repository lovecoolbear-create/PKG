/**
 * 成本配方求值器单元测试（F2）
 * ----------------------------------------------------------------
 * 覆盖 8 种结构化 kind、KB 引用与回退、条件判定、权重、以及
 * 「任一项不可求值则整组配方不可用」的失败安全语义。
 */
import {
  evalCostItem,
  evalRecipe,
  matchesConditions,
  resolveNum,
  validateCostItem,
  DEFAULT_EVAL_CONTEXT,
  type CostItemLike,
  type EvalContext,
} from "@/lib/cost-formula";
import { loadKnowledgeBase } from "@/lib/knowledge-base";

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
const approx = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

const ctx: EvalContext = {
  ...DEFAULT_EVAL_CONTEXT,
  quantity: 5000,
  areaM2: 0.12,
  netAreaM2: 0.1,
  surfaceAreaM2: 0.1,
  printAreaM2: 100,
  weightKg: 100,
  cmykColors: 4,
  spotColors: 1,
  bases: { manufacturing: 1000, subtotal: 1500 },
};

function item(name: string, kind: string, params: object, extra?: Partial<CostItemLike>): CostItemLike {
  return { name, kind, params: JSON.stringify(params), ...extra };
}

async function main() {
  // KB 引用测试需要预热知识库
  await loadKnowledgeBase();

  console.log("=== 成本配方求值器（F2）===\n");

  console.log("▸ 规格1：flat 固定金额");
  assert(evalCostItem(item("设计费", "flat", { amount: 800 }), ctx) === 800, "设计费 800");
  assert(evalCostItem(item("零", "flat", {}), ctx) === 0, "缺省 amount → 0");

  console.log("\n▸ 规格2：unit_rate 单价 × 件数");
  assert(
    approx(evalCostItem(item("模切", "unit_rate", { rate: 0.03 }), ctx) ?? -1, 150),
    "0.03 × 5000 = 150"
  );
  assert(
    approx(evalCostItem(item("模切", "unit_rate", { rate: 0.03, qty: 100 }), ctx) ?? -1, 3),
    "显式 qty=100 覆盖上下文数量 → 3"
  );

  console.log("\n▸ 规格3：area_rate 单价 × 面积");
  assert(
    approx(evalCostItem(item("覆膜", "area_rate", { rate: 0.45 }), ctx) ?? -1, 225),
    "0.45 × 0.1 × 5000 = 225"
  );
  assert(
    approx(
      evalCostItem(item("覆膜", "area_rate", { rate: 0.45, timesQuantity: false }), ctx) ?? -1,
      0.045
    ),
    "timesQuantity=false → 不乘数量 = 0.045"
  );

  console.log("\n▸ 规格4：weight_rate 重量 × 吨价 ÷ 1000");
  assert(
    approx(
      evalCostItem(item("面纸", "weight_rate", { weight: 100, pricePerTon: 5800 }), ctx) ?? -1,
      580
    ),
    "100kg × 5800 ÷ 1000 = 580"
  );
  assert(
    approx(
      evalCostItem(
        item("面纸", "weight_rate", { weight: 100, pricePerTon: 5800, discount: 0.9 }),
        ctx
      ) ?? -1,
      522
    ),
    "带 0.9 数量折扣 → 522"
  );

  console.log("\n▸ 规格5：ink_rate 面积 × 墨量 × 单价 ÷ 1000");
  assert(
    approx(
      evalCostItem(
        item("油墨", "ink_rate", { grammagePerM2: 1.8, pricePerKg: 45 }),
        ctx
      ) ?? -1,
      32.4
    ),
    "100 × 1.8 × 45 × 4色 ÷ 1000 = 32.4"
  );

  console.log("\n▸ 规格6：tiered 阶梯");
  {
    const tiers = [
      { upTo: 1000, rate: 1.2 },
      { upTo: 5000, rate: 1.0 },
      { upTo: null, rate: 0.9 },
    ];
    assert(
      approx(evalCostItem(item("印刷", "tiered", { tiers }), ctx) ?? -1, 5000),
      "5000 落第二档 → 1.0 × 5000 = 5000"
    );
    assert(
      approx(
        evalCostItem(item("印刷", "tiered", { tiers }), { ...ctx, quantity: 800 }) ?? -1,
        960
      ),
      "800 落第一档 → 1.2 × 800 = 960"
    );
    assert(
      approx(
        evalCostItem(item("印刷", "tiered", { tiers }), { ...ctx, quantity: 99999 }) ?? -1,
        89999.1
      ),
      "99999 落最后兜底档 → 0.9 × 99999"
    );
    assert(
      approx(
        evalCostItem(item("固定档", "tiered", { tiers, mode: "flat" }), ctx) ?? -1,
        1
      ),
      "mode=flat → 取档位固定值 1.0（不乘数量）"
    );
  }

  console.log("\n▸ 规格7：stepped 起步价 + 超出部分");
  assert(
    approx(
      evalCostItem(
        item("印刷起步", "stepped", { base: 300, baseIncludes: 1000, rate: 0.02 }),
        ctx
      ) ?? -1,
      380
    ),
    "300 + (5000−1000) × 0.02 = 380"
  );
  assert(
    approx(
      evalCostItem(
        item("印刷起步", "stepped", { base: 300, baseIncludes: 1000, rate: 0.02 }),
        { ...ctx, quantity: 500 }
      ) ?? -1,
      300
    ),
    "数量未超起步含 → 仅 300（不倒扣）"
  );

  console.log("\n▸ 规格8：percent_of 按基数百分比");
  assert(
    approx(
      evalCostItem(item("管理费", "percent_of", { base: "manufacturing", rate: 6 }), ctx) ?? -1,
      60
    ),
    "制造成本 1000 × 6% = 60"
  );
  assert(
    approx(
      evalCostItem(
        item("管理费", "percent_of", { base: "manufacturing", rate: 0.06, percent: false }),
        ctx
      ) ?? -1,
      60
    ),
    "rate=0.06 且 percent=false → 同样 60"
  );
  assert(
    evalCostItem(item("未知基数", "percent_of", { base: "nope", rate: 6 }), ctx) === 0,
    "基数不存在 → 0（不猜算）"
  );

  console.log("\n▸ 规格9：知识库引用与回退（数值不写死）");
  {
    const withKb = evalCostItem(
      item("制版费", "flat", { amount: { kb: "process_rate:plate_cmyk", fallback: 999 } }),
      ctx
    );
    assert(withKb === 350, `KB 命中 process_rate:plate_cmyk → 350（实际 ${withKb}）`);

    const withFallback = evalCostItem(
      item("未知项", "flat", {
        amount: { kb: "process_rate:__no_such_key__", fallback: 42 },
      }),
      ctx
    );
    assert(withFallback === 42, "KB 未命中 → 用 fallback 42");

    assert(resolveNum(7) === 7, "resolveNum 直接数字");
    assert(resolveNum(undefined, 5) === 5, "resolveNum 缺省值");
    assert(resolveNum({ fallback: 3 }) === 3, "resolveNum 仅 fallback");
  }

  console.log("\n▸ 规格10：条件判定与权重");
  {
    const conditional = item("坑纸", "weight_rate",
      { weight: 50, pricePerTon: 4000 },
      { conditions: JSON.stringify([{ field: "fluteType", op: "!=", value: "none" }]) }
    );
    assert(
      evalCostItem(conditional, ctx, { fluteType: "E_flute" }) === 200,
      "条件满足 → 50 × 4000 ÷ 1000 = 200"
    );
    assert(
      evalCostItem(conditional, ctx, { fluteType: "none" }) === 0,
      "条件不满足 → 0（该项不计）"
    );
    assert(
      evalCostItem(item("关", "flat", { amount: 100 }, { enabled: false }), ctx) === 0,
      "enabled=false → 0"
    );
    assert(
      evalCostItem(item("加权", "flat", { amount: 100 }, { weight: 0.8 }), ctx) === 80,
      "weight=0.8 → 80"
    );
    assert(
      matchesConditions(null, {}) && matchesConditions("[]", {}),
      "无条件/空条件 → 通过"
    );
    assert(matchesConditions("not a json", {}) === true, "条件解析失败 → 视为无限制");
  }

  console.log("\n▸ 规格11：失败安全（不猜算）");
  assert(
    evalCostItem(item("DSL", "formula", { expr: "a+b" }), ctx) === null,
    "kind=formula 未实现 → null（F6 实现）"
  );
  assert(
    evalCostItem(item("未知", "__nope__", {}), ctx) === null,
    "未知 kind → null"
  );

  console.log("\n▸ 规格12：整组配方求值");
  {
    const items = [
      item("面纸", "weight_rate", { weight: 100, pricePerTon: 5800 }),
      item("油墨", "ink_rate", { grammagePerM2: 1.8, pricePerKg: 45 }),
    ];
    const r = evalRecipe(items, ctx);
    assert(r !== null, "全部可求值 → 返回配方结果");
    if (r) {
      assert(approx(r.total, 612.4), `合计 580 + 32.4 = 612.4（实际 ${r.total}）`);
      assert(r.lines.length === 2, "逐项明细 2 行");
    }

    const withBad = [...items, item("坏项", "__nope__", {})];
    assert(evalRecipe(withBad, ctx) === null, "任一项不可求值 → 整组返回 null（交回退）");
    assert(evalRecipe([], ctx) === null, "空配方 → null");
  }

  console.log("\n▸ 规格13：上下文标量引用与 kb 占位符");
  {
    const byColors = evalCostItem(
      item("制版费CMYK", "unit_rate", {
        rate: { kb: "process_rate:plate_cmyk", fallback: 350 },
        qty: { ctx: "cmykColors" },
      }),
      ctx
    );
    assert(byColors === 1400, `KB价 350 × { ctx: cmykColors } 4 = 1400（实际 ${byColors}）`);

    const spot = evalCostItem(
      item("制版费专色", "unit_rate", {
        rate: { kb: "process_rate:plate_spot", fallback: 450 },
        qty: { ctx: "spotColors" },
      }),
      ctx
    );
    assert(spot === 450, `450 × { ctx: spotColors } 1 = 450（实际 ${spot}）`);

    // 占位符：按交付地域取对应物流费率
    const logistics = evalCostItem(
      item("物流", "percent_of", {
        base: "subtotal",
        rate: { kb: "labor_rate:logistics:{delivery}", fallback: 0.035 },
      }),
      ctx,
      { delivery: "east_china" }
    );
    assert(
      logistics !== null && approx(logistics, 45),
      `占位符取 east_china 费率 0.03 → 1500 × 0.03 = 45（实际 ${logistics}）`
    );

    const unknownRegion = evalCostItem(
      item("物流", "percent_of", {
        base: "subtotal",
        rate: { kb: "labor_rate:logistics:{delivery}", fallback: 0.035 },
      }),
      ctx,
      { delivery: "__nope__" }
    );
    assert(
      unknownRegion !== null && approx(unknownRegion, 52.5),
      `未知地域回退 0.035 → 1500 × 0.035 = 52.5（实际 ${unknownRegion}）`
    );
  }

  console.log("\n▸ 规格14：baseExpr 与本维度累计基数（self）");
  {
    const items = [
      item("物流", "percent_of", { base: "subtotal", rate: 3 }),
      item("管理费", "percent_of", { base: "subtotal", rate: 6 }),
      item("利润", "percent_of", { baseExpr: ["subtotal", "self"], rate: 8 }),
    ];
    const r = evalRecipe(items, ctx);
    assert(r !== null, "三项均可求值");
    if (r) {
      // subtotal=1500 → 物流 45、管理 90、利润 (1500 + 45 + 90) × 8% = 130.8 → 合计 265.8
      assert(approx(r.total, 265.8), `45 + 90 + 130.8 = 265.8（实际 ${r.total}）`);
    }
  }

  console.log("\n▸ 规格15：坏数据绝不静默算成 0（P0 回归防线）");
  {
    // 背景：早期实现里 parseParams 吞掉 JSON 异常返回 {}，坏 JSON 的成本项
    // 被当成「参数全缺省」算出 0 —— 报价少算 60% 且全程无提示。
    // 以下三条是那次事故的直接回归防线，删掉任何一条都可能让静默少算复活。
    const badParams: CostItemLike = { name: "制版费", kind: "unit_rate", params: "{bad json" };
    assert(evalCostItem(badParams, ctx) === null, "params 坏 JSON → null（不是 0）");

    const badConds: CostItemLike = {
      name: "制版费",
      kind: "flat",
      params: "{\"amount\":800}",
      conditions: "[not json",
    };
    assert(evalCostItem(badConds, ctx) === null, "conditions 坏 JSON → null（不是 800）");

    const issues: string[] = [];
    const r = evalRecipe(
      [
        item("设计费", "flat", { amount: 800 }),
        { name: "制版费 · CMYK", kind: "unit_rate", params: "{bad json" },
      ],
      ctx,
      {},
      issues
    );
    assert(r === null, "组内有一项坏 → 整组不可用（回退硬编码，不半配方算数）");
    assert(
      issues.length === 1 && issues[0].includes("制版费 · CMYK"),
      `失败项通过 issues 上报（实际 ${JSON.stringify(issues)}）`
    );
  }

  console.log("\n▸ 规格16：validateCostItem 静态校验（写库前置）");
  {
    assert(
      validateCostItem({ kind: "flat", params: "{\"amount\":800}" }) === null,
      "合法项通过"
    );
    assert(
      validateCostItem({ kind: "flat", params: "{bad json" })?.includes("参数不是合法 JSON") ===
        true,
      "params 坏 JSON 被拒"
    );
    assert(
      validateCostItem({
        kind: "flat",
        params: "{}",
        conditions: "[{\"field\":\"a\",\"op\":\"~=\",\"value\":1}]",
      })?.includes("不支持") === true,
      "非法条件运算符被拒"
    );
    assert(
      validateCostItem({ kind: "unit_rate", params: "{}" })?.includes("rate") === true,
      "unit_rate 缺 rate 被拒（否则会静默算 0）"
    );
    assert(
      validateCostItem({ kind: "percent_of", params: "{\"rate\":6}" })?.includes("base") === true,
      "percent_of 缺基数被拒"
    );
    assert(
      validateCostItem({ kind: "tiered", params: "{\"tiers\":[]}" })?.includes("非空数组") ===
        true,
      "tiered 空 tiers 被拒"
    );
    assert(
      validateCostItem({ kind: "unknown_kind", params: "{}" })?.includes("不支持的计算方式") ===
        true,
      "未知 kind 被拒"
    );
    assert(
      validateCostItem({ kind: "formula", params: "{}" })?.includes("expr") === true,
      "formula 缺 expr 被拒"
    );
    assert(
      validateCostItem({ kind: "flat", params: "[]" }) !== null,
      "params 为数组 → 不合法"
    );
    // 条件缺 field/op 也要被拒，否则 matchesConditions 会当成恒真
    assert(
      validateCostItem({ kind: "flat", params: "{}", conditions: "[{\"op\":\"==\"}]" }) !== null,
      "条件缺 field 被拒"
    );
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
