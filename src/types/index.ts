// ========== 产品类型配置化设计 ==========

export type FieldType =
  | "text"
  | "number"
  | "select"
  | "multiselect"
  | "boolean"
  | "dimension" // 长x宽x高
  | "file";

export interface FieldOption {
  value: string;
  label: string;
}

export interface ProductField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** 权重：影响信息完整度计算，越高越关键 */
  weight: number;
  /** 缺失时对误差的影响描述 */
  impactHint?: string;
  placeholder?: string;
  unit?: string;
  options?: FieldOption[];
  /** 条件显示：依赖其他字段值 */
  showWhen?: { field: string; value: string | boolean };
  defaultValue?: string | number | boolean;
  group?: string;
}

export interface CostDimensionConfig {
  key: string;
  label: string;
  /** 所属分组：manufacturing | commercial */
  group: "manufacturing" | "commercial";
  /** 合理占比区间 [min%, max%] */
  expectedRatioRange: [number, number];
  /** 对应 Agent 标识 */
  agentId: string;
  description: string;
  /** 排序 */
  order: number;
}

export interface ProductTypeConfig {
  code: string;
  name: string;
  description: string;
  fields: ProductField[];
  dimensions: CostDimensionConfig[];
  /** 分析步骤定义 */
  steps: AnalysisStepConfig[];
}

export interface AnalysisStepConfig {
  id: string;
  title: string;
  description: string;
  /** 该步骤涉及的字段 keys */
  fieldKeys?: string[];
}

// ========== Agent 输出结构 ==========

export interface AgentResult {
  dimension: string;
  dimensionLabel: string;
  estimatedAmount: number;
  /** 区间 [min, max] */
  amountRange: [number, number];
  ratio: number;
  basis: string[];
  assumptions: string[];
  confidence: number;
  risks: string[];
  /** 使用了默认值的标记 */
  usedDefaults?: string[];
  /** 材料价格来源（材料 Agent 专用） */
  priceSources?: MaterialPriceEntry[];
  /** 分项成本明细（材料/工艺等维度拆分，便于报告与测试透明呈现） */
  breakdown?: {
    label: string;
    amount: number;
    note?: string;
    /** 加工费维度专用：区分纯工艺加工(process) 与 设备/开机相关费用(equipment) */
    kind?: "process" | "equipment";
  }[];
}

export interface MaterialPriceEntry {
  item: string;
  category: "paper" | "ink" | "surface" | "foil";
  price: number;
  unit: string;
  source: string;
  fetchedAt: string;
  /** 价格获取时间戳（统一 Fetcher 架构回退时一并标记） */
  priceTimestamp?: string;
  isFallback: boolean;
  /** 是否实时检索获得：true=行情检索/实时；false/undefined=模型估算或本地基准 */
  live?: boolean;
  priceRange?: [number, number];
}

export interface MaterialPriceFetchResult {
  entries: MaterialPriceEntry[];
  hasFallback: boolean;
  fetchedAt: string;
  summary: string;
}

export interface DefaultAssumption {
  field: string;
  label: string;
  assumedValue: string;
  reason: string;
}

export interface ClarificationQuestion {
  key: string;
  label: string;
  question: string;
  impact: string;
  weight: number;
  /** 对成本的影响层级：high=必问高影响项；secondary=影响较小/可由默认覆盖 */
  priority: "high" | "secondary";
  type: "select" | "number" | "boolean" | "text";
  options?: FieldOption[];
  defaultValue?: string | number | boolean;
  defaultLabel?: string;
}

export interface ValidationIssue {
  type: "sum_mismatch" | "ratio_out_of_range" | "low_completeness" | "missing_info";
  severity: "warning" | "error";
  message: string;
  suggestion?: string;
}

