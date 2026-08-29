/**
 * 配方种子：把硬编码公式逐项搬迁为 CostItem（F3/F4 全套）
 * ----------------------------------------------------------------
 * 铁律：**搬迁只是换表达形式，绝不改变算法**。每次搬迁后必须跑
 *   npm run test:golden
 * 且 9 个黄金用例必须**零漂移**。若出现漂移，说明搬迁有误，回退重来。
 *
 * 幂等：按维度 × 品类先删后建，可重复执行。
 *
 * 进度：design_plate / finance_other 已迁（F3 早期）；本文件补全
 * labor / process / material 三维度（含彩盒/瓦楞/平面三品类分支）。
 *
 * 派生量来源：配方参数里的 { ctx: "xxx" } 引用 engine-bridge.buildEvalContext
 * 算好的 extra 桶（材料各层重量、地域系数、数量折扣、覆盖率、印刷单位费率等），
 * 价格/费率走 { kb: "..." } 占位符（material_price / process_rate / labor_rate）。
 * 全程结构化配方，未启用 DSL（FORMULA_DSL_ENABLED 保持关闭）。
 */

import { prisma } from "@/lib/db";

const PRODUCT_TYPES = ["color_print_box", "corrugated_box", "flat_print", "label"] as const;

interface SeedRow {
  name: string;
  kind: string;
  params: Record<string, unknown>;
  conditions?: Array<{ field: string; op: string; value: unknown }>;
  sortOrder: number;
  note?: string;
}

// ── 常量（与 cost-rules 对齐，价格走 KB，这里只放无 KB 的硬常量） ──────────
const DIE_FORM_COST = 200; // 一次性刀模费
const RIGID_GREY_BOARD_PRICE_PER_TON = 3800; // 灰板吨价（无 KB，纯常量）
const LABOR_BASE_PER_PIECE = 0.05; // 基础手工（检验/整理）元/个
const LABOR_GLUING_PER_PIECE = 0.025; // 糊盒元/个
const PRINT_MIN_CHARGE = 350; // 印刷起步开机费托底

// ══════════════════════════════════════════════════════════════════════════
// 人工维度 labor（box 与 flat 公式不同，按品类分支）
// ══════════════════════════════════════════════════════════════════════════

/** 彩盒/瓦楞·人工：手工操作(基准×复杂度×地域) + 糊盒(×地域) + 换线固定 */
const BOX_LABOR_ROWS: SeedRow[] = [
  {
    name: "手工操作（检验/整理）",
    kind: "unit_rate",
    params: {
      rate: LABOR_BASE_PER_PIECE,
      qty: { ctx: "quantity" },
      multiplier: { ctx: "laborMultiplier" },
    },
    sortOrder: 10,
    note: "基准 0.05 元/个 × 数量 × 盒型复杂度 × 地域系数",
  },
  {
    name: "糊盒（人工）",
    kind: "unit_rate",
    params: {
      rate: LABOR_GLUING_PER_PIECE,
      qty: { ctx: "quantity" },
      multiplier: { ctx: "regionMultiplier" },
    },
    conditions: [{ field: "needGluing", op: "==", value: true }],
    sortOrder: 20,
    note: "0.025 元/个 × 数量 × 地域系数",
  },
  {
    name: "换线/调机固定人工（简化）",
    kind: "flat",
    params: { amount: { ctx: "laborSetupCost" } },
    sortOrder: 30,
    note: "labor:setup_hours × 地域小时费率，不随数量变动",
  },
];

