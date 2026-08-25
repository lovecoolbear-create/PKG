// ========== P6 谈判辅助：多 Agent 博弈（引擎 verify） ==========
// 采购方 / 供应方 / 成本仲裁三方 LLM 角色扮演，每轮主张回引擎校验（数字守恒）。
//
// 铁律落地：
// - 数字守恒：任何主张单价不得由 AI 直接给数；若主张「改方案降本」，必须回引擎
//   runOrchestrator 重算 perUnit 验证（proposedPerUnit 与引擎实算须一致）。
// - 可溯源：每轮带 dataPointer 指向引擎保本价 / 报价字段。
// - 无 LLM 时返回确定性模板（基于 computeConcession 的保本锚），仍可用。

import type { AnalysisInput, AnalysisReport } from "@/types";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { getProductConfig } from "@/config/products";
import {
  runGated,
  detectNumberDrift,
  type DriftFinding,
} from "@/lib/agents/consistency-gate";
import { computeConcession } from "./negotiation";
import type { AiSettings } from "@/lib/config/ai-settings";

export type NegotiationRole = "buyer" | "supplier" | "cost_arbitrator";

export interface NegotiationTurn {
  role: NegotiationRole;
  roleLabel: string;
  utterance: string;
  /** 该角色本轮主张的单价（元/只） */
  proposedPerUnit?: number;
  /** 主张是否经引擎校验可行（≥保本价） */
  feasible?: boolean;
  /** 若该轮主张「改方案降本」，引擎实算的单价（用于 verify） */
  verifiedPerUnit?: number;
  dataPointer?: { fieldPath: string; label: string; value: string };
  source: "llm" | "template";
  /** P8 一致性闸门：本轮叙述文本 vs 指针真实数字的漂移发现 */
  driftWarnings?: DriftFinding[];
}

export interface NegotiationResult {
  turns: NegotiationTurn[];
  source: "llm" | "template";
  /** 引擎保本价（确定性锚，元/只） */
  breakEvenPerUnit: number;
  /** 当前报价（单只上限，元/只） */
  quotePerUnit: number;
}

/** 模型原始输出：仅主张与话术，数字由引擎 verify */
interface RawTurn {
  role: NegotiationRole;
  roleLabel: string;
  utterance: string;
  proposedPerUnit?: number;
  /** 可选：主张的降本方案 override，回引擎验证 */
  override?: Partial<AnalysisInput>;
}
interface RawNegotiation {
  turns: RawTurn[];
}

const ROLE_LABELS: Record<NegotiationRole, string> = {
  buyer: "采购方",
  supplier: "供应方",
  cost_arbitrator: "成本仲裁",
};

/** 确定性校验某主张单价是否 ≥ 保本价 */
function checkFeasible(proposed: number | undefined, floor: number): boolean | undefined {
  if (proposed === undefined || Number.isNaN(proposed)) return undefined;
  return proposed >= floor;
}

/**
 * 回引擎验证一个降本方案 override，返回实算单只成本（数字守恒核心）。
 * 任意失败返回 NaN（调用方按不可验证处理）。
 */
export async function verifyScenarioPerUnit(
  baseInput: AnalysisInput,
  productType: string,
  override: Partial<AnalysisInput>,
  aiSettings?: AiSettings
): Promise<number> {
  const config = getProductConfig(productType);
  if (!config) return NaN;
  const merged: AnalysisInput = { ...baseInput, ...override } as AnalysisInput;
  const report = await runOrchestrator({
    sessionId: `neg-verify-${Date.now()}`,
    config,
    input: merged,
    aiSettings,
  });
  return report.totalCost.perUnit.max;
}

/** 确定性模板谈判（无 LLM 兜底，基于保本锚，可落地） */
function templateNegotiation(
  baseReport: AnalysisReport,
  targetPerUnit?: number
): NegotiationResult {
  const c = computeConcession(baseReport);
  const quote = c.quotePerUnit;
  const floor = c.breakEvenPerUnit;
  const target = typeof targetPerUnit === "number" ? targetPerUnit : Math.round(quote * 0.9 * 10000) / 10000;
  const settle = Math.max(floor, Math.min(quote, (target + floor) / 2));
  const turns: NegotiationTurn[] = [
    {
      role: "buyer",
      roleLabel: ROLE_LABELS.buyer,
      utterance: `我方目标价约 ¥${target.toFixed(4)}/只，当前报价 ¥${quote.toFixed(4)} 偏高，请就材料与工艺分项让利。`,
      proposedPerUnit: target,
      feasible: checkFeasible(target, floor),
      dataPointer: { fieldPath: "totalCost.perUnit.max", label: "当前报价", value: `¥${quote.toFixed(4)}` },
      source: "template",
    },
    {
      role: "supplier",
      roleLabel: ROLE_LABELS.supplier,
      utterance: `我方保本价约 ¥${floor.toFixed(4)}/只（含约 5% 利润底线），¥${target.toFixed(4)} 低于保本无法承接；可在材料随行就市 + 加工一口价框架上优化。`,
      proposedPerUnit: floor,
      feasible: checkFeasible(floor, floor),
      dataPointer: { fieldPath: "totalCost.perUnit.min", label: "保本价", value: `¥${floor.toFixed(4)}` },
      source: "template",
    },
    {
      role: "cost_arbitrator",
      roleLabel: ROLE_LABELS.cost_arbitrator,
      utterance: `建议落点 ¥${settle.toFixed(4)}/只：介于目标与保本之间，供应方仍有合理利润、采购方获实质降本；具体分项需以引擎重算的 VAVE 方案为准。`,
      proposedPerUnit: Math.round(settle * 10000) / 10000,
      feasible: checkFeasible(settle, floor),
      dataPointer: { fieldPath: "totalCost.perUnit.max", label: "建议落点", value: `¥${settle.toFixed(4)}` },
      source: "template",
    },
  ];
  return { turns, source: "template", breakEvenPerUnit: floor, quotePerUnit: quote };
}

