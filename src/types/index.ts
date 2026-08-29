// ========== 产品类型配置化设计 ==========

import type { RoleReport } from "@/lib/agents/llm-analyst";
import type { JudgeExplanation } from "@/lib/agents/judge-explain";
import type { ConsistencyWarning } from "@/lib/agents/consistency-gate";
import type { FeasibilityResult } from "@/lib/physics/feasibility";

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
  /** 条件显示：依赖其他字段值；value 为数组时表示「命中任一即显示」 */
  showWhen?: { field: string; value: string | boolean | (string | boolean)[] };
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
  /** C2：本维度本次计算命中的**知识库条目最低置信度**（0~100）。
   *  未命中任何知识库条目（即用的是代码内置常量）时为 undefined。
   *  编排器据此对低于阈值的维度施加额外置信度惩罚并给出核实提示。 */
  kbConfidence?: number;
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
  /** 面积与材料利用率指标（材料 Agent 专用，用于向客户展示理论使用面积占比） */
  areaMetrics?: {
    /** 理论面积（刀线净面积）m²/个 */
    theoreticalAreaM2: number;
    /** 理论面积 cm²/个 */
    theoreticalAreaCm2: number;
    /** 理论使用面积占比（材料利用率）0~1 */
    utilization: number;
    /** 实际生产面积（含废边，报价用）m²/个 */
    productionAreaM2: number;
    /** 是否基于全张纸+只数真实计算（否则回退盒型默认拼版利用率） */
    sheetBased: boolean;
  } | null;
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
  /** P1 多角色表达（采购/供应/成本/客户），每条带 Data Pointer 可溯源 */
  roleReports?: RoleReport[];
  /** P2 判定解释（确定性校验证据 → AI 专业叙述，severity/type 来自确定性层） */
  judgeExplanation?: JudgeExplanation;
  /** P8 一致性闸门：跨层冲突 / 数字漂移 / 叙述矛盾的聚合告警 */
  consistencyWarnings?: ConsistencyWarning[];
  /** P-Physics 物理性能与工艺可行性确定性校验（成本估算阶段强制调用，标注当前箱型抗压/边压是否达标） */
  physicalFeasibility?: FeasibilityResult;
  /** 多视角报告对比（确定性投影 + 汇总金额对齐校验，由 orchestrator 挂载） */
  multiView?: MultiViewReport;
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

// ========== VAVE 项目实体（数据桥前置） ==========

/**
 * 成本分析结果物化为「项目」，供 VAVE 联动消费。
 * 结构 = 原始输入(AnalysisInput) + 成本引擎客观输出快照(AnalysisReport)。
 * summary 不落库，读取时由 report 派生（见 project-store.deriveProjectSummary），避免字段漂移。
 */
export interface CostProject {
  id: string;
  name: string;
  createdAt: string;
  input: AnalysisInput;
  report: AnalysisReport;
}

/** 由 CostProject.report 派生的轻量摘要（VAVE 各子模块消费，不落库） */
export interface ProjectSummary {
  totalCostPerUnit: number;
  totalCostMin: number;
  totalCostMax: number;
  /** 维度 code → 占比(%) */
  dimensionRatios: Record<string, number>;
  costDrivers: CostDriver[];
  optimizationHints: OptimizationHint[];
  /** 材料维面积指标（理论使用面积占比等），无则 undefined */
  areaMetrics?: AgentResult["areaMetrics"];
}

// ========== VAVE 角色决策策略 ==========

/**
 * 角色决策策略（纯展示控制层，重构于 2026-08-26）。
 * 铁律（规格1）：RolePolicy 仅允许调控「信息呈现的粒度(granularity) 与 重点(emphasisDimensions/framing)」，
 * 严禁修改 / 篡改 / 掩盖底层核心成本基线与物理风险指标。任何角色都不得 hide/soften 核心数字。
 * 不可侵犯清单见 `INVIOLABLE_INDICATORS`（物理风险、error 级校验、各维度金额永远渲染）。
 */
export interface RolePolicy {
  role: string; // 部门+职级，如 "procurement_manager"
  label: string; // 展示名，如 "采购 · 经理"
  /** 加重维度（置顶强调），维度 code 列表——仅影响排序/高亮，绝不改动数字 */
  emphasisDimensions: string[];
  /**
   * 信息呈现粒度（规格1 允许的唯一"可见性"控制）：
   * - coarse：仅列出强调维度 + 一条「其他成本项」汇总行（其余维度被折叠但不删除，总额守恒）
   * - standard：列出全部维度（概要）
   * - fine：列出全部维度 + 其子项明细（breakdown）
   * 不论何种粒度，核心成本基线（各维度金额 + 总额）与物理风险指标均完整可溯、不可掩盖。
   */
  granularity: "coarse" | "standard" | "fine";
  /** 表述锚定（金额/占比/设计/关系） */
  framing: "amount" | "ratio" | "design" | "relationship";
}

