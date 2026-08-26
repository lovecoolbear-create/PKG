// VAVE 角色决策策略（展示层裁剪，纯控制层，重构于 2026-08-26）。
// 8 部门 × 3 职级组合：部门决定「加重维度(emphasis) + 粒度(granularity)」，职级决定「表述锚定(framing)」。
//
// 重构铁律（对应需求规格1）：
// - RolePolicy 仅允许调控「信息呈现的粒度(granularity) 与 重点(emphasis/framing)」。
// - 严禁 hide / soften / reframe 等可删除或篡改核心成本基线、物理风险指标的能力。
// - 任意角色都不得隐藏维度金额或物理风险——见 INVIOLABLE_INDICATORS，由 multi-view / RolePanel 强制渲染。
import type { RolePolicy } from "@/types";

export type RoleDept =
  | "procurement"
  | "rd"
  | "quality"
  | "production"
  | "finance"
  | "sales"
  | "exec"
  | "customer";

export type RoleLevel = "exec" | "manager" | "director";

export const DEPT_LABELS: Record<RoleDept, string> = {
  procurement: "采购 / 供应链",
  rd: "研发 / 工程",
  quality: "质量 / QA",
  production: "生产 / 制造",
  finance: "财务",
  sales: "销售 / 业务",
  exec: "高管 / 决策层",
  customer: "客户（品牌方）",
};

export const LEVEL_LABELS: Record<RoleLevel, string> = {
  exec: "执行",
  manager: "经理",
  director: "总监 / VP",
};

/**
 * 不可侵犯清单（规格1 硬约束）：以下指标/数据任何角色都不得隐藏、淡化或改写。
 * - 各成本维度的 estimatedAmount（核心成本基线）
 * - 总成本 totalCost（核心成本基线）
 * - 物理风险指标 physicalFeasibility（P-Physics）
 * - error 级校验 validationIssues
 * 展示层（RolePanel / multi-view）必须始终渲染这些项。
 */
export const INVIOLABLE_INDICATORS = [
  "dimensions.*.estimatedAmount",
  "totalCost",
  "physicalFeasibility",
  "validationIssues[severity=error]",
] as const;

interface DeptStrategy {
  emphasisDimensions: string[];
  /** 信息呈现粒度（唯一允许的可见性控制，永不删除基线） */
  granularity: RolePolicy["granularity"];
}

// 部门级策略：仅设「强调维度 + 粒度」。不再有任何 hide/soften/reframe。
const DEPT_POLICY: Record<RoleDept, DeptStrategy> = {
  procurement: {
    emphasisDimensions: ["material", "process", "finance_other"],
    granularity: "fine", // 谈判需要完整拆分
  },
  rd: {
    emphasisDimensions: ["material", "design_plate", "process"],
    granularity: "fine", // 研发需要结构明细
  },
  quality: {
    emphasisDimensions: ["material", "process"],
    // 注意：质量(QA)不再隐藏 finance_other（旧策略曾 hide，违反规格1）。
    // QA 语境的"质量过度包装"→"结构冗余优化"改写改由 qa-framing 受控处理（保留物理余量）。
    granularity: "standard",
  },
  production: {
    emphasisDimensions: ["labor", "process", "design_plate"],
    granularity: "standard",
  },
  finance: {
    emphasisDimensions: ["finance_other", "material"],
    granularity: "coarse", // 财务重总额，折叠明细
  },
  sales: {
    emphasisDimensions: ["material", "finance_other"],
    granularity: "coarse",
  },
  exec: {
    emphasisDimensions: ["material", "finance_other", "process"],
    granularity: "coarse", // 高管重战略总额
  },
  customer: {
    emphasisDimensions: ["material", "process"],
    granularity: "standard",
  },
};

// 职级决定表述锚定与导语
const LEVEL_FRAMING: Record<
  RoleLevel,
  { framing: RolePolicy["framing"]; intro: string }
> = {
  exec: {
    framing: "design",
    intro: "聚焦可落地的具体优化点与设计参数，便于一线执行推进。",
  },
  manager: {
    framing: "ratio",
    intro: "以占比与结构看清降本空间，便于跨部门协调与优先级排序。",
  },
  director: {
    framing: "amount",
    intro: "以金额与总降本潜力呈现，便于战略优先级决策与资源投入。",
  },
};

/** 组合部门 + 职级 → 完整 RolePolicy（纯展示控制，MVP 静态配置） */
export function buildRolePolicy(
  dept: RoleDept,
  level: RoleLevel
): RolePolicy {
  const d = DEPT_POLICY[dept];
  const l = LEVEL_FRAMING[level];
  return {
    role: `${dept}_${level}`,
    label: `${DEPT_LABELS[dept]} · ${LEVEL_LABELS[level]}`,
    emphasisDimensions: d.emphasisDimensions,
    granularity: d.granularity,
    framing: l.framing,
  };
}

/**
 * 按粒度选取可见维度行。
 * 关键：coarse 时把非强调维度折叠为一条「其他成本项」汇总行（不删除、总额守恒），
 * 绝不隐藏任何基线数字——满足规格1"严禁掩盖核心成本基线"。
 */
export function selectVisibleDimensions(
  dimensions: { dimension: string; dimensionLabel: string; estimatedAmount: number; ratio: number }[],
  policy: RolePolicy
): { dimension: string; dimensionLabel: string; estimatedAmount: number; ratio: number; rolledUp?: boolean }[] {
  if (policy.granularity === "standard" || policy.granularity === "fine") {
    return dimensions.map((d) => ({ ...d }));
  }
  // coarse：强调维度单独列出，其余折叠为「其他成本项」
  const emphasis = new Set(policy.emphasisDimensions);
  const top = dimensions.filter((d) => emphasis.has(d.dimension));
  const rest = dimensions.filter((d) => !emphasis.has(d.dimension));
  const rolled = rest.reduce(
    (acc, d) => ({
      amount: acc.amount + d.estimatedAmount,
      ratio: acc.ratio + d.ratio,
    }),
    { amount: 0, ratio: 0 }
  );
  const result: {
    dimension: string;
    dimensionLabel: string;
    estimatedAmount: number;
    ratio: number;
    rolledUp?: boolean;
  }[] = top.map((d) => ({ ...d }));
  if (rest.length > 0) {
    result.push({
      dimension: "__other__",
      dimensionLabel: "其他成本项（折叠）",
      estimatedAmount: rolled.amount,
      ratio: rolled.ratio,
      rolledUp: true,
    });
  }
  return result;
}
