/**
 * 文档「第10章 示例演算」权威重算脚本
 * 用真实 Agent 函数跑文档示例（彩盒 200×150×80 / 5000 / 白卡350 / 胶印4C / 哑膜 / 糊盒 / 扣底盒 / 华东），
 * 输出每一维度金额、分项明细、财务拆解、总额、单只价、占比，供文档同步（避免手算口径漂移）。
 */
import {
  materialAgent,
  processAgent,
  laborAgent,
  designAgent,
  financeAgent,
} from "@/lib/agents/specialists";
import { deriveAnalysisContext } from "@/lib/agents/analysis-context";
import type { AnalysisInput } from "@/types";

const input: AnalysisInput = {
  quantity: 5000,
  length: 200,
  width: 150,
  height: 80,
  material: "white_card",
  grammage: "350",
  printMethod: "offset",
  colorCount: "4",
  surfaceTreatment: "matte_laminate",
  needGluing: true,
  boxType: "tuck_end",
  laborRegion: "east_china",
  deliveryLocation: "east_china",
  targetDelivery: "standard",
};

const ctx = deriveAnalysisContext(input);
const mat = materialAgent(ctx);
const lab = laborAgent(ctx);
const proc = processAgent(ctx);
const des = designAgent(ctx);
const fin = financeAgent(ctx, mat.estimatedAmount + lab.estimatedAmount + proc.estimatedAmount + des.estimatedAmount);

const rows = [mat, lab, proc, des, fin];
const subtotal = rows.slice(0, 4).reduce((s, r) => s + r.estimatedAmount, 0);
const total = subtotal + fin.estimatedAmount;

function fmt(n: number) {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function pctOf(d: { estimatedAmount: number }) {
  return total > 0 ? Math.round((d.estimatedAmount / total) * 1000) / 10 : 0;
}

console.log("########## 文档示例权威重算 ##########");
console.log(`输入: 彩盒 200×150×80 / 5000 / 白卡350 / 胶印4C / 哑膜 / 糊盒 / 扣底盒 / 华东`);
console.log(`净面积=${ctx.netAreaM2.toFixed(4)} m²/个  拼版后=${ctx.imposedAreaM2.toFixed(4)} m²/个  损耗率=${(ctx.lossRate * 100).toFixed(0)}%`);
console.log("");
for (const r of rows) {
  console.log(`\n[${r.dimensionLabel}] 合计 ¥${fmt(r.estimatedAmount)}  (占总额 ${pctOf(r)}%)`);
  for (const b of r.breakdown || []) {
    console.log(`   - ${b.label.padEnd(30)} ¥${fmt(b.amount)}${b.note ? `  （${b.note}）` : ""}`);
  }
}
console.log("\n========== 汇总 ==========");
console.log(`材料(含油墨): ¥${fmt(mat.estimatedAmount)}`);
console.log(`人工      : ¥${fmt(lab.estimatedAmount)}`);
console.log(`加工      : ¥${fmt(proc.estimatedAmount)}`);
console.log(`设计制版  : ¥${fmt(des.estimatedAmount)}`);
console.log(`制造小计  : ¥${fmt(subtotal)}`);
console.log(`财务合计  : ¥${fmt(fin.estimatedAmount)}`);
console.log(`总额      : ¥${fmt(total)}`);
console.log(`单只价    : ¥${fmt(total / Number(input.quantity))} / 个`);
console.log(`设计制版占比 : ${pctOf(des)}%  (预期区间 3%-10%，小批量越界属正常)`);

// 数量敏感提示：固定费不变，仅分摊基数变大
const fixed = des.estimatedAmount;
console.log("\n========== 数量敏感提示 ==========");
for (const mult of [2, 5]) {
  const q = Math.round(Number(input.quantity) * mult);
  console.log(`数量提升至 ${q.toLocaleString()} 个 → 单只设计制版成本 ≈ ¥${fmt(Math.round((fixed / q) * 10000) / 10000)}`);
}