/** 多视角报告对比：单行货币项目（取自主报告同一真相源，求和≡主报告总额） */
export interface ViewLineItem {
  key: string;
  label: string;
  amount: number; // 元（确定性，来自 report.dimensions / totalCost）
  ratio: number; // 占主报告总额 %
  group: string; // 分组（manufacturing / commercial / structural ...）
  note?: string;
}

/** 不可省略的硬指标（非货币，永远渲染，任何角色都不许隐藏） */
export interface InvariantIndicator {
  label: string;
  value: string;
  severity?: "info" | "warning" | "error";
}

/** QA 受控表述（规格2）：白名单改写 + 强制保留物理余量 */
export interface QaFraming {
  /** 是否成功应用受控改写 */
  applied: boolean;
  /** 原始表述（如「质量过度包装」） */
  original: string;
  /** 改写后表述（如「结构冗余优化」） */
  reframed?: string;
  /** 强制保留的物理余量数据（如「抗压冗余度 +35%」），缺则改写被拒 */
  physicalMargin?: string;
  /** 余量数据是否已保留（规格2 硬约束） */
  marginRetained: boolean;
  /** 未保留原因（marginRetained=false 时） */
  rejectReason?: string;
}

/** 单一干系人视角投影（确定性，无 LLM） */
export interface StakeholderView {
  view: "procurement" | "rd" | "exec" | "quality";
  viewLabel: string;
  policy: RolePolicy;
  /** 确定性一句话结论（非 LLM） */
  headline: string;
  /** 货币行项目（求和≡主报告总额） */
  lineItems: ViewLineItem[];
  /** 非货币硬指标（物理风险 / 合规），永远渲染 */
  invariants: InvariantIndicator[];
  /** QA 视角专用：受控改写 + 强制物理余量 */
  qaFraming?: QaFraming;
  totalAmount: number;
  /** 本视图总额是否等于主报告总额（金额对齐校验） */
  matchesMaster: boolean;
}

/** 多视角汇总对齐校验（规格3 核心保证） */
export interface MultiViewReconciliation {
  reconciled: boolean;
  /** 各视图与主报告总额的最大偏差（应≈0） */
  variance: number;
  masterTotal: number;
  perView: Record<string, { total: number; matches: boolean }>;
}

/** 主报告 + 并行导出的多视角对比（采购拆分表 / 研发结构图谱 / 高管 ROI 摘要 / 质量） */
export interface MultiViewReport {
  master: { totalCostMin: number; totalCostMax: number; perUnitMax: number };
  views: StakeholderView[];
  reconciliation: MultiViewReconciliation;
  generatedAt: string;
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

/** 刀线图形（用于视觉拆图累计真实展开面积，替代矩形公式） */
export interface DielineShape {
  type:
    | "rect"
    | "triangle"
    | "circle"
    | "trapezoid"
    | "polygon"
    | "ellipse"
    | "sector"
    | "semicircle"
    | "parallelogram"
    | "rhombus"
    | "annulus"
    | "segment"
    | "regularPolygon";
  /** rect: 宽×高(mm) */
  w?: number;
  h?: number;
  /** triangle / parallelogram: 底×高(mm)（parallelogram 用 b 作底、h 作高） */
  b?: number;
  /** circle / semicircle / sector / segment: 半径(mm) */
  r?: number;
  /** trapezoid: 上底×下底×高(mm) */
  top?: number;
  bottom?: number;
  /** ellipse: 长半轴×短半轴(mm) */
  a?: number;
  /** sector / segment: 中心角(度) */
  angleDeg?: number;
  /** rhombus: 两条对角线(mm) */
  d1?: number;
  d2?: number;
  /** annulus: 外半径×内半径(mm) */
  rOuter?: number;
  rInner?: number;
  /** regularPolygon: 边数×边长(mm) */
  sides?: number;
  sideLen?: number;
  /** polygon: 顶点(mm)，至少 3 点，顺时针或逆时针均可 */
  points?: { x: number; y: number }[];
}

export interface AnalysisInput {
  [key: string]: string | number | boolean | object | undefined;
  /** 客户是否已提供完稿文件：true 时设计费减免为 0 */
  provideReadyDesign?: boolean;
  /** 烫金/凹凸局部覆盖率等级（可选）：low=4% / medium=8%(默认) / high=15% */
  surfaceCoverageLevel?: "low" | "medium" | "high";
  /** 预留：由稿件自动估算的烫金/凹凸覆盖率（0~1），优先级高于等级；未提供则按等级 */
  surfaceCoverageOverride?: number;
  /** 理论面积（刀线净面积 mm²）：覆盖矩形展开公式；优先级高于 dielineShapes 与 L/W/H 矩形公式 */
  dielineAreaMm2?: number;
  /** 刀线图形清单（视觉拆图累计真实面积用）：各图形尺寸由图纸标注读取，按几何公式逐个累计 */
  dielineShapes?: DielineShape[];
  /** 全张纸尺寸(mm)，如 {w:700,h:1000}；用于计算真实材料利用率与实际生产面积 */
  sheetSize?: { w: number; h: number };
  /** 每版（全张纸）只数：拼版排布数量 */
  piecesPerSheet?: number;
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
