// VAVE 角色决策策略（展示层裁剪，仅作用于 VAVE 策略层，不触及成本引擎）
// 8 部门 × 3 职级组合：部门决定「加重/屏蔽」维度，职级决定「表述锚定(framing)」。
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

interface DeptStrategy {
  emphasisDimensions: string[];
  suppressRules: RolePolicy["suppressRules"];
}

// 部门级策略：对齐成本维度 code（material/labor/process/design_plate/finance_other）
const DEPT_POLICY: Record<RoleDept, DeptStrategy> = {
  procurement: {
    emphasisDimensions: ["material", "process", "finance_other"],
    suppressRules: [],
  },
  rd: {
    emphasisDimensions: ["material", "design_plate", "process"],
    suppressRules: [{ keyword: "账期", action: "soften", reframe: "资金占用" }],
  },
  quality: {
    emphasisDimensions: ["material", "process"],
    // 对 QA 不直述「质量过度包装」，改写为中性表述
    suppressRules: [
      {
        keyword: "质量过度包装",
        action: "soften",
        reframe: "设计冗余优化空间",
      },
      {
        dimension: "finance_other",
        action: "soften",
        reframe: "在满足质量合规前提下评估成本",
      },
    ],
  },
  production: {
    emphasisDimensions: ["labor", "process", "design_plate"],
    suppressRules: [],
  },
  finance: {
    emphasisDimensions: ["finance_other", "material"],
    suppressRules: [{ keyword: "工效", action: "soften", reframe: "单位人工成本" }],
  },
  sales: {
    emphasisDimensions: ["material", "finance_other"],
    suppressRules: [],
  },
  exec: {
    emphasisDimensions: ["material", "finance_other", "process"],
    suppressRules: [],
  },
  customer: {
    emphasisDimensions: ["material", "process"],
    suppressRules: [],
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

/** 组合部门 + 职级 → 完整 RolePolicy（MVP 静态配置，后续可下沉知识库运营调优） */
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
    suppressRules: d.suppressRules,
    framing: l.framing,
  };
}
