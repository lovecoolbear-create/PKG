// ========== P-Physics 物理性能与工艺可行性确定性校验模块 ==========
// 在「成本估算」与「VAVE 方案过滤」两阶段，强制调用确定性物理公式进行硬过滤，
// 不依赖任何 LLM：所有结论由公式推导，可溯源、可复算。
//
// 设计铁律（§3.1 介入纪律落地）：
// - 本模块是「确定性规则层」，输出 FEASIBILITY_FAILED 的方案在 ranker 的 Rule Filter
//   阶段即被一票否决，绝不进入下游 AI 软排序 / 策略 Agent（数字守恒 + 事实守恒）。
// - 物理公式采用行业通用形式，常数源自公开文献/标准，标「待校准」处需以供应商
//   实测（ECT 检测报告、RCT 环压）回填；未校准前仅作相对趋势判定，绝对量供参考。

import type { AnalysisInput } from "@/types";
import { getFluteType } from "@/lib/cost-rules";

// ===================== 类型 =====================

/** 触发的降本杠杆（决定防踩坑规则是否运行） */
export type FeasibilityLever =
  | "reduce_grammage" // 降克重
  | "change_paper" // 换纸张/材质
  | "skip_postprint" // 省去印后工艺（去表面处理）
  | "change_flute"; // 换楞型/层数（如双坑→单坑）

/** 物理指标缺口数据：确定性层输出，供 UI 展示与审计，绝不透传 LLM */
export interface PhysicalGaps {
  predictedECT?: number;
  requiredECT?: number;
  ectDeficit?: number;
  predictedBCT?: number;
  requiredBCT?: number;
  bctDeficit?: number;
  wetAttenuation?: number;
  pickupRisk?: boolean;
  [k: string]: number | boolean | undefined;
}

/** 纯物理量计算结果（可溯源） */
export interface BoxPhysics {
  ectKNm: number; // 边压强度 kN/m
  caliperMm: number; // 纸板厚度 mm
  perimeterCm: number; // 箱周长 cm
  bctKg: number; // 抗压强度 kgf（实验室峰值）
  wetFactor: number; // 湿敏衰减系数 (0~1)
  effectiveBCT: number; // 湿敏后有效抗压 kgf
  requiredBCT: number; // 堆码安全阈值 kgf（无载荷数据时为 0）
  hasLoadData: boolean; // 是否具备 毛重/堆码层 用于载荷校验
}

/** 物理可行性校验结果（确定性层，可附带缺口数据） */
export interface FeasibilityResult {
  passed: boolean;
  /** 确定性硬过滤未通过 = FEASIBILITY_FAILED */
  failed?: boolean;
  /** 否决/告警原因（中文，确定性） */
  reason?: string;
  metrics: BoxPhysics;
  gaps: PhysicalGaps;
  /** 触发的规则 code */
  triggered: string[];
  levers: FeasibilityLever[];
  /** 方案是否触动物理属性（决定本闸门是否运行） */
  touchedPhysics: boolean;
}

/** 物理计算输入（来自 AnalysisInput 的瓦楞相关字段） */
export interface BoxPhysicalInput {
  fluteType?: string | number | undefined;
  linerMaterial?: string | undefined;
  linerGrammage?: number | string | undefined;
  mediumGrammage?: number | string | undefined; // 芯纸(fluteGrammage)
  middleGrammage?: number | string | undefined; // 中纸(mediumGrammage)
  boardStructure?: string | undefined;
  lengthMm?: number | string | undefined;
  widthMm?: number | string | undefined;
  heightMm?: number | string | undefined;
  surfaceTreatment?: string | undefined;
  /** 单箱毛重 kg（堆码载荷校验） */
  boxWeightKg?: number | undefined;
  /** 堆码层数（含本箱） */
  stackLayers?: number | undefined;
  /** 储运环境相对湿度 %（默认 50 = 标准实验室） */
  relativeHumidity?: number | undefined;
  /** 是否海运/高湿环境（影响安全系数） */
  humidEnvironment?: boolean | undefined;
  /** 已知 ECT 实测值(kN/m)，优先于估算 */
  ectKNm?: number | undefined;
}

