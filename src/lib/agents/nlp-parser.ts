// ========== 入口一：自然语言输入与模糊意图解析器 ==========
// 接入 LLM，将口语化包装需求解析为结构化 AnalysisInput；
// 未提及参数由「包装工程默认值推断（Default Guess）」补全，并给出置信度。
// 未配置 LLM API Key 时，回退到内置关键词规则解析（仍可工作）。

import type { AnalysisInput, DielineShape, ProductTypeConfig } from "@/types";
import { normalizeAnalysisInputUnits } from "@/lib/parse/unit-normalizer";
import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
  type LlmContentPart,
} from "@/lib/llm/client";
import { auditLLMCall, modelLabel } from "@/lib/agents/consistency-gate";
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
  /** 是否要求人工确认：视觉解析/AI 推断字段存在时为真（§3.1 输入解析层铁律：AI 抽尺寸须人工核对） */
  requiresHumanConfirmation?: boolean;
  /** 字段来源追踪：deterministic=确定性预处理抽取（DXF/文本）；ai_extracted=AI 抽取（须人工核对）；inferred=系统推断默认 */
  fieldSource?: Record<string, "deterministic" | "ai_extracted" | "inferred">;
}

/**
 * P4 确定性预处理：从矢量文件(DXF)/结构化文本抽取尺寸，不依赖视觉 LLM。
 * 用于图纸解析前置——能确定性抽取的尺寸绝不交给 AI 读图（避免 120mm 误读成 170mm）。
 * 返回 L×W×H（任意可识别组合），found=false 表示源中无可识别尺寸。
 */
export function extractDeterministicDimensions(
  source: string
): { dims: Partial<AnalysisInput>; found: boolean } {
  const s = (source || "").toString();
  const dims: Partial<AnalysisInput> = {};

  // 1) 显式 L×W×H（确定性，最高优先）
  const triple = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  if (triple) {
    dims.length = Math.round(Number(triple[1]));
    dims.width = Math.round(Number(triple[2]));
    dims.height = Math.round(Number(triple[3]));
  }

  // 2) 标签式：长120 宽85 高60（补全未识别的维度）
  const labelMap: [keyof AnalysisInput, RegExp][] = [
    ["length", /长\s*[:：]?\s*(\d+(?:\.\d+)?)/],
    ["width", /宽\s*[:：]?\s*(\d+(?:\.\d+)?)/],
    ["height", /高\s*[:：]?\s*(\d+(?:\.\d+)?)/],
  ];
  for (const [k, re] of labelMap) {
    if (dims[k as keyof AnalysisInput] === undefined) {
      const m = s.match(re);
      if (m) (dims as Record<string, unknown>)[k] = Math.round(Number(m[1]));
    }
  }

  // 范围校验
  for (const k of Object.keys(dims) as (keyof AnalysisInput)[]) {
    const v = Number(dims[k]);
    if (!(v > 0 && v < 5000)) delete dims[k];
  }

  // 纪律：仅当能确定性识别时才返回尺寸；无法识别则 found=false，
  // 交由视觉 LLM 处理（但其抽取结果会被标记为 ai_extracted + 需人工确认），绝不猜测。
  return { dims, found: Object.keys(dims).length > 0 };
}

