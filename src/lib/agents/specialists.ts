import type { AgentResult, MaterialPriceFetchResult } from "@/types";
import type { AnalysisContext } from "./analysis-context";
import {
  MATERIAL_LABELS,
  calculatePaperWeight,
  getQuantityDiscount,
  PRINT_MIN_CHARGE,
  URGENCY_MULTIPLIER,
  DIE_FORM_COST,
  RIGID_GREY_BOARD_GRAMMAGE,
  RIGID_GREY_BOARD_PRICE_PER_TON,
  RIGID_FACE_GRAMMAGE,
} from "@/lib/cost-rules";
import { getPaperPriceFromFetch } from "@/lib/material-prices/fetcher";
import {
  getMaterialPrice,
  getFlutePrice,
  getProcessRate,
  getRegionMultiplier,
  getLogisticsRate,
} from "@/lib/knowledge-base";

/** 材料成本 Agent
 * 优先使用实时抓取的材料价格（materialPrices），缺失时回退静态参考表
 */
export function materialAgent(
  ctx: AnalysisContext,
  materialPrices?: MaterialPriceFetchResult
): AgentResult {
  const { quantity, area, netAreaM2, util, imposedAreaM2, lossRate, boxType, flute, material, grammage } =
    ctx;

  // 件数系数：天地盖为 lid+base 两件，用纸面积≈单件 footprint × pieceCount；其余盒型为 1
  const pieceFactor = boxType.pieceCount ?? 1;
  // 精品盒面纸为薄面纸结构（约 157g 艺术纸），与普通彩盒 body stock 克重不同
  const isRigid = boxType.code === "rigid_cover";
  const faceGrammage = isRigid ? RIGID_FACE_GRAMMAGE : Number(grammage);

  const weight = calculatePaperWeight(area * pieceFactor, faceGrammage, quantity, {
    wasteRate: lossRate,
    impositionUtilization: util,
  });

  // 优先使用实时抓取价；无抓取结果时回退知识库/静态参考表
  let pricePerTon: number;
  let priceInfo: { entry?: any } = {};
  let kbPriceSource = "";
  if (materialPrices) {
    const fetched = getPaperPriceFromFetch(materialPrices, material, grammage);
    pricePerTon = fetched.price;
    priceInfo = { entry: fetched.entry };
  } else {
    const kbMat = getMaterialPrice(material, grammage);
    pricePerTon = kbMat.value;
    kbPriceSource = kbMat.fromKb ? "知识库" : "静态参考表";
  }
  const discount = getQuantityDiscount(quantity);
  const facePaperAmount = weight * (pricePerTon / 1000) * discount;

  const breakdown: { label: string; amount: number; note?: string }[] = [
    {
      label: `面纸（${MATERIAL_LABELS[material] || material} ${faceGrammage}g）`,
      amount: facePaperAmount,
      note: `利用率 ${(util * 100).toFixed(0)}%${pieceFactor > 1 ? `，件数×${pieceFactor}` : ""}`,
    },
  ];

  // 瓦楞彩盒：面纸 + 坑纸/底纸 + 裱坑加工费
  let fluteAmount = 0;
  let mountingAmount = 0;
  if (flute.code !== "none") {
    const flutePrice = getFlutePrice(flute.code);
    const mountingRate = getProcessRate("flute_mounting_rate").value;
    const fluteWeight = calculatePaperWeight(area * pieceFactor, flute.fluteGrammage, quantity, {
      wasteRate: lossRate,
      impositionUtilization: util,
    });
    fluteAmount = fluteWeight * (flutePrice.value / 1000) * discount;
    mountingAmount = imposedAreaM2 * quantity * mountingRate;
    breakdown.push({
      label: `坑纸/底纸（${flute.label} ${flute.fluteGrammage}g）`,
      amount: fluteAmount,
    });
    breakdown.push({
      label: `裱坑加工费（${mountingRate} 元/m²）`,
      amount: mountingAmount,
    });
  }

  // 精品盒（天地盖）：灰板底材 + 面纸裱，需额外计算灰板成本（同样按件数系数放大）
  let greyBoardAmount = 0;
  if (isRigid) {
    const gbWeight = calculatePaperWeight(area * pieceFactor, RIGID_GREY_BOARD_GRAMMAGE, quantity, {
      wasteRate: lossRate,
      impositionUtilization: util,
    });
    greyBoardAmount = gbWeight * (RIGID_GREY_BOARD_PRICE_PER_TON / 1000) * discount;
    breakdown.push({
      label: `灰板（精品盒底材 ${RIGID_GREY_BOARD_GRAMMAGE}g）`,
      amount: greyBoardAmount,
      note: `灰板单价 ${RIGID_GREY_BOARD_PRICE_PER_TON} 元/吨${pieceFactor > 1 ? `，件数×${pieceFactor}` : ""}`,
    });
  }

  const amount = facePaperAmount + fluteAmount + mountingAmount + greyBoardAmount;

  const hasAllInputs = quantity > 0 && material !== "";
  const confidence = hasAllInputs ? 82 : 55;

  const paperEntry = priceInfo.entry;
  const priceSourceText = paperEntry
    ? `材料单价来源：${paperEntry.source}（获取时间 ${new Date(
        paperEntry.priceTimestamp || paperEntry.fetchedAt
      ).toLocaleString("zh-CN")}）${paperEntry.isFallback ? "（回退默认）" : ""}`
    : `材料单价：${pricePerTon} 元/吨（${kbPriceSource}）`;

  const basis = [
    `盒型：${boxType.label}（用纸利用率 ${(util * 100).toFixed(0)}%，复杂度系数 ${boxType.complexityMultiplier}）`,
    `净展开面积：${netAreaM2.toFixed(4)} m²/个（拼版利用率 ${(util * 100).toFixed(0)}% → 实际用纸 ${imposedAreaM2.toFixed(4)} m²/个）`,
    `用纸总量：${weight.toFixed(1)} kg（动态损耗率 ${(lossRate * 100).toFixed(0)}%）`,
    `面纸单价：${pricePerTon} 元/吨`,
    `数量折扣系数：${discount}`,
    priceSourceText,
  ];
  if (flute.code !== "none") {
    const flutePrice = getFlutePrice(flute.code);
    const mountingRate = getProcessRate("flute_mounting_rate").value;
    basis.push(`坑纸/底纸单价：${flutePrice.value} 元/吨（${flute.fluteGrammage}g）`);
    basis.push(
      `裱坑加工费：${mountingRate} 元/m² × ${(netAreaM2 * quantity).toFixed(1)} m² = ${mountingAmount.toFixed(0)} 元`
    );
  }

  const assumptions = [
    `按${boxType.label}估算展开面积与用纸利用率`,
    `拼版利用率按 ${(util * 100).toFixed(0)}% 计（含印刷咬口与修边损耗）`,
    `动态损耗率随数量递减（当前 ${(lossRate * 100).toFixed(0)}%）`,
    ...(flute.code !== "none"
      ? [`裱坑加工费按 ${getProcessRate("flute_mounting_rate").value} 元/m² 计`]
      : []),
    ...(isRigid
      ? [
          `精品盒为灰板+薄面纸结构：面纸按典型 ${RIGID_FACE_GRAMMAGE}g 艺术纸计（非所选普通克重），灰板 ${RIGID_GREY_BOARD_GRAMMAGE}g`,
          `天地盖为 lid+base 两件，用纸面积×${pieceFactor}`,
        ]
      : []),
  ];

  return {
    dimension: "material",
    dimensionLabel: "材料成本",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.92, amount * 1.08],
    ratio: 0,
    basis,
    assumptions,
    confidence,
    risks: material === "special" ? ["特种纸价格波动较大"] : [],
    priceSources: materialPrices?.entries,
    usedDefaults: materialPrices?.entries
      .filter((e) => e.isFallback)
      .map((e) => e.item),
    breakdown,
  };
}

