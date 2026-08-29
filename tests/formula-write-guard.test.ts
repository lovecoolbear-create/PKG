/**
 * 配方写库校验（P0 防线）
 * ----------------------------------------------------------------
 * 锁死「坏数据绝不能进库」。背景：早期 PUT 零校验，坏 JSON 写库后被
 * 求值器当成空对象算出 0，报价少算 60% 而全程无提示。
 * 这些断言是那次事故的直接回归防线。
 */
import { validateCostItemPatch } from "@/lib/cost-formula/validate";

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

const before = {
  name: "制版费 · CMYK",
  kind: "unit_rate",
  params: '{"rate":{"kb":"process_rate:plate_cmyk","fallback":350},"qty":{"ctx":"cmykColors"}}',
  conditions: '[{"field":"printMethod","op":"!=","value":"digital"}]',
};

console.log("=== 配方写库校验（P0 防线）===\n");

console.log("▸ 规格1：合法修改放行");
assert(validateCostItemPatch({ name: "制版费 · 四色" }, before).ok, "只改名称 → 通过");
assert(validateCostItemPatch({ enabled: false }, before).ok, "停用 → 通过");
assert(
  validateCostItemPatch({ params: '{"rate":400,"qty":{"ctx":"cmykColors"}}' }, before).ok,
  "合法 params → 通过"
);
assert(validateCostItemPatch({ conditions: null }, before).ok, "清空条件 → 通过");

console.log("\n▸ 规格2：坏 JSON 一律拒绝（事故回归）");
{
  const r = validateCostItemPatch({ params: "{bad json" }, before);
  assert(!r.ok, "坏 params 被拒");
  if (!r.ok) {
    assert(r.error.includes("参数不是合法 JSON"), `错误说明可读（${r.error}）`);
    assert(r.error.includes("数据库未改动"), "明确告知数据库未改动");
  }
}
{
  const r = validateCostItemPatch({ conditions: "[not json" }, before);
  assert(!r.ok, "坏 conditions 被拒");
  if (!r.ok) assert(r.error.includes("条件不是合法 JSON 数组"), "错误指向条件字段");
}

console.log("\n▸ 规格3：缺必填参数 → 拒绝（否则会静默算成 0）");
{
  const r = validateCostItemPatch({ params: "{}" }, before);
  assert(!r.ok, "unit_rate 缺 rate 被拒");
  if (!r.ok) assert(r.error.includes("rate"), "错误点名缺 rate");
}
{
  const r = validateCostItemPatch({ kind: "percent_of", params: '{"rate":6}' }, before);
  assert(!r.ok, "percent_of 缺基数被拒");
}
{
  const r = validateCostItemPatch({ kind: "unknown_kind" }, before);
  assert(!r.ok, "未知 kind 被拒");
}

console.log("\n▸ 规格4：结构性字段不可改");
for (const f of ["id", "productType", "dimension", "createdAt"]) {
  assert(!validateCostItemPatch({ [f]: "hacked" }, before).ok, `不可改 ${f}`);
}

console.log("\n▸ 规格5：合并校验——只改 name 时，库里已有的坏 params 也要拦住");
{
  const dirty = { ...before, params: "{broken" };
  const r = validateCostItemPatch({ name: "换个名" }, dirty);
  assert(!r.ok, "已存在的坏 params 不会被「只改名称」放过");
}

console.log("\n▸ 规格6：status 只能是 draft / active / archived");
{
  for (const s of ["draft", "active", "archived"]) {
    assert(validateCostItemPatch({ status: s }, before).ok, `允许 status=${s}`);
  }
  const r = validateCostItemPatch({ status: "enabled" }, before);
  assert(!r.ok, "非法 status 被拒");
  if (!r.ok) assert(r.field === "status", "错误定位到 status 字段");
}

console.log("\n▸ 规格7：weight 必须是数字（NaN 会让整维度金额变 NaN）");
{
  assert(!validateCostItemPatch({ weight: "六个点" }, before).ok, "非数字权重被拒");
  assert(validateCostItemPatch({ weight: 1.5 }, before).ok, "正常权重通过");
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
