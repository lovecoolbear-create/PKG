/**
 * 草稿试算机制测试（P1）
 * ----------------------------------------------------------------
 * 锁住 withRecipeOverrides 的四条铁律：
 *  1. 覆盖期内读到的是草稿值
 *  2. 跑完必须还原（不能污染后续真实报价）
 *  3. **数据库全程不写**
 *  4. 覆盖期内 TTL / force reload 都不能把草稿冲掉
 *
 * 第 4 条是实测踩出来的：早期 withRecipeOverrides 把 loadedAt 沿用备份的时间，
 * 若备份已接近过期，orchestrator 内部再调 loadRecipes() 就会重新查库，
 * 草稿被悄悄换回已保存值——试算显示"改了没影响"，是最坏的假绿灯。
 */

import { prisma } from "@/lib/db";
import {
  loadRecipes,
  getRecipeItems,
  withRecipeOverrides,
  reloadRecipes,
} from "@/lib/cost-formula/loader";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("\n=== 草稿试算（withRecipeOverrides）===");

  await reloadRecipes();
  const items = getRecipeItems("color_print_box", "design_plate");
  check("能加载到彩印纸盒 design_plate 配方", items.length > 0, `实际 ${items.length} 项`);
  if (!items.length) {
    console.log("\n结果：通过 " + pass + " / 失败 " + (fail + 1));
    process.exit(1);
  }

  const target = items[0];
  const originalParams = target.params;
  const originalCount = items.length;

  // ── 1. 覆盖期内读到草稿值 ────────────────────────────────────────────
  const draftParams = JSON.stringify({ amount: 12345 });
  let insideParams = "";
  const ret = await withRecipeOverrides(
    { [target.id!]: { kind: "flat", params: draftParams } },
    () => {
      insideParams =
        getRecipeItems("color_print_box", "design_plate").find(
          (i) => i.id === target.id
        )?.params ?? "";
      return "RESULT";
    }
  );
  check("覆盖期内读到的是草稿参数", insideParams === draftParams, insideParams);
  check("fn 的返回值被原样透传", ret === "RESULT", String(ret));

  // ── 2. 跑完必须还原 ────────────────────────────────────────────────
  const after = getRecipeItems("color_print_box", "design_plate").find(
    (i) => i.id === target.id
  );
  check("覆盖结束后缓存已还原", after?.params === originalParams, after?.params);
  check(
    "项数未变（没有误删/误增）",
    getRecipeItems("color_print_box", "design_plate").length === originalCount
  );

  // ── 3. 数据库全程不写 ──────────────────────────────────────────────
  const inDb = await prisma.costItem.findUnique({ where: { id: target.id! } });
  check("数据库参数未被改写", inDb?.params === originalParams, inDb?.params);
  check("数据库 kind 未被改写", inDb?.kind === target.kind, inDb?.kind);

  // ── 4. 覆盖期内 force reload 不能冲掉草稿 ────────────────────────────
  let survived = "";
  await withRecipeOverrides(
    { [target.id!]: { kind: "flat", params: draftParams } },
    async () => {
      // 模拟 orchestrator 内部（或任何链路）再次调用加载
      await loadRecipes();
      await loadRecipes(true);
      survived =
        getRecipeItems("color_print_box", "design_plate").find(
          (i) => i.id === target.id
        )?.params ?? "";
    }
  );
  check("覆盖期内再调 loadRecipes 草稿仍在", survived === draftParams, survived);
  check(
    "第二次覆盖结束后同样还原",
    getRecipeItems("color_print_box", "design_plate").find(
      (i) => i.id === target.id
    )?.params === originalParams
  );

  // ── 5. enabled:false 草稿 = 该项被移除 ──────────────────────────────
  let countWhenDisabled = -1;
  await withRecipeOverrides({ [target.id!]: { enabled: false } }, () => {
    countWhenDisabled = getRecipeItems("color_print_box", "design_plate").length;
  });
  check(
    "草稿停用某项时该项被移出配方",
    countWhenDisabled === originalCount - 1,
    `${countWhenDisabled} vs ${originalCount - 1}`
  );

  // ── 6. 并发保护：嵌套覆盖返回 null ─────────────────────────────────
  let nested: unknown = "not-run";
  await withRecipeOverrides(
    { [target.id!]: { params: draftParams } },
    async () => {
      nested = await withRecipeOverrides(
        { [target.id!]: { params: JSON.stringify({ amount: 1 }) } },
        () => "should-not-happen"
      );
    }
  );
  check("覆盖期内再发起覆盖被拒（返回 null）", nested === null, String(nested));

  // ── 7. 空草稿 = 直接跑，不动缓存 ───────────────────────────────────
  const plain = await withRecipeOverrides({}, () => "PLAIN");
  check("空草稿直接执行 fn", plain === "PLAIN", String(plain));
  check(
    "空草稿后缓存仍是库里的值",
    getRecipeItems("color_print_box", "design_plate").find(
      (i) => i.id === target.id
    )?.params === originalParams
  );

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
