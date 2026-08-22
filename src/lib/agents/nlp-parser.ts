// ========== 入口一：自然语言输入与模糊意图解析器 ==========
// 接入 LLM，将口语化包装需求解析为结构化 AnalysisInput；
// 未提及参数由「包装工程默认值推断（Default Guess）」补全，并给出置信度。
// 未配置 LLM API Key 时，回退到内置关键词规则解析（仍可工作）。

import type { AnalysisInput } from "@/types";
import { chatCompletion, extractJsonObject, isLlmConfigured } from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";

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

/** 规则兜底解析：关键词 + 正则提取数量/克重 */
function ruleParse(text: string): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
  confidence: number;
} {
  const input: Partial<AnalysisInput> = {};
  const defaults: NlpDefaultGuess[] = [];

  // 盒型
  const box = pickFromSynonyms("boxType", text);
  if (box) input.boxType = box;
  // 高级/精品 但没点名盒型 → 推断天地盖
  if (!box && (text.includes("高级") || text.includes("高档") || text.includes("精品"))) {
    input.boxType = "rigid_cover";
  }
  // 海鲜/食品 + 防水 → 表面处理覆膜
  const surf = pickFromSynonyms("surfaceTreatment", text);
  if (surf) input.surfaceTreatment = surf;
  if (text.includes("防水") && !surf) input.surfaceTreatment = "matte_laminate";

  // 材质
  const mat = pickFromSynonyms("material", text);
  if (mat) input.material = mat;

  // 瓦楞/坑
  const flute = pickFromSynonyms("fluteType", text);
  if (flute) input.fluteType = flute;

  // 印刷方式
  const pm = pickFromSynonyms("printMethod", text);
  if (pm) input.printMethod = pm;

  // 专色
  const spotMatch = text.match(/(\d+)\s*个?专色/);
  if (spotMatch) {
    input.spotColorCount = Number(spotMatch[1]);
  } else if (text.includes("专色")) {
    input.spotColorCount = 1;
  }

  // 数量：首个数字 + 量词（个/套/只/份/箱/张）
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

  // 完稿
  if (
    text.includes("完稿") ||
    text.includes("提供文件") ||
    text.includes("AI文件") ||
    text.includes("设计稿已") ||
    text.includes("有稿件")
  ) {
    input.provideReadyDesign = true;
  }
  // 不糊盒
  if (text.includes("免糊") || text.includes("不糊盒") || text.includes("不用糊")) {
    input.needGluing = false;
  }

  // 缺省项补全说明
  const DEFAULT_FALLBACK: Record<string, NlpDefaultGuess> = {
    boxType: { field: "boxType", label: "盒型结构", value: "tuck_end", reason: "未提及盒型，默认标准扣底盒" },
    material: { field: "material", label: "材质", value: "white_card", reason: "未提及材质，默认白卡纸" },
    grammage: { field: "grammage", label: "克重", value: "350", reason: "未提及克重，默认 350g" },
    fluteType: { field: "fluteType", label: "瓦楞/裱坑", value: "none", reason: "未提及瓦楞，默认非瓦楞" },
    printMethod: { field: "printMethod", label: "印刷方式", value: "offset", reason: "未提及印刷方式，默认胶印" },
    colorCount: { field: "colorCount", label: "CMYK 色数", value: "4", reason: "未提及色数，默认四色 CMYK" },
    surfaceTreatment: { field: "surfaceTreatment", label: "表面处理", value: "none", reason: "未提及表面处理，默认无" },
    spotColorCount: { field: "spotColorCount", label: "专色色数", value: 0, reason: "未提及专色，默认 0" },
  };
  for (const [k, def] of Object.entries(DEFAULT_FALLBACK)) {
    if (input[k as keyof AnalysisInput] === undefined) {
      (input as Record<string, unknown>)[k] = def.value;
      defaults.push(def);
    }
  }
  if (input.quantity === undefined) {
    defaults.push({ field: "quantity", label: "数量", value: 5000, reason: "未提及数量，默认 5000 个用于估算" });
    input.quantity = 5000;
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

/** 将 LLM 返回的任意值规整为合法枚举/类型 */
function sanitize(raw: Record<string, unknown>): {
  input: Partial<AnalysisInput>;
  defaults: NlpDefaultGuess[];
} {
  const input: Partial<AnalysisInput> = {};
  const defaults: NlpDefaultGuess[] = [];

  const setEnum = (field: keyof typeof ALLOWED, val: unknown) => {
    const v = typeof val === "string" ? val.trim() : String(val ?? "");
    if ((ALLOWED[field] as string[]).includes(v)) {
      (input as Record<string, unknown>)[field] = v;
    } else {
      const syn = pickFromSynonyms(field as keyof typeof SYNONYMS, v);
      if (syn) (input as Record<string, unknown>)[field] = syn;
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
    if (!Number.isNaN(n) && n >= 0 && n <= 8) input.spotColorCount = Math.round(n);
  }
  if (raw.grammage !== undefined) {
    const g = String(raw.grammage).replace(/[^\d]/g, "");
    if (ALLOWED.grammage.includes(g)) input.grammage = g;
  }
  if (raw.quantity !== undefined) {
    const n = Number(String(raw.quantity).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(n) && n > 0) input.quantity = Math.round(n);
  }
  if (typeof raw.needGluing === "boolean") input.needGluing = raw.needGluing;
  if (typeof raw.provideReadyDesign === "boolean") input.provideReadyDesign = raw.provideReadyDesign;

  // 补全缺省
  const DEFAULT_FALLBACK: Record<string, NlpDefaultGuess> = {
    boxType: { field: "boxType", label: "盒型结构", value: "tuck_end", reason: "未提及盒型，默认标准扣底盒" },
    material: { field: "material", label: "材质", value: "white_card", reason: "未提及材质，默认白卡纸" },
    grammage: { field: "grammage", label: "克重", value: "350", reason: "未提及克重，默认 350g" },
    fluteType: { field: "fluteType", label: "瓦楞/裱坑", value: "none", reason: "未提及瓦楞，默认非瓦楞" },
    printMethod: { field: "printMethod", label: "印刷方式", value: "offset", reason: "未提及印刷方式，默认胶印" },
    colorCount: { field: "colorCount", label: "CMYK 色数", value: "4", reason: "未提及色数，默认四色 CMYK" },
    surfaceTreatment: { field: "surfaceTreatment", label: "表面处理", value: "none", reason: "未提及表面处理，默认无" },
    spotColorCount: { field: "spotColorCount", label: "专色色数", value: 0, reason: "未提及专色，默认 0" },
  };
  for (const [k, def] of Object.entries(DEFAULT_FALLBACK)) {
    if (input[k as keyof AnalysisInput] === undefined) {
      (input as Record<string, unknown>)[k] = def.value;
      defaults.push(def);
    }
  }
  if (input.quantity === undefined) {
    defaults.push({ field: "quantity", label: "数量", value: 5000, reason: "未提及数量，默认 5000 个用于估算" });
    input.quantity = 5000;
  }

  return { input, defaults };
}

const SYSTEM_PROMPT = `你是一名资深的包装工程结构设计师，擅长将客户的口语化、模糊的包装需求转化为精确的生产下单参数。

请仅依据用户给出的需求文本进行解析，不要编造用户未提及的信息。对于未提及的参数，不要擅自填充具体值，而是留空（不输出该字段），由下游系统套用工程默认值。

输出严格的 JSON 对象（不要包含任何解释文字、不要使用 Markdown 代码块），字段如下：
{
  "boxType": "盒型，取值之一：tuck_end(标准扣底盒) / rigid_cover(天地盖精品盒) / special_window(异形开窗盒)",
  "material": "材质，取值之一：white_card(白卡纸) / coated_paper(铜版纸) / grey_board(灰底白板) / kraft(牛皮纸) / special(特种纸)",
  "grammage": "克重数字字符串，如 '350'（仅当用户明确提到如 350g）",
  "fluteType": "瓦楞/裱坑，取值之一：none(非瓦楞) / E_flute(E坑) / B_flute(B坑)",
  "printMethod": "印刷方式，取值之一：offset(胶印) / digital(数码) / flexo(柔印)",
  "colorCount": "CMYK 色数，字符串 '1'~'4'",
  "spotColorCount": "专色色数，整数（未提及则为 0）",
  "surfaceTreatment": "表面处理，取值之一：none / matte_laminate(哑膜) / gloss_laminate(亮膜) / uv / foil(烫金) / emboss(压纹击凸)",
  "quantity": "订单数量整数（从文本提取，如 '3000个' -> 3000）",
  "needGluing": "是否需要糊盒，布尔（如用户说免糊盒则为 false）",
  "provideReadyDesign": "是否已提供完稿文件，布尔"
}

只输出 JSON。`;

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

  if (isLlmConfigured()) {
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
      const { input, defaults } = sanitize(obj);

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
