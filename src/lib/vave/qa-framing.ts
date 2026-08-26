// QA / 质量语境受控表述（需求规格2）。
//
// 铁律：允许把「质量过度包装」改写为「结构冗余优化」，但必须保留原始物理余量数据
// （如「抗压冗余度 +35%」），严禁隐瞒真实质量隐患。若无法量化余量，则确定性拒绝改写。
import type { AnalysisReport, QaFraming } from "@/types";

/** 受控改写白名单（仅此一条，且必须带物理余量） */
const QA_ALLOWED_REFRAME: { original: string; reframed: string } = {
  original: "质量过度包装",
  reframed: "结构冗余优化",
};

/**
 * 构建 QA 受控表述。
 * - 仅当 physicalFeasibility 存在、且可核算出「正冗余度」时，才允许改写；
 * - 改写必附带物理余量（抗压冗余度 = (有效抗压 - 安全阈值) / 安全阈值）；
 * - 余量不可得（缺物理校验 / 缺堆码载荷 / 冗余度≤0）时 applied=false，并给出拒绝原因——
 *   绝不为了"好听"而掩盖质量隐患。
 */
export function buildQaFraming(report: AnalysisReport): QaFraming {
  const base: QaFraming = {
    applied: false,
    original: QA_ALLOWED_REFRAME.original,
    marginRetained: false,
  };

  const phys = report.physicalFeasibility;
  if (!phys || !phys.metrics) {
    return {
      ...base,
      rejectReason: "缺少物理可行性校验数据，禁止改写以免掩盖潜在质量隐患",
    };
  }

  const { effectiveBCT, requiredBCT } = phys.metrics;
  if (!(requiredBCT > 0)) {
    return {
      ...base,
      rejectReason:
        "缺少堆码载荷数据（毛重/层数），无法核算抗压冗余度，禁止改写",
    };
  }

  const redundancyPct = ((effectiveBCT - requiredBCT) / requiredBCT) * 100;
  const physicalMargin = `抗压冗余度 ${redundancyPct >= 0 ? "+" : ""}${redundancyPct.toFixed(0)}%（有效抗压 ${effectiveBCT.toFixed(0)}kgf / 安全阈值 ${requiredBCT.toFixed(0)}kgf）`;

  // 冗余度≤0：已无优化空间，改写"结构冗余优化"会误导，确定性拒绝。
  if (redundancyPct <= 0) {
    return {
      ...base,
      physicalMargin,
      marginRetained: true, // 余量已保留（用于展示真实隐患）
      rejectReason:
        "当前抗压冗余度≤0%（有效抗压未超安全阈值），不存在可优化冗余，禁止改写为「结构冗余优化」",
    };
  }

  return {
    applied: true,
    original: QA_ALLOWED_REFRAME.original,
    reframed: QA_ALLOWED_REFRAME.reframed,
    physicalMargin,
    marginRetained: true,
  };
}
