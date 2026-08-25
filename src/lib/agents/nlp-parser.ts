// ========== 入口一：自然语言输入与模糊意图解析器 ==========
// 接入 LLM，将口语化包装需求解析为结构化 AnalysisInput；
// 未提及参数由「包装工程默认值推断（Default Guess）」补全，并给出置信度。
// 未配置 LLM API Key 时，回退到内置关键词规则解析（仍可工作）。

import type { AnalysisInput, DielineShape } from "@/types";
import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
  type LlmContentPart,
} from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";

/** 图纸图像（前端读取为 base64 data URL 传入） */
export interface DrawingImage {
  /** data:image/png;base64,... 或 data:image/jpeg;base64,... */
  dataUrl: string;
  mime: string;
}

export interface NlpDefaultGuess {
  field: string;
  label: string;
  value: string | number | boolean;
  reason: string;
}

export interface NlpParseResult {
  /** 解析/推断出的结构化入参（仅含确定的字段键） */
  input: Partial<AnalysisInput>;
  /** 由系统推断补全、用户未明确提及的字段（透明展示） */
  defaults: NlpDefaultGuess[];
  /** 置信度 0-100 */
  confidence: number;
  /** 来源：llm=大模型解析；rule=规则关键词解析 */
  source: "llm" | "rule";
  /** 解析备注（面向用户） */
  note?: string;
}

// 合法枚举值（与 src/config/products/color-print-box.ts 保持一致）
const ALLOWED = {
  boxType: ["tuck_end", "rigid_cover", "special_window"],
  material: ["white_card", "coated_paper", "grey_board", "kraft", "special"],
  grammage: ["250", "300", "350", "400", "450"],
  fluteType: ["none", "E_flute", "B_flute"],
  printMethod: ["offset", "digital", "flexo"],
  colorCount: ["1", "2", "3", "4"],
  surfaceTreatment: [
    "none",
    "matte_laminate",
    "gloss_laminate",
    "uv",
    "foil",
    "emboss",
  ],
};

// 中文/口语 → 枚举 同义词映射
const SYNONYMS: Record<string, Record<string, string>> = {
  boxType: {
    天地盖: "rigid_cover",
    精品盒: "rigid_cover",
    翻盖: "rigid_cover",
    礼盒: "rigid_cover",
    扣底: "tuck_end",
    插口: "tuck_end",
    标准盒: "tuck_end",
    开窗: "special_window",
    异形: "special_window",
    异型: "special_window",
    特殊盒: "special_window",
  },
  material: {
    白卡: "white_card",
    白卡纸: "white_card",
    铜版: "coated_paper",
    铜版纸: "coated_paper",
    灰板: "grey_board",
    灰底白板: "grey_board",
    牛皮: "kraft",
    牛皮纸: "kraft",
    特种纸: "special",
    特种: "special",
  },
  fluteType: {
    瓦楞: "E_flute",
    裱坑: "E_flute",
    e坑: "E_flute",
    e坑型: "E_flute",
    b坑: "B_flute",
    b坑型: "B_flute",
  },
  printMethod: {
    数码: "digital",
    数字印刷: "digital",
    柔印: "flexo",
    柔性版: "flexo",
    胶印: "offset",
  },
  surfaceTreatment: {
    哑膜: "matte_laminate",
    磨砂: "matte_laminate",
    哑光: "matte_laminate",
    防水: "matte_laminate",
    亮膜: "gloss_laminate",
    光膜: "gloss_laminate",
     uv: "uv",
    uv上光: "uv",
    烫金: "foil",
    烫银: "foil",
    压纹: "emboss",
    击凸: "emboss",
    压凸: "emboss",
  },
};

