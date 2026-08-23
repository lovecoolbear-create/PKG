import type {
  AnalysisInput,
  ClarificationQuestion,
  DefaultAssumption,
  ProductTypeConfig,
} from "@/types";

/** 字段默认值定义 */
export const FIELD_DEFAULTS: Record<
  string,
  { value: string | number | boolean; label: string; reason: string }
> = {
  quantity: {
    value: 5000,
    label: "5000 个",
    reason: "按中等批量订单估算，小批量单位成本偏高",
  },
  length: { value: 100, label: "100 mm", reason: "按常见中小盒型默认尺寸" },
  width: { value: 80, label: "80 mm", reason: "按常见中小盒型默认尺寸" },
  height: { value: 50, label: "50 mm", reason: "按常见中小盒型默认尺寸" },
  material: {
    value: "white_card",
    label: "白卡纸",
    reason: "彩盒最常用的底纸材质",
  },
  grammage: {
    value: "350",
    label: "350g",
    reason: "彩盒主流克重，兼顾挺度与成本",
  },
  printMethod: {
    value: "offset",
    label: "胶印",
    reason: "中大批量彩盒最常用的印刷方式",
  },
  colorCount: {
    value: "4",
    label: "四色 (CMYK)",
    reason: "大多数彩盒采用四色印刷",
  },
  surfaceTreatment: {
    value: "matte_laminate",
    label: "哑膜",
    reason: "哑膜是彩盒最常见的表面处理方式",
  },
  needGluing: {
    value: true,
    label: "需要糊盒",
    reason: "大多数彩盒需要糊盒成型",
  },
  deliveryLocation: {
    value: "east_china",
    label: "华东",
    reason: "默认交付华东区域",
  },
  targetDelivery: {
    value: "standard",
    label: "标准交期 (15-20天)",
    reason: "按标准交期估算，不含加急费用",
  },
  boxType: {
    value: "tuck_end",
    label: "标准扣底盒",
    reason: "未指定盒型，默认按标准扣底盒估算",
  },
  fluteType: {
    value: "none",
    label: "无（非瓦楞）",
    reason: "未指定坑型，默认非瓦楞结构",
  },
  spotColorCount: {
    value: 0,
    label: "0 专色",
    reason: "未指定专色，默认无专色印刷",
  },
};

// ========== 追问优先级（按对成本的影响强度排序） ==========
// high = 高影响必问项；secondary = 影响较小或可由默认覆盖，高影响项补齐后再提示。
// 地域统一问 deliveryLocation：它同时驱动「物流/包装成本」与「人工地域系数」
// （deriveAnalysisContext 中 laborRegion 回退到 deliveryLocation）。
export type ImpactTier = "high" | "secondary";

const QUESTION_PRIORITY: { key: string; tier: ImpactTier; weight: number }[] = [
  { key: "quantity", tier: "high", weight: 15 },
  { key: "length", tier: "high", weight: 12 },
  { key: "width", tier: "high", weight: 12 },
  { key: "height", tier: "high", weight: 12 },
  { key: "material", tier: "high", weight: 12 },
  { key: "grammage", tier: "high", weight: 11 },
  { key: "printMethod", tier: "high", weight: 10 },
  { key: "deliveryLocation", tier: "high", weight: 9 },
  { key: "surfaceTreatment", tier: "high", weight: 9 },
  { key: "needGluing", tier: "high", weight: 8 },
  { key: "boxType", tier: "secondary", weight: 8 },
  { key: "spotColorCount", tier: "secondary", weight: 5 },
  { key: "provideReadyDesign", tier: "secondary", weight: 4 },
  { key: "targetDelivery", tier: "secondary", weight: 4 },
];

// 精准追问话术（推荐文案）：question=问题，impact=为什么要问（影响说明）
const QUESTION_COPY: Record<
  string,
  { question: string; impact: string }
