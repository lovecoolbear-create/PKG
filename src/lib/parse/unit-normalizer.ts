// ========== 解析后单位归一化（建议 #2） ==========
// AI / 规则解析出的入参，在进 Guardrail / 成本引擎前做一次确定性单位归一化，
// 防止 "2.5cm" 被当 2.5mm、"1万张" 被当 1 张。本模块绝不涉及 LLM。
//
// 与 input-guardrail 同属「确定性输入预处理」职责：单位歧义在解析层就消除，
// 不让含混单位进入引擎产出误导性成本。

import type { AnalysisInput } from "@/types";

/** 各类长度单位 → mm 的换算系数（中性工程常量，确定性） */
export const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  毫米: 1,
  cm: 10,
  厘米: 10,
  公分: 10,
  m: 1000,
  米: 1000,
  inch: 25.4,
  英寸: 25.4,
  寸: 25.4,
};

/** 把任意已知单位的长度值换算为 mm（未知单位按原值返回） */
export function toMm(value: number, unit: string): number {
  const factor = UNIT_TO_MM[unit.toLowerCase()] ?? 1;
  if (factor === 1) return value;
  return Math.round(value * factor * 100) / 100;
}

export interface UnitConversion {
  field: string;
  fromUnit: string;
  toUnit: string;
  raw: number;
  normalized: number;
  note: string;
}

const DIM_KEYWORDS: Record<string, string[]> = {
  length: ["长", "length"],
  width: ["宽", "width"],
  height: ["高", "height"],
};

/** 在 sourceText 中找某维度的「数字+单位」，返回 mm 归一值（无单位则视为 mm 原值）。 */
function extractDimMm(
  text: string,
  keywords: string[]
): { value: number; unit: string } | null {
  for (const kw of keywords) {
    const re = new RegExp(
      `${kw}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mm|毫米|cm|厘米|公分|m|米|inch|英寸|寸|")?`,
      "i"
    );
    const m = text.match(re);
    if (m) {
      const v = Number(m[1]);
      const unit = m[2] ? m[2].toLowerCase() : "mm";
      return { value: v, unit };
    }
  }
  return null;
}

/**
 * 确定性单位归一化。返回归一后的 input 与本次应用的换算清单（供 UI 透明展示）。
 * 规则：
 * - 长/宽/高：若 sourceText 中该维度带非 mm 单位（cm/m/英寸/寸），按系数换算为 mm；
 *   无文本证据（如纯图片解析）则保持原值（视为 mm）。
 * - 数量：口语 "万"（如 "1万张"）归一为个（×10000）。
 */
export function normalizeAnalysisInputUnits(
  input: Partial<AnalysisInput>,
  sourceText = ""
): { input: Partial<AnalysisInput>; conversions: UnitConversion[] } {
  const out: Partial<AnalysisInput> = { ...input };
  const conversions: UnitConversion[] = [];
  const text = sourceText || "";

  for (const dim of ["length", "width", "height"] as const) {
    const found = extractDimMm(text, DIM_KEYWORDS[dim]);
    if (!found) continue; // 文本无该维度证据，保持原值（视为 mm）
    // 以「文本原始数字 + 文本单位」为权威来源换算为 mm，避免与 LLM 已换算值叠加翻倍。
    const normalized = toMm(found.value, found.unit);
    const cur = Number(out[dim]);
    if (!Number.isFinite(cur) || cur <= 0) {
      // input 缺该维度：由文本补全
      (out as Record<string, unknown>)[dim] = normalized;
      conversions.push({
        field: dim,
        fromUnit: found.unit,
        toUnit: "mm",
        raw: found.value,
        normalized,
        note: `${dim} 由文本 ${found.unit} 补全并归一为 mm`,
      });
    } else if (normalized !== cur) {
      (out as Record<string, unknown>)[dim] = normalized;
      conversions.push({
        field: dim,
        fromUnit: found.unit,
        toUnit: "mm",
        raw: cur,
        normalized,
        note: `${dim} 由文本 ${found.unit} 归一为 mm（×${UNIT_TO_MM[found.unit.toLowerCase()] ?? 1}）`,
      });
    }
  }

  // 数量：口语「万」处理（如 "1万张" → 10000）
  const qty = Number(out.quantity);
  if (Number.isFinite(qty) && qty > 0 && text) {
    const wan = text.match(/(\d+(?:\.\d+)?)\s*万\s*(?:个|张|只|份|箱|pcs|PCS)?/i);
    if (wan && Math.round(qty) === Math.round(Number(wan[1]))) {
      const normalized = Math.round(Number(wan[1]) * 10000);
      if (normalized !== qty) {
        out.quantity = normalized;
        conversions.push({
          field: "quantity",
          fromUnit: "万",
          toUnit: "个",
          raw: qty,
          normalized,
          note: `数量由「万」归一为个（×10000）`,
        });
      }
    }
  }

  return { input: out, conversions };
}
