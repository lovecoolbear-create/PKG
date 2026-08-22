import type { AnalysisInput, CompletenessResult, ProductTypeConfig } from "@/types";

export function calculateCompleteness(
  config: ProductTypeConfig,
  input: AnalysisInput
): CompletenessResult {
  let totalWeight = 0;
  let filledWeight = 0;
  const filled: string[] = [];
  const missing: CompletenessResult["missing"] = [];

  for (const field of config.fields) {
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
