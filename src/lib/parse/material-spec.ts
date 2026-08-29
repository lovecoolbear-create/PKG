/**
 * 材质/规格自由文本解析器（注册表分发）
 *
 * 客户报价单常把「纸张类型 + 克重 + 色数 + 表面处理」压进一个非结构化文本格
 * （如「封250g铜板，内157g铜板，双面4色，封面封底过哑膜」），工具要的是结构化字段。
 * 本模块按品类注册各自的解析器，parseMaterialSpec(productType, text) 统一分发。
 *
 * 设计要点：
 * - 列映射层(尺寸/数量/枚举)跨品类共享，见 column-map.ts；本文件只负责「材质文本」这一种自由文本。
 * - 仅解析**规格字段**（材质/克重/色数/表面处理/坑型…）。**价格字段(单价/总价)不在此处理**，
 *   由导入层按知识库防污染政策处理（仅当次对比、不进知识库）。
 * - 解析不出的字段保持 undefined，交给现有「未填提示」流程，不臆造。
 *
 * 扩展新品类：在 REGISTRY 注册 `productType -> MaterialParser` 即可，无需改动分发逻辑。
 */
import type { AnalysisInput } from "@/types";

/** 单个品类材质文本解析器输出（对齐各品类的输入字段取值） */
export interface ParsedSpec {
  // —— 平面彩印类共享 ——
  material?: string; // 纸张类型（select option value）
  grammage?: string; // 内页/整体克重（option value，如 "157"）
  coverGrammage?: string; // 封面克重（option value，如 "250"）
  colorCount?: string; // CMYK 色数（"1"|"2"|"3"|"4"）
  spotColorCount?: number; // 专色数
  surfaceTreatment?: string; // 表面处理（option value）

  // —— 瓦楞纸箱类 ——
  boardStructure?: string; // 纸板层数（single/double/triple）
  fluteType?: string; // 坑型（A/B/C/E/F/BC/BE/AB）
  linerMaterial?: string; // 面/里纸材质（kraft/white_top/special）
  linerGrammage?: string; // 面/里纸克重（option value）
  fluteGrammage?: string; // 芯纸克重（option value）
  mediumGrammage?: string; // 中纸克重（双/三瓦，option value）

  /** 未识别的片段，留作透明展示，不丢弃 */
  unparsed?: string[];
}

type MaterialParser = (raw: string) => ParsedSpec;

// ============ 通用词典 ============

const PAPER_TYPE: { re: RegExp; value: string }[] = [
  { re: /铜版|铜板/, value: "coated_paper" }, // 铜板为铜版常见手误
  { re: /哑粉|哑光/, value: "matte_paper" },
  { re: /双胶|胶版/, value: "offset_paper" },
  { re: /相纸/, value: "photo_paper" },
  { re: /PP/i, value: "pp_sheet" },
  { re: /特种/, value: "special" },
];

// flat_print 克重可选值（snap 到最近档，避免客户写 155g 等中间值落空）
const GRAMMAGE_OPTIONS = ["80", "105", "128", "157", "200", "230", "250", "300"];