> = {
  quantity: {
    question: "预计订单数量大概是多少个？",
    impact: "数量决定材料采购单价与开机费分摊，是单只成本波动最大的变量",
  },
  length: {
    question: "盒型外尺寸——长是多少 mm？",
    impact: "长×宽×高共同决定展开面积与用纸量，直接驱动材料成本",
  },
  width: {
    question: "盒型外尺寸——宽是多少 mm？",
    impact: "长×宽×高共同决定展开面积与用纸量，直接驱动材料成本",
  },
  height: {
    question: "盒型外尺寸——高是多少 mm？",
    impact: "长×宽×高共同决定展开面积与用纸量，直接驱动材料成本",
  },
  material: {
    question: "主体用的是什么纸？（白卡/铜版/灰底白/牛皮/特种）",
    impact: "纸种是材料成本的核心决定因素，价格差异可达数倍",
  },
  grammage: {
    question: "纸张克重是多少？（如 250/300/350/400g）",
    impact: "克重直接决定材料单价与盒体挺度",
  },
  printMethod: {
    question: "采用哪种印刷方式？胶印 / 数码 / 柔印？",
    impact: "影响制版费与单位印刷成本；小批量数码更划算、大批量胶印更省",
  },
  deliveryLocation: {
    question: "货送到哪个区域？（华东/华南/华北/…）",
    impact: "影响物流与包装成本，并决定人工地域系数（华东/华南工价不同）",
  },
  surfaceTreatment: {
    question: "表面做什么处理？覆膜 / UV / 烫金 / 凹凸？",
    impact: "每种工艺单价不同；烫金还需电化铝与烫金版费",
  },
  needGluing: {
    question: "需要糊盒成型吗？",
    impact: "糊盒增加人工与设备工时",
  },
  boxType: {
    question: "是什么盒型？扣底 / 天地盖 / 开窗？",
    impact: "天地盖用纸率低、工序多，结构复杂度≈标准盒 1.35 倍",
  },
  spotColorCount: {
    question: "有专色吗？几个专色？",
    impact: "专色需额外调色/洗车与专色版费，对成本影响明显",
  },
  provideReadyDesign: {
    question: "是否已提供可印刷完稿文件？",
    impact: "已提供可印刷完稿时，设计费可减免为 0",
  },
  targetDelivery: {
    question: "交期要求？标准 / 加急 / 特急？",
    impact: "加急可能产生加急费与加班排产成本",
  },
};

function isFieldEmpty(input: AnalysisInput, key: string): boolean {
  const value = input[key];
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "number" && isNaN(value))
  );
}

function getFieldMeta(config: ProductTypeConfig, key: string) {
  return config.fields.find((f) => f.key === key);
}

/** 生成待澄清问题列表（按影响层级+权重排序，仅含缺失/未答/未跳过项） */
export function generateQuestions(
  config: ProductTypeConfig,
  input: AnalysisInput,
  answeredKeys: Set<string> = new Set(),
  skippedKeys: Set<string> = new Set()
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  for (const { key, tier, weight } of QUESTION_PRIORITY) {
    if (answeredKeys.has(key) || skippedKeys.has(key)) continue;
    if (!isFieldEmpty(input, key)) continue; // 图纸/自然语言已识别的，不再追问

    const field = getFieldMeta(config, key);
    if (!field) continue;
    const defaultDef = FIELD_DEFAULTS[key];
    const copy = QUESTION_COPY[key];

    questions.push({
      key,
      label: field.label,
      question: copy?.question ?? `请提供${field.label}`,
      impact: copy?.impact ?? field.impactHint ?? "影响估算精度",
      weight,
      priority: tier,
      type:
        field.type === "boolean"
          ? "boolean"
          : field.type === "select"
            ? "select"
            : field.type === "number"
              ? "number"
              : "text",
      options: field.options,
      defaultValue: defaultDef?.value ?? field.defaultValue,
      defaultLabel: defaultDef?.label,
    });
  }

  return questions.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return b.weight - a.weight;
  });
}