/** 平面彩印·人工：装订后道手工(×地域) + 换线固定 */
const FLAT_LABOR_ROWS: SeedRow[] = [
  {
    name: "装订手工（后道）",
    kind: "unit_rate",
    params: {
      rate: { ctx: "bindingLaborCostPerPiece" },
      qty: { ctx: "quantity" },
      multiplier: { ctx: "regionMultiplier" },
    },
    sortOrder: 10,
    note: "装订后道手工元/册 × 印量 × 地域系数",
  },
  {
    name: "换线/调机固定人工（简化）",
    kind: "flat",
    params: { amount: { ctx: "laborSetupCost" } },
    sortOrder: 30,
    note: "labor:setup_hours × 地域小时费率，不随数量变动",
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 加工费维度 process（box 与 flat 公式不同）
// ══════════════════════════════════════════════════════════════════════════

/** 彩盒/瓦楞·加工费：印刷(steped 托底) + 专色 + 表面 + 模切 + 贴窗 + 刀模 */
const BOX_PROCESS_ROWS: SeedRow[] = [
  {
    name: "印刷",
    kind: "stepped",
    params: {
      base: 0,
      baseIncludes: 0,
      rate: { ctx: "printUnitRate" },
      floor: { by: "printMethod", map: { digital: 0 }, fallback: PRINT_MIN_CHARGE },
    },
    sortOrder: 10,
    note: "(数量/1000)×色数×单价；非数码不低于起步开机费托底",
  },
  {
    name: "专色调色/洗车费",
    kind: "unit_rate",
    params: { rate: { kb: "process_rate:spot_color_setup" }, qty: { ctx: "spotColors" } },
    conditions: [{ field: "spotColors", op: ">", value: 0 }],
    sortOrder: 20,
    note: "专色数 × 调色洗车费率",
  },
  {
    name: "表面处理",
    kind: "area_rate",
    params: {
      rate: { kb: "process_rate:surface:{surface}" },
      area: { ctx: "surfaceAreaBasisM2" },
      multiplier: { ctx: "surfaceCoverage" },
    },
    sortOrder: 30,
    note: "覆盖率<1 按净面积局部计，满覆盖按生产面积",
  },
  {
    name: "模切",
    kind: "unit_rate",
    params: { rate: 0.015, qty: { ctx: "quantity" } },
    sortOrder: 40,
    note: "0.015 元/个（设备运行）",
  },
  {
    name: "贴窗胶片",
    kind: "unit_rate",
    params: { rate: { ctx: "windowFilmCostPerPiece" }, qty: { ctx: "quantity" } },
    conditions: [{ field: "windowFilmCostPerPiece", op: ">", value: 0 }],
    sortOrder: 50,
    note: "仅开窗盒有贴窗费",
  },
  {
    name: "刀模费（一次性）",
    kind: "flat",
    params: { amount: DIE_FORM_COST },
    sortOrder: 60,
    note: "钢刀模具制作费，不随数量变动",
  },
];

/** 平面彩印·加工费：印刷 + 专色 + 表面 + 装订设备（无刀模/模切/贴窗） */
const FLAT_PROCESS_ROWS: SeedRow[] = [
  {
    name: "印刷",
    kind: "stepped",
    params: {
      base: 0,
      baseIncludes: 0,
      rate: { ctx: "printUnitRate" },
      floor: { by: "printMethod", map: { digital: 0 }, fallback: PRINT_MIN_CHARGE },
    },
    sortOrder: 10,
    note: "(数量/1000)×色数×单价；非数码不低于起步开机费托底",
  },
  {
    name: "专色调色/洗车费",
    kind: "unit_rate",
    params: { rate: { kb: "process_rate:spot_color_setup" }, qty: { ctx: "spotColors" } },
    conditions: [{ field: "spotColors", op: ">", value: 0 }],
    sortOrder: 20,
    note: "专色数 × 调色洗车费率",
  },
  {
    name: "表面处理",
    kind: "area_rate",
    params: {
      rate: { kb: "process_rate:surface:{surface}" },
      area: { ctx: "surfaceAreaBasisM2" },
      multiplier: { ctx: "surfaceCoverage" },
    },
    sortOrder: 30,
    note: "平面彩印按单张净面积计",
  },
  {
    name: "装订设备费",
    kind: "unit_rate",
    params: { rate: { ctx: "bindingEquipCostPerPiece" }, qty: { ctx: "quantity" } },
    sortOrder: 40,
    note: "装订方式对应设备加工费元/册",
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 材料维度 material（三品类公式各异）
// ══════════════════════════════════════════════════════════════════════════

/** 彩盒·材料：面纸 + 坑纸/裱坑(可选) + 灰板(精品盒) + 油墨 */
const COLOR_BOX_MATERIAL_ROWS: SeedRow[] = [
  {
    name: "面纸",
    kind: "weight_rate",
    params: {
      weight: { ctx: "facePaperWeightKg" },
      pricePerTon: { kb: "material_price:{material}:{grammage}" },
      discount: { ctx: "quantityDiscount" },
    },
    sortOrder: 10,
    note: "面纸重量 × 吨价 ÷ 1000 × 数量折扣",
  },
  {
    name: "坑纸/底纸",
    kind: "weight_rate",
    params: {
      weight: { ctx: "fluteWeightKg" },
      pricePerTon: { kb: "process_rate:flute:{fluteType}" },
      discount: { ctx: "quantityDiscount" },
    },
    conditions: [{ field: "fluteType", op: "!=", value: "none" }],
    sortOrder: 20,
    note: "仅瓦楞彩盒（flute != none）",
  },
  {
    name: "裱坑加工费",
    kind: "area_rate",
    params: { rate: { kb: "process_rate:flute_mounting_rate" } },
    conditions: [{ field: "fluteType", op: "!=", value: "none" }],
    sortOrder: 30,
    note: "productionAreaM2 × 数量 × 裱坑费率",
  },
  {
    name: "灰板（精品盒）",
    kind: "weight_rate",
    params: {
      weight: { ctx: "greyBoardWeightKg" },
      pricePerTon: RIGID_GREY_BOARD_PRICE_PER_TON,
      discount: { ctx: "quantityDiscount" },
    },
    conditions: [{ field: "boxType", op: "==", value: "rigid_cover" }],
    sortOrder: 40,
    note: "仅精品盒（rigid_cover）",
  },
  {
    name: "油墨（CMYK）",
    kind: "ink_rate",
    params: {
      area: { ctx: "inkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:cmyk_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:cmyk_price_per_kg" },
      colors: 1,
    },
    sortOrder: 50,
    note: "印刷面积 × 墨量系数 × 单价（CMYK 不按色数倍增，与硬编码一致）",
  },
  {
    name: "油墨（专色）",
    kind: "ink_rate",
    params: {
      area: { ctx: "inkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:spot_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:spot_price_per_kg" },
      colors: { ctx: "spotColors" },
    },
    conditions: [{ field: "spotColors", op: ">", value: 0 }],
    sortOrder: 60,
    note: "专色按色数倍增",
  },
];

/** 瓦楞纸箱·材料：挂面纸(面+里+中) + 芯纸 + 油墨（多层复合，无裱坑/灰板） */
const CORRUGATED_MATERIAL_ROWS: SeedRow[] = [
  {
    name: "面纸/里纸（挂面纸）",
    kind: "weight_rate",
    params: {
      weight: { ctx: "linerWeightKg" },
      pricePerTon: { kb: "material_price:corr_liner:{linerMaterial}:{linerGrammage}" },
      discount: { ctx: "quantityDiscount" },
    },
    sortOrder: 10,
    note: "挂面纸(含中纸)重量 × 挂面吨价 ÷ 1000 × 数量折扣",
  },
  {
    name: "芯纸（瓦楞）",
    kind: "weight_rate",
    params: {
      weight: { ctx: "fluteWeightKg" },
      pricePerTon: { kb: "material_price:corr_fluting:{fluteGrammage}" },
      discount: { ctx: "quantityDiscount" },
    },
    sortOrder: 20,
    note: "芯纸重量 × 芯纸吨价 ÷ 1000 × 数量折扣",
  },
  {
    name: "油墨（CMYK）",
    kind: "ink_rate",
    params: {
      area: { ctx: "inkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:cmyk_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:cmyk_price_per_kg" },
      colors: 1,
    },
    sortOrder: 50,
    note: "印刷面积 × 墨量系数 × 单价",
  },
  {
    name: "油墨（专色）",
    kind: "ink_rate",
    params: {
      area: { ctx: "inkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:spot_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:spot_price_per_kg" },
      colors: { ctx: "spotColors" },
    },
    conditions: [{ field: "spotColors", op: ">", value: 0 }],
    sortOrder: 60,
    note: "专色按色数倍增",
  },
];

/** 平面彩印·材料：内页纸 + 封面纸(可选) + 油墨 */
const FLAT_MATERIAL_ROWS: SeedRow[] = [
  {
    name: "内页纸张",
    kind: "weight_rate",
    params: {
      weight: { ctx: "flatInnerPaperWeightKg" },
      pricePerTon: { kb: "material_price:{material}:{innerGrammage}" },
      discount: { ctx: "quantityDiscount" },
    },
    sortOrder: 10,
    note: "内页重量 × 吨价 ÷ 1000 × 数量折扣",
  },
  {
    name: "封面纸张",
    kind: "weight_rate",
    params: {
      weight: { ctx: "flatCoverPaperWeightKg" },
      pricePerTon: { kb: "material_price:{material}:{coverGrammage}" },
      discount: { ctx: "quantityDiscount" },
    },
    conditions: [{ field: "coverGrammage", op: "!=", value: "" }],
    sortOrder: 20,
    note: "仅带封面的装订方式",
  },
  {
    name: "油墨（CMYK）",
    kind: "ink_rate",
    params: {
      area: { ctx: "flatInkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:cmyk_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:cmyk_price_per_kg" },
      colors: 1,
    },
    sortOrder: 50,
    note: "单张印刷面积 × 墨量系数 × 单价",
  },
  {
    name: "油墨（专色）",
    kind: "ink_rate",
    params: {
      area: { ctx: "flatInkAreaM2" },
      grammagePerM2: { kb: "process_rate:ink:spot_grammage_per_m2" },
      pricePerKg: { kb: "process_rate:ink:spot_price_per_kg" },
      colors: { ctx: "spotColors" },
    },
    conditions: [{ field: "spotColors", op: ">", value: 0 }],
    sortOrder: 60,
    note: "专色按色数倍增",
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 已迁维度（F3 早期，三品类通用）
// ══════════════════════════════════════════════════════════════════════════

const DESIGN_PLATE_ROWS: SeedRow[] = [
  {
    name: "制版费 · CMYK",
    kind: "unit_rate",
    params: { rate: { kb: "process_rate:plate_cmyk", fallback: 350 }, qty: { ctx: "cmykColors" } },
    conditions: [{ field: "printMethod", op: "!=", value: "digital" }],
    sortOrder: 10,
    note: "原 plateCmykCost = getProcessRate('plate_cmyk')，现引用知识库",
  },
  {
    name: "制版费 · 专色",
    kind: "unit_rate",
    params: { rate: { kb: "process_rate:plate_spot", fallback: 450 }, qty: { ctx: "spotColors" } },
    conditions: [{ field: "printMethod", op: "!=", value: "digital" }],
    sortOrder: 20,
    note: "专色版费高于 CMYK；原 plateSpotCost",
  },
  {
    name: "设计费",
    kind: "flat",
    params: { amount: 800 },
    conditions: [{ field: "provideReadyDesign", op: "==", value: false }],
    sortOrder: 30,
    note: "客户提供完稿文件时减免为 0",
  },
  {
    name: "打样费 · 小批量",
    kind: "flat",
    params: { amount: 300 },
    conditions: [{ field: "quantity", op: "<", value: 5000 }],
    sortOrder: 40,
    note: "quantity < 5000 → 300",
  },
  {
    name: "打样费 · 大批量",
    kind: "flat",
    params: { amount: 150 },
    conditions: [{ field: "quantity", op: ">=", value: 5000 }],
    sortOrder: 50,
    note: "quantity >= 5000 → 150",
  },
];

const FINANCE_ROWS: SeedRow[] = [
  {
    name: "物流",
    kind: "percent_of",
    params: { base: "subtotal", rate: { kb: "labor_rate:logistics:{delivery}", fallback: 0.035 } },
    sortOrder: 10,
    note: "按交付地域取费率（KB labor_rate:logistics:{delivery}）",
  },
  {
    name: "包装辅材",
    kind: "unit_rate",
    params: { rate: 0.008 },
    sortOrder: 20,
    note: "0.008 元/个",
  },
  {
    name: "管理费",
    kind: "percent_of",
    params: { base: "subtotal", rate: 6 },
    sortOrder: 30,
    note: "占比可直接改（用户决策：百分比可编辑）",
  },
  {
    name: "合理利润",
    kind: "percent_of",
    params: { base: "subtotal", baseLines: ["物流", "管理费"], rate: 8 },
    sortOrder: 40,
    note: "利润基数 = 小计 + 物流 + 管理费（不含包装辅材）",
  },
  {
    name: "加急溢价",
    kind: "percent_of",
    params: {
      base: "subtotal",
      rate: { by: "urgency", map: { standard: 0, urgent: 7.5, express: 15 }, fallback: 0 },
    },
    sortOrder: 50,
    note: "由 URGENCY_MULTIPLIER 换算：(mult−1)×0.5",
  },
];

/** 维度 → 各品类配方行 */
const DIMENSION_ROWS: Record<string, Record<string, SeedRow[]>> = {
  design_plate: {
    color_print_box: DESIGN_PLATE_ROWS,
    corrugated_box: DESIGN_PLATE_ROWS,
    flat_print: DESIGN_PLATE_ROWS,
    label: DESIGN_PLATE_ROWS,
  },
  finance_other: {
    color_print_box: FINANCE_ROWS,
    corrugated_box: FINANCE_ROWS,
    flat_print: FINANCE_ROWS,
    label: FINANCE_ROWS,
  },
  labor: {
    color_print_box: BOX_LABOR_ROWS,
    corrugated_box: BOX_LABOR_ROWS,
    flat_print: FLAT_LABOR_ROWS,
    label: FLAT_LABOR_ROWS,
  },
  process: {
    color_print_box: BOX_PROCESS_ROWS,
    corrugated_box: BOX_PROCESS_ROWS,
    flat_print: FLAT_PROCESS_ROWS,
    label: FLAT_PROCESS_ROWS,
  },
  material: {
    color_print_box: COLOR_BOX_MATERIAL_ROWS,
    corrugated_box: CORRUGATED_MATERIAL_ROWS,
    flat_print: FLAT_MATERIAL_ROWS,
    label: FLAT_MATERIAL_ROWS,
  },
};

async function seedDimension(dimension: string, rowsByType: Record<string, SeedRow[]>) {
  let total = 0;
  for (const pt of PRODUCT_TYPES) {
    const rows = rowsByType[pt] ?? [];
    // 幂等：先清掉该维度该品类的旧配方
    await prisma.costItem.deleteMany({ where: { dimension, productType: pt } });
    for (const r of rows) {
      await prisma.costItem.create({
        data: {
          productType: pt,
          dimension,
          name: r.name,
          kind: r.kind,
          params: JSON.stringify(r.params),
          conditions: r.conditions ? JSON.stringify(r.conditions) : null,
          sortOrder: r.sortOrder,
          weight: 1,
          enabled: true,
          status: "active",
          note: r.note ?? null,
        },
      });
      total++;
    }
  }
  console.log(`✓ ${dimension}：${PRODUCT_TYPES.length} 品类 × 共 ${total} 行`);
}

async function main() {
  console.log("开始写入配方种子（labor / process / material 全套）...\n");
  for (const dim of Object.keys(DIMENSION_ROWS)) {
    await seedDimension(dim, DIMENSION_ROWS[dim]);
  }
  console.log(`\n完成。当前 CostItem 总行数：${await prisma.costItem.count()}`);
  console.log("\n请立即验证零漂移：npm run test:golden");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