function pickFromSynonyms(
  field: keyof typeof SYNONYMS,
  text: string
): string | undefined {
  for (const [kw, val] of Object.entries(SYNONYMS[field])) {
    if (text.includes(kw)) return val;
  }
  return undefined;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** 字段级文本证据：只有原始文本出现对应线索，才接受 LLM/规则提取值进入 input。
 * 其余情况一律视为系统推断/默认，进入 defaults 展示。 */
const EVIDENCE_PATTERNS: Record<string, RegExp> = {
  boxType: /天地盖|扣底|插口|标准盒|开窗|异形|异型|特殊盒/,
  material: /白卡|铜版|灰板|灰底白板|牛皮|特种/,
  grammage: /\d{2,3}\s*(?:g|克|gsm|克重)/i,
  fluteType: /瓦楞|裱坑|e坑|b坑/i,
  printMethod: /数码|胶印|柔印/,
  colorCount: /(?:[一二三四1234])\s*色|cmyk|四色|三色|双色|单色/i,
  spotColorCount: /专色/,
  surfaceTreatment: /哑膜|磨砂|哑光|亮膜|光膜|uv|烫金|烫银|压纹|击凸|压凸/i,
  needGluing: /糊盒|免糊|不糊盒|不用糊/,
  provideReadyDesign: /完稿|提供文件|AI文件|设计稿已|有稿件/,
};

/** 从文本中提取匹配到同义词的关键词（用于 reason 文案） */
function findMatchedSynonym(field: keyof typeof SYNONYMS, text: string): string | undefined {
  for (const [kw] of Object.entries(SYNONYMS[field])) {
    if (text.includes(kw)) return kw;
  }
  return undefined;
}

/** 推断缺失字段并生成 defaults。明确提到但靠同义词/经验推断的字段也进 defaults，
 * 不进 input，避免前端把推断误标为「已识别」。 */
function inferDefaults(
  text: string,
  already: Partial<AnalysisInput>
): NlpDefaultGuess[] {
  const defaults: NlpDefaultGuess[] = [];

  // 盒型推断："礼盒/高级/精品" 等 → 天地盖（这是行业经验推断，非用户明确指定）
  if (already.boxType === undefined) {
    const boxSyn = findMatchedSynonym("boxType", text);
    if (boxSyn) {
      defaults.push({
        field: "boxType",
        label: "盒型结构",
        value: SYNONYMS.boxType[boxSyn],
        reason: `由「${boxSyn}」推断，请核对`,
      });
    } else if (text.includes("高级") || text.includes("高档") || text.includes("精品")) {
      defaults.push({
        field: "boxType",
        label: "盒型结构",
        value: "rigid_cover",
        reason: "由「高级/精品」推断为天地盖精品盒，请核对",
      });
    }
  }

  // 材质推断
  if (already.material === undefined) {
    const matSyn = findMatchedSynonym("material", text);
    if (matSyn) {
      defaults.push({
        field: "material",
        label: "材质",
        value: SYNONYMS.material[matSyn],
        reason: `由「${matSyn}」推断，请核对`,
      });
    }
  }

  // 表面处理推断："防水" 等关键词 → 覆膜
  if (already.surfaceTreatment === undefined) {
    const surfSyn = findMatchedSynonym("surfaceTreatment", text);
    if (surfSyn) {
      defaults.push({
        field: "surfaceTreatment",
        label: "表面处理",
        value: SYNONYMS.surfaceTreatment[surfSyn],
        reason: `由「${surfSyn}」推断，请核对`,
      });
    } else if (text.includes("防水")) {
      defaults.push({
        field: "surfaceTreatment",
        label: "表面处理",
        value: "matte_laminate",
        reason: "由「防水」推断为覆哑膜，请核对",
      });
    }
  }

  // 瓦楞/裱坑推断
  if (already.fluteType === undefined) {
    const fluteSyn = findMatchedSynonym("fluteType", text);
    if (fluteSyn) {
      defaults.push({
        field: "fluteType",
        label: "瓦楞/裱坑",
        value: SYNONYMS.fluteType[fluteSyn],
        reason: `由「${fluteSyn}」推断，请核对`,
      });
    }
  }

  // 印刷方式推断
  if (already.printMethod === undefined) {
    const pmSyn = findMatchedSynonym("printMethod", text);
    if (pmSyn) {
      defaults.push({
        field: "printMethod",
        label: "印刷方式",
        value: SYNONYMS.printMethod[pmSyn],
        reason: `由「${pmSyn}」推断，请核对`,
      });
    }
  }

  // 系统默认补全（覆盖剩余未确定字段）
  for (const [k, def] of Object.entries(DEFAULT_FALLBACK)) {
    if (already[k as keyof AnalysisInput] === undefined && !defaults.find((d) => d.field === k)) {
      defaults.push(def);
    }
  }

  if (already.quantity === undefined) {
    defaults.push({ field: "quantity", label: "订单数量", value: 5000, reason: "未提及数量，默认 5000 个用于估算" });
  }

  return defaults;
}

/** 缺省项补全（规则解析与 LLM 解析后共用同一份基准） */
const DEFAULT_FALLBACK: Record<string, NlpDefaultGuess> = {
  boxType: { field: "boxType", label: "盒型结构", value: "tuck_end", reason: "未提及盒型，默认标准扣底盒" },
  material: { field: "material", label: "材质", value: "white_card", reason: "未提及材质，默认白卡纸" },
  grammage: { field: "grammage", label: "克重", value: "350", reason: "未提及克重，已按常见彩盒默认 350g，请核对后修改" },
  fluteType: { field: "fluteType", label: "瓦楞/裱坑", value: "none", reason: "未提及瓦楞，默认非瓦楞" },
  printMethod: { field: "printMethod", label: "印刷方式", value: "offset", reason: "未提及印刷方式，默认胶印" },
  colorCount: { field: "colorCount", label: "CMYK 色数", value: "4", reason: "未提及色数，默认四色 CMYK" },
  surfaceTreatment: { field: "surfaceTreatment", label: "表面处理", value: "none", reason: "未提及表面处理，默认无" },
  spotColorCount: { field: "spotColorCount", label: "专色色数", value: 0, reason: "未提及专色，默认 0" },
};

/** 规则兜底解析：只把文本中明确提到的字段放入 input；
 * 其余靠同义词/经验推断的字段统一进入 defaults，避免用户看到虚假「已识别」。 */
function ruleParse(text: string): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
  confidence: number;
} {
  const input: Partial<AnalysisInput> = {};

  // 数量：首个数字 + 量词（个/套/只/份/箱/张）—— 这是用户明确信息
  const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:个|套|只|份|箱|张|枚|pcs|PCS)/);
  if (qtyMatch) {
    const n = Math.round(Number(qtyMatch[1]));
    if (n > 0) input.quantity = n;
  }

  // 克重：如 350g
  const gMatch = text.match(/(\d{2,3})\s*g\b/);
  if (gMatch && ALLOWED.grammage.includes(gMatch[1])) {
    input.grammage = gMatch[1];
  }

  // 专色：明确提到 "N 个专色" 或仅 "专色"
  const spotMatch = text.match(/(\d+)\s*个?专色/);
  if (spotMatch) {
    input.spotColorCount = Number(spotMatch[1]);
  } else if (text.includes("专色")) {
    input.spotColorCount = 1;
  }

  // 完稿 / 不糊盒：布尔型明确指令
  if (
    text.includes("完稿") ||
    text.includes("提供文件") ||
    text.includes("AI文件") ||
    text.includes("设计稿已") ||
    text.includes("有稿件")
  ) {
    input.provideReadyDesign = true;
  }
  if (text.includes("免糊") || text.includes("不糊盒") || text.includes("不用糊")) {
    input.needGluing = false;
  }

  // 尺寸（自然语言中偶尔出现）
  const dimMatches: Record<string, RegExpMatchArray | null> = {
    length: text.match(/长\s*(\d+(?:\.\d+)?)\s*mm?/i),
    width: text.match(/宽\s*(\d+(?:\.\d+)?)\s*mm?/i),
    height: text.match(/高\s*(\d+(?:\.\d+)?)\s*mm?/i),
  };
  for (const [k, m] of Object.entries(dimMatches)) {
    if (m) {
      const n = Math.round(Number(m[1]));
      if (n > 0 && n < 5000) (input as Record<string, unknown>)[k] = n;
    }
  }

  // 其余字段统一走推断/默认
  const defaults = inferDefaults(text, input);

  // 把推断/默认值也合并进 input，确保下游表单完整回填
  for (const d of defaults) {
    if (input[d.field as keyof AnalysisInput] === undefined) {
      (input as Record<string, unknown>)[d.field] = d.value;
    }
  }

  // 置信度：命中的关键字段越多越高
  const keyHits = ["quantity", "boxType", "material"].filter(
    (k) => input[k as keyof AnalysisInput] !== undefined
  ).length;
  let confidence = 50 + keyHits * 13;
  if (defaults.length >= 4) confidence -= 8;
  confidence = clamp(confidence, 0, 95);

  return { input, defaults, confidence };
}