// ===================== 常数（待校准） =====================

/**
 * McKee 公式常数（BCT = K · ECT(kN/m) · √(P(cm) · t(mm))，单位 kgf）。
 * 推导：BCT(kgf) = 5.87 · ECT(kg/cm) · √(P(cm)·t(cm))，
 * 其中 ECT(kg/cm) = ECT(kN/m) / 0.981（1 kg/cm = 0.981 kN/m），t(cm) = t(mm)/10，
 * 合并得 K = 5.87 / 0.981 / √10 ≈ 1.893。
 * 复核（packwares 实例）：ECT=22.41kg/cm=22.0kN/m, P=140cm, t=2.5mm → BCT≈779kgf ✓
 */
export const MCKEE_K = 1.893;

/** 各楞型复合纸板厚度(mm)，来源 packwares 行业典型值；待试纸实测校准 */
export const CALIPER_MM: Record<string, number> = {
  none: 0.5,
  A: 4.8,
  B: 2.5,
  C: 3.6,
  E: 1.5,
  F: 0.8,
  BC: 6.5,
  BE: 4.0,
  AB: 7.3,
  // 彩盒裱坑薄层平贴
  B_flute: 1.2,
  E_flute: 1.0,
};

/**
 * 纸种环压系数 (kg/cm per g/m²)：牛皮>白板/白牛皮>testliner>再生。
 * 量级按 IS 2771 反推校准（150g 牛皮约 2.1kg/cm/层）。
 * 待以供应商 RCT 检测报告回填。
 */
export const GRADE_RC_FACTOR: Record<string, number> = {
  kraft: 0.014,
  white_top: 0.012,
  testliner: 0.012,
  recycled: 0.01,
  special: 0.012,
};

/** IS 2771 各纸板结构最小 ECT (kN/m)，作为「抗压安全下限」硬阈值 */
export const SAFE_ECT_MIN_KNM: Record<string, number> = {
  single: 4.0,
  double: 5.6,
  triple: 9.6,
};

export const DEFAULT_SAFETY_FACTOR = 3.5; // 常温仓储（ASTM D642）
export const HUMID_SAFETY_FACTOR = 4.5; // 海运/高湿

// ===================== 工具 =====================

function num(v: unknown, fb = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fb;
}
function str(v: unknown, fb = ""): string {
  return v == null ? fb : String(v);
}

/** 是否为瓦楞纸箱（本模块硬过滤仅作用于瓦楞结构；彩盒/平印降克重不在此门禁） */
export function isCorrugated(i: AnalysisInput): boolean {
  const ft = str(i.fluteType);
  const bs = str(i.boardStructure);
  if (bs === "single" || bs === "double" || bs === "triple") return true;
  return ["A", "B", "C", "E", "F", "BC", "BE", "AB"].includes(ft);
}

/**
 * 湿敏衰减系数：50%RH=1.0（标准实验室）；50→90%RH 线性衰减到 0.5。
 * 依据：行业实测瓦楞在 80%RH 损失约 35%、90%RH 损失 50%+。
 */
export function wetAttenuation(rh: number): number {
  const r = Math.max(0, Math.min(100, num(rh, 50)));
  if (r <= 50) return 1;
  return Math.max(0.4, 1 - ((r - 50) / 40) * 0.5);
}

export function safetyFactor(humid?: boolean): number {
  return humid ? HUMID_SAFETY_FACTOR : DEFAULT_SAFETY_FACTOR;
}

/**
 * 由纸种组合估算 ECT (kN/m)。
 * ECT(kg/cm) = Σ(各挂面层 RCT) + 芯纸 RCT × take-up；
 * RCT(kg/cm) ≈ 克重(g/m²) × 纸种环压系数；kg/cm → kN/m 乘 0.981。
 * 对称挂面假设（面纸=里纸同克重同材质），与 corrugated 配置模型一致。
 * 若输入直供 ectKNm（供应商实测），优先采用。
 */
