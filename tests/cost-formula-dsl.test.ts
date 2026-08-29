/**
 * 表达式沙箱测试（F6）
 * ----------------------------------------------------------------
 * 重点是**安全**：任何越界企图都必须被拒绝，而不是求值出结果。
 * 这些用例是护栏——新增函数/语法时必须同步补测。
 */
import { evalExpression, isDslEnabled } from "@/lib/cost-formula/dsl";
import { evalCostItem, evalRecipe, DEFAULT_EVAL_CONTEXT, type EvalContext } from "@/lib/cost-formula";

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

const V = { quantity: 5000, rate: 0.45, area: 12.5, flag: 1 };
const val = (expr: string, vars = V) => evalExpression(expr, vars);
const num = (expr: string, vars = V) => {
  const r = val(expr, vars);
  return r.ok ? r.value : NaN;
};
const err = (expr: string, vars = V) => val(expr, vars).ok === false;

console.log("=== 表达式沙箱（F6）===\n");

console.log("▸ 规格1：基本算术");
assert(num("1 + 2 * 3") === 7, "1+2*3 = 7（优先级正确）");
assert(num("(1 + 2) * 3") === 9, "(1+2)*3 = 9");
assert(num("10 / 4") === 2.5, "10/4 = 2.5");
assert(num("7 % 3") === 1, "7%3 = 1");
assert(num("-5 + 2") === -3, "-5+2 = -3");
assert(num("2.5 * 2") === 5, "小数 2.5*2 = 5");

console.log("\n▸ 规格2：变量（仅白名单）");
assert(num("quantity * rate") === 2250, "quantity*rate = 5000×0.45 = 2250");
assert(num("area") === 12.5, "白名单变量 area = 12.5");

console.log("\n▸ 规格3：白名单函数");
assert(num("max(1, 5)") === 5, "max(1,5) = 5");
assert(num("min(3, 8)") === 3, "min(3,8) = 3");
assert(num("round(2.5)") === 3, "round(2.5) = 3");
assert(num("ceil(2.1)") === 3, "ceil(2.1) = 3");
assert(num("floor(2.9)") === 2, "floor(2.9) = 2");
assert(num("abs(-3)") === 3, "abs(-3) = 3");
assert(num("clamp(15, 0, 10)") === 10, "clamp(15,0,10) = 10");
assert(num("max(1, 2, 3, 4, 5)") === 5, "max 支持多参数");

console.log("\n▸ 规格4：比较与三元");
assert(num("quantity > 1000 ? 300 : 150") === 300, "quantity=5000>1000 → 300");
assert(num("quantity > 9000 ? 300 : 150") === 150, "quantity=5000<9000 → 150");
assert(num("quantity == 5000 ? 1 : 0") === 1, "== 比较");
assert(num("quantity != 5000 ? 1 : 0") === 0, "!= 比较");

console.log("\n▸ 规格5：安全 —— 未知标识符一律拒绝");
for (const bad of [
  "process",
  "globalThis",
  "global",
  "require",
  "window",
  "document",
  "constructor",
  "__proto__",
  "prototype",
  "Function",
  "eval",
  "setTimeout",
  "unknownVar",
]) {
  assert(err(bad), `拒绝标识符 ${bad}`);
}

console.log("\n▸ 规格6：安全 —— 非白名单函数一律拒绝");
for (const bad of [
  "exit(1)",
  "eval('1')",
  "Function('return 1')()",
  "require('fs')",
  "fetch('/x')",
  "console.log(1)",
  "notAFunction(1)",
]) {
  assert(err(bad), `拒绝函数 ${bad}`);
}

console.log("\n▸ 规格7：安全 —— 非法语法一律拒绝");
for (const bad of [
  "a.b",
  "a[0]",
  "1;2",
  "1,2",
  '"abc"',
  "'abc'",
  "1 +",
  "(1 + 2",
  "1 + 2)",
  "1 ? 2",
  "@#$",
  "1e999",
]) {
  assert(err(bad), `拒绝语法 ${JSON.stringify(bad)}`);
}

console.log("\n▸ 规格8：安全 —— 资源上限与异常输入");
{
  const long = Array.from({ length: 6000 }, () => "1").join(" + ");
  const r = val(long);
  assert(r.ok === false, `超长表达式被步数上限拦截（${long.length} 字符）`);

  const deep = "(".repeat(200) + "1" + ")".repeat(200);
  assert(val(deep).ok === false, "超深嵌套被深度上限拦截");

  assert(err("1 / 0"), "除数为 0 被拒绝");
  assert(err("1 % 0"), "取模除数为 0 被拒绝");
  assert(val("").ok === false, "空表达式被拒绝");
  assert(val("   ").ok === false, "纯空白被拒绝");
}

console.log("\n▸ 规格9：结果必须是有限数字");
{
  const huge = val("999999999999999999999999 * 999999999999999999999999");
  assert(huge.ok === false || Number.isFinite(huge.ok ? huge.value : NaN), "溢出不会产生 Infinity");
}

console.log("\n▸ 规格10：系统开关默认关闭");
{
  const saved = process.env.FORMULA_DSL_ENABLED;
  delete process.env.FORMULA_DSL_ENABLED;
  assert(isDslEnabled() === false, "默认关闭");
  process.env.FORMULA_DSL_ENABLED = "true";
  assert(isDslEnabled() === true, "显式开启后为 true");
  if (saved == null) delete process.env.FORMULA_DSL_ENABLED;
  else process.env.FORMULA_DSL_ENABLED = saved;
}

console.log("\n▸ 规格11：与配方求值器集成");
{
  const saved = process.env.FORMULA_DSL_ENABLED;
  const ctx: EvalContext = { ...DEFAULT_EVAL_CONTEXT, quantity: 5000 };

  delete process.env.FORMULA_DSL_ENABLED;
  assert(
    evalCostItem(
      { name: "DSL项", kind: "formula", params: JSON.stringify({ expr: "quantity * 2" }) },
      ctx
    ) === null,
    "开关关闭时 formula 项返回 null（回退硬编码）"
  );

  process.env.FORMULA_DSL_ENABLED = "true";
  assert(
    evalCostItem(
      { name: "DSL项", kind: "formula", params: JSON.stringify({ expr: "quantity * 2" }) },
      ctx
    ) === 10000,
    "开关开启后正确求值 quantity*2 = 10000"
  );
  assert(
    evalCostItem(
      { name: "坏DSL", kind: "formula", params: JSON.stringify({ expr: "process.exit(1)" }) },
      ctx
    ) === null,
    "恶意表达式返回 null（不安全猜算）"
  );
  assert(
    evalRecipe(
      [
        { name: "固定", kind: "flat", params: JSON.stringify({ amount: 100 }), sortOrder: 1 },
        {
          name: "坏DSL",
          kind: "formula",
          params: JSON.stringify({ expr: "unknownVar" }),
          sortOrder: 2,
        },
      ],
      ctx
    ) === null,
    "配方含失败 DSL 项 → 整组返回 null（交回退）"
  );

  if (saved == null) delete process.env.FORMULA_DSL_ENABLED;
  else process.env.FORMULA_DSL_ENABLED = saved;
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
