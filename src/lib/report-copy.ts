// 客户报告文案集中管理（便于后期 A/B 测试与多语言）
// 语气：专业、中立、不夸大；金额一律以区间呈现。
import type { ClientSectionKey } from "@/types";

/** 报告模块固定顺序（前端严格按此渲染） */
export const SECTION_ORDER: ClientSectionKey[] = [
  "total_range",
  "structure",
  "drivers",
  "completeness",
  "confidence",
  "small_batch",
  "optimization",
  "disclaimer",
  "cta",
];

/** 免责声明（顶部 + 底部双 banner，固定文案） */
export const DISCLAIMER =
  "本结果为估算，仅供参考，最终以正式报价为准。";

/** 底部免责补充说明确认口径 */
export const DISCLAIMER_FOOTNOTE =
  "本报告基于行业基准规则与公开/估算行情生成，实际价格以工厂正式报价与合同约定为准。";

/** 转化入口文案（固定模板，预留可配置） */
export const CTA_COPY =
  "如需进一步做成本优化（VAVE）或供应链诊断，可继续沟通，我们提供深度成本拆解与落地方案。";

/**
 * 小批量提示：设计/制版占比超出预期区间时向其解释
 * 「这是一次性固定费用，单只占比随批量提升而下降，并非估算偏差」。
 * 语气中立、专业，强调这是真实成本特征而非估算错误。
 */
export const SMALL_BATCH_MESSAGE =
  "设计与制版（制版费 + 设计费 + 打样费）为一次性固定费用，不随数量按件计算。在当前较小批量下，这笔固定费用被较少数量分摊，因而单只占比偏高——这是该类产品的真实成本特征，并非估算偏差。";

/** 模块标题（对应 sectionOrder 的中文标签） */
export const SECTION_TITLES: Record<ClientSectionKey, string> = {
  total_range: "总成本区间",
  structure: "五维成本结构占比",
  drivers: "主要成本驱动点",
  completeness: "信息完整度与默认假设",
  confidence: "置信度说明",
  small_batch: "小批量提示",
  optimization: "初步优化方向",
  disclaimer: "免责声明",
  cta: "进一步沟通",
};

/** 置信度分级文案 */
export function confidenceLabel(value: number): string {
  if (value >= 75) return "较高";
  if (value >= 60) return "中等";
  return "偏低";
}
