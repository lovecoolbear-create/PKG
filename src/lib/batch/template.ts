// 批量成本分析 —— 纯逻辑共享模块（无 xlsx 运行时依赖）
// 被后端 API (route) 与前端页面共用：字段筛选 / 行→AnalysisInput / report→结果行。
import type { ProductTypeConfig, AnalysisInput, AnalysisReport } from "@/types";
import { getUnitLabel } from "@/lib/report-copy";

/** 模板第一行固定列：产品标识（不参与成本计算，仅用于结果区分） */
export const NAME_HEADER = "name (产品名称)";

/** 是否纳入批量模板列：必填 或 重要(weight>=8)。可选高级字段用户可自行加列，rowToInput 仍会识别。 */
export function isBatchField(f: ProductTypeConfig["fields"][number]): boolean {
  return f.required || f.weight >= 8;
}

/** 模板表头数组（含 name 列在最前） */
export function buildTemplateHeaders(config: ProductTypeConfig): string[] {
  const headers = [NAME_HEADER];
  for (const f of config.fields) {
    if (isBatchField(f)) headers.push(`${f.key} (${f.label})`);
  }
  return headers;
}

/** 字段 key → 表头串 映射，便于解析时定位 */
function headerKeyMap(config: ProductTypeConfig): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of config.fields) {
    if (isBatchField(f)) m[f.key] = `${f.key} (${f.label})`;
  }
  return m;
}

/** 说明 sheet：每个字段一行（key/label/类型/必填/选项） */
export function buildInstructionRows(
  config: ProductTypeConfig
): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["字段key", "字段中文", "类型", "必填", "可选值(value=填写内容，label=含义)"],
  ];
  for (const f of config.fields) {
    if (!isBatchField(f)) continue;
    const opts = f.options
      ? f.options.map((o) => `${o.value}=${o.label}`).join(" | ")
      : "";
    rows.push([
      f.key,
      f.label,
      f.type,
      f.required ? "是" : "否",
      opts,
    ]);
  }
  rows.push([]);
  rows.push(["说明", "", "", "", ""]);
  rows.push(["1. 第一行「产品名称」为必填，用于区分不同产品，不参与成本计算。", "", "", "", ""]);
  rows.push(["2. 各字段单元格填写 value（如 tuck_end、offset），不是中文 label；可选值见上表。", "", "", "", ""]);
  rows.push(["3. 数值字段直接填数字；是否类填 是/否 或 true/false。", "", "", "", ""]);
  rows.push(["4. 模板未列出的高级字段（如专色色数、瓦楞坑型）可自行在右侧加列，表头格式必须为「key (中文)」。", "", "", "", ""]);
  rows.push(["5. 示例行为演示用，正式分析前请删除示例行。", "", "", "", ""]);
  return rows;
}

/** 画册/彩盒的典型示例行（帮助用户照格式填写），调用方决定是否写入模板 */
export function buildSampleRow(config: ProductTypeConfig): (string | number)[] {
  const row: Record<string, string | number> = { [NAME_HEADER]: "示例-请删除此行" };
  if (config.code === "flat_print") {
    row["quantity (印量)"] = 3000;
    row["length (成品长度)"] = 210;
    row["width (成品宽度)"] = 285;
    row["pages (页数 (Pages))"] = 32;
    row["material (纸张类型)"] = "coated_paper";
    row["grammage (内页克重 / 整体克重)"] = "157";
    row["coverGrammage (封面克重)"] = "250";
    row["printMethod (印刷方式)"] = "offset";
    row["colorCount (CMYK 印刷色数)"] = "4";
    row["surfaceTreatment (表面处理)"] = "matte_laminate";
    row["binding (装订方式)"] = "saddle";
    row["deliveryLocation (交付地点)"] = "east_china";
  } else {
    row["quantity (订单数量)"] = 5000;
    row["length (长度)"] = 200;
    row["width (宽度)"] = 150;
    row["height (高度)"] = 80;
    row["boxType (盒型结构)"] = "tuck_end";
    row["material (材质)"] = "white_card";
    row["grammage (克重)"] = "350";
    row["printMethod (印刷方式)"] = "offset";
    row["colorCount (CMYK 印刷色数)"] = "4";
    row["surfaceTreatment (表面处理)"] = "matte_laminate";
    row["needGluing (是否糊盒)"] = "是";
    row["deliveryLocation (交付地点)"] = "east_china";
  }
  return buildTemplateHeaders(config).map((h) => (h in row ? row[h] : ""));
}

function coerceValue(
  raw: unknown,
  type: ProductTypeConfig["fields"][number]["type"],
  options?: { value: string; label: string }[]
): string | number | boolean | string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (s === "") return undefined;

  if (type === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined; // 解析失败→交给默认值兜底
  }
  if (type === "boolean") {
    return ["true", "1", "是", "yes", "y", "√"].includes(s.toLowerCase());
  }
  if (type === "multiselect") {
    return s
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => matchSelect(x, options) ?? x);
  }
  if (type === "select") {
    return matchSelect(s, options) ?? s;
  }
  return s;
}

