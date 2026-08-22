import type {
  AgentResult,
  AnalysisInput,
  MaterialPriceFetchResult,
} from "@/types";
import {
  MATERIAL_LABELS,
  calculateExpandedArea,
  calculatePaperWeight,
  getQuantityDiscount,
  getDynamicLossRate,
  PRINT_MIN_CHARGE,
  URGENCY_MULTIPLIER,
  getBoxType,
  getFluteType,
} from "@/lib/cost-rules";
import { getLaborRegion } from "@/lib/cost-rules/labor-regions";
import { getPaperPriceFromFetch } from "@/lib/material-prices/fetcher";
import {
  getMaterialPrice,
  getFlutePrice,
  getProcessRate,
  getRegionRate,
  getLogisticsRate,
} from "@/lib/knowledge-base";

function num(input: AnalysisInput, key: string, fallback = 0): number {
  const v = input[key];
  return typeof v === "number" ? v : Number(v) || fallback;
}

function str(input: AnalysisInput, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : String(v || fallback);
}

function bool(input: AnalysisInput, key: string, fallback = false): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : fallback;
}

/** 材料成本 Agent
 * 优先使用实时抓取的材料价格（materialPrices），缺失时回退静态参考表
 */
export function materialAgent(
  input: AnalysisInput,
  materialPrices?: MaterialPriceFetchResult
): AgentResult {
  const quantity = num(input, "quantity", 5000);
  const length = num(input, "length", 100);
  const width = num(input, "width", 80);
  const height = num(input, "height", 50);
  const material = str(input, "material", "white_card");
  const grammage = str(input, "grammage", "350");
  const boxType = getBoxType(str(input, "boxType", "tuck_end"));
  const flute = getFluteType(str(input, "fluteType", "none"));

  const area = calculateExpandedArea(length, width, height);
  const wasteRate = getDynamicLossRate(quantity);
  const netAreaM2 = area / 1_000_000;
  const util = boxType.impositionUtilization;
  const imposedAreaM2 = netAreaM2 / util;

  const weight = calculatePaperWeight(area, Number(grammage), quantity, {
    wasteRate,
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
      label: `面纸（${MATERIAL_LABELS[material] || material} ${grammage}g）`,
      amount: facePaperAmount,
      note: `利用率 ${(util * 100).toFixed(0)}%`,
    },
  ];

  // 瓦楞彩盒：面纸 + 坑纸/底纸 + 裱坑加工费
  let fluteAmount = 0;
  let mountingAmount = 0;
  if (flute.code !== "none") {
    const flutePrice = getFlutePrice(flute.code);
    const mountingRate = getProcessRate("flute_mounting_rate").value;
    const fluteWeight = calculatePaperWeight(area, flute.fluteGrammage, quantity, {
      wasteRate,
      impositionUtilization: util,
    });
    fluteAmount = fluteWeight * (flutePrice.value / 1000) * discount;
    mountingAmount = netAreaM2 * quantity * mountingRate;
    breakdown.push({
      label: `坑纸/底纸（${flute.label} ${flute.fluteGrammage}g）`,
      amount: fluteAmount,
    });
    breakdown.push({
      label: `裱坑加工费（${mountingRate} 元/m²）`,
      amount: mountingAmount,
    });
  }

  const amount = facePaperAmount + fluteAmount + mountingAmount;

  const hasAllInputs = quantity > 0 && length > 0 && material !== "";
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
    `用纸总量：${weight.toFixed(1)} kg（动态损耗率 ${(wasteRate * 100).toFixed(0)}%）`,
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
    `动态损耗率随数量递减（当前 ${(wasteRate * 100).toFixed(0)}%）`,
    ...(flute.code !== "none"
      ? [`裱坑加工费按 ${getProcessRate("flute_mounting_rate").value} 元/m² 计`]
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

/** 工艺加工成本 Agent */
export function processAgent(input: AnalysisInput): AgentResult {
  const quantity = num(input, "quantity", 1000);
  const length = num(input, "length", 100);
  const width = num(input, "width", 80);
  const height = num(input, "height", 50);
  const printMethod = str(input, "printMethod", "offset");
  const surface = str(input, "surfaceTreatment", "none");
  const needGluing = bool(input, "needGluing", true);
  const boxType = getBoxType(str(input, "boxType", "tuck_end"));
  const cmykColors = Number(String(input.colorCount ?? "4").split("+")[0]) || 4;
  const spotColors = num(input, "spotColorCount", 0);

  const area = calculateExpandedArea(length, width, height);
  const areaM2Total = (area / 1_000_000) * quantity;

  // 总印刷色数 = CMYK 色数 + 专色色数
  const totalColors = cmykColors + spotColors;
  const printRate = getProcessRate(`print:${printMethod}`).value;
  const rawPrintCost = (areaM2Total / quantity) * (quantity / 1000) * printRate * totalColors;
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
  const surfaceCost = areaM2Total * surfaceRate * coverage;

  const dieCutCost = quantity * 0.015;
  const gluingCost = needGluing ? quantity * 0.025 : 0;

  const amount =
    printCost + spotSetupCost + windowFilmCost + surfaceCost + dieCutCost + gluingCost;
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
    ...(needGluing ? [{ label: "糊盒", amount: gluingCost }] : []),
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
  ];
  if (needGluing) basis.push(`糊盒：约 ${gluingCost.toFixed(0)} 元`);

  return {
    dimension: "process",
    dimensionLabel: "工艺加工成本",
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

/** 人工成本 Agent —— 按所选生产地域联动人工费率
 * @param regionDefaulted 该地域是否为默认假设（用户未选/主动跳过），用于报告透明标注
 */
export function laborAgent(
  input: AnalysisInput,
  regionDefaulted?: boolean
): AgentResult {
  const quantity = num(input, "quantity", 5000);
  const needGluing = bool(input, "needGluing", true);
  const surface = str(input, "surfaceTreatment", "none");

  const region = getLaborRegion(input.laborRegion as string | undefined);
  const isDefaultRegion = regionDefaulted ?? !input.laborRegion;
  const boxType = getBoxType(str(input, "boxType", "tuck_end"));

  let baseHours = 2.5;
  if (needGluing) baseHours += region.gluingHoursPerThousand;
  if (surface === "foil" || surface === "emboss")
    baseHours += region.specialProcessHoursPerThousand;

  // 盒型复杂度系数作用于人工工时（天地盖含包边/裱胶，工时上浮）
  const totalHours = (quantity / 1000) * baseHours * boxType.complexityMultiplier;
  const regionRate = getRegionRate(region.code).value;
  const amount = totalHours * regionRate;

  return {
    dimension: "labor",
    dimensionLabel: "人工成本",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.88, amount * 1.15],
    ratio: 0,
    basis: [
      `估算工时：${totalHours.toFixed(1)} 小时（基准 ${((quantity / 1000) * baseHours).toFixed(1)} 小时 × 盒型复杂度 ${boxType.complexityMultiplier}${boxType.requiresEdgeWrap ? "（含包边/裱胶）" : ""}）`,
      `生产地域：${region.label}`,
      `人工费率：${regionRate} 元/小时`,
      `含：上料、巡检、包装${needGluing ? "、糊盒" : ""}`,
    ],
    assumptions: [
      "按标准产线配置估算",
      "未含管理岗人工",
      ...(isDefaultRegion
        ? ["未选择生产地域，默认按华东地区估算"]
        : []),
    ],
    confidence: 70,
    risks: quantity < 3000 ? ["小批量人工分摊偏高"] : [],
    breakdown: [
      {
        label: "人工费",
        amount: Math.round(amount * 100) / 100,
        note: `工时 ${totalHours.toFixed(1)}h（基准 ${((quantity / 1000) * baseHours).toFixed(1)}h × 盒型系数 ${boxType.complexityMultiplier}${boxType.requiresEdgeWrap ? " 含包边/裱胶" : ""}）× 地域费率 ${regionRate} 元/h`,
      },
    ],
    laborRegion: {
      code: region.code,
      label: region.label,
      isDefault: isDefaultRegion,
    },
  };
}

/** 设备与能耗 Agent */
export function equipmentAgent(input: AnalysisInput): AgentResult {
  const quantity = num(input, "quantity", 1000);
  const printMethod = str(input, "printMethod", "offset");
  const boxType = getBoxType(str(input, "boxType", "tuck_end"));

  let machineHours = (quantity / 1000) * 3;
  if (printMethod === "digital") machineHours *= 0.6;
  if (printMethod === "flexo") machineHours *= 0.8;
  // 盒型复杂度系数作用于设备工时
  machineHours *= boxType.complexityMultiplier;

  const equipmentRate = getProcessRate("equipment_rate").value;
  const amount = machineHours * equipmentRate;

  return {
    dimension: "equipment",
    dimensionLabel: "设备与能耗成本",
    estimatedAmount: Math.round(amount * 100) / 100,
    amountRange: [amount * 0.85, amount * 1.1],
    ratio: 0,
    basis: [
      `设备运行：${machineHours.toFixed(1)} 小时${boxType.complexityMultiplier !== 1 ? `（×盒型复杂度 ${boxType.complexityMultiplier}）` : ""}`,
      `综合费率：${equipmentRate} 元/小时（含折旧+电费+维护）`,
    ],
    assumptions: ["按标准设备利用率估算"],
    confidence: 68,
    risks: [],
    breakdown: [
      {
        label: "设备与能耗费",
        amount: Math.round(amount * 100) / 100,
        note: `设备运行 ${machineHours.toFixed(1)}h（×盒型系数 ${boxType.complexityMultiplier}）× 综合费率 ${equipmentRate} 元/h`,
      },
    ],
  };
}

/** 设计与制版 Agent */
export function designAgent(input: AnalysisInput): AgentResult {
  const colorCount = str(input, "colorCount", "4");
  const printMethod = str(input, "printMethod", "offset");
  const quantity = num(input, "quantity", 1000);
  const provideReadyDesign = bool(input, "provideReadyDesign", false);

  const cmykColors = Number(String(colorCount).split("+")[0]) || 4;
  const spotColors = num(input, "spotColorCount", 0);
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
export function financeAgent(input: AnalysisInput, subtotal: number): AgentResult {
  const delivery = str(input, "deliveryLocation", "east_china");
  const urgency = str(input, "targetDelivery", "standard");
  const quantity = num(input, "quantity", 1000);

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
  process: processAgent,
  labor: laborAgent,
  equipment: equipmentAgent,
  design_plate: designAgent,
  finance_other: financeAgent,
};
