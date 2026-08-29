import type { AnalysisInput, DielineShape, ProductTypeConfig, ValidationIssue } from "@/types";
import {
  calculateExpandedArea,
  getDynamicLossRate,
  getBoxType,
  getFluteType,
  computeDielineArea,
  type BoxTypeConfig,
  type FluteConfig,
} from "@/lib/cost-rules";

/**
 * 共享派生上下文（dataflow 形态的非零通信）
 *
 * 在 fan-out 调用各 Specialist 之前，由 deriveAnalysisContext 一次性计算所有
 * 共享派生量（展开面积 / 净面积 / 拼版后面积 / 印刷总面积 / 数量 / 动态损耗率 /
 * 解析后的盒型与坑型等）。Specialist 只读消费此上下文，不再各自重算，
 * 从而保证派生量单一真相源、消除重复计算，且不会因迭代而跑偏。
 *
 * 支持多品类：productType 决定派生量算法（彩盒按盒型展开面积；平面彩印按
 * 单张成品面积 × 页数 × 数量 计算总印张面积）。
 */
export interface AnalysisContext {
  // 解析后的原始标量
  length: number;
  width: number;
  height: number;
  quantity: number;
  material: string;
  grammage: string;
  /** 封面克重（仅带封面的装订方式有值；散页/折页为空） */
  coverGrammage: string;
  /** 瓦楞纸箱：纸板结构（单瓦3层/双瓦5层/三瓦7层） */
  boardStructure: "single" | "double" | "triple";
  /** 瓦楞纸箱：面纸/里纸材质（挂面纸） */
  linerMaterial: string;
  /** 瓦楞纸箱：面纸/里纸克重 g/m² */
  linerGrammage: string;
  /** 瓦楞纸箱：芯纸克重 g/m²（平张状态） */
  fluteGrammage: string;
  /** 瓦楞纸箱：中纸克重 g/m²（仅双瓦/三瓦） */
  mediumGrammage: string;
  printMethod: string;
  surface: string;
  needGluing: boolean;
  colorCountRaw: string;
  cmykColors: number;
  spotColors: number;
  /** 烫金/凹凸局部覆盖率等级（默认 medium=8%） */
  surfaceCoverageLevel: "low" | "medium" | "high";
  /** 预留：稿件自动估算的覆盖率（0~1），优先级高于等级 */
  surfaceCoverageOverride?: number;
  laborRegion?: string;
  delivery: string;
  urgency: string;
  provideReadyDesign: boolean;
  /** 品类标识：color_print_box | flat_print（决定派生量与各 Agent 公式分支） */
  productType: string;

  // 解析后的结构化对象
  boxType: BoxTypeConfig;
  flute: FluteConfig;

  // 派生量（只算一次）
  area: number; // 矩形面积 mm²（彩盒=盒型展开；平面=单张成品）
  netAreaM2: number; // 理论面积（刀线净面积/单张成品）m²/个
  dielineAreaMm2: number; // 理论面积（刀线净面积）mm²
  util: number; // 默认拼版利用率（回退用）
  imposedAreaM2: number; // 实际生产面积 m²/个（含废边，报价用；回退=netAreaM2/util）
  productionAreaMm2: number; // 实际生产面积 mm²（含废边，报价用，供材料重量计算）
  productionAreaM2: number; // 实际生产面积 m²/个（含废边，报价用）
  utilization: number; // 理论使用面积占比（材料利用率）
  sheetBased: boolean; // 是否基于全张纸+只数真实计算
  areaM2Total: number; // 理论面积 × 数量（印刷/表面总量）
  lossRate: number; // 动态损耗率

  // 平面彩印派生量
  singleSheetAreaM2: number; // 单张成品面积 m²
  totalPaperAreaM2: number; // 总印张面积 m²（单张×页数×数量）
  pages: number; // 页数（海报=1）
  binding: string; // 装订方式（none/saddle/perfect/thread_sewn/hardcover/spiral/accordion/fold）
}

function num(input: AnalysisInput, key: string, fallback = 0): number {
  const v = input[key];
  return typeof v === "number" ? v : Number(v) || fallback;
}
function str(input: AnalysisInput, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : String(v || fallback);
}
function bool(input: AnalysisInput, key: string, fallback = false): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : fallback;
}