/** 判断字段是否有文本证据。图纸视觉解析传空串时视为「有证据」（图片就是证据），全部接受。 */
function hasEvidence(sourceText: string, field: string): boolean {
  if (!sourceText) return true;
  const pat = EVIDENCE_PATTERNS[field];
  if (!pat) return true;
  return pat.test(sourceText);
}

/** 将 LLM 返回的任意值规整为合法枚举/类型，并审计每个字段的文本证据。
 * 自然语言解析时，只有文本明确支持的字段才进 input；其余交给 inferDefaults 推断/默认。
 * 图纸视觉解析传空串 sourceText，跳过审计，接受 LLM 从图中提取的值。 */
function isValidDielineShape(s: DielineShape): boolean {
  switch (s.type) {
    case "rect":
      return (s.w ?? 0) > 0 && (s.h ?? 0) > 0;
    case "triangle":
      return (s.b ?? 0) > 0 && (s.h ?? 0) > 0;
    case "circle":
      return (s.r ?? 0) > 0;
    case "trapezoid":
      return (s.top ?? 0) > 0 && (s.bottom ?? 0) > 0 && (s.h ?? 0) > 0;
    case "polygon":
      return Array.isArray(s.points) && s.points.length >= 3;
    case "ellipse":
      return (s.a ?? 0) > 0 && (s.b ?? 0) > 0;
    case "sector":
      return (s.r ?? 0) > 0 && (s.angleDeg ?? 0) > 0 && (s.angleDeg ?? 0) < 360;
    case "semicircle":
      return (s.r ?? 0) > 0;
    case "parallelogram":
      return (s.b ?? 0) > 0 && (s.h ?? 0) > 0;
    case "rhombus":
      return (s.d1 ?? 0) > 0 && (s.d2 ?? 0) > 0;
    case "annulus":
      return (s.rOuter ?? 0) > (s.rInner ?? 0) && (s.rInner ?? 0) > 0;
    case "segment":
      return (s.r ?? 0) > 0 && (s.angleDeg ?? 0) > 0 && (s.angleDeg ?? 0) < 360;
    case "regularPolygon":
      return (s.sides ?? 0) >= 3 && (s.sideLen ?? 0) > 0;
    default:
      return false;
  }
}