function snapTo(g: number, options: string[]): string {
  let best = options[0];
  let bestDiff = Infinity;
  for (const opt of options) {
    const diff = Math.abs(Number(opt) - g);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

const COLOR_MAP: { re: RegExp; value: string }[] = [
  { re: /四色|4\s*色|4\s*c|CMYK/i, value: "4" },
  { re: /三色|3\s*色/, value: "3" },
  { re: /双色|2\s*色/, value: "2" },
  { re: /单色|1\s*色/, value: "1" },
];

const SURFACE_MAP: { re: RegExp; value: string }[] = [
  { re: /烫金|烫银/, value: "foil" },
  { re: /哑膜|哑光膜|雾膜/, value: "matte_laminate" },
  { re: /亮膜|光膜/, value: "gloss_laminate" },
  { re: /UV/i, value: "uv" },
  { re: /过油|上光|印油/, value: "varnish" },
];

function normalize(text: string): string {
  return text
    .replace(/[，,；;、]/g, "，") // 统一分隔符
    .replace(/\s+/g, "")
    .trim();
}

/**
 * 抽取材质文本中「未被任何词典识别」的片段，作为待审词典候选（学习闭环原料）。
 * 先按分隔符切片，逐段判断是否命中已知词表/数字；未命中的片段即为未知描述词。
 */
function collectUnrecognized(raw: string): string[] {
  if (!raw) return [];
  const maps = [
    PAPER_TYPE,
    CB_PAPER_TYPE,
    COLOR_MAP,
    SURFACE_MAP,
    CB_SURFACE_MAP,
    BOARD_MAP,
    FLUTE_MAP,
    LINER_MAT_MAP,
  ].flat();
  const segs = raw
    .split(/[，,；;、+/＋]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const seg of segs) {
    if (seg.length < 2) continue; // 单字噪声忽略
    const recognized = maps.some(({ re }) => re.test(seg)) || /\d/.test(seg);
    if (!recognized) out.add(seg);
  }
  return [...out];
}

// ============ 平面彩印解析器 ============

const flatPrintParser: MaterialParser = (raw) => {
  const text = normalize(raw);
  const result: ParsedSpec = {};

  // 纸张类型
  for (const { re, value } of PAPER_TYPE) {
    if (re.test(text)) {
      result.material = value;
      break;
    }
  }

  // 克重：(封|封面|内|内页|表|底)? Ng
  const gRe = /(封|封面|内|内页|表|底)?\s*(\d+)\s*g\b/gi;
  let m: RegExpExecArray | null;
  const grams: { qualifier: string; value: number }[] = [];
  while ((m = gRe.exec(text))) {
    grams.push({ qualifier: m[1] || "", value: Number(m[2]) });
  }
  for (const g of grams) {
    const snapped = snapTo(g.value, GRAMMAGE_OPTIONS);
    if (/封|封面|表/.test(g.qualifier)) {
      result.coverGrammage = snapped;
    } else if (/内|内页|底/.test(g.qualifier)) {
      result.grammage = snapped;
    } else {
      // 无前缀：单张/海报等本张克重
      result.grammage = snapped;
    }
  }

  // CMYK 色数
  for (const { re, value } of COLOR_MAP) {
    if (re.test(text)) {
      result.colorCount = value;
      break;
    }
  }

  // 专色
  const spot = text.match(/专色\s*(\d+)/i) || text.match(/(\d+)\s*专色/i);
  if (spot) result.spotColorCount = Number(spot[1]);
  else if (/专色/.test(text)) result.spotColorCount = 1;

  // 表面处理
  for (const { re, value } of SURFACE_MAP) {
    if (re.test(text)) {
      result.surfaceTreatment = value;
      break;
    }
  }

  result.unparsed = collectUnrecognized(raw); // 未识别片段进待审词典池
  return result;
};

// ============ 瓦楞纸箱解析器 ============
//
// 常见写法：
//  - "双瓦BC坑，面175g牛卡，芯120g高强，里150g牛卡"
//  - "单瓦B坑，面牛皮175，里牛皮150，芯高强120"
//  - "AB坑，300g牛皮+180g芯+300g里"
//  - "K175/B120/K150"（行业短写：字母表材质，数字表克重）
//  - "面纸牛皮纸175g，芯纸高强瓦楞原纸120g，里纸牛皮纸150g"

const BOARD_MAP: { re: RegExp; value: string }[] = [
  { re: /三瓦|七层|7\s*层/, value: "triple" },
  { re: /双瓦|五层|5\s*层/, value: "double" },
  { re: /单瓦|三层|3\s*层/, value: "single" },
];

const FLUTE_MAP: { re: RegExp; value: string }[] = [
  { re: /AB\s*坑|AB双坑/i, value: "AB" },
  { re: /BC\s*坑|BC双坑/i, value: "BC" },
  { re: /BE\s*坑|BE双坑/i, value: "BE" },
  { re: /A\s*坑/i, value: "A" },
  { re: /B\s*坑/i, value: "B" },
  { re: /C\s*坑/i, value: "C" },
  { re: /E\s*坑/i, value: "E" },
  { re: /F\s*坑/i, value: "F" },
];

const LINER_MAT_MAP: { re: RegExp; value: string }[] = [
  { re: /白板|白牛|white/i, value: "white_top" },
  { re: /牛卡|牛皮|牛皮纸|kraft|挂面/i, value: "kraft" },
  { re: /特种/, value: "special" },
];

const LINER_G_OPTIONS = ["125", "150", "175", "200", "230", "250"];
const FLUTE_G_OPTIONS = ["90", "100", "110", "120", "140", "160", "180"];
const MEDIUM_G_OPTIONS = ["110", "120", "140", "160"];

function firstMatch(text: string, maps: { re: RegExp; value: string }[]): string | undefined {
  for (const { re, value } of maps) if (re.test(text)) return value;
  return undefined;
}

const corrugatedBoxParser: MaterialParser = (raw) => {
  const text = normalize(raw);
  const result: ParsedSpec = {};
  const notes: string[] = [];

  // 层数 / 纸板结构
  const board = firstMatch(text, BOARD_MAP);
  if (board) result.boardStructure = board;

  // 坑型
  const flute = firstMatch(text, FLUTE_MAP);
  if (flute) result.fluteType = flute;

  // 面/里纸材质
  const linerMat = firstMatch(text, LINER_MAT_MAP);
  if (linerMat) result.linerMaterial = linerMat;

  // —— 克重抽取 ——
  // 1) 带限定词的 "(面|表|外|芯|中|里|底)纸?\d+g"
  const qualG = /(面|表|外|芯|中|里|底)[^0-9]*?(\d+(?:\.\d+)?)\s*g?/gi;
  const tagged: { q: string; g: number }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = qualG.exec(text))) {
    tagged.push({ q: mm[1], g: Number(mm[2]) });
  }

  const assignByQualifier = (q: string, g: number) => {
    if (/面|表|外/.test(q)) {
      if (!result.linerGrammage) result.linerGrammage = snapTo(g, LINER_G_OPTIONS);
      else notes.push(`面纸与里纸克重不同(${g}g)，工具仅单克重字段，已取面纸`);
    } else if (/芯/.test(q)) {
      if (!result.fluteGrammage) result.fluteGrammage = snapTo(g, FLUTE_G_OPTIONS);
    } else if (/中/.test(q)) {
      if (!result.mediumGrammage) result.mediumGrammage = snapTo(g, MEDIUM_G_OPTIONS);
    } else if (/里|底/.test(q)) {
      // 里纸：双/三瓦结构与面纸同字段（配置无独立里纸字段）
      if (!result.linerGrammage) result.linerGrammage = snapTo(g, LINER_G_OPTIONS);
      else if (g !== Number(result.linerGrammage) && !result.mediumGrammage)
        result.mediumGrammage = snapTo(g, MEDIUM_G_OPTIONS);
      else if (g !== Number(result.linerGrammage))
        notes.push(`里纸克重(${g}g)与面纸不同，工具仅单克重字段`);
    }
  };
  tagged.forEach((t) => assignByQualifier(t.q, t.g));

  // 2) 短写法 "K175/B120/K150" 或 "175/120/150"：按段顺序 面/芯/里
  if (tagged.length === 0) {
    // 用 "/" 或 "+" 分割的段，每段提取全部数字（支持 "面牛皮175，里牛皮150，芯高强120" 这类无分隔符写法）
    const segs = text.split(/[\/＋+]/).map((s) => s.trim()).filter(Boolean);
    const gramsInOrder: number[] = [];
    for (const seg of segs) {
      const allNums = seg.match(/\d+(?:\.\d+)?/g);
      if (allNums) gramsInOrder.push(...allNums.map(Number));
      // 段内材质字母提示：K/kraft, W/B 白板
      if (/^K/i.test(seg)) result.linerMaterial = result.linerMaterial ?? "kraft";
      else if (/^[WB]/i.test(seg)) result.linerMaterial = result.linerMaterial ?? "white_top";
    }
    if (gramsInOrder.length) {
      if (!result.linerGrammage) result.linerGrammage = snapTo(gramsInOrder[0], LINER_G_OPTIONS);
      if (gramsInOrder[1] && !result.fluteGrammage)
        result.fluteGrammage = snapTo(gramsInOrder[1], FLUTE_G_OPTIONS);
      if (gramsInOrder[2] && !result.linerGrammage)
        result.linerGrammage = snapTo(gramsInOrder[2], LINER_G_OPTIONS);
      else if (gramsInOrder[2] && !result.mediumGrammage)
        result.mediumGrammage = snapTo(gramsInOrder[2], MEDIUM_G_OPTIONS);
    }
  }

  // 印刷色数 / 专色 / 表面处理（与平面彩印共享词典）
  for (const { re, value } of COLOR_MAP) {
    if (re.test(text)) {
      result.colorCount = value;
      break;
    }
  }
  const spot = text.match(/专色\s*(\d+)/i) || text.match(/(\d+)\s*专色/i);
  if (spot) result.spotColorCount = Number(spot[1]);
  else if (/专色/.test(text)) result.spotColorCount = 1;
  for (const { re, value } of SURFACE_MAP) {
    if (re.test(text)) {
      result.surfaceTreatment = value;
      break;
    }
  }

  result.unparsed = collectUnrecognized(raw); // 未识别片段进待审词典池
  return result;
};

