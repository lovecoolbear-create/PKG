// ========== 品类计量单位（确定性，非 AI 生成） ==========
// 用于 UI 展示与 AI 话术的中性工程术语。
// - 平印（册/张）、标签（张）按单张计；
// - 盒类（彩盒/瓦楞）按「只」计。
export function unitLabel(productType: string): string {
  if (productType === "flat_print") return "册/张";
  if (productType === "label") return "张";
  return "只";
}
