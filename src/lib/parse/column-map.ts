/**
 * 客户报价表 → 工具字段 映射层（跨品类共享 + 按品类注册）
 *
 * 客户表列名千变万化，本层用「语义别名」做模糊匹配：把「尺寸/成品尺寸/开本」都认成 dimensions，
 * 再把单元格值提取成工具的结构化字段。材质文本格走 parseMaterialSpec（注册表分发）。
 *
 * 数据卫生（见知识库防污染政策）：
 * - **价格字段(单价/总价)不进 AnalysisInput**，单独放入 price 桶，仅用于当次对比，绝不持久化进知识库。
 * - 规格字段(材质/克重/色数/尺寸/数量/装订…)可沉淀。
 *
 * 扩展新品类：在 REGISTRY 注册 productType -> CustomerTableConfig（headerAliases + build）。
 */
import type { AnalysisInput } from "@/types";
import { parseMaterialSpec, applyParsedSpec } from "./material-spec";

export interface PriceInfo {
  unitPrice?: number;
  totalPrice?: number;
  currency: string;
}

/** 待审词典候选（导入时捕获的未收录类目描述词；人工确认后落为覆盖，不污染知识库） */
export interface DictCandidateInput {
  token: string;
  suggestedField?: string;
  confidence?: number;
}

export interface DictCandidate extends DictCandidateInput {
  productType: string;
  scope: "header" | "material_text";
}

/** 解析期加载的已确认覆盖（由 dict-store 提供，服务端内存解析用） */
export interface ResolvedOverrides {
  /** 表头 token(归一化) -> 语义字段 key */
  header: Record<string, string>;
  /** 材质文本 token -> 覆盖字段/值 */
  material: { token: string; field: string; value?: string }[];
}

export interface MappedProduct {
  name?: string;
  /** 结构化输入（不含价格） */
  input: Partial<AnalysisInput>;
  /** 价格桶：仅当次对比用，不进知识库 */
  price?: PriceInfo;
  /** 未匹配到的原始列名（透明展示） */
  unmatched: string[];
  notes: string[];
  /** 本次解析捕获的待审词典候选（表头未匹配 / 材质未识别片段） */
  dictCandidates?: DictCandidate[];
}

export interface CustomerTableConfig {
  /** 语义键 -> 匹配的表头子串（归一化后包含即命中） */
  headerAliases: Record<string, string[]>;
  /** 把「语义键 -> 原始值」映射为工具输入 + 价格 */
  build: (
    cells: Record<string, string>,
  ) => {
    name?: string;
    input: Partial<AnalysisInput>;
    price?: PriceInfo;
    notes: string[];
    /** 材质文本中未识别片段（进待审词典池） */
    dictCandidates?: DictCandidateInput[];
  };
}

// ============ 共享提取工具 ============