// ============ 彩印纸盒解析器 ============
//
// 常见写法：
//  - "350g白卡，四色，哑膜，烫金"
//  - "300g灰底白板，单色印刷"
//  - "白卡350，双面4C，过哑膜"
//  - "250g铜版纸，专色1"
//  - "牛皮纸300，单色"
//
// 材质选项与 flat_print 不同（白卡/灰底白板/牛皮/特种），故独立词典。

const CB_PAPER_TYPE: { re: RegExp; value: string }[] = [
  { re: /白卡|单粉|粉纸|单铜/i, value: "white_card" },
  { re: /灰底白板|灰板|灰底|白板纸/i, value: "grey_board" },
  { re: /铜版|铜板|art/i, value: "coated_paper" },
  { re: /牛皮|牛卡|kraft/i, value: "kraft" },
  { re: /金银卡|镭射|特种/i, value: "special" },
];

// 彩盒克重可选值（snap 到最近档）
const CB_G_OPTIONS = ["250", "300", "350", "400", "450"];

// 彩盒表面处理：在通用 SURFACE_MAP 基础上补 emboss（压纹/击凸/凹凸）
const CB_SURFACE_MAP: { re: RegExp; value: string }[] = [
  { re: /烫金|烫银|烫印/, value: "foil" },
  { re: /哑膜|哑光膜|雾膜|消光膜/, value: "matte_laminate" },
  { re: /亮膜|光膜/, value: "gloss_laminate" },
  { re: /UV|紫外/i, value: "uv" },
  { re: /过油|上光|印油|光油/, value: "varnish" },
  { re: /压纹|击凸|凹凸|压凹凸|浮雕/, value: "emboss" },
];