export function estimateECT(inp: BoxPhysicalInput): number {
  if (typeof inp.ectKNm === "number" && Number.isFinite(inp.ectKNm)) return inp.ectKNm;
  const liner = num(inp.linerGrammage);
  const medium = num(inp.mediumGrammage);
  const grade = str(inp.linerMaterial, "kraft");
  const rc = GRADE_RC_FACTOR[grade] ?? GRADE_RC_FACTOR.kraft;
  const mediumRC = (GRADE_RC_FACTOR.recycled ?? 0.01) + 0.002; // 半化学芯纸略高
  const flute = getFluteType(str(inp.fluteType));
  const takeup = flute.takeUpFactor || 0;
  const structure = str(inp.boardStructure, "single");
  const linerLayers = structure === "triple" ? 4 : structure === "double" ? 3 : 2;
  const linerRC = liner * rc;
  const totalLinerRC = linerRC * linerLayers;
  const totalFluteRC = medium * mediumRC * takeup;
  const ectKgCm = totalLinerRC + totalFluteRC;
  return ectKgCm * 0.981;
}

/** McKee 公式：BCT(kgf) = K · ECT(kN/m) · √(P(cm) · t(mm)) */
export function mckeeBCT(ectKNm: number, perimeterCm: number, caliperMm: number): number {
  return MCKEE_K * ectKNm * Math.sqrt(Math.max(0, perimeterCm) * Math.max(0, caliperMm));
}

/** 纯物理计算（成本估算阶段与方案过滤共用） */
export function assessBoxPhysics(inp: BoxPhysicalInput): BoxPhysics {
  const flute = getFluteType(str(inp.fluteType));
  const caliperMm = CALIPER_MM[str(inp.fluteType)] ?? (flute.takeUpFactor > 0 ? 3.0 : 0.5);
  const L = num(inp.lengthMm);
  const W = num(inp.widthMm);
  const perimeterCm = (2 * (L + W)) / 10; // mm → cm
  const ectKNm = estimateECT(inp);
  const bctKg = mckeeBCT(ectKNm, perimeterCm, caliperMm);
  const wetFactor = wetAttenuation(num(inp.relativeHumidity, 50));
  const effectiveBCT = bctKg * wetFactor;
  const boxWeight = num(inp.boxWeightKg, 0);
  const stack = num(inp.stackLayers, 0);
  const hasLoadData = boxWeight > 0 && stack > 1;
  const requiredBCT = hasLoadData ? boxWeight * (stack - 1) * safetyFactor(inp.humidEnvironment) : 0;
  return { ectKNm, caliperMm, perimeterCm, bctKg, wetFactor, effectiveBCT, requiredBCT, hasLoadData };
}

/** AnalysisInput → BoxPhysicalInput（芯纸=fluteGrammage，中纸=mediumGrammage）
 *  注：AnalysisInput 为开放索引签名，读取到的字段类型为宽联合，这里按运行期已知类型收窄。 */
export function toPhysicalInput(i: AnalysisInput): BoxPhysicalInput {
  return {
    fluteType: i.fluteType as string | undefined,
    linerMaterial: i.linerMaterial as string | undefined,
    linerGrammage: i.linerGrammage as number | undefined,
    mediumGrammage: i.fluteGrammage as number | undefined,
    middleGrammage: i.mediumGrammage as number | undefined,
    boardStructure: i.boardStructure as string | undefined,
    lengthMm: i.length as number | undefined,
    widthMm: i.width as number | undefined,
    heightMm: i.height as number | undefined,
    surfaceTreatment: i.surfaceTreatment as string | undefined,
    boxWeightKg: i.boxWeightKg as number | undefined,
    stackLayers: i.stackLayers as number | undefined,
    relativeHumidity: i.relativeHumidity as number | undefined,
    humidEnvironment: i.humidEnvironment as boolean | undefined,
    ectKNm: i.ectKNm as number | undefined,
  };
}

// ===================== 杠杆检测 / 防踩坑规则 =====================

const GRAM_KEYS = ["linerGrammage", "fluteGrammage", "mediumGrammage", "grammage"];
const PHYS_KEYS = [...GRAM_KEYS, "linerMaterial", "surfaceTreatment", "fluteType", "boardStructure"];
const TREATMENTS = ["matte_laminate", "gloss_laminate", "uv"];

