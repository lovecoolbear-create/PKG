// ========== P3 推荐排序：确定性 Rule Filter + AI 软排序 ==========
// 流程：先确定性硬约束一票否决（物理强度/客户规范/MOQ）→ 可行集内 AI 按可实施性加权软排序 + 解释。
//
// 铁律落地：
// - 硬约束由确定性规则判定布尔，AI 绝无「加权放过」的权力（§3.1 介入纪律）。
// - 理论降本% 来自引擎（数字守恒），AI 只叠加可实施性维度并解释（事实守恒）。
// - 排序输出结构化可追溯：每个方案带 filterReason（否决原因）或 softReason（排序理由）。

import type { AnalysisInput } from "@/types";
import { FLUTE_TYPES } from "@/lib/cost-rules";
import {
  runGated,
  reconcileRankerNarrative,
} from "@/lib/agents/consistency-gate";
import { assessScenarioFeasibility, type FeasibilityResult } from "@/lib/physics/feasibility";
import type { AiSettings } from "@/lib/config/ai-settings";

/** 一个 VAVE 情景（已由其调用方重跑引擎得到 perUnit） */
export interface VaveScenario {
  id: string;
  label: string;
  /** 基于基线的 override（确定性构造） */
  override: Partial<AnalysisInput>;
  /** 该情景单只成本（引擎重跑结果） */
  perUnit: number;
  /** 基线单只成本 */
  baselinePerUnit: number;
}

export interface RankedScenario extends VaveScenario {
  passed: boolean;
  /** 一票否决原因（确定性） */
  filterReason?: string;
  /** 全局展示序：passed 在前按软排序，未过排后 */
  rank: number;
  /** AI/数字 软排序理由 */
  softReason?: string;
  /** 物理可行性校验结果（确定性层，含缺口数据；失败方案绝不透传 LLM） */
  feasibility?: FeasibilityResult;
}

/** 模型原始输出：仅排序与理由，硬约束与数字来自确定性层 */
interface RawRank {
  order: string[];
  reasons: Record<string, string>;
}

const MOQ_MIN = 500;
const GRAMMAGE_FLOOR = 80; // 常见纸张物理下限（g），低于则强度不达标

/**
 * 确定性硬约束过滤（一票否决）。
 * 返回 passed=false 即该方案不可行，绝不进入 AI 排序。
 * 返回 feasibility：物理可行性校验结果（确定性层，含缺口数据），供 UI 展示与审计。
 */
export interface RuleFilterResult {
  passed: boolean;
  reason?: string;
  feasibility?: FeasibilityResult;
}

export function ruleFilter(s: VaveScenario, base: AnalysisInput): RuleFilterResult {
  const t = s.override;

  // 1. 克重低于物理下限 → 强度不满足
  if (typeof t.grammage === "number" && t.grammage < GRAMMAGE_FLOOR) {
    return {
      passed: false,
      reason: `目标克重 ${t.grammage}g 低于物理下限 ${GRAMMAGE_FLOOR}g，强度不达标`,
      feasibility: assessScenarioFeasibility({ base, override: t }),
    };
  }

  // 2. 双坑降单坑且盒型需承重 → 否决
  // 双坑 takeUpFactor ≥ 2（BC/BE/AB），单坑 ≤ 1.54，以此确定性区分
  const baseIsDouble =
    (base.fluteType ? FLUTE_TYPES[String(base.fluteType)]?.takeUpFactor ?? 0 : 0) >= 2;
  const tgtFlute = t.fluteType ? FLUTE_TYPES[String(t.fluteType)] : undefined;
  const tgtIsDouble = tgtFlute ? (tgtFlute.takeUpFactor ?? 0) >= 2 : baseIsDouble;
  if (baseIsDouble && !tgtIsDouble) {
    const box = String(base.boxType || "");
    if (box === "rsc" || box === "die_cut") {
      return {
        passed: false,
        reason: `双坑降单坑后承重不足，盒型 ${box} 需保持双坑及以上`,
        feasibility: assessScenarioFeasibility({ base, override: t }),
      };
    }
  }

  // 3. 批量低于 MOQ 下限 → 否决
  if (typeof t.quantity === "number" && t.quantity < MOQ_MIN) {
    return {
      passed: false,
      reason: `批量 ${t.quantity} 低于 MOQ 下限 ${MOQ_MIN}`,
      feasibility: assessScenarioFeasibility({ base, override: t }),
    };
  }

  // 4. 物理性能与工艺可行性硬过滤（P-Physics）：
  //    方案触动物理属性时，强制调用确定性物理公式（McKee BCT / ECT / 湿敏衰减）；
  //    未通过 → FEASIBILITY_FAILED，确定性层一票否决，绝不透传下游 LLM。
  const phys = assessScenarioFeasibility({ base, override: t });
  if (!phys.passed && phys.failed) {
    return { passed: false, reason: phys.reason, feasibility: phys };
  }

  return { passed: true, feasibility: phys };
}