const colorPrintBoxParser: MaterialParser = (raw) => {
  const text = normalize(raw);
  const result: ParsedSpec = {};

  // 纸张类型
  for (const { re, value } of CB_PAPER_TYPE) {
    if (re.test(text)) {
      result.material = value;
      break;
    }
  }

  // 克重：取文本中所有带 g 的数字，彩盒多为单层，取最大值作主克重
  const gRe = /(\d+(?:\.\d+)?)\s*g\b/gi;
  const grams: number[] = [];
  let gm: RegExpExecArray | null;
  while ((gm = gRe.exec(text))) grams.push(Number(gm[1]));
  if (grams.length) {
    result.grammage = snapTo(Math.max(...grams), CB_G_OPTIONS);
  }

  // CMYK 色数（已增强支持 "4C"）
  for (const { re, value } of COLOR_MAP) {
    if (re.test(text)) {
      result.colorCount = value;
      break;
    }
  }

  // 专色
  const spot = text.match(/专色\s*(\d+)/i) || text.match(/(\d+)\s*专色/i);
  if (spot) result.spotColorCount = Number(spot[1]);
  else if (/专色/.test(text)) result.spotColorCount = 1;

  // 表面处理
  for (const { re, value } of CB_SURFACE_MAP) {
    if (re.test(text)) {
      result.surfaceTreatment = value;
      break;
    }
  }

  result.unparsed = collectUnrecognized(raw); // 未识别片段进待审词典池
  return result;
};

