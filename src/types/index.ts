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
  /** 人工地域（人工 Agent 专用） */
  laborRegion?: { code: string; label: string; isDefault: boolean };
  /** 分项成本明细（材料/工艺等维度拆分，便于报告与测试透明呈现） */
  breakdown?: { label: string; amount: number; note?: string }[];
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
}

export interface OptimizationHint {
  id: string;
  title: string;
  summary: string;
  detail: string;
  potentialSaving: string;
  category: "material" | "process" | "design" | "logistics";
}

// ========== 表单数据 ==========

export interface AnalysisInput {
  [key: string]: string | number | boolean | undefined;
  /** 客户是否已提供完稿文件：true 时设计费减免为 0 */
  provideReadyDesign?: boolean;
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
