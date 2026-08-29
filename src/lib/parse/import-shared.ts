// ========== 共享导入管线（xlsx 结构化导入 与 扫描件/图片视觉抽取 复用） ==========
// 把「映射 → 词典捕获 → 成本引擎估算 → 组装产物行」这一段从各导入路由抽出，
// 避免两条导入线各写一份、出现口径分叉。价格始终在 price 桶、不进 input，守住红线。

import { randomUUID } from "crypto";
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import {
  mapCustomerSheet,
  type DictCandidate,
  type PriceInfo,
} from "@/lib/parse/column-map";
import * as dictStore from "@/lib/parse/dict-store";
import type { AnalysisInput } from "@/types";

export interface ImportEstimate {
  perUnitMin: number;
  perUnitMax: number;
  perUnit: number;
  totalMin: number;
  totalMax: number;
  confidence: number;
  missingFields: string[];
  dimensions: { dimension: string; dimensionLabel: string; amount: number; ratio: number }[];
}

export interface ImportProductRow {
  index: number;
  name?: string;
  input: Partial<AnalysisInput>;
  price?: PriceInfo;
  unmatched: string[];
  notes: string[];
  dictCandidates?: DictCandidate[];
  estimate?: ImportEstimate;
}

export interface ImportResult {
  productType: string;
  productTypeName: string;
  hasPrice: boolean;
  newTerms: number;
  rowCount: number;
  products: ImportProductRow[];
}

/**
 * 统一导入后段：表头+数据矩阵 → 映射 → 捕获未收录词进词典池 → 逐行跑成本引擎 → 产物行。
 * @param overrides 已确认的词典覆盖（由调用方 loadOverrides 后传入，使学过的词即时生效）
 */
export async function runImportPipeline(
  productType: string,
  headers: string[],
  dataMatrix: (string | number | undefined)[][],
  overrides: ReturnType<typeof dictStore.loadOverrides>
): Promise<ImportResult> {
  const config = getProductConfig(productType);
  if (!config) throw new Error(`未知品类：${productType}`);

  // 结构化映射（价格进 price 桶，不进 input）
  const mapped = mapCustomerSheet(productType, headers, dataMatrix, overrides);

  // 捕获阶段：把本次解析发现的未收录描述词并入待审词典池（去重）
  const captured = mapped.flatMap((m) => m.dictCandidates ?? []);
  const newTerms = captured.length ? dictStore.addCandidates(captured).length : 0;

  // 逐行跑成本引擎，取我方估算（价格字段不参与，避免污染）
  const products: ImportProductRow[] = [];
  let hasPrice = false;
  for (let i = 0; i < mapped.length; i++) {
    const m = mapped[i];
    if (m.price && (m.price.unitPrice != null || m.price.totalPrice != null))
      hasPrice = true;

    let estimate: ImportEstimate | undefined;
    try {
      const report = await runOrchestrator({
        sessionId: randomUUID(),
        config,
        input: (m.input ?? {}) as AnalysisInput,
      });
      const mid =
        Math.round(
          ((report.totalCost.perUnit.min + report.totalCost.perUnit.max) / 2) * 100
        ) / 100;
      estimate = {
        perUnitMin: report.totalCost.perUnit.min,
        perUnitMax: report.totalCost.perUnit.max,
        perUnit: mid,
        totalMin: report.totalCost.min,
        totalMax: report.totalCost.max,
        confidence: report.overallConfidence,
        missingFields: report.missingFields.map((x) => x.label),
        dimensions: report.dimensions.map((d) => ({
          dimension: d.dimension,
          dimensionLabel: d.dimensionLabel,
          amount: d.estimatedAmount,
          ratio: d.ratio,
        })),
      };
    } catch {
      estimate = undefined;
    }

    products.push({
      index: i,
      name: m.name,
      input: m.input ?? {},
      price: m.price,
      unmatched: m.unmatched,
      notes: m.notes,
      dictCandidates: m.dictCandidates,
      estimate,
    });
  }

  return {
    productType,
    productTypeName: config.name,
    hasPrice,
    newTerms,
    rowCount: products.length,
    products,
  };
}
