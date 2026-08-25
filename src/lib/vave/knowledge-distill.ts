// ========== P7 知识沉淀：真实案例 → AI 反推待固化规则 ==========
// 对比「引擎估算 vs 实际成交」，由 AI 反推应调整的 KB 参数/规则。
//
// 铁律（§3.2 硬约束 B：AI 无写入权）：
// - 本模块只「提案」——产出 PendingRule 进入待审核池，绝不直写生产规则库/知识库/代码。
// - 待审核池经人工（SQE/工程师）在 UI 点击「确认固化」后，才由确定性写入转 KB override。
// - AI 反推依据必须来自真实案例对比（可追溯），不得凭空捏造。

import type { AnalysisInput, AnalysisReport } from "@/types";
import { callStructuredLLM } from "@/lib/llm/structured";
import type { AiSettings } from "@/lib/config/ai-settings";

export type PendingRuleTarget =
  | "material_price"
  | "flute_config"
  | "grammage_floor"
  | "process_rate"
  | "loss_rate"
  | "other";

export interface PendingRule {
  id: string;
  title: string;
  target: PendingRuleTarget;
  /** 拟修改的配置/参数（人类可读） */
  description: string;
  /** 建议值（结构化描述，供确认后写入 override） */
  proposedValue: string;
  /** 反推依据（来自真实案例对比，可追溯） */
  evidence: string;
  /** 置信度 0-100 */
  confidence: number;
  /** 提案来源：ai=大模型反推；system=确定性对比兜底 */
  source: "ai" | "system";
  createdAt: string;
  status: "pending" | "confirmed" | "rejected";
}

export interface DistillInput {
  baselineInput: AnalysisInput;
  baselineReport: AnalysisReport;
  /** 实际成交单只成本（元） */
  actualPerUnit: number;
  /** 实际采用的方案/工艺（自由文本，可选） */
  actualChoices?: string;
  aiSettings?: AiSettings;
}

/** 模型原始输出：仅提案内容，id/status 由确定性层补全 */
interface RawRule {
  title: string;
  target: PendingRuleTarget;
  description: string;
  proposedValue: string;
  evidence: string;
  confidence: number;
}
interface RawDistill {
  rules: RawRule[];
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const SYSTEM_PROMPT = `你是包装成本知识工程师。给定一份「引擎估算成本」与「客户实际成交单只成本」的对比，请反推应当调整的知识库参数/规则。
铁律（不可违反）：
- 不得编造金额；evidence 必须明确点出估算值与实测值的差异来源。
- 只输出可操作的参数调整建议（材料单价档、坑型系数、克重下限、加工费率、损耗率等），不要输出客套话。
- 输出严格 JSON（不要多余文字）：
{"rules":[{"title":"...","target":"material_price|flute_config|grammage_floor|process_rate|loss_rate|other","description":"...","proposedValue":"...","evidence":"...","confidence":<0-100>}]}
最多 4 条，按置信度降序。`;

/** 确定性兜底：基于估算 vs 实测偏差直接生成待审核规则 */
function systemDistill(input: DistillInput): PendingRule[] {
  const est = input.baselineReport.totalCost.perUnit.max;
  const act = input.actualPerUnit;
  const delta = act - est;
  const now = new Date().toISOString();
  const base = {
    id: genId(),
    source: "system" as const,
    createdAt: now,
    status: "pending" as const,
  };
  if (Math.abs(delta) < 0.0001) {
    return [
      {
        ...base,
        title: "估算与实际吻合",
        target: "other",
        description: "引擎估算单只成本与实际成交基本一致，暂无需调整。",
        proposedValue: "维持当前参数",
        evidence: `估算 ¥${est.toFixed(4)} ≈ 实际 ¥${act.toFixed(4)}`,
        confidence: 70,
      },
    ];
  }
  if (delta < 0) {
    // 实际更便宜 → 估算偏高（材料/损耗/费率可能偏贵）
    const ratio = act / (est || 1);
    const material = input.baselineReport.dimensions.find((d) => d.dimension === "material");
    const target: PendingRuleTarget = material && material.ratio > 50 ? "material_price" : "process_rate";
    return [
      {
        ...base,
        title: target === "material_price" ? "材料基准价经验修正" : "加工/费率经验修正",
        target,
        description: `实际单只 ¥${act.toFixed(4)} 低于估算 ¥${est.toFixed(4)}（约低 ${((1 - ratio) * 100).toFixed(1)}%），疑似${target === "material_price" ? "材料基准价" : "加工费率"}偏高。`,
        proposedValue: `${target === "material_price" ? "材料吨价" : "加工费率"}建议下调至当前的 ${(ratio * 100).toFixed(0)}% 后复核`,
        evidence: `估算单只 ¥${est.toFixed(4)} vs 实际成交 ¥${act.toFixed(4)}；材料占比 ${material?.ratio ?? "?"}%`,
        confidence: 62,
      },
    ];
  }
  // 实际更贵 → 疑似漏算（损耗/小项）
  return [
    {
      ...base,
      title: "成本项疑似漏算",
      target: "loss_rate",
      description: `实际单只 ¥${act.toFixed(4)} 高于估算 ¥${est.toFixed(4)}（约高 ${((delta / (est || 1)) * 100).toFixed(1)}%），疑似损耗率或小额加工项低估。`,
      proposedValue: "复核损耗率与小额加工费（如后道/运输）",
      evidence: `估算单只 ¥${est.toFixed(4)} vs 实际成交 ¥${act.toFixed(4)}`,
      confidence: 58,
    },
  ];
}

/**
 * 由真实案例反推待固化规则（P7 核心）。仅提案，不写库。
 * 失败/未配置时返回确定性对比兜底（仍为可审核的提案）。
 */
export async function distillCaseToRules(input: DistillInput): Promise<PendingRule[]> {
  const fallback = systemDistill(input);
  const est = input.baselineReport.totalCost.perUnit.max;
  const dims = input.baselineReport.dimensions
    .map((d) => `${d.dimensionLabel}:¥${d.estimatedAmount}(${d.ratio}%)`)
    .join("；");
  const user = `引擎估算单只成本 ¥${est.toFixed(4)}，实际成交单只成本 ¥${input.actualPerUnit.toFixed(4)}。
各维估算：${dims}
实际方案/工艺：${input.actualChoices || "（未提供）"}
请反推应调整的知识库参数（1-4 条）。`;

  const result = await callStructuredLLM<RawDistill>({
    system: SYSTEM_PROMPT,
    user,
    fallback: { rules: [] },
    settings: input.aiSettings,
    temperature: 0.2,
    timeoutMs: 20000,
  });

  if (!result.rules || result.rules.length === 0) {
    return fallback;
  }

  const now = new Date().toISOString();
  return result.rules.map((r) => ({
    id: genId(),
    title: r.title,
    target: r.target,
    description: r.description,
    proposedValue: r.proposedValue,
    evidence: r.evidence,
    confidence: Math.max(0, Math.min(100, Math.round(r.confidence ?? 50))),
    source: "ai" as const,
    createdAt: now,
    status: "pending" as const,
  }));
}
