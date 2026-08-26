// P9 AI 降本规则闭环：纯逻辑单元测试（无 DB 依赖）
import {
  localEmbedder,
  cosine,
  deriveContext,
  pendingRuleToRuleTemplate,
  shouldDeprecate,
  rankByCosine,
  conflictRateOf,
  EMBED_DIM,
  TTL_DAYS,
  CONFLICT_RATE_THRESHOLD,
} from "@/lib/vave/rule-lifecycle";
import type { PendingRule } from "@/lib/vave/knowledge-distill";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}
function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function makeRule(over: Partial<PendingRule> = {}): PendingRule {
  return {
    id: "pr_test",
    title: "材料基准价经验修正",
    target: "material_price",
    description: "实际低于估算，疑似材料基准价偏高。",
    proposedValue: "材料吨价建议下调至当前的 92% 后复核",
    evidence: "估算 ¥2.0 vs 实际 ¥1.8",
    confidence: 62,
    source: "system",
    createdAt: new Date().toISOString(),
    status: "pending",
    ...over,
  };
}

console.log("== P9 规则闭环 · 纯逻辑测试 ==");

// ---- 规格3：本地确定性向量 ----
console.log("[规格3] localEmbedder / cosine");
{
  const e1 = localEmbedder("双坑降单坑降本");
  const e2 = localEmbedder("双坑降单坑降本");
  assert(e1.length === EMBED_DIM, "向量维度 = EMBED_DIM");
  assert(JSON.stringify(e1) === JSON.stringify(e2), "同一文本 → 完全确定（可复现）");
  const norm = Math.sqrt(e1.reduce((s, v) => s + v * v, 0));
  assert(approx(norm, 1), "L2 归一化（模长≈1）");
  assert(approx(cosine(e1, e2), 1), "相同向量余弦=1");
  const e3 = localEmbedder("完全不相关的另一主题 海运 湿度");
  assert(cosine(e1, e3) < cosine(e1, e2), "不同文本余弦 < 相同文本");
}

// ---- 规格3：元数据派生（确定性预过滤输入） ----
console.log("[规格3] deriveContext 元数据派生");
{
  const heavy = deriveContext(
    { fluteType: "double", linerMaterial: "kraft", stackLayers: 5, boxWeightKg: 15 } as any,
    "corrugated_box"
  );
  assert(heavy.boxType === "double_wall", "fluteType=double → boxType=double_wall");
  assert(heavy.material === "kraft", "linerMaterial 透传");
  assert(heavy.loadClass === "heavy", "5×15=75kg → heavy");

  const light = deriveContext(
    { fluteType: "single", linerMaterial: "recycled", stackLayers: 2, boxWeightKg: 5 } as any,
    "corrugated_box"
  );
  assert(light.boxType === "single_wall", "single → single_wall");
  assert(light.loadClass === "light", "2×5=10kg → light");

  const medium = deriveContext(
    { fluteType: "triple", stackLayers: 3, boxWeightKg: 10 } as any,
    "corrugated_box"
  );
  assert(medium.loadClass === "medium", "3×10=30kg → medium");
}

// ---- 规格1：LLM 提案 → 确定性规则模板 ----
console.log("[规格1] pendingRuleToRuleTemplate 确定性转换");
{
  const ctx = deriveContext(
    { fluteType: "double", linerMaterial: "kraft", stackLayers: 5, boxWeightKg: 15 } as any,
    "corrugated_box"
  );
  const r = makeRule({ target: "material_price", proposedValue: "材料吨价建议下调至当前的 92% 后复核" });
  const t1 = pendingRuleToRuleTemplate(r, ctx);
  const t2 = pendingRuleToRuleTemplate(r, ctx);
  assert(JSON.stringify(t1) === JSON.stringify(t2), "同输入 → 同输出（确定性）");
  assert(t1.status === "ACTIVE", "人工固化 → status=ACTIVE");
  const json = JSON.parse(t1.ruleJson);
  assert(json.kind === "kb_override", "material_price → kb_override");
  assert(json.category === "material_price", "category 映射正确");
  assert(json.action === "scale_by_ratio" && approx(json.ratio!, 0.92), "解析出 92% → ratio 0.92");
  assert(t1.embedding != null, "生成 embedding 向量");

  // grammage_floor → validation_floor
  const g = makeRule({ target: "grammage_floor", proposedValue: "克重下限设为 200" });
  const gt = pendingRuleToRuleTemplate(g, ctx);
  const gj = JSON.parse(gt.ruleJson);
  assert(gj.kind === "validation_floor", "grammage_floor → validation_floor");
  assert(gj.action === "set" && gj.value === 200, "解析出数值 200");

  // 无数字提案 → set 且无 value
  const o = makeRule({ target: "other", proposedValue: "复核损耗率" });
  const oj = JSON.parse(pendingRuleToRuleTemplate(o, ctx).ruleJson);
  assert(oj.action === "set" && oj.value === undefined, "无数字 → set 无 value");
}

// ---- 规格2：生命周期 TTL / 冲突率 ----
console.log("[规格2] shouldDeprecate 生命周期判定");
{
  const now = new Date("2026-08-26T00:00:00Z");
  const recent = new Date(now.getTime() - 10 * 86_400_000);
  const stale = new Date(now.getTime() - (TTL_DAYS + 5) * 86_400_000);

  assert(
    shouldDeprecate(
      { status: "ACTIVE", createdAt: stale, triggerCount: 0, conflictCount: 0 },
      { now }
    ),
    "连续 90+ 天未触发 → DEPRECATED"
  );
  assert(
    !shouldDeprecate(
      { status: "ACTIVE", createdAt: recent, triggerCount: 3, conflictCount: 0 },
      { now }
    ),
    "近期触发 → 保留 ACTIVE"
  );
  assert(
    shouldDeprecate(
      { status: "ACTIVE", createdAt: recent, triggerCount: 10, conflictCount: 5 },
      { now }
    ),
    "冲突率 0.5 ≥ 阈值 → DEPRECATED"
  );
  assert(
    !shouldDeprecate(
      { status: "ACTIVE", createdAt: recent, triggerCount: 10, conflictCount: 2 },
      { now }
    ),
    "冲突率 0.2 < 阈值 → 保留"
  );
  assert(
    !shouldDeprecate(
      { status: "DEPRECATED", createdAt: stale, triggerCount: 0, conflictCount: 0 },
      { now }
    ),
    "已非 ACTIVE → 不再判定（幂等）"
  );
  assert(conflictRateOf({ status: "ACTIVE", createdAt: now, triggerCount: 0, conflictCount: 0 }) === 0, "无触发 → 冲突率 0");
  assert(
    conflictRateOf({ status: "ACTIVE", createdAt: now, triggerCount: 4, conflictCount: 1 }) === 0.25,
    "冲突率 = 1/4 = 0.25"
  );
}

// ---- 规格3：向量检索排序 ----
console.log("[规格3] rankByCosine 语义重排");
{
  const query = [1, 0, 0];
  const candidates = [
    { id: "B", embedding: JSON.stringify([0, 1, 0]) }, // 正交 → 0
    { id: "A", embedding: JSON.stringify([1, 0, 0]) }, // 同向 → 1
    { id: "C", embedding: null }, // 无向量 → 排末尾
  ];
  const ranked = rankByCosine(candidates, query);
  assert(ranked[0].id === "A" && approx(ranked[0].score, 1), "最相似 A 排第一（score=1）");
  assert(ranked[1].id === "B" && approx(ranked[1].score, 0), "正交 B 居中（score=0）");
  assert(ranked[2].id === "C", "无向量 C 排末尾");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