function sanitize(
  raw: Record<string, unknown>,
  sourceText = ""
): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
} {
  const parsed: Partial<AnalysisInput> = {};

  const setEnum = (field: keyof typeof ALLOWED, val: unknown) => {
    const v = typeof val === "string" ? val.trim() : String(val ?? "");
    if ((ALLOWED[field] as string[]).includes(v)) {
      (parsed as Record<string, unknown>)[field] = v;
    } else {
      const syn = pickFromSynonyms(field as keyof typeof SYNONYMS, v);
      if (syn) (parsed as Record<string, unknown>)[field] = syn;
    }
  };

  if (raw.boxType !== undefined) setEnum("boxType", raw.boxType);
  if (raw.material !== undefined) setEnum("material", raw.material);
  if (raw.fluteType !== undefined) setEnum("fluteType", raw.fluteType);
  if (raw.printMethod !== undefined) setEnum("printMethod", raw.printMethod);
  if (raw.surfaceTreatment !== undefined) setEnum("surfaceTreatment", raw.surfaceTreatment);
  if (raw.colorCount !== undefined) setEnum("colorCount", String(raw.colorCount));

  if (raw.spotColorCount !== undefined) {
    const n = Number(raw.spotColorCount);
    if (!Number.isNaN(n) && n >= 0 && n <= 8) parsed.spotColorCount = Math.round(n);
  }
  if (raw.grammage !== undefined) {
    const g = String(raw.grammage).replace(/[^\d]/g, "");
    if (ALLOWED.grammage.includes(g)) parsed.grammage = g;
  }
  if (raw.quantity !== undefined) {
    const n = Number(String(raw.quantity).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(n) && n > 0) parsed.quantity = Math.round(n);
  }
  if (typeof raw.needGluing === "boolean") parsed.needGluing = raw.needGluing;
  if (typeof raw.provideReadyDesign === "boolean") parsed.provideReadyDesign = raw.provideReadyDesign;

  // ---- 视觉解析专用几何/拼版字段（不进文本审计，直接用于面积计算）----
  const geo: Partial<AnalysisInput> = {};

  // 刀线净面积直接覆盖（mm²）
  if (raw.dielineAreaMm2 !== undefined) {
    const n = Number(raw.dielineAreaMm2);
    if (!Number.isNaN(n) && n > 0 && n < 50_000_000) geo.dielineAreaMm2 = n;
  }

  // 刀线图形清单：逐个校验后保留
  if (Array.isArray(raw.dielineShapes)) {
    const allowed = new Set([
      "rect", "square", "triangle", "circle", "trapezoid", "polygon",
      "ellipse", "sector", "semicircle", "parallelogram", "rhombus",
      "annulus", "segment", "regularPolygon",
    ]);
    const shapes = (raw.dielineShapes as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => {
        const tRaw = String(s.type ?? "").trim();
        const t = tRaw === "square" ? "rect" : tRaw;
        if (!allowed.has(t)) return null;
        const n = (v: unknown) => {
          const x = Number(v);
          return Number.isNaN(x) ? 0 : x;
        };
        const base: Record<string, unknown> = { type: t };
        if (t === "rect") {
          base.w = n(s.w);
          base.h = n(s.h);
        } else if (t === "triangle") {
          base.b = n(s.b);
          base.h = n(s.h);
        } else if (t === "circle") {
          base.r = n(s.r);
        } else if (t === "trapezoid") {
          base.top = n(s.top);
          base.bottom = n(s.bottom);
          base.h = n(s.h);
        } else if (t === "polygon") {
          const pts = Array.isArray(s.points)
            ? (s.points as unknown[])
                .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
                .map((p) => ({ x: n(p.x), y: n(p.y) }))
            : [];
          base.points = pts;
        } else if (t === "ellipse") {
          base.a = n(s.a);
          base.b = n(s.b);
        } else if (t === "sector") {
          base.r = n(s.r);
          base.angleDeg = n(s.angleDeg);
        } else if (t === "semicircle") {
          base.r = n(s.r);
        } else if (t === "parallelogram") {
          base.b = n(s.b);
          base.h = n(s.h);
        } else if (t === "rhombus") {
          base.d1 = n(s.d1);
          base.d2 = n(s.d2);
        } else if (t === "annulus") {
          base.rOuter = n(s.rOuter);
          base.rInner = n(s.rInner);
        } else if (t === "segment") {
          base.r = n(s.r);
          base.angleDeg = n(s.angleDeg);
        } else if (t === "regularPolygon") {
          base.sides = n(s.sides);
          base.sideLen = n(s.sideLen);
        }
        return base as unknown as DielineShape;
      })
      .filter((s): s is DielineShape => s !== null && isValidDielineShape(s));
    if (shapes.length > 0) geo.dielineShapes = shapes;
  }

  // 全张纸尺寸
  if (raw.sheetSize && typeof raw.sheetSize === "object") {
    const ss = raw.sheetSize as Record<string, unknown>;
    const w = Number(ss.w);
    const h = Number(ss.h);
    if (w > 0 && h > 0 && w < 5000 && h < 5000) geo.sheetSize = { w, h };
  }

  // 每版只数
  if (raw.piecesPerSheet !== undefined) {
    const n = Number(raw.piecesPerSheet);
    if (!Number.isNaN(n) && n > 0 && n < 1000) geo.piecesPerSheet = Math.round(n);
  }

  // 尺寸（图纸视觉解析可能输出；自然语言解析一般不含）
  for (const k of ["length", "width", "height"] as const) {
    if (raw[k] !== undefined) {
      const n = Number(String(raw[k]).replace(/[^\d.]/g, ""));
      if (!Number.isNaN(n) && n > 0 && n < 5000) {
        (parsed as Record<string, unknown>)[k] = Math.round(n);
      }
    }
  }

  // 审计：只有文本有证据的字段才进入 input；其余丢弃，由 inferDefaults 处理。
  // 图纸视觉解析 sourceText 为空，跳过审计。
  const input: Partial<AnalysisInput> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (hasEvidence(sourceText, field)) {
      (input as Record<string, unknown>)[field] = value;
    }
  }

  const defaults = inferDefaults(sourceText, input);

  // 把推断/默认值合并回 input，确保下游表单能完整回填
  for (const d of defaults) {
    if (input[d.field as keyof AnalysisInput] === undefined) {
      (input as Record<string, unknown>)[d.field] = d.value;
    }
  }

  // 兼容图纸视觉解析：sourceText 为空时不审计，但尺寸仍需进入 input（不在 defaults 里）。
  for (const k of ["length", "width", "height"] as const) {
    if (parsed[k] !== undefined && input[k] === undefined) {
      (input as Record<string, unknown>)[k] = parsed[k];
    }
  }

  // 几何/拼版字段（视觉解析产出，不依赖文本审计）直接合并进 input
  Object.assign(input, geo);

  return { input, defaults };
}