/** 人工成本 Agent（独立于加工费，仅人工部分随地域浮动）
 * 糊盒等手工工序归入人工；印刷/覆膜/模切等设备与油墨驱动的工序留在加工费。
 */
export function laborAgent(ctx: AnalysisContext): AgentResult {
  const { quantity, boxType, needGluing, laborRegion } = ctx;

  // 地域系数：以华东人工费率为基准 1.0，仅作用于人工
  // （方案B：人工独立后，地区人工费差异只体现在人工，不放大设备/油墨的地域差）
  const regionMultiplier = getRegionMultiplier(laborRegion);

  // 基础手工操作（检验、整理、装箱前整理）：华东基准单价(元/个) × 盒型复杂度系数
  const LABOR_BASE_PER_PIECE = 0.05;
  const baseLabor = quantity * LABOR_BASE_PER_PIECE * boxType.complexityMultiplier;

  // 糊盒为典型人工工序
  const gluingCost = needGluing ? quantity * 0.025 : 0;

  const rawAmount = baseLabor + gluingCost;
  const amount = Math.round(rawAmount * regionMultiplier * 100) / 100;
  const confidence = laborRegion ? 72 : 55;

  const breakdown: { label: string; amount: number; note?: string }[] = [
    {
      label: `手工操作（检验/整理，基准 ${LABOR_BASE_PER_PIECE} 元/个）`,
      amount: Math.round(baseLabor * 100) / 100,
      note: `盒型复杂度系数 ${boxType.complexityMultiplier}`,
    },
    ...(needGluing
      ? [
          {
            label: "糊盒（人工）",
            amount: gluingCost,
            note: `${quantity} 个 × 0.025 元/个`,
          },
        ]
      : []),
  ];

  const basis: string[] = [
    `生产地域系数：${regionMultiplier}（以华东人工费率为基准 1.0，仅作用于人工成本）`,
    `手工操作：约 ${baseLabor.toFixed(0)} 元（基准 ${LABOR_BASE_PER_PIECE} 元/个 × 数量 ${quantity} × 盒型复杂度 ${boxType.complexityMultiplier}）`,
    ...(needGluing
      ? [`糊盒：约 ${gluingCost.toFixed(0)} 元（${quantity} 个 × 0.025 元/个）`]
      : []),
  ];

  return {
    dimension: "labor",
    dimensionLabel: "人工成本",
    estimatedAmount: amount,
    amountRange: [amount * 0.9, amount * 1.15],
    ratio: 0,
    basis,
    breakdown,
    assumptions: ["按标准手工工序估算", "糊盒为典型人工工序"],
    confidence,
    risks: [],
  };
}