export function deriveAnalysisContext(
  input: AnalysisInput,
  productType?: string
): AnalysisContext {
  const pt = productType ?? str(input, "productType", "color_print_box");

  const length = num(input, "length", 100);
  const width = num(input, "width", 80);
  const height = num(input, "height", 50);
  const quantity = num(input, "quantity", 5000);
  const material = str(input, "material", "white_card");
  const grammageRaw = str(input, "grammage", "");
  // 瓦楞纸箱专属字段（其余品类忽略，分层计成本用）
  const boardStructureRaw = str(input, "boardStructure", "single");
  const boardStructure: "single" | "double" | "triple" =
    boardStructureRaw === "double" || boardStructureRaw === "triple"
      ? boardStructureRaw
      : "single";
  const linerMaterial = str(input, "linerMaterial", "kraft");
  const linerGrammage = str(input, "linerGrammage", "175");
  const fluteGrammage = str(input, "fluteGrammage", "120");
  const mediumGrammage = str(input, "mediumGrammage", "120");
  const     grammage =
      grammageRaw ||
      (pt === "flat_print" || pt === "label"
        ? suggestInnerGrammage(num(input, "pages", 1))
        : "350");
  // 封面克重：平面彩印且为「带封面装订」时，未显式填写则默认 250g（config 的 defaultValue 不被 applyDefaults 识别，故在此兜底）
  const COVER_BINDINGS = ["saddle", "perfect", "thread_sewn", "hardcover", "spiral", "accordion"];
  const coverGrammageRaw = str(input, "coverGrammage", "");
  const coverGrammage =
    coverGrammageRaw ||
    ((pt === "flat_print" || pt === "label") && COVER_BINDINGS.includes(str(input, "binding", "none"))
      ? "250"
      : "");
  const printMethod = str(input, "printMethod", "offset");
  const surface = str(input, "surfaceTreatment", "none");
  const needGluing = bool(input, "needGluing", true);
  const colorCountRaw = str(input, "colorCount", "4");
  const cmykColors = Number(String(colorCountRaw).split("+")[0]) || 4;
  const spotColors = num(input, "spotColorCount", 0);
  const surfaceCoverageLevelRaw = str(input, "surfaceCoverageLevel", "medium");
  const surfaceCoverageLevel: "low" | "medium" | "high" =
    surfaceCoverageLevelRaw === "low" || surfaceCoverageLevelRaw === "high"
      ? surfaceCoverageLevelRaw
      : "medium";
  const surfaceCoverageOverrideRaw = input.surfaceCoverageOverride;
  const surfaceCoverageOverride =
    typeof surfaceCoverageOverrideRaw === "number" ? surfaceCoverageOverrideRaw : undefined;
  // 人工地域：优先用显式选择；未选时回退到交付地域（统一地域体系，避免系数静默恒为1.0）
  const laborRegion =
    input.laborRegion != null
      ? String(input.laborRegion)
      : input.deliveryLocation != null
        ? String(input.deliveryLocation)
        : undefined;
  const delivery = str(input, "deliveryLocation", "east_china");
  const urgency = str(input, "targetDelivery", "standard");
  const provideReadyDesign = bool(input, "provideReadyDesign", false);

  // 盒型/坑型：平面彩印无盒型概念，用 tuck_end 作中性桩（complexity=1, pieceCount=1, 无贴窗），保证下游不崩
  const boxType = getBoxType(
    (pt === "flat_print" || pt === "label") ? "tuck_end" : str(input, "boxType", "tuck_end")
  );
  const flute = getFluteType(str(input, "fluteType", "none"));

  // 全张纸 + 每版只数（两类品类都支持，用于真实材料利用率）
  const sheetSizeRaw = input.sheetSize as { w: number; h: number } | undefined;
  const sheetW = sheetSizeRaw && sheetSizeRaw.w > 0 ? Number(sheetSizeRaw.w) : 0;
  const sheetH = sheetSizeRaw && sheetSizeRaw.h > 0 ? Number(sheetSizeRaw.h) : 0;
  const piecesPerSheet =
    typeof input.piecesPerSheet === "number" && input.piecesPerSheet > 0
      ? input.piecesPerSheet
      : 0;
  const hasSheet = sheetW > 0 && sheetH > 0 && piecesPerSheet > 0;
  const utilDefault = 0.9; // 平面彩印默认拼版利用率（开数损耗）

  // ===== 派生量：按品类分支 =====
  let singleSheetAreaM2: number;
  let totalPaperAreaM2: number;
  let pages: number;
  let binding: string;
  let netAreaM2: number;
  let dielineAreaMm2: number;
  let util: number;
  let imposedAreaM2: number;
  let productionAreaMm2: number;
  let utilization: number;

  if (pt === "flat_print" || pt === "label") {
    pages = num(input, "pages", 1);
    binding = str(input, "binding", "none");
    singleSheetAreaM2 = (length * width) / 1_000_000;
    dielineAreaMm2 = length * width; // 单张刀线面积 mm²（仅用于展示口径对齐）
    netAreaM2 = singleSheetAreaM2; // 单张面积：油墨/表面处理按单张计
    totalPaperAreaM2 = singleSheetAreaM2 * pages * quantity; // 总印张面积
    util = utilDefault;
    if (hasSheet) {
      const sheetArea = sheetW * sheetH;
      productionAreaMm2 = sheetArea / piecesPerSheet; // 每册分摊真实耗纸（含废边）
      utilization = (singleSheetAreaM2 * 1_000_000) / productionAreaMm2; // 单张利用率
      if (utilization > 1) utilization = 1;
    } else {
      productionAreaMm2 = (singleSheetAreaM2 * 1_000_000) / util;
      utilization = util;
    }
    imposedAreaM2 = productionAreaMm2 / 1_000_000;
  } else {
    const area = calculateExpandedArea(length, width, height);
    // 理论面积（刀线净面积）：覆盖优先序 dielineAreaMm2 > dielineShapes > 矩形公式
    const dielineOverride =
      typeof input.dielineAreaMm2 === "number" && input.dielineAreaMm2 > 0
        ? input.dielineAreaMm2
        : undefined;
    const dielineShapes = Array.isArray(input.dielineShapes)
      ? (input.dielineShapes as DielineShape[])
      : undefined;
    dielineAreaMm2 =
      dielineOverride ??
      (dielineShapes && dielineShapes.length > 0
        ? computeDielineArea(dielineShapes)
        : area);
    netAreaM2 = dielineAreaMm2 / 1_000_000; // 理论面积 m²/个
    util = boxType.impositionUtilization;
    if (hasSheet) {
      const sheetArea = sheetW * sheetH; // mm²
      productionAreaMm2 = sheetArea / piecesPerSheet; // 每盒分摊真实耗纸（含废边）
      utilization = dielineAreaMm2 / productionAreaMm2; // 理论使用面积占比
      if (utilization > 1) utilization = 1; // 钳制：理论面积不应超单盒分摊纸，超出为数据异常
    } else {
      productionAreaMm2 = (netAreaM2 * 1_000_000) / util; // 回退：盒型默认拼版利用率
      utilization = util;
    }
    imposedAreaM2 = productionAreaMm2 / 1_000_000;
    singleSheetAreaM2 = netAreaM2; // 彩盒无单张概念，对齐命名
    totalPaperAreaM2 = netAreaM2 * quantity;
    pages = 1;
    binding = "none";
  }

  const productionAreaM2 = productionAreaMm2 / 1_000_000;
  const areaM2Total = netAreaM2 * quantity; // 理论面积 × 数量（印刷/表面总量）
  const lossRate = getDynamicLossRate(quantity);

  return {
    productType: pt,
    length,
    width,
    height,
    quantity,
    material,
    grammage,
    coverGrammage,
    boardStructure,
    linerMaterial,
    linerGrammage,
    fluteGrammage,
    mediumGrammage,
    printMethod,
    surface,
    needGluing,
    colorCountRaw,
    cmykColors,
    spotColors,
    surfaceCoverageLevel,
    surfaceCoverageOverride,
    laborRegion,
    delivery,
    urgency,
    provideReadyDesign,
    boxType,
    flute,
    area: length * width,
    netAreaM2,
    dielineAreaMm2,
    util,
    imposedAreaM2,
    productionAreaMm2,
    productionAreaM2,
    utilization,
    sheetBased: hasSheet,
    areaM2Total,
    lossRate,
    singleSheetAreaM2,
    totalPaperAreaM2,
    pages,
    binding,
  };
}