// ============ 注册表分发 ============

const REGISTRY: Record<string, MaterialParser> = {
  flat_print: flatPrintParser,
  corrugated_box: corrugatedBoxParser,
  color_print_box: colorPrintBoxParser,
};

/** 是否存在该品类的材质解析器 */
export function hasMaterialParser(productType: string): boolean {
  return !!REGISTRY[productType];
}

/**
 * 按品类解析材质自由文本为结构化规格字段。
 * @param productType 品类 code（如 "flat_print" / "corrugated_box"）
 * @param text 原始文本（可能为 undefined / 空）
 * @returns 结构化字段；无解析器或空文本返回 {}
 */
export function parseMaterialSpec(productType: string, text?: string): ParsedSpec {
  if (!text || !text.trim()) return {};
  const parser = REGISTRY[productType];
  if (!parser) return {};
  return parser(text);
}

/**
 * 把 ParsedSpec 合并进 AnalysisInput（仅填补未定义的键，不覆盖已有值）。
 * 显式列（如独立克重列）的值优先于材质文本推断，故材质解析只补缺。
 */
export function applyParsedSpec(
  input: AnalysisInput,
  spec: ParsedSpec,
): AnalysisInput {
  const out: AnalysisInput = { ...input };
  if (spec.material !== undefined && out.material === undefined)
    out.material = spec.material;
  if (spec.grammage !== undefined && out.grammage === undefined)
    out.grammage = spec.grammage;
  if (spec.coverGrammage !== undefined && out.coverGrammage === undefined)
    out.coverGrammage = spec.coverGrammage;
  if (spec.colorCount !== undefined && out.colorCount === undefined)
    out.colorCount = spec.colorCount;
  if (spec.spotColorCount !== undefined && out.spotColorCount === undefined)
    out.spotColorCount = spec.spotColorCount;
  if (spec.surfaceTreatment !== undefined && out.surfaceTreatment === undefined)
    out.surfaceTreatment = spec.surfaceTreatment;

  // 瓦楞纸箱专用字段
  if (spec.boardStructure !== undefined && (out as any).boardStructure === undefined)
    (out as any).boardStructure = spec.boardStructure;
  if (spec.fluteType !== undefined && (out as any).fluteType === undefined)
    (out as any).fluteType = spec.fluteType;
  if (spec.linerMaterial !== undefined && (out as any).linerMaterial === undefined)
    (out as any).linerMaterial = spec.linerMaterial;
  if (spec.linerGrammage !== undefined && (out as any).linerGrammage === undefined)
    (out as any).linerGrammage = spec.linerGrammage;
  if (spec.fluteGrammage !== undefined && (out as any).fluteGrammage === undefined)
    (out as any).fluteGrammage = spec.fluteGrammage;
  if (spec.mediumGrammage !== undefined && (out as any).mediumGrammage === undefined)
    (out as any).mediumGrammage = spec.mediumGrammage;

  return out;
}
