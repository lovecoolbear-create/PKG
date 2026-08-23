import type { AnalysisInput } from "@/types";
import {
  calculateExpandedArea,
  getDynamicLossRate,
  getBoxType,
  getFluteType,
  type BoxTypeConfig,
  type FluteConfig,
} from "@/lib/cost-rules";

/**
 * 共享派生上下文（dataflow 形态的非零通信）
 *
 * 在 fan-out 调用各 Specialist 之前，由 deriveAnalysisContext 一次性计算所有
 * 共享派生量（展开面积 / 净面积 / 拼版后面积 / 印刷总面积 / 数量 / 动态损耗率 /
 * 解析后的盒型与坑型等）。6 个 Specialist 只读消费此上下文，不再各自重算，
 * 从而保证派生量单一真相源、消除重复计算，且不会因迭代而跑偏。
 */
export interface AnalysisContext {
  // 解析后的原始标量
  length: number;
  width: number;
  height: number;
  quantity: number;
  material: string;
  grammage: string;
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

  // 解析后的结构化对象
  boxType: BoxTypeConfig;
  flute: FluteConfig;

  // 派生量（只算一次）
  area: number; // 展开面积 mm²
  netAreaM2: number; // 净展开面积 m²/个
  util: number; // 拼版利用率
  imposedAreaM2: number; // 拼版后实际用纸 m²/个
  areaM2Total: number; // 净展开面积 × 数量（印刷/表面总量）
  lossRate: number; // 动态损耗率
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

export function deriveAnalysisContext(input: AnalysisInput): AnalysisContext {
  const length = num(input, "length", 100);
  const width = num(input, "width", 80);
  const height = num(input, "height", 50);
  const quantity = num(input, "quantity", 5000);
  const material = str(input, "material", "white_card");
  const grammage = str(input, "grammage", "350");
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

  const boxType = getBoxType(str(input, "boxType", "tuck_end"));
  const flute = getFluteType(str(input, "fluteType", "none"));

  const area = calculateExpandedArea(length, width, height);
  const netAreaM2 = area / 1_000_000;
  const util = boxType.impositionUtilization;
  const imposedAreaM2 = netAreaM2 / util;
  const areaM2Total = netAreaM2 * quantity;
  const lossRate = getDynamicLossRate(quantity);

  return {
    length,
    width,
    height,
    quantity,
    material,
    grammage,
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
    area,
    netAreaM2,
    util,
    imposedAreaM2,
    areaM2Total,
    lossRate,
  };
}
