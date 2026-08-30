// 输入层 Guardrail 确定性验证（建议 #1）：覆盖 block / warn 各规则，
// 断言无漏报（应拦的没拦）与无误报（合法输入被误拦）。跑法：npx tsx scripts/verify-input-guardrail.ts
import { getProductConfig } from "@/config/products";
import { runInputGuardrail } from "@/lib/agents/input-guardrail";
import type { AnalysisInput } from "@/types";

const box = getProductConfig("color_print_box")!;
const corr = getProductConfig("corrugated_box")!;
const flat = getProductConfig("flat_print")!;
const label = getProductConfig("label")!;

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    fails.push(name);
  }
}

// ---------- BLOCK 用例 ----------
// 1. 数量≤0
{
  const r = runInputGuardrail({ quantity: 0, length: 200, width: 150, height: 100, material: "white_card", boxType: "tuck_end" } as AnalysisInput, box);
  check("qty=0 应 block", r.hasBlocker && r.blockers.some((i) => i.code === "qty_invalid"));
}
// 2. 数量缺失
{
  const r = runInputGuardrail({ length: 200, width: 150, height: 100 } as AnalysisInput, box);
  check("qty 缺失应 block", r.hasBlocker && r.blockers.some((i) => i.code === "qty_invalid"));
}
// 3. 尺寸≤0
{
  const r = runInputGuardrail({ quantity: 3000, length: 0, width: 150, height: 100, material: "white_card", boxType: "tuck_end" } as AnalysisInput, box);
  check("尺寸=0 应 block", r.hasBlocker && r.blockers.some((i) => i.code === "dim_nonpositive"));
}
// 4. 尺寸非数字
{
  const r = runInputGuardrail({ quantity: 3000, length: "abc" as unknown as number, width: 150, height: 100 } as AnalysisInput, box);
  check("尺寸非数字应 block", r.hasBlocker && r.blockers.some((i) => i.code === "dim_nan"));
}
// 5. 枚举非法（material 不在选项）
{
  const r = runInputGuardrail({ quantity: 3000, material: "banana", boxType: "tuck_end" } as AnalysisInput, box);
  check("material 非法应 block", r.hasBlocker && r.blockers.some((i) => i.code === "enum_invalid" && i.field === "material"));
}
// 6. 克重不在范围
{
  const r = runInputGuardrail({ quantity: 3000, grammage: "999", material: "white_card", boxType: "tuck_end" } as AnalysisInput, box);
  check("克重越界应 block", r.hasBlocker && r.blockers.some((i) => i.code === "grammage_out_of_range"));
}
// 7. 专色越界
{
  const r = runInputGuardrail({ quantity: 3000, spotColorCount: 20 } as AnalysisInput, box);
  check("专色>8 应 block", r.hasBlocker && r.blockers.some((i) => i.code === "spot_invalid"));
}
// 8. 面积超上限 → block
{
  const r = runInputGuardrail({ quantity: 3000, length: 200, width: 150, dielineAreaMm2: 60_000_000 } as AnalysisInput, box);
  check("面积过大应 block", r.hasBlocker && r.blockers.some((i) => i.code === "area_oversize"));
}

// ---------- WARN 用例 ----------
// 9. 印量偏小
{
  const r = runInputGuardrail({ quantity: 10, length: 200, width: 150, height: 100, material: "white_card", boxType: "tuck_end" } as AnalysisInput, box);
  check("qty=10 仅 warn 不 block", !r.hasBlocker && r.warnings.some((i) => i.code === "qty_small"));
}
// 10. 尺寸疑似单位混淆
{
  const r = runInputGuardrail({ quantity: 3000, length: 5000, width: 150, height: 100 } as AnalysisInput, box);
  check("尺寸>2000 应 warn", !r.hasBlocker && r.warnings.some((i) => i.code === "dim_oversize"));
}
// 11. 面积与长宽乘积偏差过大（warn）
{
  const r = runInputGuardrail({ quantity: 3000, length: 200, width: 150, dielineAreaMm2: 6000 } as AnalysisInput, box);
  // 200*150=30000，6000/30000=0.2，落在 (0.05,8] 内 → 不报；故意用极端值验证 warn 触发
  const r2 = runInputGuardrail({ quantity: 3000, length: 200, width: 150, dielineAreaMm2: 600 } as AnalysisInput, box);
  check("面积偏差>20倍 应 warn", !r2.hasBlocker && r2.warnings.some((i) => i.code === "area_unit_mismatch"));
}
// 12. 瓦楞缺载荷数据（warn，且 tied to #4 门禁前置）
{
  const r = runInputGuardrail({ quantity: 3000, fluteType: "E", boxType: "rsc" } as AnalysisInput, corr);
  check("瓦楞缺载荷应 warn", !r.hasBlocker && r.warnings.some((i) => i.code === "corrugated_missing_load"));
}

// ---------- 合法输入不应误报 ----------
// 13. 标准合法彩盒
{
  const r = runInputGuardrail({ quantity: 3000, length: 200, width: 150, height: 100, material: "white_card", boxType: "tuck_end", grammage: "350", printMethod: "offset", colorCount: "4", surfaceTreatment: "none", spotColorCount: 0 } as AnalysisInput, box);
  check("合法彩盒应无 block", !r.hasBlocker);
}
// 14. 合法平印
{
  const r = runInputGuardrail({ quantity: 5000, length: 210, width: 297, material: "coated_paper", grammage: "157", printMethod: "offset", colorCount: "4" } as AnalysisInput, flat);
  check("合法平印应无 block", !r.hasBlocker);
}
// 15. 合法标签
{
  const r = runInputGuardrail({ quantity: 5000, length: 100, width: 150, material: "coated_paper", grammage: "80", printMethod: "offset", colorCount: "4", surfaceTreatment: "matte_laminate" } as AnalysisInput, label);
  check("合法标签应无 block", !r.hasBlocker);
}
// 16. 合法瓦楞（带载荷）
{
  const r = runInputGuardrail({ quantity: 2000, fluteType: "E", boxType: "rsc", boxWeight: 1.2, stackLayers: 5 } as AnalysisInput, corr);
  check("合法瓦楞(带载荷)应无 block 且无缺载荷 warn", !r.hasBlocker && !r.warnings.some((i) => i.code === "corrugated_missing_load"));
}

console.log(`输入 Guardrail 验证：通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败用例：\n - " + fails.join("\n - "));
  process.exit(1);
} else {
  console.log("✅ 全部通过（block/warn 规则与合法输入零误报）");
}