/** 自动识别方案触动的降本杠杆 */
export function detectLevers(base: AnalysisInput, override: Partial<AnalysisInput>): FeasibilityLever[] {
  const levers: FeasibilityLever[] = [];
  for (const k of ["linerGrammage", "fluteGrammage", "mediumGrammage", "grammage"]) {
    const b = num((base as Record<string, unknown>)[k]);
    const o = num((override as Record<string, unknown>)[k]);
    if (b > 0 && o > 0 && o < b) levers.push("reduce_grammage");
  }
  const bm = str(base.linerMaterial);
  const om = str((override as Record<string, unknown>).linerMaterial);
  if (om && bm && om !== bm) levers.push("change_paper");
  const bs = str(base.surfaceTreatment);
  const os = str((override as Record<string, unknown>).surfaceTreatment);
  if (TREATMENTS.includes(bs) && os === "none") levers.push("skip_postprint");
  const bf = str(base.fluteType);
  const of = str((override as Record<string, unknown>).fluteType);
  if (bf && of && bf !== of) levers.push("change_flute");
  return Array.from(new Set(levers));
}

function touchesPhysics(base: AnalysisInput, override: Partial<AnalysisInput>): boolean {
  for (const k of PHYS_KEYS) {
    if (str((base as Record<string, unknown>)[k]) !== str((override as Record<string, unknown>)[k])) return true;
  }
  return false;
}

/**
 * 自动包装线吸盘抓取异常判定（确定性启发式）：
 * 无表面处理（去膜/去上光）→ 低摩擦面；叠加低克重(<150g) 或 再生/特种低摩擦纸 → 易打滑。
 * 仅作防踩坑预警；待以产线实测 COF 回填校准。
 */
export function pickupRisk(i: AnalysisInput): boolean {
  const st = str(i.surfaceTreatment);
  if (st && st !== "none") return false; // 有处理 → 有抓附面
  const liner = num(i.linerGrammage);
  const mat = str(i.linerMaterial);
  if (liner > 0) return liner < 150 || mat === "recycled" || mat === "special";
  return mat === "recycled" || mat === "special";
}

function structureLabel(structure: string): string {
  return structure === "triple" ? "三瓦" : structure === "double" ? "双瓦" : "单瓦";
}

// ===================== 主入口 =====================

/**
 * VAVE 方案物理硬过滤（确定性层）。
 * - 仅当方案触动物理属性（降克重/换纸/省印后/换楞）时运行；
 * - 触动后若 ECT 跌破结构安全下限、或（有载荷数据时）湿敏后抗压低于堆码阈值、
 *   或省印后触发吸盘抓取风险 → FEASIBILITY_FAILED（passed=false）；
 * - 非瓦楞方案（彩盒/平印）直接放行（本门禁仅覆盖瓦楞结构）。
 */
