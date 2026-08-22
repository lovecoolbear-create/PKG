import { seedDatabase, ensureProductType } from "@/lib/seed";

async function main() {
  await seedDatabase();
  const pt = await ensureProductType();
  console.log("Seed 完成。产品类型:", pt?.code, "-", pt?.name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