function norm(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** "210*285" / "210×285" / "210x285" -> {length,width} */
export function parseDimensions(text?: string): {
  length?: number;
  width?: number;
} {
  if (!text) return {};
  const m = String(text).match(
    /(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)/,
  );
  if (m) return { length: Number(m[1]), width: Number(m[2]) };
  return {};
}

/** 数量阶梯 "500/1000/2000" -> 取最小起订量；单值直接取 */
export function parseQuantity(text?: string): number | undefined {
  if (text == null) return undefined;
  const nums = String(text)
    .match(/\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter((n) => n > 0);
  if (!nums || !nums.length) return undefined;
  return Math.min(...nums);
}

/** 提取页数数字： "32P" / "32页" / "32" */
export function parsePages(text?: string): number | undefined {
  if (text == null) return undefined;
  const m = String(text).match(/(\d+)\s*(?:p|页|面)?/i);
  return m ? Number(m[1]) : undefined;
}

const PRINT_METHOD: { re: RegExp; value: string }[] = [
  { re: /柔印|水印|flexo/i, value: "flexo" },
  { re: /数码|数字|喷墨/, value: "digital" },
  { re: /胶印|平印|offset/i, value: "offset" },
];

/** "210*285*60" / "210×285×60" -> {length,width,height} */
export function parseDimensions3D(text?: string): {
  length?: number;
  width?: number;
  height?: number;
} {
  if (!text) return {};
  const m = String(text).match(
    /(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)/,
  );
  if (m) return { length: Number(m[1]), width: Number(m[2]), height: Number(m[3]) };
  // 也兼容 长×宽（无高）退化为 2D
  const m2 = String(text).match(
    /(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)/,
  );
  if (m2) return { length: Number(m2[1]), width: Number(m2[2]) };
  return {};
}

const BOX_TYPE: { re: RegExp; value: string }[] = [
  { re: /模切|啤|刀模|die.?cut/i, value: "die_cut" },
  { re: /折叠|折合|folder/i, value: "folder" },
  { re: /开槽|普通箱|常规箱|RSC|rsc/i, value: "rsc" },
];

export function mapBoxType(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of BOX_TYPE) if (re.test(text)) return value;
  return undefined;
}

const BOARD: { re: RegExp; value: string }[] = [
  { re: /三瓦|七层|7\s*层/, value: "triple" },
  { re: /双瓦|五层|5\s*层/, value: "double" },
  { re: /单瓦|三层|3\s*层/, value: "single" },
];

export function mapBoard(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of BOARD) if (re.test(text)) return value;
  return undefined;
}

const FLUTE: { re: RegExp; value: string }[] = [
  { re: /AB\s*坑|AB双坑/i, value: "AB" },
  { re: /BC\s*坑|BC双坑/i, value: "BC" },
  { re: /BE\s*坑|BE双坑/i, value: "BE" },
  { re: /A\s*坑/i, value: "A" },
  { re: /B\s*坑/i, value: "B" },
  { re: /C\s*坑/i, value: "C" },
  { re: /E\s*坑/i, value: "E" },
  { re: /F\s*坑/i, value: "F" },
];

export function mapFlute(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of FLUTE) if (re.test(text)) return value;
  return undefined;
}

const COLOR_COUNT: { re: RegExp; value: string }[] = [
  { re: /四色|4\s*色|CMYK/i, value: "4" },
  { re: /三色|3\s*色/, value: "3" },
  { re: /双色|2\s*色/, value: "2" },
  { re: /单色|1\s*色/, value: "1" },
];

export function mapColorCount(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of COLOR_COUNT) if (re.test(text)) return value;
  return undefined;
}

const SURFACE_SHORT: { re: RegExp; value: string }[] = [
  { re: /无|素箱|免处理|不处理|不做/i, value: "none" },
  { re: /烫金|烫银/, value: "foil" },
  { re: /哑膜|哑光膜|雾膜/, value: "matte_laminate" },
  { re: /亮膜|光膜/, value: "gloss_laminate" },
  { re: /UV/i, value: "uv" },
  { re: /过油|上光|印油/, value: "varnish" },
];

export function mapSurface(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of SURFACE_SHORT) if (re.test(text)) return value;
  return undefined;
}

/** 粘箱/成型 等布尔列：是/需要/粘/钉/成型 -> true；否/免/无 -> false；空 -> undefined */
export function mapBool(text?: string): boolean | undefined {
  if (text == null || String(text).trim() === "") return undefined;
  if (/是|需要|粘|钉|成型|糊|true|yes/i.test(text)) return true;
  if (/否|不|免|无|不用|false|no/i.test(text)) return false;
  return undefined;
}

export function mapPrintMethod(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of PRINT_METHOD) if (re.test(text)) return value;
  return undefined;
}

const BINDING: { re: RegExp; value: string }[] = [
  { re: /骑马[钉订]|骑订/, value: "saddle" },
  { re: /无线胶装|胶装|perfect/i, value: "perfect" },
  { re: /锁线/, value: "thread_sewn" },
  { re: /精装|硬壳/, value: "hardcover" },
  { re: /圈装|yo|铁圈|螺旋/, value: "spiral" },
  { re: /折页|对折/, value: "fold" },
  { re: /散页|单张|不装订|无装订/, value: "none" },
];

