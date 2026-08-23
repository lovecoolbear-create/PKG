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
  laborRegion: {
    value: "east_china",
    label: "华东地区",
    reason: "默认按华东制造业水平估算人工",
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

/** 高影响字段 - 优先提问 */
const HIGH_IMPACT_KEYS = [
  "quantity",
  "material",
  "grammage",
  "surfaceTreatment",
  "needGluing",
  "length",
  "width",
  "height",
  "printMethod",
  "colorCount",
  "laborRegion",
];

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

/** 生成待澄清问题列表（按影响权重排序） */
export function generateQuestions(
  config: ProductTypeConfig,
  input: AnalysisInput,
  answeredKeys: Set<string> = new Set(),
  skippedKeys: Set<string> = new Set()
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  for (const key of HIGH_IMPACT_KEYS) {
    if (answeredKeys.has(key) || skippedKeys.has(key)) continue;
    if (!isFieldEmpty(input, key)) continue;

    const field = getFieldMeta(config, key);
    const defaultDef = FIELD_DEFAULTS[key];

    // laborRegion 不在 config.fields 中，单独处理
    if (key === "laborRegion") {
      questions.push({
        key,
        label: "生产地域",
        question: "请选择工厂所在地域，不同地区人工费率差异明显",
        impact: "人工费率差异可达 15-20%",
        weight: 10,
        type: "select",
        options: [
          { value: "east_china", label: "华东地区" },
          { value: "south_china_dg", label: "华南地区（东莞一带）" },
        ],
        defaultValue: defaultDef?.value,
        defaultLabel: defaultDef?.label,
      });
      continue;
    }

    if (!field) continue;

    questions.push({
      key,
      label: field.label,
      question: buildQuestionText(field.label, field.impactHint),
      impact: field.impactHint || "影响估算精度",
      weight: field.weight,
      type: field.type === "boolean" ? "boolean" : field.type === "select" ? "select" : "number",
      options: field.options,
      defaultValue: defaultDef?.value ?? field.defaultValue,
      defaultLabel: defaultDef?.label,
    });
  }

  return questions.sort((a, b) => b.weight - a.weight);
}

function buildQuestionText(label: string, hint?: string): string {
  const templates: Record<string, string> = {
    订单数量: "请问订单数量是多少？数量对材料单价和开机费分摊影响显著",
    材质: "请问使用什么材质？不同纸种价格差异较大",
    克重: "请问纸板克重是多少？克重影响材料单价和盒体挺度",
    表面处理: "是否有特殊表面处理（覆膜、UV、烫金、凹凸等）？",
    是否糊盒: "是否需要糊盒？糊盒会增加人工和设备成本",
    长度: "请问盒型外尺寸（长）是多少 mm？",
    宽度: "请问盒型外尺寸（宽）是多少 mm？",
    高度: "请问盒型外尺寸（高）是多少 mm？",
    印刷方式: "请问采用什么印刷方式？",
    印刷色数: "请问印刷色数是多少？含专色请说明",
  };
  return templates[label] || `请提供${label}${hint ? `（${hint}）` : ""}`;
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
    process: ["printMethod", "colorCount", "surfaceTreatment", "needGluing"],
    design_plate: ["colorCount", "printMethod"],
    finance_other: ["deliveryLocation", "targetDelivery"],
  };

  const related = dimensionFields[dimension] || [];
  const hitCount = assumptions.filter((a) => related.includes(a.field)).length;
  return Math.min(hitCount * 8, 25);
}