const SYSTEM_PROMPT = `你是一名资深的包装工程结构设计师，擅长将客户的口语化、模糊的包装需求转化为精确的生产下单参数。

请仅依据用户给出的需求文本进行解析，不要编造用户未提及的信息。对于未提及的参数，必须直接省略该字段（不要输出 null、不要输出空字符串、不要输出占位值），由下游系统套用工程默认值。

特别注意：
1. 克重（grammage）只有在用户文本中明确出现如"350g"、"350克"、"350gsm"、"克重350"等字样时才输出；否则必须省略该字段，禁止默认填 350。
2. 材质（material）、盒型（boxType）、印刷方式（printMethod）等未明确提及时同样必须省略，禁止用"白卡纸"、"标准盒"等常见值硬填。

输出严格的 JSON 对象（不要包含任何解释文字、不要使用 Markdown 代码块），字段如下：
{
  "boxType": "盒型，取值之一：tuck_end(标准扣底盒) / rigid_cover(天地盖精品盒) / special_window(异形开窗盒)",
  "material": "材质，取值之一：white_card(白卡纸) / coated_paper(铜版纸) / grey_board(灰底白板) / kraft(牛皮纸) / special(特种纸)",
  "grammage": "克重数字字符串，如 '350'（仅当用户明确提到如 350g/350克/350gsm 时才输出）",
  "fluteType": "瓦楞/裱坑，取值之一：none(非瓦楞) / E_flute(E坑) / B_flute(B坑)",
  "printMethod": "印刷方式，取值之一：offset(胶印) / digital(数码) / flexo(柔印)",
  "colorCount": "CMYK 色数，字符串 '1'~'4'",
  "spotColorCount": "专色色数，整数（未提及则省略）",
  "surfaceTreatment": "表面处理，取值之一：none / matte_laminate(哑膜) / gloss_laminate(亮膜) / uv / foil(烫金) / emboss(压纹击凸)",
  "quantity": "订单数量整数（从文本提取，如 '3000个' -> 3000）",
  "needGluing": "是否需要糊盒，布尔（如用户说免糊盒则为 false；未提及则省略）",
  "provideReadyDesign": "是否已提供完稿文件，布尔（未提及则省略）"
}

只输出 JSON。`;

