import {
  detectNumberDrift,
  reconcileNarrative,
  reconcileJudge,
  reconcileRankerNarrative,
  reconcileCrossLayer,
  auditLLMCall,
  listAuditLog,
  type DataPointerLike,
} from "@/lib/agents/consistency-gate";

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

const ptr: DataPointerLike[] = [
  { fieldPath: "totalCost.perUnit.max", label: "单只成本", value: "¥6.21（18%）" },
];

console.log("1) detectNumberDrift");
{
  const drift = detectNumberDrift("材料占比30%，单只¥6.50，明显偏高", ptr);
  assert(drift.length >= 2, `漂移应检出 ≥2 处（实际 ${drift.length}）`);
  assert(
    drift.some((d) => d.kind === "amount" && d.expectedValue === 6.21),
    "金额漂移应命中 ¥6.21 基准"
  );
  assert(
    drift.some((d) => d.kind === "percent" && d.expectedValue === 18),
    "百分比漂移应命中 18% 基准"
  );
}
{
  const clean = detectNumberDrift("单只¥6.21，材料占18%，结构合理", ptr);
  assert(clean.length === 0, `一致文本不应报漂移（实际 ${clean.length}）`);
}

console.log("2) reconcileNarrative");
{
  const r = reconcileNarrative({
    deterministicVerdict: "reject",
    narrativeText: "该方案完全可行，推荐采用",
    correction: "双坑降单坑承重不足",
  });
  assert(r.hadConflict, "reject + 称可行 应判定冲突");
  assert(r.text.includes("不可行"), "冲突时应强制以确定性结论替换");
}
{
  const r = reconcileNarrative({
    deterministicVerdict: "pass",
    narrativeText: "该方案完全可行，推荐采用",
    correction: "x",
  });
  assert(!r.hadConflict, "pass + 称可行 不应冲突");
}

console.log("3) reconcileJudge");
{
  const { raw, warnings } = reconcileJudge(
    { findings: [{ why: "该问题完全可行，没有问题", fix: "建议改克重" }] },
    [{ type: "strength", severity: "error" }]
  );
  assert(warnings.length === 1, "error 但称可行 应产出 1 告警");
  assert(
    (raw.findings[0].why || "").includes("硬性冲突"),
    "why 应被强制替换为确定性结论"
  );
}

console.log("4) reconcileRankerNarrative");
{
  const { raw, warnings } = reconcileRankerNarrative(
    { order: ["s1"], reasons: { s1: "该方案可行，推荐" } },
    { s1: { passed: false, reason: "双坑降单坑承重不足" } }
  );
  assert(warnings.length === 1, "否决方案被称可行 应产出 1 告警");
  assert(
    raw.reasons["s1"] === "双坑降单坑承重不足",
    "排序理由应被强制替换为否决原因"
  );
}

console.log("5) reconcileCrossLayer");
{
  const { reports, warnings } = reconcileCrossLayer({
    judgeHasError: true,
    roleReports: [
      { role: "client", roleLabel: "客户决策视角", headline: "风险可控", points: ["一切正常"] },
    ],
  });
  assert(warnings.length === 1, "判定 error 但客户称无风险 应产出 1 告警");
  assert(
    reports[0].points.some((p) => p.includes("须以判定层")),
    "客户视角应被标注须以判定层为准"
  );
}
{
  const { warnings } = reconcileCrossLayer({
    judgeHasError: false,
    roleReports: [
      { role: "client", roleLabel: "客户决策视角", headline: "风险可控", points: ["一切正常"] },
    ],
  });
  assert(warnings.length === 0, "判定无 error 不应跨层告警");
}

console.log("6) auditLLMCall + listAuditLog");
{
  auditLLMCall({
    ts: new Date().toISOString(),
    layer: "unit_test",
    source: "template",
    model: "test",
    inputSummary: "测试输入",
    engineKeyValues: { a: 1 },
    outputText: "测试输出",
    warnings: [],
  });
  const log = listAuditLog(5);
  assert(log.length >= 1, "审计日志应至少 1 条");
  assert(log[log.length - 1].layer === "unit_test", "末条应为 unit_test");
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
