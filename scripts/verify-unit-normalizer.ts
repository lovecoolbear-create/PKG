// 解析后单位归一化验证（建议 #2）：断言 cm/m/英寸→mm、万→个 的确定性换算，
// 且对纯 mm / 无文本证据情形保持幂等（不误转、不翻倍）。
// 跑法：npx tsx scripts/verify-unit-normalizer.ts
import { normalizeAnalysisInputUnits, toMm, UNIT_TO_MM } from "@/lib/parse/unit-normalizer";
import type { AnalysisInput } from "@/types";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
  }
}

// 1. cm → mm
{
  const { input, conversions } = normalizeAnalysisInputUnits(
    { quantity: 1, length: 2.5 } as Partial<AnalysisInput>,
    "长2.5cm"
  );
  check("长2.5cm → 25mm", input.length === 25);
  check("cm 产生换算记录", conversions.some((c) => c.field === "length" && c.normalized === 25));
}

// 2. 英寸 → mm
{
  const { input } = normalizeAnalysisInputUnits(
    { length: 1 } as Partial<AnalysisInput>,
    "长1英寸"
  );
  check("长1英寸 → 25.4mm", Math.abs((input.length as number) - 25.4) < 1e-9);
}

// 3. m → mm
{
  const { input } = normalizeAnalysisInputUnits(
    { length: 0.2 } as Partial<AnalysisInput>,
    "长0.2米"
  );
  check("长0.2米 → 200mm", input.length === 200);
}

// 4. 纯 mm 不应误转（幂等）
{
  const { input, conversions } = normalizeAnalysisInputUnits(
    { length: 250 } as Partial<AnalysisInput>,
    "长250mm"
  );
  check("长250mm 保持不变", input.length === 250);
  check("mm 无换算记录", !conversions.some((c) => c.field === "length"));
}

// 5. 无文本证据 → 保持原值（视为 mm）
{
  const { input, conversions } = normalizeAnalysisInputUnits(
    { length: 100 } as Partial<AnalysisInput>,
    "印量5000"
  );
  check("无维度文本→保持100", input.length === 100);
  check("无维度文本→无换算", conversions.length === 0);
}

// 6. 万 → 个（数量）
{
  const { input, conversions } = normalizeAnalysisInputUnits(
    { quantity: 1 } as Partial<AnalysisInput>,
    "1万张"
  );
  check("1万张 → 10000", input.quantity === 10000);
  check("万产生换算记录", conversions.some((c) => c.field === "quantity" && c.normalized === 10000));
}

// 7. 多重单位共存
{
  const { input } = normalizeAnalysisInputUnits(
    { length: 2.5, width: 150 } as Partial<AnalysisInput>,
    "长2.5cm 宽150mm"
  );
  check("长2.5cm→25 宽150mm→150", input.length === 25 && input.width === 150);
}

// 8. toMm 直接换算
{
  check("toMm 2.5cm=25", toMm(2.5, "cm") === 25);
  check("toMm 1mm=1", toMm(1, "mm") === 1);
  check("UNIT_TO_MM 含英寸", UNIT_TO_MM["英寸"] === 25.4);
}

console.log(`单位归一化验证：通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败用例：\n - " + fails.join("\n - "));
  process.exit(1);
} else {
  console.log("✅ 全部通过（cm/英寸/m→mm、万→个、幂等无误转）");
}