const DRAWING_SYSTEM_PROMPT = `你是一名资深的包装工程结构设计师，擅长阅读包装结构图纸/刀版图/彩盒展开图，并提取生产下单所需的精确参数。

请仔细观察用户提供的图纸图片（可能包含展开图、尺寸标注、结构示意、工艺注释），仅依据图中可见信息提取参数，不要编造图中没有的信息。对于图纸中确实无法判断的参数，不要输出该字段，由下游系统套用工程默认值。

输出严格的 JSON 对象（不要包含任何解释文字、不要使用 Markdown 代码块），字段如下：
{
  "boxType": "盒型，取值之一：tuck_end(标准扣底盒) / rigid_cover(天地盖精品盒) / special_window(异形开窗盒)",
  "material": "材质，取值之一：white_card(白卡纸) / coated_paper(铜版纸) / grey_board(灰底白板) / kraft(牛皮纸) / special(特种纸)",
  "grammage": "克重数字字符串，如 '350'（依据图中标注如 350g）",
  "fluteType": "瓦楞/裱坑，取值之一：none(非瓦楞) / E_flute(E坑) / B_flute(B坑)",
  "dimensions": { "length": 长mm(整数), "width": 宽mm(整数), "height": 高mm(整数) },
  "printMethod": "印刷方式，取值之一：offset(胶印) / digital(数码) / flexo(柔印)",
  "colorCount": "CMYK 色数，字符串 '1'~'4'",
  "spotColorCount": "专色色数，整数（图中可见专色标注则为对应数，否则 0）",
  "surfaceTreatment": "表面处理，取值之一：none / matte_laminate(哑膜) / gloss_laminate(亮膜) / uv / foil(烫金) / emboss(压纹击凸)",
  "quantity": "订单数量整数（若图中注明如 '3000个'）",
  "needGluing": "是否需要糊盒，布尔",
  "provideReadyDesign": "是否已提供完稿文件，布尔（图纸通常即完稿，可置 true）",
  "dielineShapes": "刀线图形清单（异形/开窗盒用）：从图中读取各基本图形尺寸，按几何逐个累计真实展开面积。支持类型与示例：{type:'rect',w:100,h:50}、{type:'triangle',b:40,h:20}、{type:'circle',r:15}、{type:'trapezoid',top:30,bottom:50,h:40}、{type:'ellipse',a:60,b:30}、{type:'sector',r:40,angleDeg:90}、{type:'semicircle',r:25}、{type:'parallelogram',b:50,h:30}、{type:'rhombus',d1:40,d2:24}、{type:'annulus',rOuter:50,rInner:20}、{type:'segment',r:30,angleDeg:60}、{type:'regularPolygon',sides:6,sideLen:20}、{type:'polygon',points:[{x:0,y:0},{x:100,y:0},{x:80,y:60}]}。任意直线异形优先用 polygon 顶点法。标准矩形盒可省略此字段。",
  "sheetSize": "全张纸尺寸 mm（图中若注明拼版用纸），形如 {w:700,h:1000}",
  "piecesPerSheet": "每版（全张纸）只数（图中若注明拼版个数）"
}

只输出 JSON。`;

