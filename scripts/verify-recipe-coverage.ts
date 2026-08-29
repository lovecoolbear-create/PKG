/**
 * 配方覆盖率自检（F3/F4 搬迁验收）
 * ----------------------------------------------------------------
 * 黄金基线「零漂移」只证明数值没变，**不能**证明数值是配方算出来的：
 * 配方求值失败会静默回退硬编码，结果同样零漂移 —— 迁移看起来成功，其实一行没生效。
 *
 * 本脚本用同一批黄金用例跑真实引擎，逐维度检查：
 *   1. 该维度是否真的被配方覆盖（breakdown 项标记 note="配方驱动"）；
 *   2. basis 里是否出现「⚠️ 成本配方不可用」回退痕迹；
 *   3. 汇总每个维度在 9 个用例中的配方覆盖情况。
 *
 * 任一维度出现回退 → 退出码 1。
 *
 * 用法：npx tsx scripts/verify-recipe-coverage.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import type { AiSettings } from "@/lib/config/ai-settings";
import type { AnalysisInput } from "@/types";

const AI_OFF: AiSettings = { provider: "disabled", baseUrl: "", apiKey: "", modelName: "" };
const CASES_PATH = path.join(process.cwd(), "scripts/golden-cases.json");

const DIMENSIONS = ["material", "labor", "process", "design_plate", "finance_other"] as const;
const RECIPE_NOTE = "配方驱动";
const FALLBACK_MARK = "成本配方不可用";

interface GoldenCase {
  id: string;
  name: string;
  productType: string;
  input: AnalysisInput;
}

async function main() {
  const cases: GoldenCase[] = JSON.parse(readFileSync(CASES_PATH, "utf8")).cases;
  console.log(`配方覆盖率自检：${cases.length} 个黄金用例 × ${DIMENSIONS.length} 个维度\n`);

  /** 维度 → 被配方驱动的用例数 */
  const covered: Record<string, number> = {};
  const problems: string[] = [];

  for (const c of cases) {
    const config = getProductConfig(c.productType);
    if (!config) throw new Error(`未知品类：${c.productType}（用例 ${c.id}）`);
    const report = await runOrchestrator({
      sessionId: `coverage-${c.id}`,
      config,
      input: c.input,
      skippedKeys: [],
      aiSettings: AI_OFF,
    });
    const marks: string[] = [];

    for (const dim of DIMENSIONS) {
      const d = report.dimensions.find((x) => x.dimension === dim);
      if (!d) {
        problems.push(`[${c.id}] 维度 ${dim} 缺失`);
        continue;
      }
      const fellBack = d.basis.some((b) => b.includes(FALLBACK_MARK));
      const byRecipe =
        !fellBack && (d.breakdown ?? []).length > 0 && (d.breakdown ?? []).every((l) => l.note === RECIPE_NOTE);

      if (fellBack) {
        const why = d.basis.find((b) => b.includes(FALLBACK_MARK)) ?? "";
        problems.push(`[${c.id}] 维度 ${dim} 配方求值失败并回退硬编码：${why}`);
      }
      if (byRecipe) covered[dim] = (covered[dim] ?? 0) + 1;
      marks.push(`${dim}=${byRecipe ? "配方" : fellBack ? "回退!" : "硬编码"}`);
    }
    console.log(`▸ ${c.id.padEnd(24)} ${marks.join("  ")}`);
  }

  console.log("\n维度覆盖汇总：");
  for (const dim of DIMENSIONS) {
    const n = covered[dim] ?? 0;
    const flag = n === cases.length ? "✅" : n === 0 ? "❌" : "🟡";
    console.log(`  ${flag} ${dim.padEnd(14)} ${n}/${cases.length} 用例由配方驱动`);
  }

  if (problems.length) {
    console.error(`\n❌ 发现 ${problems.length} 处问题：`);
    for (const p of problems) console.error(`   ${p}`);
    process.exit(1);
  }

  const allFull = DIMENSIONS.every((d) => (covered[d] ?? 0) === cases.length);
  if (!allFull) {
    console.error("\n❌ 存在未被配方覆盖的维度（配方缺失或明细未走配方路径）");
    process.exit(1);
  }
  console.log("\n✅ 五个维度在全部用例中均由配方驱动，无静默回退");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
