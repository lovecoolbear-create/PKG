/**
 * 配方 → 引擎桥接层（F2 下半部）
 * ----------------------------------------------------------------
 * 把「配方优先、硬编码回退」接进成本引擎：
 *   - 某维度**有生效配方且可求值** → 用配方结果覆盖 estimatedAmount 与 breakdown；
 *   - **无配方 / 求值失败** → 保持 specialists 现有的硬编码结果（行为完全不变）。
 *
 * 因此库为空（当前状态）时，本层是纯 no-op，由黄金基线回归保证零漂移。
 *
 * 约束：
 *  - 不重算任何派生量，全部取自共享的 AnalysisContext；
 *  - 按依赖顺序求值：material → labor → process → design_plate → finance_other，
 *    使 percent_of 能拿到正确的累计基数（manufacturing / subtotal）；
 *  - 只覆盖金额与明细，**不改置信度逻辑**（置信度仍由引擎原机制决定）。
 */

import type { AgentResult } from "@/types";
import type { AnalysisContext } from "@/lib/agents/analysis-context";
import { BINDING_LABOR, BINDING_EQUIP } from "@/lib/agents/specialists";
import { evalRecipe, type EvalContext } from "./index";
import { getRecipeItems } from "./loader";
import {
  calculatePaperWeight,
  getQuantityDiscount,
  getSurfaceCoverage,
  RIGID_FACE_GRAMMAGE,
  RIGID_GREY_BOARD_GRAMMAGE,
  LABOR_SETUP_ENABLED,
} from "@/lib/cost-rules";
import { getRegionMultiplier, getRegionRate, getProcessRate } from "@/lib/knowledge-base";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 维度求值顺序（后者可依赖前者的累计值作为 percent_of 基数） */
const DIMENSION_ORDER = [
  "material",
  "labor",
  "process",
  "design_plate",
  "finance_other",
] as const;

/** 表面处理局部覆盖率等级 → 默认覆盖率（与 cost-rules 对齐） */
const SURFACE_LOCAL_KEYS = ["foil", "emboss"];

/**
 * 从共享派生上下文构造配方求值上下文。
 * 重量默认 0：材料项的重量应由配方参数指定（不同材料项重量不同），
 * 不能用一个全局重量覆盖。
 *
 * 派生量桶（extra）：把「按上下文才能确定的量」一次性算好（复用 cost-rules /
 * knowledge-base 的同一函数，保证与硬编码 agent 零漂移），配方参数用
 * `{ ctx: "xxx" }` 引用。这样结构化配方无需启用 DSL 即可表达动态乘子与分层重量。
 */