/**
 * 平面彩印·内页克重随页数自动派生默认（伊顿报价经验梯度，仅作建议/默认，用户可覆盖）
 * ≤32P→157g、≤100P→128g、≤200P→105g、>200P→80g（厚本用轻内页控厚度与成本）
 */
export function suggestInnerGrammage(pages: number): string {
  if (pages <= 32) return "157";
  if (pages <= 100) return "128";
  if (pages <= 200) return "105";
  return "80";
}

/**
 * 平面彩印·装订可行性校验（warning，允许覆盖，不阻断分析）
 * 骑马钉受厚度限制：内页越厚可钉页数越少。超过上限仅告警，提示改用胶装等。
 */
export function validateFlatBinding(
  input: AnalysisInput,
  config: ProductTypeConfig
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (config.code !== "flat_print") return issues;
  const binding = String(input.binding ?? "none");
  if (binding !== "saddle") return issues;

  const pages = Number(input.pages) || 1;
  const innerG = Number(String(input.grammage ?? "157")) || 157;
  // 厚度上限（经验值）：≤80g→64P、≤105g→56P、≤128g→48P、>128g→40P
  let maxP = 40;
  if (innerG <= 80) maxP = 64;
  else if (innerG <= 105) maxP = 56;
  else if (innerG <= 128) maxP = 48;

  if (pages > maxP) {
    issues.push({
      type: "missing_info",
      severity: "warning",
      message: `骑马钉 + ${pages}P（内页 ${innerG}g）超过可行厚度上限约 ${maxP}P，装订可能不牢或无法钉合`,
      suggestion: "建议改用无线胶装/锁线胶装，或降低内页克重；此为可行性提示，可按实际工艺覆盖",
    });
  }
  return issues;
}
