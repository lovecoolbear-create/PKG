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
  matte_laminate: 0.45,
  gloss_laminate: 0.42,
  uv: 1.2,
  foil: 3.5,
  emboss: 2.0,
};

/** 制版费基础（元/色） */
export const PLATE_COST_PER_COLOR = 350;

/**
 * 油墨成本（简化模型）常量
 * 公式：油墨成本 = 印刷面积(m²) × 墨量系数(g/m²) × 油墨单价(元/kg) / 1000
 * - 印刷面积 = 单只印刷面积(netAreaM2) × 数量（默认单面印刷；双面需×面数，暂简化为单面）
 * - 四色(CMYK)与专色分开计：专色墨量更高（实地覆盖），专色墨单价亦更高（定制/小批量调墨）
 * - 这些默认值可经知识库 ink:* 键覆盖；属简化估算，后期用真实成交数据校准
 */
/** 四色(CMYK)综合墨量系数：g/m²（4 色合计平均覆盖率，含叠印） */
export const INK_CMYK_GRAMMAGE_PER_M2 = 5;
/** 四色油墨单价（元/kg） */
export const INK_CMYK_PRICE_PER_KG = 42;
/** 单专色墨量系数：g/m²（实地覆盖，高于四色单色平均） */
export const INK_SPOT_GRAMMAGE_PER_M2 = 8;
/** 专色油墨单价（元/kg，定制墨/小批量调墨，高于四色） */
export const INK_SPOT_PRICE_PER_KG = 90;

/**
 * 印刷费起步价（最低消费 / 开机费托底），单位元
 * 胶印/柔印等非数码印刷的起步开机费不低于此值；数码印刷不设起步价
 */
export const PRINT_MIN_CHARGE = 350;

/** 人工费率（元/小时，华东基准，仅作换线固定人工的小时费率参考） */
export const LABOR_RATE = 28;

/** 设备折旧+能耗（元/小时） */
export const EQUIPMENT_RATE = 45;

/**
 * 人工成本简化模型参数
 * 说明：人工当前为「固定元/个 × 复杂度 + 糊盒」的简化估算，非真实工时核算。
 * 仅用于量级参考；真实工厂人工应按「工时 × 小时费率」或计件工资记录（见校准案例模板）。
 */
/** 基准手工操作（检验/整理）单价 元/个 */
export const LABOR_BASE_PER_PIECE = 0.05;
/** 糊盒单价 元/个 */
export const LABOR_GLUING_PER_PIECE = 0.025;
/** 换线/调机固定工时 小时/单（简化项，不随数量变动） */
export const LABOR_SETUP_HOURS = 0.5;
/** 是否计入换线/调机固定人工简化项 */
export const LABOR_SETUP_ENABLED = true;

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

/** 材质中文标签（统一来源，供材料 Agent 与价格 Fetcher 共用） */
export const MATERIAL_LABELS: Record<string, string> = {
  white_card: "白卡纸",
  coated_paper: "铜版纸",
  grey_board: "灰底白板",
  kraft: "牛皮纸",
  special: "特种纸",
};

// ========== 盒型结构与复杂度系数 (Box Type Multipliers) ==========
export interface BoxTypeConfig {
  code: string;
  label: string;
  /** 复杂度系数：作用于人工工时与设备工时 */
  complexityMultiplier: number;
  /** 该盒型对应的拼版/用纸利用率（净展开面积/系数=实际用纸） */
  impositionUtilization: number;
  /** 贴窗胶片成本（元/个），仅开窗盒适用 */
  windowFilmCostPerPiece: number;
  /** 是否需包边/裱胶（天地盖），用于报告说明 */
  requiresEdgeWrap: boolean;
  /** 件数系数：天地盖为 lid+base 两件，用纸面积≈单件 footprint × 此系数 */
  pieceCount: number;
  description: string;
}

export const BOX_TYPES: Record<string, BoxTypeConfig> = {
  tuck_end: {
    code: "tuck_end",
    label: "标准扣底盒",
    complexityMultiplier: 1.0,
    impositionUtilization: 0.85,
    windowFilmCostPerPiece: 0,
    requiresEdgeWrap: false,
    pieceCount: 1,
    description: "常规插口扣底盒，制造复杂度基准",
  },
  rigid_cover: {
    code: "rigid_cover",
    label: "天地盖精品盒",
    complexityMultiplier: 1.35,
    impositionUtilization: 0.72,
    windowFilmCostPerPiece: 0,
    requiresEdgeWrap: true,
    pieceCount: 2,
    description: "天地盖/翻盖精品盒，含包边与裱胶工序，结构复杂、用纸利用率低；为 lid+base 两件，用纸面积约 2×",
  },
  special_window: {
    code: "special_window",
    label: "异形/开窗盒",
    complexityMultiplier: 1.25,
    impositionUtilization: 0.8,
    windowFilmCostPerPiece: 0.05,
    requiresEdgeWrap: false,
    pieceCount: 1,
    description: "异形或开窗盒，含贴窗胶片成本，模切与对位难度更高",
  },
};

export function getBoxType(code?: string): BoxTypeConfig {
  return BOX_TYPES[code || "tuck_end"] || BOX_TYPES.tuck_end;
}

// ========== 裱坑工艺（瓦楞彩盒 Flute Mounting） ==========
export interface FluteConfig {
  code: string;
  label: string;
  /** 坑纸/底纸克重（g） */
  fluteGrammage: number;
  /** 坑纸/底纸单价（元/吨） */
  flutePricePerTon: number;
}

export const FLUTE_TYPES: Record<string, FluteConfig> = {
  none: { code: "none", label: "无（非瓦楞）", fluteGrammage: 0, flutePricePerTon: 0 },
  E_flute: { code: "E_flute", label: "E坑", fluteGrammage: 140, flutePricePerTon: 4200 },
  B_flute: { code: "B_flute", label: "B坑", fluteGrammage: 160, flutePricePerTon: 4000 },
};

export function getFluteType(code?: string): FluteConfig {
  return FLUTE_TYPES[code || "none"] || FLUTE_TYPES.none;
}

/** 裱坑加工费（元/m²） */
export const FLUTE_MOUNTING_RATE = 0.18;

// ========== 专色印刷 (Spot Color) ==========
/** CMYK 版费（元/版） */
export const CMYK_PLATE_COST = 350;
/** 专色版费（元/版），高于普通 CMYK */
export const SPOT_COLOR_PLATE_COST = 450;
/** 专色固定调色/洗车费（元/专色） */
export const SPOT_COLOR_SETUP_COST = 150;

/** 刀模费（一次性，单位元/单）——模切钢刀模具制作费，不随数量变动 */
export const DIE_FORM_COST = 200;

// ========== 精品盒（天地盖）灰板底材 ==========
/** 精品盒灰板代表克重（g/㎡），真实精品盒为灰板底材 + 面纸裱，需另计灰板 */
export const RIGID_GREY_BOARD_GRAMMAGE = 1000;
/** 精品盒灰板单价（元/吨），代表厚灰板行情 */
export const RIGID_GREY_BOARD_PRICE_PER_TON = 3800;
/**
 * 精品盒面纸典型克重（g/㎡）：天地盖为灰板 + 薄面纸裱结构，
 * 面纸并非普通彩盒的 250-450g  body stock，而是约 157g 铜版/艺术纸。
 * 故精品盒面纸克重固定取此值，与用户所选普通克重区分（已在报告中标注假设）。
 */
export const RIGID_FACE_GRAMMAGE = 157;
