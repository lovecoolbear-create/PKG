/**
 * 黄金基线回归（A1：改公式前的防回归保险）
 * ----------------------------------------------------------------
 * 用途：用固定输入跑真实成本引擎（runOrchestrator），把「五维数值 + 总成本 +
 * 单件价 + 整体置信度」与已提交的基线快照比对，防止改动公式/系数/费率后
 * 悄悄把别的品类算崩。
 *
 * 确定性前提（脚本会自检）：
 *  - aiSettings 强制 provider="disabled" → isLlmConfigured=false → 查价走本地基准、
 *    SQE 诊断/角色报告走模板回退，全程不联网、不调 LLM；
 *  - 未配置 PAPER_PRICE_API_KEY → fetcher 优雅回退本地基准（fetcher.ts:51）；
 *  - 快照剔除 generatedAt 等时间戳字段。
 *
 * 用法：
 *   npx tsx scripts/golden-regression.ts              比对（CI/日常用）
 *   npx tsx scripts/golden-regression.ts --update     重新生成基线（改动引擎后确认新值正确再执行）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import type { AiSettings } from "@/lib/config/ai-settings";
import type { AnalysisInput, AnalysisReport } from "@/types";

/** 强制关闭 AI：LLM 与联网查价全部走确定性回退 */
const AI_OFF: AiSettings = { provider: "disabled", baseUrl: "", apiKey: "", modelName: "" };

const CASES_PATH = path.join(process.cwd(), "scripts/golden-cases.json");
const BASELINE_PATH = path.join(process.cwd(), "scripts/golden-baseline.json");

/** 相对容差 0.5%（吸收浮点与四舍五入抖动），绝对下限 0.01 元（避免小额项被误判） */
const REL_TOL = 0.005;
const ABS_TOL = 0.01;

interface GoldenCase {
  id: string;
  name: string;
  productType: string;
  input: AnalysisInput;
}
interface Snapshot {
  dimensions: Record<string, number>;
  totalMin: number;
  totalMax: number;
  perUnitMin: number;
  perUnitMax: number;
  overallConfidence: number;
}
type Baseline = Record<string, Snapshot>;

const round = (n: number) => Math.round(n * 100) / 100;

function toSnapshot(r: AnalysisReport): Snapshot {
  const dimensions: Record<string, number> = {};
  for (const d of r.dimensions) dimensions[d.dimension] = round(d.estimatedAmount);
  return {
    dimensions,
    totalMin: round(r.totalCost.min),
    totalMax: round(r.totalCost.max),
    perUnitMin: round(r.totalCost.perUnit.min),
    perUnitMax: round(r.totalCost.perUnit.max),
    overallConfidence: r.overallConfidence,
  };
}

async function runCase(c: GoldenCase): Promise<Snapshot> {
  const config = getProductConfig(c.productType);
  if (!config) throw new Error(`未知品类：${c.productType}（用例 ${c.id}）`);
  const report = await runOrchestrator({
    sessionId: `golden-${c.id}`,
    config,
    input: c.input,
    skippedKeys: [],
    aiSettings: AI_OFF,
  });
  return toSnapshot(report);
}

const approx = (a: number, b: number) => Math.abs(a - b) <= Math.max(ABS_TOL, Math.abs(b) * REL_TOL);

function diffSnapshot(id: string, name: string, got: Snapshot, want: Snapshot): string[] {
  const problems: string[] = [];
  const keys = new Set([...Object.keys(want.dimensions), ...Object.keys(got.dimensions)]);
  for (const k of keys) {
    const w = want.dimensions[k];
    const g = got.dimensions[k];
    if (w == null) {
      problems.push(`维度 ${k} 为新增（基线中没有）`);
    } else if (g == null) {
      problems.push(`维度 ${k} 丢失（基线中有现在没了）`);
    } else if (!approx(g, w)) {
      const drift = w === 0 ? "∞" : `${(((g - w) / w) * 100).toFixed(2)}%`;
      problems.push(`维度 ${k}：期望 ${w} → 实际 ${g}（偏离 ${drift}）`);
    }
  }
  const scalars: [string, number, number][] = [
    ["总成本 min", got.totalMin, want.totalMin],
    ["总成本 max", got.totalMax, want.totalMax],
    ["单件价 min", got.perUnitMin, want.perUnitMin],
    ["单件价 max", got.perUnitMax, want.perUnitMax],
  ];
  for (const [label, g, w] of scalars) {
    if (!approx(g, w)) problems.push(`${label}：期望 ${w} → 实际 ${g}`);
  }
  if (got.overallConfidence !== want.overallConfidence) {
    problems.push(`整体置信度：期望 ${want.overallConfidence} → 实际 ${got.overallConfidence}`);
  }
  return problems.map((p) => `[${id} ${name}] ${p}`);
}

async function main() {
  const update = process.argv.includes("--update");

  if (process.env.PAPER_PRICE_API_KEY) {
    console.warn("⚠️  检测到 PAPER_PRICE_API_KEY，联网查价会破坏黄金基线确定性，建议回归时清空该变量。");
  }

  const cases: GoldenCase[] = JSON.parse(readFileSync(CASES_PATH, "utf8")).cases;
  console.log(`黄金基线回归：${cases.length} 个用例（${update ? "生成基线" : "比对模式"}）\n`);

  const snapshots: Baseline = {};
  const determinismIssues: string[] = [];

  for (const c of cases) {
    const first = await runCase(c);
    // 确定性自检：同一输入连跑两次必须完全一致，否则基线本身不可信
    const second = await runCase(c);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      determinismIssues.push(`[${c.id}] 两次运行结果不一致 → 引擎存在非确定性，黄金基线不成立`);
    }
    snapshots[c.id] = first;

    const dimStr = Object.entries(first.dimensions)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`▸ ${c.id}  ${c.name}`);
    console.log(`    ${dimStr}`);
    console.log(
      `    总成本 ${first.totalMin}~${first.totalMax} · 单件 ${first.perUnitMin}~${first.perUnitMax} · 置信度 ${first.overallConfidence}%`
    );
  }

  if (update) {
    writeFileSync(BASELINE_PATH, JSON.stringify(snapshots, null, 2) + "\n", "utf8");
    console.log(`\n✅ 基线已写入 ${path.relative(process.cwd(), BASELINE_PATH)}（请确认数值正确后再提交）`);
    if (determinismIssues.length) {
      console.log("\n⚠️  确定性自检未通过：");
      determinismIssues.forEach((d) => console.log("   " + d));
      process.exit(1);
    }
    console.log("✅ 确定性自检通过（每个用例连跑两次结果一致）");
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`\n❌ 基线文件不存在：${BASELINE_PATH}\n   先执行：npx tsx scripts/golden-regression.ts --update`);
    process.exit(1);
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const problems: string[] = [];
  const missing: string[] = [];

  for (const c of cases) {
    const want = baseline[c.id];
    if (!want) {
      missing.push(`[${c.id}] 基线中缺少该用例 → 需执行 --update`);
      continue;
    }
    problems.push(...diffSnapshot(c.id, c.name, snapshots[c.id], want));
  }

  problems.push(...determinismIssues, ...missing);

  console.log("");
  if (problems.length) {
    console.log(`❌ 回归失败，共 ${problems.length} 处偏差：`);
    problems.forEach((p) => console.log("   " + p));
    process.exit(1);
  }
  console.log(`✅ 黄金基线回归通过：${cases.length} 个用例全部吻合（容差 ${(REL_TOL * 100).toFixed(1)}%）`);
  console.log("✅ 确定性自检通过（每个用例连跑两次结果一致）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
