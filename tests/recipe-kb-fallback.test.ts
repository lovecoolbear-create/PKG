/**
 * 配方 KB 引用回退 + 条件事实完整性测试（F3/F4 搬迁踩坑防回归）
 * ----------------------------------------------------------------
 * 锁住 material / labor / process 三维度搬迁时实测踩出的两类**静默归零**故障：
 *
 * 【坑 1】通用 kb 引用缺基准常量回退 → 成本塌成 0
 *   硬编码 Agent 走 getMaterialPrice / getFlutePrice / getProcessRate 等类型化 getter，
 *   知识库无条目时回退 cost-rules 代码常量（唯一真相源）。
 *   而配方里的 `{ kb: "material_price:white_card:350" }` 原先只经 getKbNumber，
 *   知识库为空时吃调用方 fallback（默认 0）→ 面纸成本直接算成 0，且 issues 为空、
 *   配方"求值成功"，静默少算 90%。修复：resolveNum 增加 referenceFallback 兜底。
 *
 * 【坑 2】kb 键少写分类前缀 → 同样静默归零
 *   `{ kb: "surface:{surface}" }` 会被切成 category="surface" / key="matte_laminate"，
 *   而真实分类是 process_rate、键才是 surface:matte_laminate。分类不存在 → 0。
 *   本测试用真实键值断言两者都能取到非 0，防止再写错前缀。
 *
 * 【坑 3】factsOf 漏字段 → 条件恒不成立、成本项被整条丢掉
 *   专色调色费/专色油墨的适用条件是 spotColors > 0，但 factsOf 早期未暴露 spotColors，
 *   条件判定拿到 undefined → 恒假 → 明细里直接少两项（黄金基线出现 -150/-300 偏差）。
 *   本测试断言 factsOf 必须包含条件里用到的关键事实。
 */

import { referenceFallback } from "@/lib/knowledge-base";
import { resolveNum } from "@/lib/cost-formula";
import { factsOf } from "@/lib/cost-formula/engine-bridge";
import { deriveAnalysisContext } from "@/lib/agents/analysis-context";
import {
  MATERIAL_PRICES,
  FLUTE_TYPES,
  CORRUGATED_LINER_PRICES,
  CORRUGATED_FLUTING_PRICES,
  INK_CMYK_PRICE_PER_KG,
  SURFACE_TREATMENT_RATES,
  LOGISTICS_RATES,
} from "@/lib/cost-rules";
import { LABOR_REGIONS } from "@/lib/cost-rules/labor-regions";
import type { AnalysisInput } from "@/types";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  check(name, got === want, `期望 ${String(want)}，实际 ${String(got)}`);
}

function main() {
  console.log("\n=== 坑 1/2：通用 kb 引用的基准常量回退 ===");

  // 卡纸单价
  eq(
    "material_price:white_card:350 → MATERIAL_PRICES 常量",
    referenceFallback("material_price", "white_card:350"),
    MATERIAL_PRICES.white_card["350"]
  );
  eq(
    "未知材质/克重 → 兜底 5500（不为 0）",
    referenceFallback("material_price", "nonexistent:999"),
    5500
  );

  // 瓦楞多层
  eq(
    "material_price:corr_liner:kraft:175 → CORRUGATED_LINER_PRICES",
    referenceFallback("material_price", "corr_liner:kraft:175"),
    CORRUGATED_LINER_PRICES.kraft["175"]
  );
  eq(
    "material_price:corr_fluting:120 → CORRUGATED_FLUTING_PRICES",
    referenceFallback("material_price", "corr_fluting:120"),
    CORRUGATED_FLUTING_PRICES["120"]
  );

  // 坑纸单价走 process_rate:flute:*
  eq(
    "process_rate:flute:E_flute → FLUTE_TYPES.flutePricePerTon",
    referenceFallback("process_rate", "flute:E_flute"),
    FLUTE_TYPES.E_flute.flutePricePerTon
  );

  // 工艺/油墨/表面（PROCESS_RATE_FALLBACK 一族）
  eq(
    "process_rate:ink:cmyk_price_per_kg → 油墨单价常量",
    referenceFallback("process_rate", "ink:cmyk_price_per_kg"),
    INK_CMYK_PRICE_PER_KG
  );
  eq(
    "process_rate:surface:matte_laminate → 表面处理费率常量",
    referenceFallback("process_rate", "surface:matte_laminate"),
    SURFACE_TREATMENT_RATES.matte_laminate
  );

  // 人工/物流
  eq(
    "labor_rate:region:east_china → LABOR_REGIONS.baseRate",
    referenceFallback("labor_rate", "region:east_china"),
    LABOR_REGIONS.east_china.baseRate
  );
  eq(
    "labor_rate:logistics:south_china → LOGISTICS_RATES",
    referenceFallback("labor_rate", "logistics:south_china"),
    LOGISTICS_RATES.south_china
  );

  check(
    "未知分类 → undefined（不硬造数）",
    referenceFallback("market_price", "whatever") === undefined
  );

  console.log("\n=== resolveNum 优先级：显式 fallback > 基准常量 > 缺省值 ===");

  eq(
    "无显式 fallback 的 kb 引用 → 取基准常量（而非 0）",
    resolveNum({ kb: "material_price:white_card:350" }, 0, {}),
    MATERIAL_PRICES.white_card["350"]
  );
  eq(
    "显式 fallback 优先于基准常量（保留既有配方语义）",
    resolveNum({ kb: "material_price:white_card:350", fallback: 1 }, 0, {}),
    1
  );
  eq(
    "占位符插值后再查基准常量",
    resolveNum({ kb: "material_price:{material}:{grammage}" }, 0, {
      material: "coated_paper",
      grammage: "300",
    }),
    MATERIAL_PRICES.coated_paper["300"]
  );
  eq(
    "分类前缀写错（surface:xxx）→ 无基准常量，回落缺省值",
    resolveNum({ kb: "surface:matte_laminate" }, 0, {}),
    0
  );
  check(
    "写对分类前缀（process_rate:surface:xxx）→ 拿到非 0 费率",
    resolveNum({ kb: "process_rate:surface:matte_laminate" }, 0, {}) > 0
  );

  console.log("\n=== 坑 3：factsOf 必须暴露条件用到的事实 ===");

  const input = {
    productType: "color_print_box",
    length: 200,
    width: 120,
    height: 60,
    quantity: 5000,
    material: "white_card",
    grammage: "350",
    printMethod: "offset",
    colorCount: "4",
    spotColorCount: 1,
    surface: "matte_laminate",
    boxType: "tuck_end",
    needGluing: true,
    delivery: "east_china",
    urgency: "standard",
  } as unknown as AnalysisInput;

  const ctx = deriveAnalysisContext(input);
  const facts = factsOf(ctx);

  // 配方 conditions 里实际引用到的字段，缺一个就会整条成本项被丢掉
  const REQUIRED_FACT_KEYS = [
    "productType",
    "material",
    "grammage",
    "coverGrammage",
    "surface",
    "printMethod",
    "binding",
    "boxType",
    "fluteType",
    "quantity",
    "needGluing",
    "provideReadyDesign",
    "urgency",
    "delivery",
    "windowFilmCostPerPiece",
    "cmykColors",
    "spotColors",
  ];
  for (const k of REQUIRED_FACT_KEYS) {
    check(`facts 含 ${k}`, k in facts, `factsOf 缺字段，相关条件会恒不成立`);
  }
  eq("facts.spotColors 透传输入值", facts.spotColors, 1);
  eq("facts.cmykColors 透传输入值", facts.cmykColors, 4);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main();