const SYSTEM_PROMPT = `你是包装采购谈判的模拟引擎，需生成采购方、供应方、成本仲裁三方的多轮对话。
铁律（不可违反）：
- 不得编造任何精确金额、占比、工期；proposedPerUnit 只能是数字或省略。
- 若某方主张「通过改方案降本」（如降克重/提批量），必须在 override 中给出对应的方案字段（如 {"grammage":128} 或 {"quantity":2000}），系统会回引擎实算校验。
- 输出严格 JSON（不要多余文字）：
{"turns":[{"role":"buyer|supplier|cost_arbitrator","roleLabel":"采购方|供应方|成本仲裁","utterance":"话术","proposedPerUnit":<数字|省略>,"override":<方案对象|省略>}]}
顺序：buyer 先开价 → supplier 守价 → cost_arbitrator 给落点建议。语气符合各自立场。`;

/**
 * 模拟谈判（P6 核心）。每轮主张经引擎校验（保本锚 / override 重算）。
 * 失败/未配置时返回确定性模板（基于保本锚）。
 */
export async function simulateNegotiation(
  baseInput: AnalysisInput,
  productType: string,
  baseReport: AnalysisReport,
  aiSettings?: AiSettings,
  targetPerUnit?: number
): Promise<NegotiationResult> {
  const c = computeConcession(baseReport);
  const floor = c.breakEvenPerUnit;
  const quote = c.quotePerUnit;

  const fallback = templateNegotiation(baseReport, targetPerUnit);
  const user = `当前报价 ¥${quote.toFixed(4)}/只，保本价约 ¥${floor.toFixed(4)}/只${typeof targetPerUnit === "number" ? `，采购方目标价 ¥${targetPerUnit.toFixed(4)}/只` : ""}。请生成三方谈判模拟（buyer→supplier→cost_arbitrator）。`;

  const { result } = await runGated<RawNegotiation>({
    layer: "negotiation",
    system: SYSTEM_PROMPT,
    user,
    fallback: { turns: [] },
    settings: aiSettings,
    temperature: 0.3,
    timeoutMs: 25000,
    engineKV: { breakEvenPerUnit: floor, quotePerUnit: quote },
  });

  // 未配置 LLM：result 的空 turns → 用模板
  if (!result.turns || result.turns.length === 0) {
    return fallback;
  }

  const turns: NegotiationTurn[] = [];
  for (const t of result.turns) {
    const turn: NegotiationTurn = {
      role: t.role,
      roleLabel: t.roleLabel || ROLE_LABELS[t.role],
      utterance: t.utterance,
      proposedPerUnit:
        typeof t.proposedPerUnit === "number" && !Number.isNaN(t.proposedPerUnit)
          ? Math.round(t.proposedPerUnit * 10000) / 10000
          : undefined,
      source: "llm",
    };
    turn.feasible = checkFeasible(turn.proposedPerUnit, floor);

    // 若主张改方案，回引擎 verify（数字守恒：AI 主张数字须与引擎一致）
    if (t.override && Object.keys(t.override).length > 0) {
      try {
        const verified = await verifyScenarioPerUnit(baseInput, productType, t.override, aiSettings);
        if (!Number.isNaN(verified)) {
          turn.verifiedPerUnit = Math.round(verified * 10000) / 10000;
        }
      } catch {
        // 验证失败：留空，前端提示「未验证」
      }
    }

    const ptrField = t.role === "supplier" ? "totalCost.perUnit.min" : "totalCost.perUnit.max";
    const ptrValue = t.role === "supplier" ? `¥${floor.toFixed(4)}` : `¥${quote.toFixed(4)}`;
    turn.dataPointer = {
      fieldPath: ptrField,
      label: t.role === "supplier" ? "保本价" : "报价",
      value: ptrValue,
    };
    // P8 漂移检测：本轮叙述 vs 指针真实数字
    const drift = detectNumberDrift(t.utterance, [
      { fieldPath: ptrField, label: turn.dataPointer.label, value: ptrValue },
    ]);
    turn.driftWarnings = drift.length ? drift : undefined;
    turns.push(turn);
  }

  return { turns, source: "llm", breakEvenPerUnit: floor, quotePerUnit: quote };
}