export function buildEvalContext(
  ctx: AnalysisContext,
  bases: Record<string, number> = {}
): EvalContext {
  const regionMultiplier = getRegionMultiplier(ctx.laborRegion);
  const regionHourlyRate = getRegionRate(ctx.laborRegion).value;
  const quantityDiscount = getQuantityDiscount(ctx.quantity);
  const totalColors = ctx.cmykColors + ctx.spotColors;

  const cover = getSurfaceCoverage(ctx.surfaceCoverageLevel, ctx.surface, ctx.surfaceCoverageOverride);
  const isLocal = SURFACE_LOCAL_KEYS.includes(ctx.surface);
  const surfaceCoverage = isLocal ? cover.value : 1;
  // 盒型：覆盖率<1 按净面积局部计，满覆盖按生产面积（含废边）；平面彩印恒按净面积
  const surfaceAreaBasisM2 =
    ctx.productType === "flat_print"
      ? ctx.netAreaM2
      : surfaceCoverage < 1
        ? ctx.netAreaM2
        : ctx.productionAreaM2;

  const setupHours = LABOR_SETUP_ENABLED ? getProcessRate("labor:setup_hours").value : 0;
  const laborSetupCost = LABOR_SETUP_ENABLED ? setupHours * regionHourlyRate : 0;
  const laborMultiplier = (ctx.boxType?.complexityMultiplier ?? 1) * regionMultiplier;
  const windowFilmCostPerPiece = ctx.boxType?.windowFilmCostPerPiece ?? 0;
  const bindingLaborCostPerPiece = BINDING_LABOR[ctx.binding]?.cost ?? 0;
  const bindingEquipCostPerPiece = BINDING_EQUIP[ctx.binding]?.cost ?? 0;

  // 印刷单位费率（元/个）：(单价/色/千印) × 色数 ÷ 1000，供 stepped 表达起步价托底
  const printUnitRate = getProcessRate(`print:${ctx.printMethod}`).value * totalColors / 1000;

  const extra: Record<string, number> = {
    regionMultiplier,
    regionHourlyRate,
    quantityDiscount,
    surfaceCoverage,
    surfaceAreaBasisM2,
    totalColors,
    laborMultiplier,
    laborSetupCost,
    windowFilmCostPerPiece,
    bindingLaborCostPerPiece,
    bindingEquipCostPerPiece,
    printUnitRate,
  };

  const pt = ctx.productType;

  if (pt === "flat_print") {
    const COVER_BINDINGS = ["saddle", "perfect", "thread_sewn", "hardcover", "spiral", "accordion"];
    const hasCover = COVER_BINDINGS.includes(ctx.binding) && !!ctx.coverGrammage;
    const innerPages = Math.max(ctx.pages - (hasCover ? 1 : 0), 0);
    const innerG = Number(ctx.grammage) || 157;
    const coverG = Number(ctx.coverGrammage) || 250;
    const lossFactor = 1 + ctx.lossRate;
    extra.flatInnerPaperWeightKg =
      ((ctx.singleSheetAreaM2 * innerPages * ctx.quantity * innerG) / 1000) * lossFactor;
    extra.flatCoverPaperWeightKg = hasCover
      ? ((ctx.singleSheetAreaM2 * ctx.quantity * coverG) / 1000) * lossFactor
      : 0;
    extra.innerGrammage = innerG;
    extra.coverGrammage = hasCover ? coverG : innerG;
    extra.flatInkAreaM2 = ctx.netAreaM2 * ctx.quantity;
  } else {
    const isRigid = ctx.boxType?.code === "rigid_cover";
    const faceGrammage = isRigid ? RIGID_FACE_GRAMMAGE : Number(ctx.grammage);
    const pieceFactor = ctx.boxType?.pieceCount ?? 1;
    extra.faceGrammage = faceGrammage;
    extra.pieceFactor = pieceFactor;
    extra.facePaperWeightKg = calculatePaperWeight(
      ctx.productionAreaMm2 * pieceFactor,
      faceGrammage,
      ctx.quantity,
      { wasteRate: ctx.lossRate, impositionUtilization: 1 }
    );
    extra.inkAreaM2 = ctx.productionAreaM2 * ctx.quantity;

    if (pt === "corrugated_box") {
      const areaM2 = ctx.productionAreaMm2 / 1_000_000;
      const linerCount = ctx.boardStructure === "double" ? 3 : ctx.boardStructure === "triple" ? 4 : 2;
      const middleCount = linerCount - 2;
      const linerGPerM2 =
        2 * Number(ctx.linerGrammage) + middleCount * Number(ctx.mediumGrammage || ctx.linerGrammage);
      extra.linerWeightKg = ((areaM2 * linerGPerM2 * ctx.quantity * (1 + ctx.lossRate)) / 1000);
      const isCombo = ["BC", "BE", "AB"].includes(ctx.flute?.code ?? "");
      const fluteLayers = isCombo
        ? 1
        : ctx.boardStructure === "double"
          ? 2
          : ctx.boardStructure === "triple"
            ? 3
            : 1;
      const fluteGPerM2 = Number(ctx.fluteGrammage) * (ctx.flute?.takeUpFactor ?? 1) * fluteLayers;
      extra.fluteWeightKg = ((areaM2 * fluteGPerM2 * ctx.quantity * (1 + ctx.lossRate)) / 1000);
    } else {
      // 彩盒：坑纸（仅当 flute != none）/ 灰板（仅精品盒）
      extra.fluteWeightKg =
        ctx.flute?.code && ctx.flute.code !== "none"
          ? calculatePaperWeight(
              ctx.productionAreaMm2 * pieceFactor,
              ctx.flute.fluteGrammage,
              ctx.quantity,
              { wasteRate: ctx.lossRate, impositionUtilization: 1 }
            )
          : 0;
      extra.greyBoardWeightKg = isRigid
        ? calculatePaperWeight(
            ctx.productionAreaMm2 * pieceFactor,
            RIGID_GREY_BOARD_GRAMMAGE,
            ctx.quantity,
            { wasteRate: ctx.lossRate, impositionUtilization: 1 }
          )
        : 0;
    }
  }

  return {
    quantity: ctx.quantity,
    areaM2: ctx.productionAreaM2,
    netAreaM2: ctx.netAreaM2,
    surfaceAreaM2: ctx.productionAreaM2,
    printAreaM2: ctx.areaM2Total,
    weightKg: 0,
    cmykColors: ctx.cmykColors,
    spotColors: ctx.spotColors,
    bases,
    extra,
  };
}

