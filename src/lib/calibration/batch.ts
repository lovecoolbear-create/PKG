/**
 * 校准案例批量导入 —— 纯逻辑共享模块（无 xlsx 运行时依赖）
 *
 * xlsx 的读写放在客户端（动态 import，与 /batch 页一致），
 * 本模块只负责「扁平行 → 校准案例」的映射与校验，前端与 API 共用同一份规则。
 */

import type { ProductTypeConfig } from "@/types";
import {
  ANCHOR_KEYS,
  DIM_KEYS,
  DIM_LABELS,
  validateCase,
  type CaseIssue,
  type CaseLike,
} from "./validate";

// ========== 列定义 ==========

export interface TemplateColumn {
  /** 表头文本 */
  header: string;
  /** 归属：meta / input.<key> / actual.<key> / anchor.<key> */
  target: string;
  /** 说明（模板第二行注释行用） */
  hint?: string;
  /** 示例值 */
  sample?: string | number;
}

const META_COLUMNS: TemplateColumn[] = [
  { header: "案例标识", target: "caseId", hint: "必填，唯一，如 2026-客户A-白卡彩盒", sample: "2026-示例-白卡彩盒" },
  { header: "产品类别", target: "productType", hint: "可填中文名或代码，留空用模板品类", sample: "彩印纸盒" },
  { header: "供应商", target: "meta.supplier", sample: "某厂" },
  { header: "报价日期", target: "meta.date", hint: "如 2026-08", sample: "2026-08" },
  { header: "口径备注", target: "meta.note", hint: "含税？含运？打样费是否单列", sample: "含13%税；物流含在财务" },
];

const ACTUAL_COLUMNS: TemplateColumn[] = [
  { header: "实际总价(元)", target: "actual.total", hint: "必填，供应商实报总价", sample: 6800 },
  ...DIM_KEYS.map((k) => ({
    header: `${DIM_LABELS[k]}(元)`,
    target: `actual.${k}`,
    hint: "供应商拆了才填，留空不参与分维度校准",
  })),
];

const ANCHOR_COLUMNS: TemplateColumn[] = [
  { header: "纸价锚(元/吨)", target: "anchor.paperPricePerTon", hint: "纸商/行情当期实际纸价" },
  { header: "工价锚(元/个)", target: "anchor.laborRatePerPiece", hint: "该厂实际计件工价" },
  { header: "制版锚(元)", target: "anchor.plateCost", hint: "实际制版/刀模费" },
  { header: "财务锚(元)", target: "anchor.financeTotal", hint: "实际管理+利润+物流合计" },
];

/** 生成某品类的模板列（meta + 该品类所有字段 + 实际报价 + 外部锚） */
export function buildTemplateColumns(cfg: ProductTypeConfig): TemplateColumn[] {
  const inputCols: TemplateColumn[] = cfg.fields.map((f) => ({
    header: f.unit ? `${f.label}(${f.unit})` : f.label,
    target: `input.${f.key}`,
    hint: f.options?.length ? `可选：${f.options.map((o) => o.label).join("/")}` : f.placeholder,
  }));
  return [...META_COLUMNS, ...inputCols, ...ACTUAL_COLUMNS, ...ANCHOR_COLUMNS];
}

/** 模板示例行（照抄 calibration-cases.example.json 的口径，非真实案例） */
const SAMPLE_VALUES: Record<string, string | number> = {
  "meta.supplier": "某厂",
  "meta.date": "2026-08",
  "meta.note": "含13%税；物流含在财务；打样费已含在设计制版",
  "actual.total": 6800,
  "actual.material": 2900,
  "actual.labor": 520,
  "actual.process": 1500,
  "actual.design_plate": 700,
  "actual.finance_other": 1180,
};

export function buildTemplateRow(
  cfg: ProductTypeConfig,
  columns: TemplateColumn[]
): (string | number)[] {
  return columns.map((c) => {
    if (c.target.startsWith("input.")) {
      const f = cfg.fields.find((x) => x.key === c.target.slice(6));
      if (!f) return "";
      if (f.defaultValue !== undefined) return String(f.defaultValue);
      if (f.options?.length) return f.options[0].label;
      return f.type === "number" ? 1 : "";
    }
    if (c.target === "caseId") return "2026-示例-请删除此行";
    if (c.target === "productType") return cfg.name;
    return SAMPLE_VALUES[c.target] ?? "";
  });
}

// ========== 解析 ==========

/** 归一化表头：去空格、去括号说明、去 * 号、小写 */
function normHeader(h: string): string {
  return String(h)
    .replace(/\s+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\*/g, "")
    .trim()
    .toLowerCase();
}