const RANK_SYSTEM_PROMPT = `你是一名资深包装 VAVE 降本专家。下面是一组「已通过硬约束」的可行降本方案，每个含理论降本百分比。
任务：结合可实施性（供应商能力、交期、质量风险、变更评审成本）给出优先级排序与每方案理由。
铁律（不可违反）：
- 不得编造金额、百分比、工期等任何数字；order 必须是给定 id 的子集与排列。
- 输出严格 JSON（不要多余文字）：{"order":["id1","id2",...],"reasons":{"id1":"理由","id2":"理由"}}。
- 理由要可执行、点出「为什么这个排前面/后面」（如供应商易做、无需重测、或需客户变更评审）。`;

/**
 * 规则过滤 + AI 软排序（P3 核心）。
 * @returns 带 passed/filterReason/rank/softReason 的排序结果；失败/未配置时按传入序（理论降本）确定性排序。
 */
export async function rankScenarios(
  scenarios: VaveScenario[],
  base: AnalysisInput,
  aiSettings?: AiSettings
): Promise<RankedScenario[]> {
  const filtered = scenarios.map((s) => ({ s, f: ruleFilter(s, base) }));
  const passed = filtered.filter((x) => x.f.passed).map((x) => x.s);

  // 确定性过滤结果（供 P8 对账：否决方案不得被 AI 称可行）
  const filterResults: Record<string, { passed: boolean; reason?: string }> = {};
  filtered.forEach(({ s, f }) => {
    filterResults[s.id] = { passed: f.passed, reason: f.reason };
  });

  const payload = passed.map((s) => ({
    id: s.id,
    label: s.label,
    savingPct: +(((s.baselinePerUnit - s.perUnit) / (s.baselinePerUnit || 1)) * 100).toFixed(1),
  }));

  const fallback: RawRank = {
    order: passed.map((s) => s.id),
    reasons: Object.fromEntries(passed.map((s) => [s.id, "按理论降本幅度排序"])),
  };

  const user = `以下为通过硬约束的可行 VAVE 方案（含理论降本%）：\n${JSON.stringify(
    payload
  )}\n请输出排序与理由。`;

  const { result } = await runGated<RawRank>({
    layer: "ranker",
    system: RANK_SYSTEM_PROMPT,
    user,
    fallback,
    settings: aiSettings,
    temperature: 0.2,
    timeoutMs: 20000,
    engineKV: { scenarioCount: scenarios.length, passedCount: passed.length },
    reconcile: (raw) => reconcileRankerNarrative(raw as RawRank, filterResults),
  });

  const usedFallback = result === fallback;
  const orderMap = new Map(result.order.map((id, i) => [id, i]));
  const passedRanked = passed
    .slice()
    .sort((a, b) => (orderMap.get(a.id) ?? 99) - (orderMap.get(b.id) ?? 99));

  const out: RankedScenario[] = [];
  passedRanked.forEach((s, i) => {
    out.push({
      ...s,
      passed: true,
      rank: i + 1,
      softReason: result.reasons[s.id] || "按理论降本幅度排序",
      feasibility: filtered.find((x) => x.s.id === s.id)?.f.feasibility,
    });
  });
  filtered
    .filter((x) => !x.f.passed)
    .forEach((x, i) => {
      out.push({
        ...x.s,
        passed: false,
        filterReason: x.f.reason,
        rank: passedRanked.length + 1 + i,
        softReason: undefined,
        feasibility: x.f.feasibility,
      });
    });

  if (usedFallback && out.length === 0) {
    // 无任何方案（极端情况）：原样返回，passed 基于过滤
    return filtered.map((x, i) => ({
      ...x.s,
      passed: x.f.passed,
      filterReason: x.f.reason,
      rank: i + 1,
    }));
  }
  return out;
}