/** 工艺加工成本 Agent（含设备：印刷/覆膜/模切/刀模等设备与油墨驱动，不随地域浮动） */
export function processAgent(ctx: AnalysisContext): AgentResult {
  const { quantity, netAreaM2, imposedAreaM2, printMethod, surface, boxType, cmykColors, spotColors } =
    ctx;

  // 总印刷色数 = CMYK 色数 + 专色色数
  const totalColors = cmykColors + spotColors;
  const printRate = getProcessRate(`print:${printMethod}`).value;
  // 胶印/柔印按千印计价：印数(千张) × 色数 × 单价(元/色/千印)；
  // 数码印刷按张不计色令，故仍按此式（其单价已含张费、且数码无起步开机费托底）
  const rawPrintCost = (quantity / 1000) * printRate * totalColors;
  // 印刷费起步价托底：胶印/柔印等非数码印刷不低于 PRINT_MIN_CHARGE；数码印刷不设起步价
  const floorApplied = printMethod !== "digital" && rawPrintCost < PRINT_MIN_CHARGE;
  const printCost = floorApplied ? PRINT_MIN_CHARGE : rawPrintCost;

  // 专色固定调色/洗车费（元/专色）
  const spotSetupRate = getProcessRate("spot_color_setup").value;
  const spotSetupCost = spotColors * spotSetupRate;

  // 开窗盒贴窗胶片成本（0.05 元/个）
  const windowFilmCost = quantity * boxType.windowFilmCostPerPiece;

  // 表面处理局部覆盖率：烫金/凹凸按默认 8% 局部面积计费，其余（哑膜/亮膜/UV）按 100% 展开面积
  const SURFACE_LOCAL_COVERAGE: Record<string, number> = { foil: 0.08, emboss: 0.08 };
  const coverage = SURFACE_LOCAL_COVERAGE[surface] ?? 1;
  const surfaceRate = getProcessRate(`surface:${surface}`).value;
  // 面积口径：全覆盖工艺（覆膜/UV）作用于整张印版（含拼版损耗）→ 用 imposedAreaM2；
  // 局部工艺（烫金/凹凸）只覆盖盒面局部 → 用净面积 netAreaM2。与材料用纸口径保持一致。
  const surfaceAreaBasisM2 = coverage < 1 ? netAreaM2 : imposedAreaM2;
  const surfaceCost = surfaceAreaBasisM2 * quantity * surfaceRate * coverage;

  const dieCutCost = quantity * 0.015;
  const dieFormCost = DIE_FORM_COST; // 一次性刀模费（钢刀模具制作）

  const amountRaw =
    printCost + spotSetupCost + windowFilmCost + surfaceCost + dieCutCost + dieFormCost;
  const amount = Math.round(amountRaw * 100) / 100;
  const confidence = printMethod && surface ? 78 : 50;

  const breakdown: { label: string; amount: number; note?: string }[] = [
    {
      label: `印刷（${printMethod}）${totalColors}色`,
      amount: printCost,
      note: floorApplied ? `含起步开机费 ${PRINT_MIN_CHARGE} 元托底` : undefined,
    },
    ...(spotColors > 0
      ? [
          {
            label: `专色调色/洗车费（${spotColors}专色×${spotSetupRate}）`,
            amount: spotSetupCost,
          },
        ]
      : []),
    ...(boxType.windowFilmCostPerPiece > 0
      ? [
          {
            label: `贴窗胶片（${boxType.windowFilmCostPerPiece}元/个）`,
            amount: windowFilmCost,
          },
        ]
      : []),
    {
      label: `表面处理（${surface}）`,
      amount: surfaceCost,
      note: coverage < 1 ? `按展开面积 ${(coverage * 100).toFixed(0)}% 局部计` : undefined,
    },
    { label: "模切", amount: dieCutCost },
    { label: "刀模费（一次性）", amount: dieFormCost, note: "钢刀模具制作费，不随数量变动" },
  ];

  const basis: string[] = [
    `印刷(${printMethod})：${totalColors}色（CMYK ${cmykColors} + 专色 ${spotColors}），约 ${printCost.toFixed(0)} 元${floorApplied ? `（含起步开机费 ${PRINT_MIN_CHARGE} 元托底）` : ""}`,
    ...(spotColors > 0
      ? [
          `专色调色/洗车费：${spotColors} 专色 × ${spotSetupRate} 元 = ${spotSetupCost.toFixed(0)} 元`,
        ]
      : []),
    ...(boxType.windowFilmCostPerPiece > 0
      ? [
          `贴窗胶片：${quantity} 个 × ${boxType.windowFilmCostPerPiece} 元 = ${windowFilmCost.toFixed(0)} 元`,
        ]
      : []),
    `表面处理(${surface})：约 ${surfaceCost.toFixed(0)} 元${coverage < 1 ? `（按展开面积 ${(coverage * 100).toFixed(0)}% 局部计）` : ""}`,
    `模切：约 ${dieCutCost.toFixed(0)} 元`,
    `刀模费（一次性）：${dieFormCost} 元（钢刀模具制作费）`,
  ];

  return {
    dimension: "process",
    dimensionLabel: "加工费（含设备）",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.9, amount * 1.12],
    ratio: 0,
    basis,
    breakdown,
    assumptions: ["按标准工艺路线估算", "不含特殊后道（如手工组装）", "烫金/凹凸默认按展开面积8%局部覆盖率估算"],
    confidence,
    risks:
      surface === "foil" || surface === "emboss"
        ? ["烫金/凹凸按默认8%局部覆盖率估算，实际以稿件为准"]
        : [],
  };
}


