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

/**
 * 品类级示例值（演示味道最浓的那几个字段）。
 * 只写「该品类最典型」的组合，其余字段交给 defaultValue / 选项兜底。
 */
const CATEGORY_SAMPLE: Record<string, Record<string, string | number>> = {
  color_print_box: {
    quantity: 5000,
    length: 200,
    width: 150,
    height: 80,
    material: "white_card",
    grammage: "350",
    boxType: "tuck_end",
    printMethod: "offset",
    surfaceTreatment: "matte_laminate",
  },
  flat_print: {
    quantity: 3000,
    length: 210,
    width: 285,
    pages: 32,
    grammage: "157",
    coverGrammage: "250",
    binding: "perfect",
    surfaceTreatment: "matte_laminate",
  },
  corrugated_box: {
    quantity: 3000,
    length: 400,
    width: 300,
    height: 250,
    boardStructure: "single",
    fluteType: "B",
    linerMaterial: "kraft",
    linerGrammage: "175",
    fluteGrammage: "120",
    // 瓦楞箱绝大多数不覆膜，示例行别把用户带偏到「覆哑膜」
    printMethod: "flexo",
    surfaceTreatment: "none",
  },
  label: {
    quantity: 5000,
    length: 50,
    width: 30,
    material: "coated_paper",
    grammage: "80",
    printMethod: "offset",
    surfaceTreatment: "matte_laminate",
  },
};

/** 全局偏好值（仅当该字段的 options 里有它时才生效） */
const PREFERRED_SAMPLE: Record<string, string | number> = {
  colorCount: "4",
  deliveryLocation: "east_china",
  surfaceTreatment: "matte_laminate",
  printMethod: "offset",
  material: "coated_paper",
  boxType: "tuck_end",
  binding: "perfect",
  pages: 32,
  spotColorCount: 0,
};

/** 数值字段最后兜底：保证任何新品类都能生成「可导入」的示例行 */
const NUMBER_FALLBACK: Record<string, number> = {
  quantity: 1000,
  length: 100,
  width: 100,
  height: 50,
  pages: 16,
};

/**
 * 典型示例行（帮助用户照格式填写），调用方决定是否写入模板。
 *
 * 按字段 key 生成，不依赖中文表头字符串——历史版本用「订单数量/长度/…」硬编码，
 * 标签品类的字段名是「印量/成品长度/面材类型」，导致示例行整行空白、用户照抄无从下手
 * （且导入时报「缺少必填字段」）。现在改为：品类覆盖 → 全局偏好 → 字段 defaultValue
 * → 选项中间项 / 数值兜底，新增品类也不会再出现空示例行。
 */
export function buildSampleRow(config: ProductTypeConfig): (string | number)[] {
  const cat = CATEGORY_SAMPLE[config.code] ?? {};
  const byHeader: Record<string, string | number> = {};

  for (const f of config.fields) {
    if (!isBatchField(f)) continue;
    const legal = (v: unknown) =>
      v === undefined || !f.options || f.options.some((o) => String(o.value) === String(v));

    let v: string | number | undefined;
    if (cat[f.key] !== undefined && legal(cat[f.key])) v = cat[f.key];
    else if (PREFERRED_SAMPLE[f.key] !== undefined && legal(PREFERRED_SAMPLE[f.key]))
      v = PREFERRED_SAMPLE[f.key];
    else if (f.defaultValue !== undefined && legal(f.defaultValue)) v = f.defaultValue as string | number;

    if (v === undefined) {
      if (f.options?.length) {
        // 中间项比首项更有代表性（首项常是「无」）
        v = f.options[Math.floor(f.options.length / 2)].value;
      } else if (f.type === "number") {
        v = NUMBER_FALLBACK[f.key] ?? 1;
      }
    }
    if (v === undefined) continue;
    // 布尔列写「是/否」，与导入端 coerceValue 的取值表一致
    byHeader[`${f.key} (${f.label})`] = f.type === "boolean" ? (v ? "是" : "否") : v;
  }

  return buildTemplateHeaders(config).map(
    (h) => (h === NAME_HEADER ? "示例-请删除此行" : byHeader[h] ?? "")
  );
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
      // 品类声明了 defaultValue 的必填字段 → 直接取默认值，不算缺失。
      // 历史不一致：单品流程会用 config 的 defaultValue（如 needGluing=true），
      // 但批量导入却报「缺少必填字段：是否糊盒」，用户被迫补一列根本不需要的字段。
      if (f.required && f.defaultValue !== undefined) {
        (input as Record<string, unknown>)[f.key] = f.defaultValue;
        raw[f.key] = typeof f.defaultValue === "object" ? undefined : (f.defaultValue as string | number | boolean);
        continue;
      }
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
