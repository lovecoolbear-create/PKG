import type { AgentResult, ProductTypeConfig, ReviewReport } from "@/types";
import type { AnalysisContext } from "./analysis-context";

/**
 * 只读跨维度审阅器
 *
 * 在 6 个 Specialist 计算完成后调用。只做跨维度一致性检查并产出 findings，
 * **绝不修改任何已算出的数字**（不重算、不回写 results）。这是对单维度
 * validate() 的补充视角：材料主导、表面局部覆盖率假设、单只成本合理性、
 * 维度齐全性。
 *
 * ── 铁律（架构护栏，勿违反）────────────────────────────────────────────
 * **数值对不对归公式，合不合理才问 AI。**
 * 本审阅器属「合理性审阅」层：只产出提示（findings），**绝不回写 amount**。
 * 哪怕发现某维度数值明显不合理，也只能用 warning 提示用户复核，
 * **不能"顺手修正"**——一旦审阅层开始改数，成本引擎就不再可复现、可审计，
 * 整个工具的可信地基就没了。
 * 同一铁律适用于 consistency-gate（consistencyWarnings 只挂载不回写）。
 *
 * 自动化护栏：tests/review-readonly.test.ts（断言调用后 results 完全未被修改）。
 * 若你改动本文件，请先跑 npm test。
 */
export function reviewAnalysis(
  ctx: AnalysisContext,
  results: AgentResult[],
  config: ProductTypeConfig
): ReviewReport {
  const findings: ReviewReport["findings"] = [];
  const byDim = (d: string) => results.find((r) => r.dimension === d);
  const total = results.reduce((s, r) => s + r.estimatedAmount, 0);

  // 1. 材料主导：材料成本占比过高时，提示降本重点
  const material = byDim("material");
  if (material && material.ratio > 60) {
    findings.push({
      code: "material_dominant",
      severity: "info",
      message: `材料成本占比 ${material.ratio}%，为主要成本构成`,
      suggestion: "降本重点应放在材质替代、克重优化或纸价谈判上",
    });
  }

  // 2. 表面局部覆盖率假设：烫金/凹凸仅按 8% 局部估算，需提醒以稿件为准
  if (ctx.surface === "foil" || ctx.surface === "emboss") {
    findings.push({
      code: "surface_local_coverage",
      severity: "info",
      message: "烫金/凹凸按展开面积 8% 局部覆盖率估算",
      suggestion: "实际覆盖率以稿件为准，差异可能较大",
    });
  }

  // 3. 单只成本合理性：总额 / 数量偏离经验区间则提示复核输入
  const perUnit = ctx.quantity > 0 ? total / ctx.quantity : 0;
  if (ctx.quantity > 0 && perUnit < 0.05) {
    findings.push({
      code: "per_unit_low",
      severity: "warning",
      message: `单只估算成本仅 ${perUnit.toFixed(3)} 元，可能数量或尺寸输入偏小`,
      suggestion: "请核对数量与长宽高是否填写正确",
    });
  } else if (ctx.quantity > 0 && perUnit > 50) {
    findings.push({
      code: "per_unit_high",
      severity: "warning",
      message: `单只估算成本 ${perUnit.toFixed(2)} 元，明显高于普通彩盒区间`,
      suggestion: "请复核材质、工艺与数量是否匹配",
    });
  }

  // 4. 维度齐全一致性：配置声明的维度是否都计算出来了
  const missingDims = config.dimensions.filter(
    (d) => !results.some((r) => r.dimension === d.key)
  );
  if (missingDims.length > 0) {
    findings.push({
      code: "missing_dimension",
      severity: "warning",
      message: `缺少维度：${missingDims.map((d) => d.label).join("、")}`,
      suggestion: "配置与计算结果不一致，请检查维度定义",
    });
  }

  return {
    findings,
    consistent:
      findings.every((f) => f.severity !== "warning") && missingDims.length === 0,
    perUnitEstimated: Math.round(perUnit * 100) / 100,
  };
}