export interface AnalysisReport {
  sessionId: string;
  productType: string;
  productTypeName: string;
  generatedAt: string;
  completeness: number;
  missingFields: { key: string; label: string; impact: string }[];
  totalCost: {
    min: number;
    max: number;
    unit: string;
    perUnit: { min: number; max: number };
  };
  overallConfidence: number;
  dimensions: AgentResult[];
  manufacturingCost: { total: number; ratio: number };
  commercialCost: { total: number; ratio: number };
  validationIssues: ValidationIssue[];
  optimizationHints: OptimizationHint[];
  disclaimer: string;
  /** 材料价格来源汇总 */
  materialPriceSources?: MaterialPriceFetchResult;
  /** 人工生产地域 */
  laborRegion?: { code: string; label: string; isDefault: boolean };
  /** 使用了默认值的字段 */
  defaultAssumptions?: DefaultAssumption[];
  /** 因采用默认假设，整体置信度被下调的分数（各维度默认惩罚均值，上限参考 25） */
  defaultConfidencePenalty?: number;
  /** AI 包装 SQE 专家诊断（LLM 生成或模板兜底） */
  sqeDiagnosis?: {
    text: string;
    source: "llm" | "template";
    generatedAt: string;
  };
  /** 跨维度一致性审阅（只读，不改数字） */
  review?: ReviewReport;
  /** 主要成本驱动点（金额前 3，由 orchestrator 生成） */
  costDrivers?: CostDriver[];
  /** 小批量特殊提示（设计/制版占比越界时 visible=true） */
  smallBatchNote?: SmallBatchNote;
  /** 转化入口文案（固定模板，预留可配置） */
  ctaCopy?: string;
  /** 报告模块固定顺序（前端严格按序渲染） */
  sectionOrder?: ClientSectionKey[];
}

export interface ReviewFinding {
  code: string;
  severity: "info" | "warning";
  message: string;
  suggestion?: string;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  /** 是否通过跨维度一致性校验（无任何 warning 且维度齐全） */
  consistent: boolean;
  /** 单只估算成本（元/个） */
  perUnitEstimated: number;
}

export interface OptimizationHint {
  id: string;
  title: string;
  summary: string;
  detail: string;
  potentialSaving: string;
  category: "material" | "process" | "design" | "logistics";
}

// ========== 客户报告优化结构 ==========

/** 主要成本驱动点（取金额前几，由 orchestrator 生成） */
export interface CostDriver {
  dimension: string;
  dimensionLabel: string;
  amount: number;
  ratio: number;
  /** 为什么贵（来自该维度 breakdown 最贵分项的 note，或 basis[0]） */
  reason: string;
}

/** 小批量特殊提示：设计/制版占比超出预期区间时触发，作为「真实成本特征」展示（非错误） */
export interface SmallBatchNote {
  visible: boolean;
  dimension: string;
  /** 当前设计制版占比（%） */
  ratio: number;
  /** 预期占比区间下限（%） */
  expectedMin: number;
  /** 预期占比区间上限（%） */
  expectedMax: number;
  /** 设计制版固定费用总额（元）：制版 + 设计 + 打样，一次性、不随数量按件计 */
  fixedFee: number;
  /** 当前批量下摊到单只的设计制版成本（元/个） */
  currentPerPiece: number;
  /** 数量提升后的单只降本提示（fixedFee 不变，仅分摊基数变大） */
  suggestions: { quantity: number; perPiece: number }[];
  /** 三段式解释文案：固定费说明 / 当前批量正常现象 / 数量提升提示框架 */
  message: string;
}

/** 客户报告模块固定顺序键（前端严格按此渲染） */
export type ClientSectionKey =
  | "total_range"
  | "structure"
  | "drivers"
  | "completeness"
  | "confidence"
  | "small_batch"
  | "optimization"
  | "disclaimer"
  | "cta";

// ========== 表单数据 ==========

export interface AnalysisInput {
  [key: string]: string | number | boolean | undefined;
  /** 客户是否已提供完稿文件：true 时设计费减免为 0 */
  provideReadyDesign?: boolean;
  /** 烫金/凹凸局部覆盖率等级（可选）：low=4% / medium=8%(默认) / high=15% */
  surfaceCoverageLevel?: "low" | "medium" | "high";
  /** 预留：由稿件自动估算的烫金/凹凸覆盖率（0~1），优先级高于等级；未提供则按等级 */
  surfaceCoverageOverride?: number;
}

export interface UploadedFileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  category: "design" | "photo";
  url?: string;
}

export interface CompletenessResult {
  score: number;
  filled: string[];
  missing: { key: string; label: string; weight: number; impact: string }[];
}
