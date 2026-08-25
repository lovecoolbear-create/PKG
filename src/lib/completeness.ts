import type { AnalysisInput, CompletenessResult, ProductField, ProductTypeConfig } from "@/types";

/** 字段是否可见：无 showWhen 恒可见；有则依赖字段值命中才可见（数组 value 命中任一即可） */
export function isFieldVisible(field: ProductField, input: AnalysisInput): boolean {
  const cond = field.showWhen;
  if (!cond) return true;
  const cur = input[cond.field];
  const targets = Array.isArray(cond.value) ? cond.value : [cond.value];
  return targets.some((t) => String(cur) === String(t));
}

export function calculateCompleteness(
  config: ProductTypeConfig,
  input: AnalysisInput
): CompletenessResult {
  let totalWeight = 0;
  let filledWeight = 0;
  const filled: string[] = [];
  const missing: CompletenessResult["missing"] = [];

  for (const field of config.fields) {
    if (!isFieldVisible(field, input)) continue; // 条件字段不满足时不计入完整度
    totalWeight += field.weight;
    const value = input[field.key];

    const isFilled =
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(typeof value === "number" && isNaN(value));

    if (isFilled) {
      filledWeight += field.weight;
      filled.push(field.key);
    } else if (field.required || field.weight >= 8) {
      missing.push({
        key: field.key,
        label: field.label,
        weight: field.weight,
        impact: field.impactHint || "影响估算精度",
      });
    }
  }

  const score = totalWeight > 0 ? Math.round((filledWeight / totalWeight) * 100) : 0;

  return { score, filled, missing: missing.sort((a, b) => b.weight - a.weight) };
}

export function getConfidencePenalty(completeness: number): number {
  if (completeness >= 90) return 0;
  if (completeness >= 75) return 5;
  if (completeness >= 60) return 12;
  if (completeness >= 40) return 20;
  return 30;
}