/** 条件判定可用的事实（全部来自共享上下文，不重算） */
export function factsOf(ctx: AnalysisContext): Record<string, unknown> {
  return {
    productType: ctx.productType,
    material: ctx.material,
    grammage: ctx.grammage,
    coverGrammage: ctx.coverGrammage,
    surface: ctx.surface,
    printMethod: ctx.printMethod,
    binding: ctx.binding,
    boxType: ctx.boxType?.code,
    fluteType: ctx.flute?.code,
    boardStructure: ctx.boardStructure,
    linerMaterial: ctx.linerMaterial,
    linerGrammage: ctx.linerGrammage,
    fluteGrammage: ctx.fluteGrammage,
    mediumGrammage: ctx.mediumGrammage,
    windowFilmCostPerPiece: ctx.boxType?.windowFilmCostPerPiece ?? 0,
    pages: ctx.pages,
    quantity: ctx.quantity,
    // 色数：专色相关成本项（专色调色/洗车费、专色油墨）以 spotColors > 0 为适用条件，
    // 缺这两个事实会让条件恒不成立、静默漏算，故必须暴露。
    cmykColors: ctx.cmykColors,
    spotColors: ctx.spotColors,
    totalColors: ctx.cmykColors + ctx.spotColors,
    needGluing: ctx.needGluing,
    provideReadyDesign: ctx.provideReadyDesign,
    urgency: ctx.urgency,
    laborRegion: ctx.laborRegion,
    delivery: ctx.delivery,
  };
}

/**
 * 按维度应用配方覆盖。无配方或求值失败的维度原样返回（回退硬编码）。
 */
export function applyRecipeOverrides(
  results: AgentResult[],
  ctx: AnalysisContext,
  productType: string
): AgentResult[] {
  const out = results.map((r) => ({ ...r }));
  const facts = factsOf(ctx);

  // 累计值（供 percent_of 取基数），随求值进度更新
  const acc: Record<string, number> = {
    material: 0,
    labor: 0,
    process: 0,
    design_plate: 0,
  };

  for (const dim of DIMENSION_ORDER) {
    const idx = out.findIndex((r) => r.dimension === dim);
    if (idx < 0) continue;
    const r = out[idx];

    const items = getRecipeItems(productType, dim);
    if (items.length) {
      const manufacturing = acc.material + acc.labor + acc.process;
      const subtotal = manufacturing + acc.design_plate;
      const evalCtx = buildEvalContext(ctx, {
        ...acc,
        manufacturing,
        subtotal,
      });

      const issues: string[] = [];
      const recipe = evalRecipe(items, evalCtx, facts, issues);
      if (recipe) {
        // 区间必须同步缩放：totalCost.min/max 是由各维度 amountRange 汇总而来的，
        // 若只改 estimatedAmount 而不动区间，报告总额会与分项明细自相矛盾。
        // 按新值/旧值的比例缩放，保留原有的不确定性带宽（如 -10% ~ +15%）。
        const oldAmount = r.estimatedAmount;
        const scale = oldAmount > 0 ? recipe.total / oldAmount : 1;
        out[idx] = {
          ...r,
          estimatedAmount: round2(recipe.total),
          amountRange: [
            round2(r.amountRange[0] * scale),
            round2(r.amountRange[1] * scale),
          ],
          breakdown: recipe.lines.map((l) => ({
            label: l.name,
            amount: round2(l.amount),
            note: "配方驱动",
          })),
          basis: [...r.basis, "成本配方驱动（CostItem）"],
        };
      } else {
        // 配方不可用 → 回退硬编码。但**必须留下可见痕迹**：
        // 早期实现是静默回退，坏数据让报价少算 60% 而用户毫不知情。
        out[idx] = {
          ...r,
          basis: [
            ...r.basis,
            `⚠️ 成本配方不可用，已回退内置算法：${issues.join("；") || "存在无法求值的成本项"}`,
          ],
        };
      }
    }

    // 用（可能被覆盖后的）最终值更新累计
    acc[dim] = out[idx].estimatedAmount;
  }

  return out;
}