export function assessScenarioFeasibility(opts: {
  base: AnalysisInput;
  override: Partial<AnalysisInput>;
  levers?: FeasibilityLever[];
}): FeasibilityResult {
  const { base, override } = opts;
  const merged: AnalysisInput = { ...base, ...override };
  if (!isCorrugated(merged)) return neutral();

  const levers = opts.levers ?? detectLevers(base, override);
  const touched = touchesPhysics(base, override);
  const phys = assessBoxPhysics(toPhysicalInput(merged));
  const structure = str(merged.boardStructure, "single");
  const ectFloor = SAFE_ECT_MIN_KNM[structure] ?? SAFE_ECT_MIN_KNM.single;

  const triggered: string[] = [];
  const gaps: PhysicalGaps = {};

  // 1) ECT 安全下限（结构抗压阈值）
  if (touched && phys.ectKNm < ectFloor) {
    triggered.push("ect_floor");
    gaps.predictedECT = +phys.ectKNm.toFixed(2);
    gaps.requiredECT = ectFloor;
    gaps.ectDeficit = +(ectFloor - phys.ectKNm).toFixed(2);
  }
  // 2) BCT 堆码安全阈值（需毛重/堆码层载荷数据）
  if (touched && phys.hasLoadData && phys.effectiveBCT < phys.requiredBCT) {
    triggered.push("bct_threshold");
    gaps.predictedBCT = +phys.effectiveBCT.toFixed(1);
    gaps.requiredBCT = +phys.requiredBCT.toFixed(1);
    gaps.bctDeficit = +(phys.requiredBCT - phys.effectiveBCT).toFixed(1);
    gaps.wetAttenuation = +phys.wetFactor.toFixed(2);
  }
  // 3) 自动线吸盘抓取异常（省去印后工艺）
  if (levers.includes("skip_postprint") && pickupRisk(merged)) {
    triggered.push("pickup_risk");
    gaps.pickupRisk = true;
  }

  const failed = triggered.length > 0;
  let reason: string | undefined;
  if (failed) {
    const parts = ["物理校验未通过（FEASIBILITY_FAILED）"];
    if (gaps.predictedECT != null) {
      parts.push(
        `边压 ECT=${gaps.predictedECT}kN/m 低于${structureLabel(structure)}安全下限 ${gaps.requiredECT}kN/m（缺口 ${gaps.ectDeficit}kN/m）`
      );
    }
    if (gaps.predictedBCT != null) {
      parts.push(
        `湿敏后抗压=${gaps.predictedBCT}kgf 低于堆码安全阈值 ${gaps.requiredBCT}kgf（缺口 ${gaps.bctDeficit}kgf，湿敏系数 ${gaps.wetAttenuation}）`
      );
    }
    if (gaps.pickupRisk) {
      parts.push("取消表面处理后低摩擦面易致自动包装线吸盘抓取异常");
    }
    reason = parts.join("；");
  }

  return {
    passed: !failed,
    failed,
    reason,
    metrics: phys,
    gaps,
    triggered,
    levers,
    touchedPhysics: touched,
  };
}

/**
 * 成本估算阶段的物理可行性评估（标注当前箱型是否达标，不否决用户自有设计）。
 * 返回 failed=true 仅作告警（ValidationIssue），不在估算阶段拦截。
 */
export function assessBaseline(input: AnalysisInput): FeasibilityResult {
  if (!isCorrugated(input)) return neutral();
  const phys = assessBoxPhysics(toPhysicalInput(input));
  const structure = str(input.boardStructure, "single");
  const ectFloor = SAFE_ECT_MIN_KNM[structure] ?? SAFE_ECT_MIN_KNM.single;
  const triggered: string[] = [];
  const gaps: PhysicalGaps = {};
  if (phys.ectKNm < ectFloor) {
    triggered.push("ect_floor");
    gaps.predictedECT = +phys.ectKNm.toFixed(2);
    gaps.requiredECT = ectFloor;
    gaps.ectDeficit = +(ectFloor - phys.ectKNm).toFixed(2);
  }
  if (phys.hasLoadData && phys.effectiveBCT < phys.requiredBCT) {
    triggered.push("bct_threshold");
    gaps.predictedBCT = +phys.effectiveBCT.toFixed(1);
    gaps.requiredBCT = +phys.requiredBCT.toFixed(1);
    gaps.bctDeficit = +(phys.requiredBCT - phys.effectiveBCT).toFixed(1);
    gaps.wetAttenuation = +phys.wetFactor.toFixed(2);
  }
  const failed = triggered.length > 0;
  return {
    passed: !failed,
    failed,
    reason: failed
      ? `当前箱型物理抗压估算偏低（ECT ${gaps.predictedECT}kN/m < ${structureLabel(structure)}安全下限 ${gaps.requiredECT}kN/m）`
      : undefined,
    metrics: phys,
    gaps,
    triggered,
    levers: [],
    touchedPhysics: true,
  };
}

function neutral(): FeasibilityResult {
  return {
    passed: true,
    failed: false,
    metrics: {
      ectKNm: 0,
      caliperMm: 0,
      perimeterCm: 0,
      bctKg: 0,
      wetFactor: 1,
      effectiveBCT: 0,
      requiredBCT: 0,
      hasLoadData: false,
    },
    gaps: {},
    triggered: [],
    levers: [],
    touchedPhysics: false,
  };
}