// 合法枚举值（作为无品类配置时的保守超集；实际解析时以 ProductTypeConfig.fields.options 为准）
const ALLOWED = {
  boxType: ["tuck_end", "rigid_cover", "special_window"],
  material: [
    "white_card", "coated_paper", "matte_paper", "offset_paper", "photo_paper",
    "grey_board", "kraft", "pp_sheet", "pvc", "pet", "special",
  ],
  grammage: ["80", "105", "128", "157", "200", "230", "250", "300", "350", "400", "450"],
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
    哑粉: "matte_paper",
    哑粉纸: "matte_paper",
    双胶: "offset_paper",
    双胶纸: "offset_paper",
    相纸: "photo_paper",
    pp: "pp_sheet",
    pp纸: "pp_sheet",
    pp合成纸: "pp_sheet",
    合成纸: "pp_sheet",
    pvc: "pvc",
    pvc材料: "pvc",
    pet: "pet",
    灰板: "grey_board",
    灰底白板: "grey_board",
    牛皮: "kraft",
    牛皮纸: "kraft",
    牛卡: "kraft",
    牛卡纸: "kraft",
    特种纸: "special",
    特种: "special",
    不干胶: "special",
  },
  fluteType: {
    // 顺序敏感：越具体越靠前。泛词「瓦楞」必须放最后——
    // 否则「五层BC瓦」会被先匹配成 E_flute（对瓦楞品类还是非法值）。
    a坑: "A",
    c坑: "C",
    f坑: "F",
    五层bc瓦: "BC",
    bc双坑: "BC",
    bc坑: "BC",
    bc瓦: "BC",
    五层: "BC",
    be双坑: "BE",
    be坑: "BE",
    ab双坑: "AB",
    ab坑: "AB",
    七层: "AB",
    e坑: "E_flute",
    e坑型: "E_flute",
    b坑: "B_flute",
    b坑型: "B_flute",
    裱坑: "E_flute",
    瓦楞: "E_flute",
  },
  binding: {
    骑马钉: "saddle",
    无线胶装: "perfect",
    锁线胶装: "thread_sewn",
    锁线: "thread_sewn",
    精装: "hardcover",
    圈装: "spiral",
    yo圈: "spiral",
    风琴折: "accordion",
    古线装: "accordion",
    折页: "fold",
    胶装: "perfect",
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
    覆膜: "gloss_laminate",
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

// ==================== 品类感知（2026-08-30 补） ====================
// 历史缺陷：本文件所有枚举/默认值都写死为「彩印纸盒」口径（ALLOWED.grammage 只有
// 250~450g、DEFAULT_FALLBACK 无条件注入 boxType/fluteType）。结果是：在瓦楞/平印/标签
// 品类下用自然语言输入，会被静默填入彩盒字段——
//   · 「瓦楞纸箱 牛卡175g」→ grammage 被改成 350g（175 不在彩盒档位）
//   · 「画册 157g」→ grammage 被改成 350g
//   · 「不干胶标签 80g」→ grammage 被改成 350g
//   · 平印/标签品类被凭空注入 boxType=tuck_end / fluteType=none（这两个字段它们根本没有）
// 修复：把品类配置（ProductTypeConfig）作为可选参数贯穿 ruleParse/inferDefaults/sanitize，
// 用 config.fields 校验「该品类是否有此字段」「枚举值是否合法」「默认值取品类声明值」。
// 不传 config 时行为完全等同旧逻辑（向后兼容所有既有调用点）。

/** 品类里某字段的可选值；该品类无此字段或无选项约束时返回 undefined */
function configOptions(
  config: ProductTypeConfig | undefined,
  key: string
): string[] | undefined {
  if (!config) return undefined;
  const f = config.fields.find((x) => x.key === key);
  if (!f?.options?.length) return undefined;
  return f.options.map((o) => String(o.value));
}

/** 该品类是否存在此字段（不传 config 时保守返回 true，保持旧行为） */
function configHasField(config: ProductTypeConfig | undefined, key: string): boolean {
  if (!config) return true;
  return config.fields.some((x) => x.key === key);
}

/** 品类配置声明的默认值 */
function configDefaultValue(
  config: ProductTypeConfig | undefined,
  key: string
): string | number | boolean | undefined {
  if (!config) return undefined;
  return config.fields.find((x) => x.key === key)?.defaultValue;
}

/** 解析出的枚举值是否对该品类合法（无选项约束时不限制） */
function enumOkFor(
  config: ProductTypeConfig | undefined,
  key: string,
  value: unknown
): boolean {
  if (!configHasField(config, key)) return false;
  const opts = configOptions(config, key);
  if (!opts) return true;
  return opts.includes(String(value));
}

/**
 * 品类字段别名：通用解析结果落到该品类**实际存在**的字段上。
 * 例：瓦楞没有 `material`/`grammage`，只有 `linerMaterial`/`linerGrammage`——
 * 若无别名，「牛卡175g」这种最典型的瓦楞描述会被整段丢弃。
 */
const FIELD_ALIAS: Record<string, string[]> = {
  material: ["material", "linerMaterial"],
  grammage: ["grammage", "linerGrammage"],
};

function resolveField(config: ProductTypeConfig | undefined, canonical: string): string {
  if (!config) return canonical;
  for (const cand of FIELD_ALIAS[canonical] ?? [canonical]) {
    if (configHasField(config, cand)) return cand;
  }
  return canonical;
}

/** 字段级文本证据：只有原始文本出现对应线索，才接受 LLM/规则提取值进入 input。
 * 其余情况一律视为系统推断/默认，进入 defaults 展示。 */
const EVIDENCE_PATTERNS: Record<string, RegExp> = {
  boxType: /天地盖|扣底|插口|标准盒|开窗|异形|异型|特殊盒/,
  material: /白卡|铜版|哑粉|双胶|相纸|灰板|灰底白板|牛皮|牛卡|特种|pp|PVC|PET|不干胶/i,
  grammage: /\d{2,3}\s*(?:g|克|gsm|克重)/i,
  fluteType: /瓦楞|裱坑|e坑|b坑/i,
  printMethod: /数码|胶印|柔印/,
  colorCount: /(?:[一二三四1234])\s*色|cmyk|四色|三色|双色|单色/i,
  spotColorCount: /专色/,
  surfaceTreatment: /哑膜|磨砂|哑光|亮膜|光膜|覆膜|uv|烫金|烫银|压纹|击凸|压凸/i,
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
function pushDefault(
  defaults: NlpDefaultGuess[],
  config: ProductTypeConfig | undefined,
  g: NlpDefaultGuess
): void {
  // 该品类根本没有这个字段 → 绝不注入（历史 bug：平印/标签被注入 boxType/fluteType）
  if (!configHasField(config, g.field)) return;
  // 枚举值对该品类非法 → 绝不注入（历史 bug：瓦楞被注入 E_flute，而瓦楞坑型是 A/B/C/E/F/BC/BE）
  if (!enumOkFor(config, g.field, g.value)) return;
  defaults.push(g);
}

function inferDefaults(
  text: string,
  already: Partial<AnalysisInput>,
  config?: ProductTypeConfig
): NlpDefaultGuess[] {
  const defaults: NlpDefaultGuess[] = [];

  // 盒型推断："礼盒/高级/精品" 等 → 天地盖（这是行业经验推断，非用户明确指定）
  if (already.boxType === undefined) {
    const boxSyn = findMatchedSynonym("boxType", text);
    if (boxSyn) {
      pushDefault(defaults, config, {
        field: "boxType",
        label: "盒型结构",
        value: SYNONYMS.boxType[boxSyn],
        reason: `由「${boxSyn}」推断，请核对`,
      });
    } else if (text.includes("高级") || text.includes("高档") || text.includes("精品")) {
      pushDefault(defaults, config, {
        field: "boxType",
        label: "盒型结构",
        value: "rigid_cover",
        reason: "由「高级/精品」推断为天地盖精品盒，请核对",
      });
    }
  }

  // 材质推断（瓦楞品类自动落到 linerMaterial）
  if (already.material === undefined && already.linerMaterial === undefined) {
    const matSyn = findMatchedSynonym("material", text);
    if (matSyn) {
      pushDefault(defaults, config, {
        field: resolveField(config, "material"),
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
      pushDefault(defaults, config, {
        field: "surfaceTreatment",
        label: "表面处理",
        value: SYNONYMS.surfaceTreatment[surfSyn],
        reason: `由「${surfSyn}」推断，请核对`,
      });
    } else if (text.includes("防水")) {
      pushDefault(defaults, config, {
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
      pushDefault(defaults, config, {
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
      pushDefault(defaults, config, {
        field: "printMethod",
        label: "印刷方式",
        value: SYNONYMS.printMethod[pmSyn],
        reason: `由「${pmSyn}」推断，请核对`,
      });
    }
  }

  // 装订方式（平印专用）：config 无 binding 字段时 pushDefault 会自动跳过
  if (already.binding === undefined) {
    const bSyn = findMatchedSynonym("binding", text);
    if (bSyn) {
      pushDefault(defaults, config, {
        field: "binding",
        label: "装订方式",
        value: SYNONYMS.binding[bSyn],
        reason: `由「${bSyn}」推断，请核对`,
      });
    }
  }

  // 系统默认补全（覆盖剩余未确定字段）
  // 品类感知：① 该品类没有的字段不注入；② 默认值优先取品类 config 声明的 defaultValue。
  for (const [k, def] of Object.entries(DEFAULT_FALLBACK)) {
    const target = resolveField(config, k);
    if (already[target as keyof AnalysisInput] !== undefined) continue;
    if (defaults.find((d) => d.field === target)) continue;
    const cfgDefault = configDefaultValue(config, target);
    pushDefault(defaults, config, {
      ...def,
      field: target,
      value: cfgDefault !== undefined ? cfgDefault : def.value,
      reason:
        cfgDefault !== undefined
          ? `${def.reason}（已改用「${config?.name ?? "当前品类"}」的默认值 ${cfgDefault}）`
          : def.reason,
    });
  }

  if (already.quantity === undefined) {
    const qtyDefault = configDefaultValue(config, "quantity");
    pushDefault(defaults, config, {
      field: "quantity",
      label: "订单数量",
      value: qtyDefault !== undefined ? Number(qtyDefault) : 5000,
      reason: "未提及数量，默认 5000 个用于估算",
    });
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
function ruleParse(text: string, config?: ProductTypeConfig): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
  confidence: number;
} {
  const input: Partial<AnalysisInput> = {};

  // 数量：数字 + 量词。量词须覆盖四类品类的常用说法——
  // 历史缺陷：原正则无「本/册/件/条/片/对」，导致「画册 1000本」完全匹配不到，
  // 数量被 inferDefaults 静默填成默认 5000（用户明确写了 1000 却被改成 5 倍）。
  const qtyMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:个|套|只|份|箱|张|枚|本|册|件|条|片|对|pcs|PCS)/i
  );
  if (qtyMatch) {
    const n = Math.round(Number(qtyMatch[1]));
    if (n > 0) input.quantity = n;
  }

  // 页数（平印专用）：32P / 32页。仅在该品类确实有 pages 字段时写入，
  // 并做 1~2000 的区间守卫（与 input-guardrail 的 pages_oversize 阈值一致）。
  if (configHasField(config, "pages") && input.pages === undefined) {
    const pMatch = text.match(/(\d+)\s*(?:页|[pP])(?![a-zA-Z])/);
    if (pMatch) {
      const n = Math.round(Number(pMatch[1]));
      if (n >= 1 && n <= 2000) input.pages = n;
    }
  }

  // 印刷色数（CMYK 整体色数）：口语「单/双/三/四色」
  // 历史缺陷：此前完全不识别，任何文本都静默落到默认 4 色。
  const COLOR_WORDS: Record<string, string> = {
    单色: "1",
    一色: "1",
    双色: "2",
    两色: "2",
    三色: "3",
    四色: "4",
    五色: "5",
    六色: "6",
  };
  for (const [kw, v] of Object.entries(COLOR_WORDS)) {
    if (text.includes(kw) && enumOkFor(config, "colorCount", v)) {
      input.colorCount = v;
      break;
    }
  }

  // 克重：如 350g。品类感知——写死的 ALLOWED.grammage 只有彩盒档位(250~450)，
  // 导致瓦楞 175g / 平印 157g / 标签 80g 全被判为「非法」并静默改成 350g。
  const gKey = resolveField(config, "grammage");
  const gMatch = text.match(/(\d{2,3})\s*g\b/);
  if (
    gMatch &&
    (ALLOWED.grammage.includes(gMatch[1]) || enumOkFor(config, gKey, gMatch[1]))
  ) {
    (input as Record<string, unknown>)[gKey] = gMatch[1];
  }

  // 封面克重（平印专用）：「封面250g」。主克重正则会先命中内页克重，此处单独取封面。
  if (configHasField(config, "coverGrammage")) {
    const cg = text.match(/封面\s*(\d{2,3})\s*g/i);
    if (cg && enumOkFor(config, "coverGrammage", cg[1])) {
      input.coverGrammage = cg[1];
    }
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

  // 尺寸（自然语言中偶尔出现）：标签式 长120 宽85 高60
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

  // 尺寸（最常见的三连写法 L×W×H，如 200x150x80mm / 400×300×250）：
  // 历史缺陷（P0）：项目内已有确定性函数 extractDeterministicDimensions，
  // 但 ruleParse 从未调用它——而三连写法恰恰是用户写尺寸的最常见形式，
  // 结果尺寸三个字段全部丢失、落到默认值，材料成本（第一驱动）直接失真。
  // 仅补全尚未识别到的维度，不覆盖上面标签式已识别的结果。
  const det = extractDeterministicDimensions(text);
  if (det.found) {
    for (const k of ["length", "width", "height"] as const) {
      const v = det.dims[k];
      if (typeof v === "number" && (input as Record<string, unknown>)[k] === undefined) {
        (input as Record<string, unknown>)[k] = v;
      }
    }
  }

  // 尺寸（二维写法 L×W，如「画册 210x285mm」「标签 50x30mm」「100mm*100mm」）：
  // 平印/标签是平面产品、没有高，extractDeterministicDimensions 只认三连故会漏。
  // 仅在三连未命中、且长宽都还没识别到时补全，避免误伤。
  const has3D = input.length !== undefined && input.width !== undefined && input.height !== undefined;
  if (!has3D && input.length === undefined && input.width === undefined) {
    const pair = text.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?/i);
    if (pair) {
      const l = Math.round(Number(pair[1]));
      const w = Math.round(Number(pair[2]));
      if (l > 0 && l < 5000 && w > 0 && w < 5000) {
        input.length = l;
        input.width = w;
      }
    }
  }

  // 其余字段统一走推断/默认
  const defaults = inferDefaults(text, input, config);

  // 置信度：必须基于「文本明确命中的关键字段」计算，且在把 defaults 合并进 input 之前，
  // 否则被默认补全的 material/boxType 会被误算为「已识别」而虚高（旧逻辑恒为 ~81%）
  const keyHits = ["quantity", "boxType", "material"].filter(
    (k) => input[k as keyof AnalysisInput] !== undefined
  ).length;
  let confidence = 45 + keyHits * 12;
  // 材质/盒型等关键结构字段无文本证据（仅靠默认）→ 大幅下调，避免误导
  if (!input.material && !input.boxType) confidence -= 25;
  // 默认值过多 → 下调
  if (defaults.length >= 5) confidence -= 12;
  else if (defaults.length >= 3) confidence -= 6;
  confidence = clamp(confidence, 15, 95);

  // 把推断/默认值也合并进 input，确保下游表单完整回填
  for (const d of defaults) {
    if (input[d.field as keyof AnalysisInput] === undefined) {
      (input as Record<string, unknown>)[d.field] = d.value;
    }
  }

  // 解析后单位归一化（建议 #2）：cm/m/英寸→mm、万→个，确定性、绝不交 AI
  const norm = normalizeAnalysisInputUnits(input, text);
  return { input: norm.input, defaults, confidence };
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
  sourceText = "",
  config?: ProductTypeConfig
): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
} {
  const parsed: Partial<AnalysisInput> = {};

  const setEnum = (field: keyof typeof ALLOWED, val: unknown) => {
    const v = typeof val === "string" ? val.trim() : String(val ?? "");
    if ((ALLOWED[field] as string[]).includes(v) || enumOkFor(config, field, v)) {
      (parsed as Record<string, unknown>)[field] = v;
    } else {
      const syn = pickFromSynonyms(field as keyof typeof SYNONYMS, v);
      if (syn && enumOkFor(config, field, syn)) {
        (parsed as Record<string, unknown>)[field] = syn;
      }
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
    if (ALLOWED.grammage.includes(g) || enumOkFor(config, "grammage", g)) {
      parsed.grammage = g;
    }
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

  // LLM 未输出尺寸时，回退到确定性文本抽取（平面/标签产品常见的 100mm*100mm、50x30mm 等）
  if (sourceText) {
    const det = extractDeterministicDimensions(sourceText);
    if (det.found) {
      for (const k of ["length", "width", "height"] as const) {
        const v = det.dims[k];
        if (typeof v === "number" && (parsed as Record<string, unknown>)[k] === undefined) {
          (parsed as Record<string, unknown>)[k] = v;
        }
      }
    }
    // extractDeterministicDimensions 只认三连/标签式，此处补二维写法
    const hasAnyDim =
      parsed.length !== undefined || parsed.width !== undefined || parsed.height !== undefined;
    if (!hasAnyDim) {
      const pair = sourceText.match(
        /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?/i
      );
      if (pair) {
        const l = Math.round(Number(pair[1]));
        const w = Math.round(Number(pair[2]));
        if (l > 0 && l < 5000 && w > 0 && w < 5000) {
          parsed.length = l;
          parsed.width = w;
        }
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

  const defaults = inferDefaults(sourceText, input, config);

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

  // 解析后单位归一化（建议 #2）：cm/m/英寸→mm、万→个，确定性、绝不交 AI
  const norm = normalizeAnalysisInputUnits(input, sourceText);
  return { input: norm.input, defaults };
}

const SYSTEM_PROMPT = `你是一名资深的包装工程结构设计师，擅长将客户的口语化、模糊的包装需求转化为精确的生产下单参数。

请仅依据用户给出的需求文本进行解析，不要编造用户未提及的信息。对于未提及的参数，必须直接省略该字段（不要输出 null、不要输出空字符串、不要输出占位值），由下游系统套用工程默认值。

特别注意：
1. 尺寸必须提取：文本中如"100mm*100mm"、"长100mm 宽80mm"、"50x30mm"等，请输出 length（长 mm，整数）、width（宽 mm，整数）、height（高 mm，整数；平面产品/标签/贴纸可省略 height）。
2. 克重（grammage）只有在用户文本中明确出现如"350g"、"350克"、"350gsm"、"克重350"等字样时才输出；否则必须省略该字段，禁止默认填 350。
3. 材质（material）、盒型（boxType）、印刷方式（printMethod）等未明确提及时同样必须省略，禁止用"白卡纸"、"标准盒"等常见值硬填。

输出严格的 JSON 对象（不要包含任何解释文字、不要使用 Markdown 代码块），字段如下：
{
  "length": "长 mm（整数），文本中如 '100mm'/'长100' 等可提取",
  "width": "宽 mm（整数），文本中如 '100mm'/'宽80' 等可提取",
  "height": "高 mm（整数）；标签/贴纸/平面印刷可省略",
  "boxType": "盒型，取值之一：tuck_end(标准扣底盒) / rigid_cover(天地盖精品盒) / special_window(异形开窗盒)；未提及则省略",
  "material": "材质，取值之一：white_card(白卡纸) / coated_paper(铜版纸) / matte_paper(哑粉纸) / offset_paper(双胶纸) / photo_paper(相纸) / grey_board(灰底白板) / kraft(牛皮纸) / pp_sheet(PP合成纸) / pvc(PVC) / pet(PET) / special(特种纸)；未提及则省略",
  "grammage": "克重数字字符串，如 '350'（仅当用户明确提到如 350g/350克/350gsm 时才输出）",
  "fluteType": "瓦楞/裱坑，取值之一：none(非瓦楞) / E_flute(E坑) / B_flute(B坑)；未提及则省略",
  "printMethod": "印刷方式，取值之一：offset(胶印) / digital(数码) / flexo(柔印)；未提及则省略",
  "colorCount": "CMYK 色数，字符串 '1'~'4'；未提及则省略",
  "spotColorCount": "专色色数，整数（未提及则省略）",
  "surfaceTreatment": "表面处理，取值之一：none / matte_laminate(哑膜) / gloss_laminate(亮膜/覆膜) / uv / foil(烫金) / emboss(压纹击凸)；未提及则省略",
  "quantity": "订单数量整数（从文本提取，如 '3000个' -> 3000）；未提及则省略",
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
 * 解析包装图纸（视觉）：图纸图片交由视觉大模型做「语义对齐」，但尺寸优先由
 * 确定性预处理（DXF/文本，deterministicSource）抽取——AI 绝不读尺寸（§3.1 输入解析层铁律）。
 * 需要支持视觉的模型（如 LM Studio 的 qwen2.5-vl-3b）；无视觉模型但有确定性源时仍可抽尺寸。
 */
export async function parseDrawingImage(
  images: DrawingImage[],
  aiSettings?: AiSettings,
  opts?: { deterministicSource?: string }
): Promise<NlpParseResult> {
  // P4 前置：确定性抽取尺寸（DXF/文本），绝不交给视觉 LLM 读尺寸
  const det = opts?.deterministicSource
    ? extractDeterministicDimensions(opts.deterministicSource)
    : null;
  const fieldSource: Record<string, "deterministic" | "ai_extracted" | "inferred"> = {};

  if (!images || images.length === 0) {
    // 无图但有确定性源：仅返回尺寸，其余待补
    if (det?.found) {
      const defaults = inferDefaults("", det.dims);
      for (const d of defaults) fieldSource[d.field] = "inferred";
      for (const k of Object.keys(det.dims)) fieldSource[k] = "deterministic";
      return {
        input: det.dims as Partial<AnalysisInput>,
        defaults,
        confidence: 82,
        source: "rule",
        requiresHumanConfirmation: false,
        fieldSource,
        note: "已通过确定性预处理（DXF/结构文本）抽取尺寸，请补充结构与工艺后生成报告。",
      };
    }
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      requiresHumanConfirmation: false,
      note: "请先上传图纸图片或 DXF/结构文本。",
    };
  }

  if (!isLlmConfigured(aiSettings) || aiSettings?.provider === "disabled") {
    if (det?.found) {
      const defaults = inferDefaults("", det.dims);
      for (const d of defaults) fieldSource[d.field] = "inferred";
      for (const k of Object.keys(det.dims)) fieldSource[k] = "deterministic";
      return {
        input: det.dims as Partial<AnalysisInput>,
        defaults,
        confidence: 82,
        source: "rule",
        requiresHumanConfirmation: false,
        fieldSource,
        note: "未配置视觉模型，已用确定性预处理（DXF/文本）抽取尺寸；请人工补全结构与工艺。",
      };
    }
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      requiresHumanConfirmation: false,
      note: "未配置支持视觉的模型（如本地 LM Studio 的 qwen2.5-vl-3b）且未提供 DXF/结构文本，无法解析图纸。请在右上角「AI 设置」中配置 LM Studio 视觉模型，或上传 DXF/结构文本抽尺寸。",
    };
  }

  try {
    const content: LlmContentPart[] = [
      {
        type: "text",
        text: det?.found
          ? "图纸尺寸已由确定性预处理抽取，请勿输出 dimensions/几何字段；仅输出你能从图面判断的结构与工艺参数（盒型/材质/表面处理/印刷/专色/拼版）。"
          : "请解析以下包装图纸/结构图，仅依据图中可见信息提取结构与工艺参数。尺寸若可见标注可输出，但将被标记为需人工核对。",
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

    // 处理 dimensions 对象（图纸尺寸，仅作 AI 抽取，落 ai_extracted 待确认）
    const dims = obj.dimensions as Record<string, unknown> | undefined;
    if (dims && typeof dims === "object") {
      for (const k of ["length", "width", "height"] as const) {
        const n = Number(String(dims[k] ?? "").replace(/[^\d.]/g, ""));
        if (!Number.isNaN(n) && n > 0 && n < 5000) {
          (input as Record<string, unknown>)[k] = Math.round(n);
        }
      }
    }

    // 字段来源追踪：默认值为推断；其余为 AI 抽取
    for (const d of defaults) fieldSource[d.field] = "inferred";
    for (const k of Object.keys(input)) {
      if (fieldSource[k]) continue;
      fieldSource[k] = "ai_extracted";
    }

    // P4 核心：确定性源抽取的尺寸覆盖 AI、并标记为 deterministic
    let hasDetOverride = false;
    if (det?.found) {
      for (const [k, v] of Object.entries(det.dims)) {
        (input as Record<string, unknown>)[k] = v;
        fieldSource[k] = "deterministic";
        hasDetOverride = true;
      }
    }

    const keyHits = ["quantity", "boxType", "material", "length"].filter(
      (k) => input[k as keyof AnalysisInput] !== undefined
    ).length;
    let confidence = 72 + keyHits * 7;
    if (defaults.length >= 4) confidence -= 10;
    confidence = clamp(confidence, 0, 98);

    const aiDriven = Object.values(fieldSource).some((v) => v === "ai_extracted");
    const drawingResult: NlpParseResult = {
      input,
      defaults,
      confidence,
      source: "llm",
      requiresHumanConfirmation: aiDriven, // 只要存在 AI 抽取字段就必须人工核对
      fieldSource,
      note: det?.found
        ? "尺寸已由确定性预处理（DXF/文本）抽取，结构与工艺由视觉模型解析，请核对工艺参数后生成报告。"
        : "已从图纸视觉解析，尺寸与工艺均为 AI 抽取，请务必逐字段核对（尤其尺寸）后生成报告。",
    };
    auditLLMCall({
      ts: new Date().toISOString(),
      layer: "parse_drawing",
      source: "llm",
      model: modelLabel(aiSettings),
      inputSummary: `图纸解析；确定性源=${det?.found ? "是" : "否"}；图像数=${images?.length ?? 0}`,
      engineKeyValues: det?.found ? (det.dims as Record<string, string | number>) : {},
      outputText: JSON.stringify({ input, defaults }),
      warnings: [],
    });
    return drawingResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 视觉解析失败时，若确定性源可用仍返回尺寸
    if (det?.found) {
      const defaults = inferDefaults("", det.dims);
      for (const d of defaults) fieldSource[d.field] = "inferred";
      for (const k of Object.keys(det.dims)) fieldSource[k] = "deterministic";
      return {
        input: det.dims as Partial<AnalysisInput>,
        defaults,
        confidence: 82,
        source: "rule",
        requiresHumanConfirmation: false,
        fieldSource,
        note: `视觉解析失败（${msg}），已回退至确定性预处理尺寸，请人工补全结构与工艺。`,
      };
    }
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      requiresHumanConfirmation: false,
      note: `图纸视觉解析失败：${msg}。请确认已配置支持视觉的模型（如 qwen2.5-vl-3b）且本地 LM Studio 服务正常，或上传 DXF/结构文本抽尺寸。`,
    };
  }
}

/** 解析自然语言需求为结构化入参（含默认值推断与置信度） */
export async function parseNaturalLanguage(
  text: string,
  aiSettings?: AiSettings,
  config?: ProductTypeConfig
): Promise<NlpParseResult> {
  const cleaned = (text || "").trim();
  if (!cleaned) {
    return {
      input: {},
      defaults: [],
      confidence: 0,
      source: "rule",
      requiresHumanConfirmation: false,
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
        // 质量优先：NLP 走 27B 主模型，用户接受 >90s 冷加载长等待。放宽至 180s 覆盖 27B JIT 冷启动（实测常 >90s）；
        // 不常驻 27B（否则视觉 2.5vl 进来双载 OOM 崩机），JIT Only Keep Last 保证 NLP/视觉单载互斥；
        // retries:0 避免超时重试把单次等待放大成多轮（每轮都因冷加载超时），单次超时即干净回退规则解析
        { temperature: 0.1, timeoutMs: 180000, retries: 0, settings: aiSettings }
      );

      const obj = extractJsonObject(raw);
      const { input, defaults } = sanitize(obj, cleaned, config);

      // 置信度以「系统须默认补全的字段数」为主要信号：默认项越多越不可信（稳健、不随 LLM 抽取位置漂移）
      let confidence = 95 - defaults.length * 7;
      // 关键结构字段（材质/盒型）均未识别 → 硬惩罚，避免虚高误导
      if (!input.material && !input.boxType) confidence -= 20;
      confidence = clamp(confidence, 15, 95);

      const nlResult: NlpParseResult = {
        input,
        defaults,
        confidence,
        source: "llm",
        requiresHumanConfirmation: confidence < 60,
        note: "大模型已解析需求并补全工程默认值，请核对后生成报告。",
      };
      auditLLMCall({
        ts: new Date().toISOString(),
        layer: "parse_natural",
        source: "llm",
        model: modelLabel(aiSettings),
        inputSummary: cleaned.slice(0, 600),
        engineKeyValues: {},
        outputText: JSON.stringify({ input, defaults }),
        warnings: [],
      });
      return nlResult;
    } catch (err) {
      // LLM 失败 → 规则兜底；记录错误便于排查（旧逻辑静默吞掉，无法定位 NLP 失真根因）
      console.error("[NLP] parseNaturalLanguage LLM 路径失败，已回退规则解析：", err);
    }
  }

  const { input, defaults, confidence: ruleConfidence } = ruleParse(cleaned, config);
  // LLM 配置可用却走到规则兜底（调用失败/超时）→ 置信度压低并强制人工确认，避免伪装成高可信解析
  const confidence = isLlmConfigured(aiSettings)
    ? Math.min(ruleConfidence, 45)
    : ruleConfidence;
  return {
    input,
    defaults,
    confidence,
    source: "rule",
    requiresHumanConfirmation: isLlmConfigured(aiSettings) ? true : false,
    note: isLlmConfigured(aiSettings)
      ? "大模型解析暂不可用，已切换为关键词规则解析，结果置信度较低，请务必逐字段核对。"
      : "当前为关键词规则解析（未配置大模型），建议核对后生成报告。",
  };
}
