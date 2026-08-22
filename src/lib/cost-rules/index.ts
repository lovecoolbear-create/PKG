/**
 * 材料单价参考表（元/吨）- 规则驱动，非 AI 自由发挥
 * 后续可从 KnowledgeEntry 动态加载
 */
export const MATERIAL_PRICES: Record<string, Record<string, number>> = {
  white_card: { "250": 5200, "300": 5400, "350": 5600, "400": 5800, "450": 6000 },
  coated_paper: { "250": 4800, "300": 5000, "350": 5200, "400": 5500, "450": 5800 },
  grey_board: { "250": 4500, "300": 4700, "350": 4900, "400": 5100, "450": 5300 },
  kraft: { "250": 4200, "300": 4400, "350": 4600, "400": 4800, "450": 5000 },
  special: { "250": 8000, "300": 8500, "350": 9000, "400": 9500, "450": 10000 },
};

/** 数量阶梯折扣系数 */
export function getQuantityDiscount(quantity: number): number {
  if (quantity >= 50000) return 0.85;
  if (quantity >= 20000) return 0.88;
  if (quantity >= 10000) return 0.92;
  if (quantity >= 5000) return 0.95;
  if (quantity >= 1000) return 0.98;
  return 1.0;
}

/**
 * 拼版利用率系数（净展开面积 / 该系数 = 实际用纸面积）
 * 考虑印刷咬口（gripper margin）与修边损耗，行业基准约 0.85
 */
export const IMPOSITION_UTILIZATION = 0.85;

/**
 * 动态损耗率：随订单数量递减（替代原先固定的 8%）
 * 数量 < 2,000         -> 12%
 * 2,000 <= 数量 < 10,000 -> 8%
 * 10,000 <= 数量 < 50,000 -> 5%
 * 数量 >= 50,000       -> 3%
 */
export function getDynamicLossRate(quantity: number): number {
  if (quantity < 2000) return 0.12;
  if (quantity < 10000) return 0.08;
  if (quantity < 50000) return 0.05;
  return 0.03;
}

/** 计算展开面积（mm²）- 简化的彩盒展开公式 */
export function calculateExpandedArea(
  length: number,
  width: number,
  height: number
): number {
  // 标准 tuck-end box 展开面积估算
  const panelArea = 2 * (length * width) + 2 * (length * height) + 2 * (width * height);
  const glueFlap = width * 15; // 粘口
  const tuckFlap = length * 20 * 2; // 插舌
  return panelArea + glueFlap + tuckFlap;
}

/** 计算用纸重量（kg）
 * @param impositionUtilization 拼版利用率（净展开面积 / 该系数 = 实际用纸面积），默认 1
 * @param wasteRate 损耗率，默认 0.08（建议改用 getDynamicLossRate 动态值）
 */
export function calculatePaperWeight(
  areaMm2: number,
  grammage: number,
  quantity: number,
  options?: { wasteRate?: number; impositionUtilization?: number }
): number {
  const util = options?.impositionUtilization ?? 1;
  const wasteRate = options?.wasteRate ?? 0.08;
  // 拼版利用率：净展开面积 / 系数（考虑印刷咬口与修边损耗）
  const imposedAreaM2 = (areaMm2 / 1_000_000) / util;
  const weightPerPiece = (imposedAreaM2 * grammage) / 1000; // kg
  return weightPerPiece * quantity * (1 + wasteRate);
}

/** 印刷方式基础单价（元/色/千印） */
export const PRINT_BASE_RATES: Record<string, number> = {
  offset: 35,
  digital: 80,
  flexo: 25,
};

/** 表面处理单价（元/m²） */
export const SURFACE_TREATMENT_RATES: Record<string, number> = {
  none: 0,
  matte_laminate: 0.8,
  gloss_laminate: 0.75,
  uv: 1.2,
  foil: 3.5,
  emboss: 2.0,
};

/** 制版费基础（元/色） */
export const PLATE_COST_PER_COLOR = 350;

/**
 * 印刷费起步价（最低消费 / 开机费托底），单位元
 * 胶印/柔印等非数码印刷的起步开机费不低于此值；数码印刷不设起步价
 */
export const PRINT_MIN_CHARGE = 350;

/** 人工费率（元/小时） */
export const LABOR_RATE = 28;

/** 设备折旧+能耗（元/小时） */
export const EQUIPMENT_RATE = 45;

/** 物流费率（按区域） */
export const LOGISTICS_RATES: Record<string, number> = {
  east_china: 0.03,
  south_china: 0.035,
  north_china: 0.04,
  central_china: 0.038,
  southwest: 0.045,
  northeast: 0.042,
};

/** 加急系数 */
export const URGENCY_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  urgent: 1.15,
  express: 1.3,
};