/**
 * 每轮只推少量精准问题：
 * - 高影响项未补齐前，只展示高影响项（每次最多 maxHigh 条），避免长问卷；
 * - 高影响项全部补齐/跳过后再展示次级项。
 */
export function selectQuestionsForRound(
  questions: ClarificationQuestion[],
  maxHigh = 3,
  maxSecondary = 2
): ClarificationQuestion[] {
  const high = questions
    .filter((q) => q.priority === "high")
    .sort((a, b) => b.weight - a.weight);
  if (high.length > 0) return high.slice(0, maxHigh);
  const secondary = questions
    .filter((q) => q.priority === "secondary")
    .sort((a, b) => b.weight - a.weight);
  return secondary.slice(0, maxSecondary);
}

export interface CompletenessPrompt {
  level: "high" | "medium" | "low";
  text: string;
}

/**
 * 完整度提示：用户在补充信息时看到，引导其优先补齐高影响项。
 * 明确要求展示「补充以下信息可将估算误差显著降低」文案。
 */
export function getCompletenessPrompt(
  completeness: number,
  highMissing: { key: string; label: string; impact: string }[]
): CompletenessPrompt {
  if (completeness >= 90) {
    return {
      level: "low",
      text: "信息已较完整，估算误差较小，可直接用于初步测算与商务沟通。",
    };
  }
  const items = highMissing.slice(0, 3).map((m) => m.label);
  const list = items.length ? items.join("、") : "关键参数";
  const verb = completeness < 60 ? "显著" : "明显";
  return {
    level: completeness < 60 ? "high" : "medium",
    text: `当前信息完整度 ${completeness}%。补充以下信息可将估算误差${verb}降低：${list}。`,
  };
}

/** 应用默认值到输入：对缺失的高影响字段一律套用合理默认值，
 * 并收集「采用默认假设」清单（区分用户主动跳过 / 未填写）
 */
export function applyDefaults(
  input: AnalysisInput,
  skippedKeys: Set<string> = new Set()
): { input: AnalysisInput; assumptions: DefaultAssumption[] } {
  const result = { ...input };
  const assumptions: DefaultAssumption[] = [];

  for (const key of Object.keys(FIELD_DEFAULTS)) {
    if (!isFieldEmpty(result, key)) continue;
    const def = FIELD_DEFAULTS[key];
    if (!def) continue;

    result[key] = def.value;
    const skipped = skippedKeys.has(key);
    assumptions.push({
      field: key,
      label: getLabelForKey(key),
      assumedValue: def.label,
      reason: skipped
        ? `${def.reason}（你选择跳过，已用默认值）`
        : `${def.reason}（未填写，已用默认值）`,
    });
  }

  return { input: result, assumptions };
}

function getLabelForKey(key: string): string {
  const labels: Record<string, string> = {
    quantity: "订单数量",
    length: "长度",
    width: "宽度",
    height: "高度",
    material: "材质",
    grammage: "克重",
    printMethod: "印刷方式",
    colorCount: "印刷色数",
    surfaceTreatment: "表面处理",
    needGluing: "是否糊盒",
    laborRegion: "生产地域",
    deliveryLocation: "交付地点",
    targetDelivery: "目标交期",
  };
  return labels[key] || key;
}

/** 某维度是否使用了默认值（用于降低置信度） */
export function getDefaultPenaltyForDimension(
  dimension: string,
  assumptions: DefaultAssumption[]
): number {
  const dimensionFields: Record<string, string[]> = {
    material: ["material", "grammage", "quantity", "length", "width", "height"],
    labor: ["deliveryLocation", "needGluing", "boxType", "quantity"],
    process: ["printMethod", "colorCount", "surfaceTreatment", "needGluing"],
    design_plate: ["colorCount", "printMethod", "provideReadyDesign"],
    finance_other: ["deliveryLocation", "targetDelivery"],
  };

  const related = dimensionFields[dimension] || [];
  const hitCount = assumptions.filter((a) => related.includes(a.field)).length;
  return Math.min(hitCount * 8, 25);
}
