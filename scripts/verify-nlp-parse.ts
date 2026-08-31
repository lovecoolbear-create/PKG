/**
 * NLP 规则解析回归（2026-08-30 全流程测试发现 P0 后补的守卫）
 * ----------------------------------------------------------------
 * 覆盖 2026-08-30 修掉的五类缺陷，防止复发：
 *  ① 三连尺寸 200x150x80mm 不解析（ruleParse 从未调用 extractDeterministicDimensions）
 *  ② 二维尺寸 210x285mm（平印/标签）不解析
 *  ③ 量词缺「本/册」，「1000本」被静默改成默认 5000
 *  ④ 枚举/默认值写死为彩盒口径：瓦楞 175g、平印 157g、标签 80g 全被改成 350g；
 *     平印/标签被凭空注入 boxType/fluteType
 *  ⑤ 材质同义词缺「牛卡」、坑型缺 BC/五层、色数缺「三色」、平印缺 pages/binding
 *
 * 用法：npm run test:nlp
 */
import { parseNaturalLanguage } from "@/lib/agents/nlp-parser";
import { getProductConfig } from "@/config/products";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else {
    fail++;
    fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function parse(text: string, productType?: string) {
  const cfg = productType ? getProductConfig(productType) ?? undefined : undefined;
  const r = await parseNaturalLanguage(text, undefined, cfg);
  // defaults 会合并进 input（UI 侧行为），这里也合并后再断言
  const merged: Record<string, unknown> = { ...r.input };
  for (const d of r.defaults) merged[d.field] = d.value;
  return { ...r, merged };
}

async function main() {
  console.log("\n── ① 三连尺寸（P0：曾经完全不解析）──");
  {
    const r = await parse("做一个彩盒，200x150x80mm，350g白卡，5000个，四色印刷，覆哑膜", "color_print_box");
    check("彩盒·length=200", r.merged.length === 200, String(r.merged.length));
    check("彩盒·width=150", r.merged.width === 150, String(r.merged.width));
    check("彩盒·height=80", r.merged.height === 80, String(r.merged.height));
    check("彩盒·quantity=5000", r.merged.quantity === 5000, String(r.merged.quantity));
    check("彩盒·grammage=350", r.merged.grammage === "350", String(r.merged.grammage));
    check("彩盒·material=white_card", r.merged.material === "white_card", String(r.merged.material));
    check("彩盒·colorCount=4", String(r.merged.colorCount) === "4", String(r.merged.colorCount));
    check("彩盒·surfaceTreatment=matte_laminate", r.merged.surfaceTreatment === "matte_laminate", String(r.merged.surfaceTreatment));
  }
  {
    const r = await parse("瓦楞纸箱，五层BC瓦，牛卡175g，三色，3000只，400x300x250mm", "corrugated_box");
    check("瓦楞·length=400", r.merged.length === 400, String(r.merged.length));
    check("瓦楞·width=300", r.merged.width === 300, String(r.merged.width));
    check("瓦楞·height=250", r.merged.height === 250, String(r.merged.height));
    check("瓦楞·quantity=3000", r.merged.quantity === 3000, String(r.merged.quantity));
    check("瓦楞·fluteType=BC（五层BC瓦）", r.merged.fluteType === "BC", String(r.merged.fluteType));
    check("瓦楞·linerMaterial=kraft（牛卡）", r.merged.linerMaterial === "kraft", String(r.merged.linerMaterial));
    check("瓦楞·linerGrammage=175", r.merged.linerGrammage === "175", String(r.merged.linerGrammage));
    check("瓦楞·colorCount=3（三色）", String(r.merged.colorCount) === "3", String(r.merged.colorCount));
    check("瓦楞·不注入彩盒 material", r.merged.material === undefined, String(r.merged.material));
    check("瓦楞·不注入彩盒 grammage", r.merged.grammage === undefined, String(r.merged.grammage));
  }

  console.log("  ── ② 二维尺寸（平印/标签，P0）──");
  {
    const r = await parse("画册 210x285mm 32P 157g铜版 封面250g 胶装 1000本 四色", "flat_print");
    check("平印·length=210", r.merged.length === 210, String(r.merged.length));
    check("平印·width=285", r.merged.width === 285, String(r.merged.width));
    check("平印·height 不注入（平面产品）", r.merged.height === undefined, String(r.merged.height));
    check("平印·quantity=1000（不是默认 5000）", r.merged.quantity === 1000, String(r.merged.quantity));
    check("平印·pages=32", r.merged.pages === 32, String(r.merged.pages));
    check("平印·grammage=157", r.merged.grammage === "157", String(r.merged.grammage));
    check("平印·coverGrammage=250", r.merged.coverGrammage === "250", String(r.merged.coverGrammage));
    check("平印·binding=perfect（胶装）", r.merged.binding === "perfect", String(r.merged.binding));
    check("平印·不注入 boxType", r.merged.boxType === undefined, String(r.merged.boxType));
    check("平印·不注入 fluteType", r.merged.fluteType === undefined, String(r.merged.fluteType));
  }
  {
    const r = await parse("不干胶标签 50x30mm 80g铜版 5000张 四色", "label");
    check("标签·length=50", r.merged.length === 50, String(r.merged.length));
    check("标签·width=30", r.merged.width === 30, String(r.merged.width));
    check("标签·grammage=80", r.merged.grammage === "80", String(r.merged.grammage));
    check("标签·quantity=5000", r.merged.quantity === 5000, String(r.merged.quantity));
    check("标签·不注入 boxType", r.merged.boxType === undefined, String(r.merged.boxType));
  }
  {
    // 用户实测：100mm*100mm + pvc + 覆膜 只识别出数量
    const r = await parse("我要做尺寸为100mm*100mm的标签，材料是pvc，覆膜，数量为50000张", "label");
    check("标签·100mm*100mm length=100", r.merged.length === 100, String(r.merged.length));
    check("标签·100mm*100mm width=100", r.merged.width === 100, String(r.merged.width));
    check("标签·pvc material=pvc", r.merged.material === "pvc", String(r.merged.material));
    check("标签·覆膜 surface=gloss_laminate", r.merged.surfaceTreatment === "gloss_laminate", String(r.merged.surfaceTreatment));
    check("标签·quantity=50000", r.merged.quantity === 50000, String(r.merged.quantity));
    check("标签·不注入 height", r.merged.height === undefined, String(r.merged.height));
  }

  console.log("  ── ③ 品类别名不串味 ──");
  {
    // 同一句文本，按不同品类解析出的字段名必须不同
    const a = await parse("牛卡175g 3000只", "corrugated_box");
    const b = await parse("白卡350g 3000个", "color_print_box");
    check("瓦楞用 linerGrammage 而非 grammage", a.merged.linerGrammage === "175" && a.merged.grammage === undefined, JSON.stringify({ l: a.merged.linerGrammage, g: a.merged.grammage }));
    check("彩盒用 grammage 而非 linerGrammage", b.merged.grammage === "350" && b.merged.linerGrammage === undefined, JSON.stringify({ l: b.merged.linerGrammage, g: b.merged.grammage }));
  }

  console.log("  ── ④ 向后兼容：不传品类时行为不变 ──");
  {
    const r = await parse("350g白卡 5000个 四色");
    check("无 config·material=white_card", r.merged.material === "white_card", String(r.merged.material));
    check("无 config·grammage=350", r.merged.grammage === "350", String(r.merged.grammage));
    check("无 config·有 boxType 兜底", r.merged.boxType !== undefined, String(r.merged.boxType));
  }

  console.log("  ── ⑤ 边界与异常 ──");
  {
    const r = await parse("", "color_print_box");
    check("空文本 confidence=0", r.confidence === 0, String(r.confidence));
    const r2 = await parse("随便说点什么", "color_print_box");
    check("无信息文本不崩且有 defaults", Array.isArray(r2.defaults), "");
    check("无信息文本不产 NaN", Object.values(r2.merged).every((v) => typeof v !== "number" || Number.isFinite(v)), JSON.stringify(r2.merged));
    const r3 = await parse("画册 99999P 1本", "flat_print");
    check("超大页数不写入（>2000 守卫）", r3.merged.pages === undefined || Number(r3.merged.pages) <= 2000, String(r3.merged.pages));
    check("「1本」被识别为数量", r3.merged.quantity === 1, String(r3.merged.quantity));
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fails.length) {
    console.log("\n失败项：");
    fails.forEach((f) => console.log("  ❌ " + f));
    process.exit(1);
  } else {
    console.log("✅ NLP 规则解析回归全部通过");
  }
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