function matchOptionValue(f: ProductTypeConfig["fields"][number], raw: string): string | undefined {
  const v = String(raw).trim();
  if (!v) return undefined;
  const byValue = f.options?.find((o) => String(o.value).toLowerCase() === v.toLowerCase());
  if (byValue) return String(byValue.value);
  const byLabel = f.options?.find((o) => o.label === v || o.label.includes(v));
  if (byLabel) return String(byLabel.value);
  return v; // 原样透传，交由 validate 的枚举检查给出 warning
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim();
  return s === "是" || s === "true" || s === "1" || s === "Y" || s === "y";
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v).replace(/[,，\s元]/g, "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function resolveProductType(raw: string, all: ProductTypeConfig[]): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const byCode = all.find((p) => p.code.toLowerCase() === s.toLowerCase());
  if (byCode) return byCode.code;
  const byName = all.find((p) => p.name === s);
  if (byName) return byName.code;
  return s; // 原样，validate 会报未知品类
}

/** 扁平行 → 校准案例。defaultProductType 在行内未指定品类时兜底。 */
export function mapRowToCase(
  row: Record<string, unknown>,
  allConfigs: ProductTypeConfig[],
  defaultProductType: string
): CaseLike {
  // 建表头索引
  const idx = new Map<string, unknown>();
  for (const [h, v] of Object.entries(row)) idx.set(normHeader(h), v);

  const lookup = (columns: TemplateColumn[], key: string): unknown => {
    const col = columns.find((c) => c.target === key);
    if (!col) return undefined;
    return idx.get(normHeader(col.header));
  };

  const ptRaw = lookup(META_COLUMNS, "productType");
  const productType =
    resolveProductType(String(ptRaw ?? ""), allConfigs) || defaultProductType;
  const cfg = allConfigs.find((p) => p.code === productType);

  const input: Record<string, unknown> = {};
  if (cfg) {
    for (const f of cfg.fields) {
      const col = { header: f.unit ? `${f.label}(${f.unit})` : f.label, target: `input.${f.key}` };
      const raw = idx.get(normHeader(col.header));
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      if (f.type === "boolean") input[f.key] = toBool(raw);
      else if (f.type === "number") {
        const n = toNum(raw);
        if (n !== undefined) input[f.key] = n;
      } else if (f.options?.length) input[f.key] = matchOptionValue(f, String(raw));
      else input[f.key] = String(raw).trim();
    }
  }

  const actualTotal = toNum(lookup(ACTUAL_COLUMNS, "actual.total"));
  const actual: Record<string, unknown> = {};
  if (actualTotal !== undefined) actual.total = actualTotal;
  for (const k of DIM_KEYS) {
    const n = toNum(lookup(ACTUAL_COLUMNS, `actual.${k}`));
    if (n !== undefined) actual[k] = n;
  }

  const caseIdRaw = lookup(META_COLUMNS, "caseId");
  const meta: Record<string, unknown> = {};
  for (const k of ["supplier", "date", "note"]) {
    const v = lookup(META_COLUMNS, `meta.${k}`);
    if (v !== undefined && String(v).trim() !== "") meta[k] = String(v).trim();
  }
  for (const k of ANCHOR_KEYS) {
    const v = toNum(lookup(ANCHOR_COLUMNS, `anchor.${k}`));
    if (v !== undefined) meta[k] = v;
  }

  const out: CaseLike = {
    caseId: caseIdRaw === undefined ? "" : String(caseIdRaw).trim(),
    productType,
    input: { ...input, productType },
    actual,
  };
  if (Object.keys(meta).length) out.meta = meta;
  return out;
}

// ========== 批量校验 ==========

export interface BatchRowResult {
  index: number;
  caseId: string;
  productType: string;
  total?: number;
  errors: CaseIssue[];
  warnings: CaseIssue[];
}

export interface BatchPreview {
  rows: BatchRowResult[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  warnRows: number;
}

export function previewRows(
  rows: Record<string, unknown>[],
  allConfigs: ProductTypeConfig[],
  defaultProductType: string
): { preview: BatchPreview; cases: CaseLike[] } {
  const cases: CaseLike[] = [];
  const results: BatchRowResult[] = [];

  rows.forEach((row, i) => {
    const c = mapRowToCase(row, allConfigs, defaultProductType);
    const { errors, warnings } = validateCase(c);
    cases.push(c);
    results.push({
      index: i,
      caseId: String(c.caseId ?? ""),
      productType: String(c.productType ?? ""),
      total: typeof c.actual?.total === "number" ? c.actual.total : undefined,
      errors,
      warnings,
    });
  });

  const invalidRows = results.filter((r) => r.errors.length).length;
  const warnRows = results.filter((r) => !r.errors.length && r.warnings.length).length;

  return {
    preview: {
      rows: results,
      totalRows: results.length,
      validRows: results.length - invalidRows,
      invalidRows,
      warnRows,
    },
    cases,
  };
}

/** 粘贴板文本（TSV/CSV）→ 扁平行数组 */
export function parseClipboardTable(text: string): Record<string, unknown>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const split = (line: string) =>
    line.includes("\t") ? line.split("\t") : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

  const headers = split(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map((line) => {
    const cells = split(line).map((c) => c.replace(/^"|"$/g, "").trim());
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}
