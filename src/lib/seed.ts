import { prisma } from "@/lib/db";
import { getDefaultProductType } from "@/config/products";
import { colorPrintBoxConfig } from "@/config/products/color-print-box";

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