function matchSelect(
  s: string,
  options?: { value: string; label: string }[]
): string | undefined {
  if (!options || options.length === 0) return undefined;
  const lower = s.toLowerCase();
  for (const o of options) {
    if (o.value.toLowerCase() === lower) return o.value;
  }
  for (const o of options) {
    if (o.label === s) return o.value;
  }
  return undefined;
}

export interface RowParseResult {
  name: string;
  input: AnalysisInput;
  /** 该行解析出的字段（含原始值），用于结果回显 */
  raw: Record<string, string | number | boolean | undefined>;
  /** 必填字段缺失或无法解析时的错误信息；非空表示该行不应进入分析 */
  errors?: string[];
}

/**
 * 单行（对象）转 AnalysisInput。
 * row 的 key 支持两种：完整表头「key (label)」或裸 key。
 */
export function rowToInput(
  row: Record<string, unknown>,
  config: ProductTypeConfig
): RowParseResult {
  const name = String(row[NAME_HEADER] ?? row["name"] ?? "").trim() || "未命名";
  const input: AnalysisInput = {};
  const raw: Record<string, string | number | boolean | undefined> = {};
  const hk = headerKeyMap(config);
  const missing: string[] = [];

  for (const f of config.fields) {
    if (!isBatchField(f)) continue;
    const header = hk[f.key];
    const cell = row[header] ?? row[f.key];
    const isEmpty = cell === null || cell === undefined || String(cell).trim() === "";
    if (isEmpty) {
      if (f.required) missing.push(f.label);
      continue;
    }
    const v = coerceValue(cell, f.type, f.options);
    if (v === undefined) {
      if (f.required) missing.push(`${f.label}(无法解析)`);
      continue;
    }
    (input as Record<string, unknown>)[f.key] = v;
    raw[f.key] = typeof v === "object" ? undefined : (v as string | number | boolean);
  }

  return { name, input, raw, errors: missing.length ? missing : undefined };
}

export interface BatchResultRow {
  name: string;
  raw: Record<string, string | number | boolean | undefined>;
  report: AnalysisReport;
}

/** 结果 sheet 列定义（顺序固定） */
export function buildResultHeaders(
  config: ProductTypeConfig
): { key: string; label: string }[] {
  const cols: { key: string; label: string }[] = [
    { key: "__name", label: "产品名称" },
  ];
  // 输入字段回显
  for (const f of config.fields) {
    if (isBatchField(f)) cols.push({ key: `in_${f.key}`, label: `输入_${f.label}` });
  }
  // 输出
  cols.push({ key: "total_min", label: "总成本下限(元)" });
  cols.push({ key: "total_max", label: "总成本上限(元)" });
  const unit = getUnitLabel(config.code);
  cols.push({ key: "per_min", label: `单位成本下限(元/${unit})` });
  cols.push({ key: "per_max", label: `单位成本上限(元/${unit})` });
  for (const d of config.dimensions) {
    cols.push({ key: `dim_${d.key}`, label: `${d.label}(元)` });
  }
  cols.push({ key: "completeness", label: "信息完整度(%)" });
  cols.push({ key: "confidence", label: "置信度" });
  cols.push({ key: "issues", label: "告警数" });
  cols.push({ key: "issue_msg", label: "主要告警" });
  return cols;
}

/** 单行结果 → 值数组（与 buildResultHeaders 顺序对应） */
export function resultToValues(
  r: BatchResultRow,
  config: ProductTypeConfig
): (string | number)[] {
  const rep = r.report;
  const dimMap = new Map(rep.dimensions.map((d) => [d.dimension, d]));
  const vals: (string | number)[] = [r.name];
  for (const f of config.fields) {
    if (!isBatchField(f)) continue;
    const rv = r.raw[f.key];
    vals.push(
      rv === undefined || rv === null
        ? ""
        : typeof rv === "boolean"
        ? rv
          ? "是"
          : "否"
        : rv
    );
  }
  vals.push(rep.totalCost.min, rep.totalCost.max);
  vals.push(rep.totalCost.perUnit.min, rep.totalCost.perUnit.max);
  for (const d of config.dimensions) {
    vals.push(dimMap.get(d.key)?.estimatedAmount ?? 0);
  }
  vals.push(rep.completeness);
  vals.push(rep.overallConfidence);
  vals.push(rep.validationIssues.length);
  vals.push(
    rep.validationIssues
      .map((v) => `[${v.severity === "error" ? "错误" : "提示"}]${v.message}`)
      .join(" | ")
      .slice(0, 300)
  );
  return vals;
}
