import { prisma } from "@/lib/db";
import { getDefaultProductType } from "@/config/products";
import { colorPrintBoxConfig } from "@/config/products/color-print-box";
import {
  MATERIAL_PRICES,
  PRINT_BASE_RATES,
  SURFACE_TREATMENT_RATES,
  CMYK_PLATE_COST,
  SPOT_COLOR_PLATE_COST,
  SPOT_COLOR_SETUP_COST,
  FLUTE_MOUNTING_RATE,
  LOGISTICS_RATES,
  FLUTE_TYPES,
} from "@/lib/cost-rules";
import { LABOR_REGIONS } from "@/lib/cost-rules/labor-regions";

export async function seedDatabase() {
  const config = colorPrintBoxConfig;

  await prisma.productType.upsert({
    where: { code: config.code },
    update: {
      name: config.name,
      description: config.description,
      config: JSON.stringify(config),
    },
    create: {
      code: config.code,
      name: config.name,
      description: config.description,
      config: JSON.stringify(config),
    },
  });

  // Seed basic cost rules
  const rules = [
    {
      productType: "color_print_box",
      dimension: "material",
      name: "材料成本公式",
      formula: "weight * pricePerTon / 1000 * discount",
      parameters: JSON.stringify({ wasteRate: 0.08 }),
    },
    {
      productType: "color_print_box",
      dimension: "process",
      name: "工艺加工公式",
      formula: "printCost + surfaceCost + dieCutCost + gluingCost",
      parameters: JSON.stringify({}),
    },
  ];

  for (const rule of rules) {
    const existing = await prisma.costRule.findFirst({
      where: { productType: rule.productType, dimension: rule.dimension, name: rule.name },
    });
    if (!existing) {
      await prisma.costRule.create({ data: rule });
    }
  }

  // 知识库：把成本领域权威参数（材料价/工艺费率/地域费率）灌入 KnowledgeEntry
  await seedKnowledgeBase();
}

/**
 * 将硬编码的成本领域参数迁移为可由 KnowledgeEntry 管理的知识条目（幂等）。
 * 之后成本引擎会优先读取这些条目，缺失时回退代码常量。
 */
export async function seedKnowledgeBase() {
  type SeedEntry = {
    category: string;
    key: string;
    value: Record<string, unknown>;
    tags: string[];
  };

  const entries: SeedEntry[] = [];

  // 1) 材料单价（元/吨）
  for (const [material, grams] of Object.entries(MATERIAL_PRICES)) {
    for (const [g, price] of Object.entries(grams)) {
      entries.push({
        category: "material_price",
        key: `${material}:${g}`,
        value: { value: price, material, grammage: g, unit: "元/吨" },
        tags: [material, `${g}g`],
      });
    }
  }

  // 2) 工艺/费用费率（process_rate）
  for (const [m, rate] of Object.entries(PRINT_BASE_RATES)) {
    entries.push({
      category: "process_rate",
      key: `print:${m}`,
      value: { value: rate, unit: "元/色/千印" },
      tags: ["print", m],
    });
  }
  for (const [s, rate] of Object.entries(SURFACE_TREATMENT_RATES)) {
    entries.push({
      category: "process_rate",
      key: `surface:${s}`,
      value: { value: rate, unit: "元/m²" },
      tags: ["surface", s],
    });
  }
  entries.push({
    category: "process_rate",
    key: "plate_cmyk",
    value: { value: CMYK_PLATE_COST, unit: "元/版" },
    tags: ["plate"],
  });
  entries.push({
    category: "process_rate",
    key: "plate_spot",
    value: { value: SPOT_COLOR_PLATE_COST, unit: "元/版" },
    tags: ["plate", "spot"],
  });
  entries.push({
    category: "process_rate",
    key: "spot_color_setup",
    value: { value: SPOT_COLOR_SETUP_COST, unit: "元/专色" },
    tags: ["spot"],
  });
  entries.push({
    category: "process_rate",
    key: "flute_mounting_rate",
    value: { value: FLUTE_MOUNTING_RATE, unit: "元/m²" },
    tags: ["flute", "mounting"],
  });
  for (const [code, f] of Object.entries(FLUTE_TYPES)) {
    if (code === "none") continue;
    entries.push({
      category: "process_rate",
      key: `flute:${code}`,
      value: { value: f.flutePricePerTon, fluteGrammage: f.fluteGrammage, unit: "元/吨" },
      tags: ["flute", code],
    });
  }

  // 3) 地域费率（labor_rate：人工基础费率 + 物流费率）
  for (const [code, r] of Object.entries(LABOR_REGIONS)) {
    entries.push({
      category: "labor_rate",
      key: `region:${code}`,
      value: { value: r.baseRate, unit: "元/小时" },
      tags: ["region", code],
    });
  }
  for (const [code, rate] of Object.entries(LOGISTICS_RATES)) {
    entries.push({
      category: "labor_rate",
      key: `logistics:${code}`,
      value: { value: rate, unit: "费率" },
      tags: ["logistics", code],
    });
  }

  for (const e of entries) {
    const existing = await prisma.knowledgeEntry.findFirst({
      where: { category: e.category, key: e.key },
    });
    if (!existing) {
      await prisma.knowledgeEntry.create({
        data: {
          category: e.category,
          key: e.key,
          value: JSON.stringify(e.value),
          source: "import",
          confidence: 70,
          tags: JSON.stringify(e.tags),
        },
      });
    }
  }
}

export async function ensureProductType() {
  const config = getDefaultProductType();
  let pt = await prisma.productType.findUnique({ where: { code: config.code } });
  if (!pt) {
    await seedDatabase();
    pt = await prisma.productType.findUnique({ where: { code: config.code } });
  }
  return pt!;
}