/**
 * 解析包装图纸（视觉）：将图纸图片交由视觉大模型提取结构化入参。
 * 需要支持视觉的模型（如 Ollama qwen2.5vl）；无视觉模型时返回提示性结果。
 */
export async function parseDrawingImage(
  images: DrawingImage[],
  aiSettings?: AiSettings
): Promise<NlpParseResult> {
  if (!images || images.length === 0) {
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      note: "请先上传图纸图片",
    };
  }
  if (!isLlmConfigured(aiSettings) || aiSettings?.provider === "disabled") {
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      note: "未配置支持视觉的模型（如本地 Ollama 的 qwen2.5vl），无法解析图纸。请在右上角「AI 设置」中配置本地 Ollama 并选择带视觉能力的模型。",
    };
  }

  try {
    const content: LlmContentPart[] = [
      {
        type: "text",
        text: "请解析以下包装图纸/结构图，提取生产参数并输出 JSON。",
      },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.dataUrl },
      })),
    ];

    const raw = await chatCompletion(
      [
        { role: "system", content: DRAWING_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      { temperature: 0.1, timeoutMs: 30000, settings: aiSettings }
    );

    const obj = extractJsonObject(raw);
    const { input, defaults } = sanitize(obj);

    // 处理 dimensions 对象（图纸尺寸）
    const dims = obj.dimensions as Record<string, unknown> | undefined;
    if (dims && typeof dims === "object") {
      for (const k of ["length", "width", "height"] as const) {
        const n = Number(String(dims[k] ?? "").replace(/[^\d.]/g, ""));
        if (!Number.isNaN(n) && n > 0 && n < 5000) {
          (input as Record<string, unknown>)[k] = Math.round(n);
        }
      }
    }

    const keyHits = ["quantity", "boxType", "material", "length"].filter(
      (k) => input[k as keyof AnalysisInput] !== undefined
    ).length;
    let confidence = 72 + keyHits * 7;
    if (defaults.length >= 4) confidence -= 10;
    confidence = clamp(confidence, 0, 98);

    return {
      input,
      defaults,
      confidence,
      source: "llm",
      note: "已从图纸视觉解析并补全工程默认值，请核对尺寸与工艺后生成报告。",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      note: `图纸视觉解析失败：${msg}。请确认已配置支持视觉的模型（如 qwen2.5vl）且本地 Ollama 服务正常。`,
    };
  }
}

