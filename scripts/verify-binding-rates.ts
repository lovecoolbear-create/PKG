/**
 * 装订费率回归守卫（2026-08-30 建立）
 *
 * 背景（§6 静默归零坑）：flat_print 配置提供 锁线胶装/精装/圈装YO圈/古线装风琴折 四档装订，
 * 但 BINDING_LABOR / BINDING_EQUIP 曾缺这四档 → `?? none` 静默按 0 元计费，
 * 用户在 UI 上能选到、报告不报错也不提示，等于直接少算装订费。
 * 本脚本锁死「四档必须有非零费率 + 既有档位数值不被误改」，防止该坑复发。
 *
 * 确定性脚本，不调用 LLM，不改任何数据。
 */
import { getBindingLabor, getBindingEquip } from "@/lib/agents/specialists";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(
      `  ❌ ${name}${got !== undefined ? ` → 实际 ${String(got)}` : ""}`
    );
  }
}

// ===== ① 新增四档装订不得为 0（静默归零守卫，本脚本存在的核心理由）=====
console.log("── ① 新增四档装订费率不得为 0（静默归零守卫）──");
const NEW_BINDINGS: [string, string][] = [
  ["thread_sewn", "锁线胶装"],
  ["hardcover", "精装"],
  ["spiral", "圈装/YO圈"],
  ["accordion", "古线装/风琴折"],
];
for (const [code, label] of NEW_BINDINGS) {
  const l = getBindingLabor(code);
  const e = getBindingEquip(code);
  check(`${label} 人工费率 > 0`, l.cost > 0, l.cost);
  check(`${label} 设备费率 > 0`, e.cost > 0, e.cost);
  check(`${label} 人工标签正确`, l.label === label, l.label);
  check(`${label} 设备标签正确`, e.label === label, e.label);
}

// ===== ② 既有档位数值保持（防误改回归）=====
console.log("── ② 既有档位数值保持不变 ──");
const EXPECTED: [string, number, number][] = [
  ["none", 0, 0],
  ["saddle", 0.05, 0.08],
  ["perfect", 0.15, 0.25],
  ["fold", 0.03, 0.05],
];
for (const [code, labor, equip] of EXPECTED) {
  check(
    `${code} 人工 = ${labor}`,
    getBindingLabor(code).cost === labor,
    getBindingLabor(code).cost
  );
  check(
    `${code} 设备 = ${equip}`,
    getBindingEquip(code).cost === equip,
    getBindingEquip(code).cost
  );
}

// ===== ③ 未知装订值回退 none（不静默放大；非法枚举由 input-guardrail 前置拦截）=====
console.log("── ③ 未知装订值回退 none ──");
check(
  "未知 code 人工 = 0",
  getBindingLabor("__unknown__").cost === 0,
  getBindingLabor("__unknown__").cost
);
check(
  "未知 code 设备 = 0",
  getBindingEquip("__unknown__").cost === 0,
  getBindingEquip("__unknown__").cost
);
check(
  "undefined 回退 none",
  getBindingLabor(undefined).cost === 0,
  getBindingLabor(undefined).cost
);

// ===== ④ 无 KB 条目时走常量兜底（fromKb=false）=====
console.log("── ④ 无知识库条目时走常量兜底 ──");
check(
  "hardcover fromKb = false",
  getBindingLabor("hardcover").fromKb === false,
  getBindingLabor("hardcover").fromKb
);

console.log(`\n装订费率验证：通过 ${pass} / ${pass + fail}`);
console.log(
  fail === 0
    ? "✅ 全部通过（四档新增装订均有非零费率，无静默归零）"
    : `❌ ${fail} 项失败`
);
process.exit(fail === 0 ? 0 : 1);