export function mapBinding(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of BINDING) if (re.test(text)) return value;
  return undefined;
}

const REGION: { re: RegExp; value: string }[] = [
  { re: /华东|上海|江苏|浙江/, value: "east_china" },
  { re: /华南|深圳|广州|广东/, value: "south_china" },
  { re: /华北|北京|天津/, value: "north_china" },
  { re: /华中|武汉|湖南|湖北/, value: "central_china" },
  { re: /西南|成都|重庆|四川/, value: "southwest" },
  { re: /东北|辽宁|沈阳|黑龙江/, value: "northeast" },
];

export function mapRegion(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of REGION) if (re.test(text)) return value;
  return undefined;
}

const LEADTIME: { re: RegExp; value: string }[] = [
  { re: /特急|3\s*[-~]?\s*5\s*天?/, value: "express" },
  { re: /加急|急|7\s*[-~]?\s*10\s*天?/, value: "urgent" },
  { re: /标准|常规|15\s*[-~]?\s*20\s*天?|15\s*天/, value: "standard" },
];

export function mapLeadTime(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of LEADTIME) if (re.test(text)) return value;
  return undefined;
}

/** 价格文本 "¥1,234.50" / "1234.5" -> number */
export function parseMoney(text?: string): number | undefined {
  if (text == null) return undefined;
  const cleaned = String(text).replace(/[¥￥,\s]/g, "");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function detectCurrency(text?: string): string {
  if (!text) return "CNY";
  if (/[$]|usd|美元/i.test(text)) return "USD";
  if (/[¥￥]|rmb|元/i.test(text)) return "CNY";
  return "CNY";
}

// ============ 彩印纸盒专用映射 ============

const COLOR_BOX_TYPE: { re: RegExp; value: string }[] = [
  { re: /天地盖|翻盖|精品|礼盒|书型|抽屉|磁吸/, value: "rigid_cover" },
  { re: /异形|开窗|手提|特殊|吸塑|组合/, value: "special_window" },
  { re: /扣底|插口|自锁|标准|管式|普通|折叠|粘盒/, value: "tuck_end" },
];

export function mapColorBoxType(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of COLOR_BOX_TYPE) if (re.test(text)) return value;
  return undefined;
}

const COLOR_BOX_FLUTE: { re: RegExp; value: string }[] = [
  { re: /无|不裱|不坑|无坑|单张|非瓦/, value: "none" },
  { re: /E\s*坑|E\s*瓦|e坑|e瓦/i, value: "E_flute" },
  { re: /B\s*坑|B\s*瓦|b坑|b瓦/i, value: "B_flute" },
];

export function mapColorBoxFlute(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of COLOR_BOX_FLUTE) if (re.test(text)) return value;
  return undefined;
}

const COLOR_BOX_SURFACE: { re: RegExp; value: string }[] = [
  { re: /烫金|烫银|烫印/, value: "foil" },
  { re: /哑膜|哑光膜|雾膜|消光/, value: "matte_laminate" },
  { re: /亮膜|光膜/, value: "gloss_laminate" },
  { re: /UV|紫外/, value: "uv" },
  { re: /压纹|击凸|凹凸|浮雕/, value: "emboss" },
  { re: /过油|上光|光油|印油/, value: "varnish" },
  { re: /无|免|不做|不处理|素/, value: "none" },
];

export function mapColorBoxSurface(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { re, value } of COLOR_BOX_SURFACE) if (re.test(text)) return value;
  return undefined;
}

const CB_G_OPTIONS = ["250", "300", "350", "400", "450"];