/** 设计与制版 Agent */
export function designAgent(ctx: AnalysisContext): AgentResult {
  const { printMethod, quantity, provideReadyDesign, cmykColors, spotColors } = ctx;
  const plateCmykCost = getProcessRate("plate_cmyk").value;
  const plateSpotCost = getProcessRate("plate_spot").value;
  let plateCost = 0;
  if (printMethod === "digital") plateCost = 0;
  else plateCost = cmykColors * plateCmykCost + spotColors * plateSpotCost; // 专色版费高于 CMYK

  // 客户提供完稿文件时，设计费减免为 0
  const designCost = provideReadyDesign ? 0 : 800;
  const proofingCost = quantity < 5000 ? 300 : 150;
  const amount = plateCost + designCost + proofingCost;

  return {
    dimension: "design_plate",
    dimensionLabel: "设计与制版成本",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.9, amount * 1.05],
    ratio: 0,
    basis: [
      printMethod !== "digital"
        ? `CTP制版：CMYK ${cmykColors}色×${plateCmykCost}元${spotColors > 0 ? ` + 专色 ${spotColors}版×${plateSpotCost}元` : ""} = ${plateCost} 元`
        : "数码印刷免制版",
      provideReadyDesign ? `设计费：0 元（客户提供完稿文件，已减免）` : `设计费：${designCost} 元（标准盒型）`,
      `打样费：${proofingCost} 元`,
    ],
    assumptions: provideReadyDesign
      ? ["客户提供完稿文件，设计费减免为 0"]
      : ["设计费按标准盒型估算，复杂结构另计"],
    confidence: printMethod ? 75 : 50,
    risks: [],
    breakdown: [
      ...(plateCost > 0
        ? [
            {
              label: `制版费（CMYK ${cmykColors}色${spotColors > 0 ? ` + 专色 ${spotColors}版` : ""}）`,
              amount: plateCost,
              note:
                spotColors > 0
                  ? `专色版费 ${plateSpotCost} 元/版（高于 CMYK ${plateCmykCost} 元）`
                  : undefined,
            },
          ]
        : []),
      {
        label: provideReadyDesign ? "设计费（客户完稿，减免）" : "设计费",
        amount: designCost,
      },
      { label: "打样费", amount: proofingCost },
    ],
  };
}