/** 解析自然语言需求为结构化入参（含默认值推断与置信度） */
export async function parseNaturalLanguage(
  text: string,
  aiSettings?: AiSettings
): Promise<NlpParseResult> {
  const cleaned = (text || "").trim();
  if (!cleaned) {
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      note: "请输入需求描述",
    };
  }

  if (isLlmConfigured(aiSettings)) {
    try {
      const raw = await chatCompletion(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `请解析以下包装需求：\n"""${cleaned}"""`,
          },
        ],
        { temperature: 0.1, timeoutMs: 15000, settings: aiSettings }
      );

      const obj = extractJsonObject(raw);
      const { input, defaults } = sanitize(obj, cleaned);

      const keyHits = ["quantity", "boxType", "material"].filter(
        (k) => input[k as keyof AnalysisInput] !== undefined
      ).length;
      let confidence = 70 + keyHits * 8;
      if (defaults.length >= 4) confidence -= 10;
      confidence = clamp(confidence, 0, 98);

      return {
        input,
        defaults,
        confidence,
        source: "llm",
        note: "大模型已解析需求并补全工程默认值，请核对后生成报告。",
      };
    } catch {
      // LLM 失败 → 规则兜底
    }
  }

  const { input, defaults, confidence } = ruleParse(cleaned);
  return {
    input,
    defaults,
    confidence,
    source: "rule",
    note: isLlmConfigured(aiSettings)
      ? "大模型解析暂不可用，已切换为关键词规则解析，请核对结果。"
      : "当前为关键词规则解析（未配置大模型），建议核对后生成报告。",
  };
}