/** 克重文本（如 "350g"）吸附到彩盒档位 */
export function snapGrammageCB(text?: string): string | undefined {
  if (text == null) return undefined;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*g?/i);
  if (!m) return undefined;
  const g = Number(m[1]);
  let best = CB_G_OPTIONS[0];
  let bestDiff = Infinity;
  for (const opt of CB_G_OPTIONS) {
    const diff = Math.abs(Number(opt) - g);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

// ============ 平面彩印配置 ============

const flatPrintConfig: CustomerTableConfig = {
  headerAliases: {
    name: ["产品名称", "品名", "名称", "货物名称"],
    dimensions: ["尺寸", "成品尺寸", "开本", "规格", "成品规格"],
    material: [
      "材质",
      "材料",
      "纸张",
      "材质及后道工艺",
      "后道工艺",
      "用料",
      "工艺",
    ],
    quantity: ["数量", "印量", "册数", "份数", "印数"],
    printMethod: ["印刷方式", "印法", "印刷"],
    pages: ["页数", "页码", "p数", "面数"],
    binding: ["装订", "装帧", "装订方式"],
    delivery: ["交付地", "收货地", "地区", "交货地", "目的地"],
    leadTime: ["交期", "工期", "交货期", "货期"],
    unitPrice: ["单价", "价格", "报价", "含税单价"],
    totalPrice: ["总价", "金额", "合计", "含税金额"],
  },
  build(cells) {
    const input: Partial<AnalysisInput> = {};
    const notes: string[] = [];
    const name = cells.name; // 非成本字段，仅作行标识，不放进 input

    const dim = parseDimensions(cells.dimensions);
    if (dim.length) input.length = dim.length;
    if (dim.width) input.width = dim.width;
    if (!dim.length && cells.dimensions)
      notes.push(`尺寸「${cells.dimensions}」未识别为 长*宽`);

    const qty = parseQuantity(cells.quantity);
    if (qty) input.quantity = qty;

    const pages = parsePages(cells.pages);
    if (pages) input.pages = pages;

    const pm = mapPrintMethod(cells.printMethod);
    if (pm) input.printMethod = pm;

    const bd = mapBinding(cells.binding);
    if (bd) input.binding = bd;

    const region = mapRegion(cells.delivery);
    if (region) input.deliveryLocation = region;

    const lt = mapLeadTime(cells.leadTime);
    if (lt) input.targetDelivery = lt;

    // 材质文本格 → 结构化（注册表分发）
    let matCands: DictCandidateInput[] = [];
    if (cells.material) {
      const spec = parseMaterialSpec("flat_print", cells.material);
      Object.assign(input, applyParsedSpec(input as AnalysisInput, spec));
      matCands = spec.unparsed?.filter(Boolean).map((t) => ({ token: t })) ?? [];
    }

    // 价格桶（仅当次对比，不进 input）
    const unitPrice = parseMoney(cells.unitPrice);
    const totalPrice = parseMoney(cells.totalPrice);
    let price: PriceInfo | undefined;
    if (unitPrice != null || totalPrice != null) {
      price = {
        unitPrice: unitPrice ?? undefined,
        totalPrice: totalPrice ?? undefined,
        currency: detectCurrency(cells.unitPrice || cells.totalPrice),
      };
    }

    return { name, input, price, notes, dictCandidates: matCands };
  },
};

// ============ 瓦楞纸箱配置 ============

const corrugatedBoxConfig: CustomerTableConfig = {
  headerAliases: {
    name: ["产品名称", "品名", "名称", "货物名称", "箱号", "箱型编号", "货号"],
    length: ["长", "长度", "外径长", "箱内长", "l"],
    width: ["宽", "宽度", "外径宽", "箱内宽", "w"],
    height: ["高", "高度", "外径高", "箱内高", "h"],
    dimensions: ["尺寸", "规格", "纸箱尺寸", "长宽高", "外径尺寸", "箱规"],
    boxType: ["箱型", "箱型结构", "结构", "箱式"],
    boardStructure: ["纸板结构", "层数", "瓦楞层数", "几层", "纸板层数"],
    fluteType: ["坑型", "楞型", "瓦楞", "坑别", "flute"],
    material: ["材质", "材料", "纸张", "用料", "纸板材质", "面纸", "里纸"],
    quantity: ["数量", "订单量", "印量", "只数", "套数", "箱数"],
    printMethod: ["印刷方式", "印法", "印刷"],
    colorCount: ["色数", "印刷色数", "几色", "颜色数"],
    surfaceTreatment: ["表面处理", "后道", "表面", "工艺"],
    needGluing: ["粘箱", "成型", "钉箱", "糊盒", "粘盒"],
    delivery: ["交付地", "收货地", "地区", "交货地", "目的地"],
    leadTime: ["交期", "工期", "交货期", "货期"],
    unitPrice: ["单价", "价格", "报价", "含税单价"],
    totalPrice: ["总价", "金额", "合计", "含税金额"],
  },
  build(cells) {
    const input: Partial<AnalysisInput> = {};
    const notes: string[] = [];
    const name = cells.name;

    // 尺寸：优先 长/宽/高 三列，否则 3D 解析
    if (cells.length && cells.width && cells.height) {
      const l = Number(cells.length),
        w = Number(cells.width),
        h = Number(cells.height);
      if (!isNaN(l)) input.length = l;
      if (!isNaN(w)) input.width = w;
      if (!isNaN(h)) input.height = h;
    } else if (cells.dimensions) {
      const d = parseDimensions3D(cells.dimensions);
      if (d.length) input.length = d.length;
      if (d.width) input.width = d.width;
      if (d.height) input.height = d.height;
      if (!d.length)
        notes.push(`尺寸「${cells.dimensions}」未识别为 长*宽*高`);
    }

    const qty = parseQuantity(cells.quantity);
    if (qty) input.quantity = qty;

    const box = mapBoxType(cells.boxType);
    if (box) input.boxType = box;

    const board = mapBoard(cells.boardStructure);
    if (board) input.boardStructure = board;

    const flute = mapFlute(cells.fluteType);
    if (flute) input.fluteType = flute;

    const pm = mapPrintMethod(cells.printMethod);
    if (pm) input.printMethod = pm;

    const cc = mapColorCount(cells.colorCount);
    if (cc) input.colorCount = cc;

    const surf = mapSurface(cells.surfaceTreatment);
    if (surf) input.surfaceTreatment = surf;

    const glue = mapBool(cells.needGluing);
    if (glue !== undefined) input.needGluing = glue;

    const region = mapRegion(cells.delivery);
    if (region) input.deliveryLocation = region;

    const lt = mapLeadTime(cells.leadTime);
    if (lt) input.targetDelivery = lt;

    // 材质文本格 → 结构化（注册表分发到 corrugated_box 解析器）
    let matCands: DictCandidateInput[] = [];
    if (cells.material) {
      const spec = parseMaterialSpec("corrugated_box", cells.material);
      Object.assign(input, applyParsedSpec(input as AnalysisInput, spec));
      matCands = spec.unparsed?.filter(Boolean).map((t) => ({ token: t })) ?? [];
    }

    // 价格桶（仅当次对比，不进 input）
    const unitPrice = parseMoney(cells.unitPrice);
    const totalPrice = parseMoney(cells.totalPrice);
    let price: PriceInfo | undefined;
    if (unitPrice != null || totalPrice != null) {
      price = {
        unitPrice: unitPrice ?? undefined,
        totalPrice: totalPrice ?? undefined,
        currency: detectCurrency(cells.unitPrice || cells.totalPrice),
      };
    }

    return { name, input, price, notes, dictCandidates: matCands };
  },
};

// ============ 彩印纸盒配置 ============

const colorPrintBoxConfig: CustomerTableConfig = {
  headerAliases: {
    name: ["产品名称", "品名", "名称", "货号", "款号", "盒号", "型号"],
    length: ["长", "长度", "盒长", "外径长", "l", "长(mm)"],
    width: ["宽", "宽度", "盒宽", "外径宽", "w", "宽(mm)"],
    height: ["高", "高度", "盒高", "外径高", "h", "高(mm)"],
    dimensions: ["尺寸", "规格", "成品尺寸", "彩盒尺寸", "长宽高", "盒规", "外形尺寸"],
    boxType: ["盒型", "盒型结构", "结构", "款式", "盒式", "盒种类"],
    material: ["材质", "材料", "纸张", "用料", "纸张材质", "面纸", "卡纸", "纸板材质"],
    grammage: ["克重", "克数", "gsm", "g/m2", "平方克重", "纸张克重"],
    fluteType: ["坑型", "裱坑", "瓦楞坑", "裱纸坑型"],
    printMethod: ["印刷方式", "印法", "印刷"],
    colorCount: ["色数", "印刷色数", "几色", "颜色数", "cmyk"],
    spotColorCount: ["专色", "专色数", "专色色数"],
    surfaceTreatment: ["表面处理", "后道", "表面", "工艺", "表面工艺"],
    needGluing: ["糊盒", "粘盒", "成型", "是否糊盒"],
    provideReadyDesign: ["完稿", "完稿文件", "已提供文件", "刀模图", "提供稿件"],
    delivery: ["交付地", "收货地", "地区", "交货地", "目的地", "出货地"],
    leadTime: ["交期", "工期", "交货期", "货期"],
    quantity: ["数量", "订单量", "印量", "只数", "套数", "盒数", "订货量"],
    unitPrice: ["单价", "价格", "报价", "含税单价"],
    totalPrice: ["总价", "金额", "合计", "含税金额"],
  },
  build(cells) {
    const input: Partial<AnalysisInput> = {};
    const notes: string[] = [];
    const name = cells.name;

    // 材质文本 → 结构化（先填，显式列后覆盖）
    let matCands: DictCandidateInput[] = [];
    if (cells.material) {
      const spec = parseMaterialSpec("color_print_box", cells.material);
      Object.assign(input, applyParsedSpec(input as AnalysisInput, spec));
      matCands = spec.unparsed?.filter(Boolean).map((t) => ({ token: t })) ?? [];
    }

    // 尺寸：优先 长/宽/高 三列，否则 3D 解析
    if (cells.length && cells.width && cells.height) {
      const l = Number(cells.length),
        w = Number(cells.width),
        h = Number(cells.height);
      if (!isNaN(l)) input.length = l;
      if (!isNaN(w)) input.width = w;
      if (!isNaN(h)) input.height = h;
    } else if (cells.dimensions) {
      const d = parseDimensions3D(cells.dimensions);
      if (d.length) input.length = d.length;
      if (d.width) input.width = d.width;
      if (d.height) input.height = d.height;
      if (!d.length)
        notes.push(`尺寸「${cells.dimensions}」未识别为 长*宽*高`);
    }

    const qty = parseQuantity(cells.quantity);
    if (qty) input.quantity = qty;

    const box = mapColorBoxType(cells.boxType);
    if (box) input.boxType = box;

    // 显式克重列覆盖材质文本推断
    const g = snapGrammageCB(cells.grammage);
    if (g) input.grammage = g;

    const flute = mapColorBoxFlute(cells.fluteType);
    if (flute) input.fluteType = flute;

    const pm = mapPrintMethod(cells.printMethod);
    if (pm) input.printMethod = pm;

    const cc = mapColorCount(cells.colorCount);
    if (cc) input.colorCount = cc;

    const spot = parseQuantity(cells.spotColorCount);
    if (spot != null) input.spotColorCount = spot;

    const surf = mapColorBoxSurface(cells.surfaceTreatment);
    if (surf) input.surfaceTreatment = surf;

    const glue = mapBool(cells.needGluing);
    if (glue !== undefined) input.needGluing = glue;

    const ready = mapBool(cells.provideReadyDesign);
    if (ready !== undefined) input.provideReadyDesign = ready;

    const region = mapRegion(cells.delivery);
    if (region) input.deliveryLocation = region;

    const lt = mapLeadTime(cells.leadTime);
    if (lt) input.targetDelivery = lt;

    // 价格桶（仅当次对比，不进 input）
    const unitPrice = parseMoney(cells.unitPrice);
    const totalPrice = parseMoney(cells.totalPrice);
    let price: PriceInfo | undefined;
    if (unitPrice != null || totalPrice != null) {
      price = {
        unitPrice: unitPrice ?? undefined,
        totalPrice: totalPrice ?? undefined,
        currency: detectCurrency(cells.unitPrice || cells.totalPrice),
      };
    }

    return { name, input, price, notes, dictCandidates: matCands };
  },
};

// ============ 注册表分发 ============

const REGISTRY: Record<string, CustomerTableConfig> = {
  flat_print: flatPrintConfig,
  corrugated_box: corrugatedBoxConfig,
  color_print_box: colorPrintBoxConfig,
};

export function hasColumnMap(productType: string): boolean {
  return !!REGISTRY[productType];
}

/**
 * 品类强特征（signature）：命中即直接判定，避免共享列名（尺寸/材质/数量…）互相干扰。
 * 例如瓦楞表含「坑型/箱型/纸板结构」即判 corrugated_box；画册含「装订/页数/铜版」即判 flat_print。
 */
const SIGNATURE: Record<string, string[]> = {
  flat_print: ["装订", "页数", "铜版", "铜板", "骑马钉", "骑订", "胶装", "锁线", "精装"],
  corrugated_box: ["坑型", "楞型", "瓦楞", "箱型", "纸板结构", "纸箱", "瓦楞纸箱"],
  color_print_box: [
    "彩盒",
    "彩印盒",
    "彩印纸盒",
    "天地盖",
    "扣底",
    "精品盒",
    "礼盒",
    "彩印",
    "折叠盒",
    "开窗盒",
  ],
};

/**
 * 按表头自动识别品类：
 *  1) 强特征(signature)优先——命中即返回；
 *  2) 回退到通用别名命中计数，取最高分者；
 *  3) 无任一命中返回 undefined（调用方再让用户手动选品类）。
 */
export function detectProductType(headers: string[]): string | undefined {
  const normHeaders = headers.map((h) => norm(String(h)));

  for (const [code, sigs] of Object.entries(SIGNATURE)) {
    if (normHeaders.some((h) => sigs.some((s) => h.includes(norm(s))))) return code;
  }

  let best: { code: string; score: number } | undefined;
  for (const [code, config] of Object.entries(REGISTRY)) {
    let score = 0;
    for (const aliases of Object.values(config.headerAliases)) {
      if (normHeaders.some((h) => aliases.some((a) => h.includes(norm(a)))))
        score++;
    }
    if (!best || score > best.score) best = { code, score };
  }
  return best && best.score > 0 ? best.code : undefined;
}

/**
 * 列出所有品类注册表的语义字段 key（用于待审词典确认时的字段白名单与自动建议）。
 */
export function getSemanticFieldKeys(): string[] {
  const set = new Set<string>();
  for (const cfg of Object.values(REGISTRY))
    for (const k of Object.keys(cfg.headerAliases)) set.add(k);
  return [...set];
}

/**
 * 确定性自动建议：为未匹配表头 token 猜测其语义字段（无 LLM）。
 * 策略：遍历所有注册表的别名，按「子串包含」或「字符交集」打分，取最高者。
 */
export function suggestField(token: string): {
  field?: string;
  confidence: number;
} {
  const t = norm(String(token));
  if (!t) return { confidence: 0 };
  let bestField: string | undefined;
  let bestScore = 0;
  for (const cfg of Object.values(REGISTRY)) {
    for (const [field, aliasArr] of Object.entries(cfg.headerAliases)) {
      for (const a of aliasArr) {
        const na = norm(a);
        if (!na) continue;
        let score = 0;
        if (t.includes(na)) score = na.length;
        else if (na.includes(t)) score = t.length;
        else {
          const shared = [...new Set(t.split(""))].filter((ch) =>
            na.includes(ch),
          ).length;
          score = shared;
        }
        if (score > bestScore) {
          bestScore = score;
          bestField = field;
        }
      }
    }
  }
  const confidence =
    bestScore > 0 ? Math.min(1, bestScore / Math.max(t.length, 2)) : 0;
  return { field: bestScore > 0 ? bestField : undefined, confidence };
}

/**
 * 把一组表头 + 数据行映射为工具结构化产品列表。
 * @param productType 品类 code
 * @param headers 原始表头数组
 * @param rows 原始数据行（与 headers 对齐的值数组）
 * @param overrides 已确认的词典覆盖（人工审核后落库），使学过的新词即时生效
 * @returns 每个产品含 input(不含价) + price(可选) + 未匹配列 + 待审词典候选
 */
export function mapCustomerSheet(
  productType: string,
  headers: string[],
  rows: (string | number | undefined)[][],
  overrides?: ResolvedOverrides,
): MappedProduct[] {
  const config = REGISTRY[productType];
  if (!config) {
    return rows.map(() => ({
      input: {},
      unmatched: [...headers],
      notes: ["无该品类的列映射配置"],
    }));
  }

  // 1. 表头 -> 语义键（先内置别名，再叠加已确认覆盖）
  const normHeaders = headers.map((h) => ({ raw: h, key: norm(String(h)) }));
  const semanticToHeaderIdx: Record<string, number[]> = {};
  for (const [semantic, aliases] of Object.entries(config.headerAliases)) {
    normHeaders.forEach((h, idx) => {
      if (aliases.some((a) => h.key.includes(norm(a)))) {
        (semanticToHeaderIdx[semantic] ??= []).push(idx);
      }
    });
  }
  // 生效层：用户学过的表头别名优先于内置
  if (overrides?.header) {
    for (const [token, field] of Object.entries(overrides.header)) {
      const nt = norm(token);
      if (!nt) continue;
      normHeaders.forEach((h, idx) => {
        if (h.key.includes(nt) || nt.includes(h.key)) {
          (semanticToHeaderIdx[field] ??= []).push(idx);
        }
      });
    }
  }
  const matchedHeaderIdx = new Set(
    Object.values(semanticToHeaderIdx).flat(),
  );

  // 2. 逐行映射
  return rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const [semantic, idxs] of Object.entries(semanticToHeaderIdx)) {
      const v = row[idxs[0]];
      if (v != null && String(v).trim() !== "")
        cells[semantic] = String(v).trim();
    }
    const { name, input, price, notes, dictCandidates: matCands } =
      config.build(cells);

    // 生效层：材质文本里学过的片段 -> 直接补全字段
    if (overrides?.material && cells.material) {
      for (const ov of overrides.material) {
        if (
          cells.material.includes(ov.token) &&
          (input as Record<string, unknown>)[ov.field] === undefined
        ) {
          (input as Record<string, unknown>)[ov.field] = ov.value ?? ov.token;
        }
      }
    }

    // 捕获层：表头未匹配 -> 待审候选（已学过的不再重复捕获）
    const learnedHeaders = overrides
      ? new Set(Object.keys(overrides.header).map(norm))
      : new Set<string>();
    const learnedMat = overrides
      ? new Set(overrides.material.map((o) => o.token))
      : new Set<string>();
    const unmatched = normHeaders
      .filter((_, idx) => !matchedHeaderIdx.has(idx))
      .map((h) => h.raw);
    const headerCands: DictCandidate[] = unmatched
      .filter((h) => !learnedHeaders.has(norm(h)))
      .map((h) => {
        const s = suggestField(h);
        return {
          token: h,
          productType,
          scope: "header",
          suggestedField: s.field,
          confidence: s.confidence,
        };
      });
    const matDict: DictCandidate[] = (matCands ?? [])
      .filter((c) => !learnedMat.has(c.token))
      .map((c) => ({
        ...c,
        productType,
        scope: "material_text",
      }));
    const dictCandidates = [...headerCands, ...matDict];
    return { name, input, price, unmatched, notes, dictCandidates };
  });
}