/** 财务与其他 Agent */
export function financeAgent(ctx: AnalysisContext, subtotal: number): AgentResult {
  const { delivery, urgency, quantity } = ctx;

  const logisticsRate = getLogisticsRate(delivery).value;
  const logisticsCost = subtotal * logisticsRate;

  const packagingCost = quantity * 0.008;
  const managementRate = 0.06;
  const managementCost = subtotal * managementRate;

  const urgencyMult = URGENCY_MULTIPLIER[urgency] ?? 1.0;
  const profitRate = 0.08;
  const profitBase = (subtotal + logisticsCost + managementCost) * profitRate;
  const urgencyPremium = urgencyMult > 1 ? subtotal * (urgencyMult - 1) * 0.5 : 0;

  const amount = logisticsCost + packagingCost + managementCost + profitBase + urgencyPremium;

  return {
    dimension: "finance_other",
    dimensionLabel: "财务与其他成本",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.9, amount * 1.15],
    ratio: 0,
    basis: [
      `物流(${delivery})：约 ${logisticsCost.toFixed(0)} 元`,
      `包装辅材：约 ${packagingCost.toFixed(0)} 元`,
      `管理费用(6%)：约 ${managementCost.toFixed(0)} 元`,
      `合理利润(8%)：约 ${profitBase.toFixed(0)} 元`,
      urgencyMult > 1 ? `加急溢价：约 ${urgencyPremium.toFixed(0)} 元` : "",
    ].filter(Boolean),
    assumptions: ["管理费率按中小工厂平均水平", "利润率为行业参考值"],
    confidence: delivery ? 72 : 55,
    risks: urgency === "express" ? ["特急交期产能存在不确定性"] : [],
    breakdown: [
      {
        label: `物流（${delivery}）`,
        amount: Math.round(logisticsCost * 100) / 100,
        note: `费率 ${(logisticsRate * 100).toFixed(1)}%`,
      },
      { label: "包装辅材", amount: Math.round(packagingCost * 100) / 100 },
      {
        label: "管理费",
        amount: Math.round(managementCost * 100) / 100,
        note: `费率 ${managementRate * 100}%`,
      },
      {
        label: "合理利润",
        amount: Math.round(profitBase * 100) / 100,
        note: `费率 ${profitRate * 100}%`,
      },
      ...(urgencyPremium > 0
        ? [
            {
              label: "加急溢价",
              amount: Math.round(urgencyPremium * 100) / 100,
              note: `${urgency} 交期`,
            },
          ]
        : []),
    ],
  };
}

export const AGENT_MAP = {
  material: materialAgent,
  labor: laborAgent,
  process: processAgent,
  design_plate: designAgent,
  finance_other: financeAgent,
};
