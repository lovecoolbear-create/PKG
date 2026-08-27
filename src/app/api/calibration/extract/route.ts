import { NextRequest, NextResponse } from "next/server";
import {
  chatCompletion,
  extractJsonObject,
  isLlmConfigured,
  type LlmMessage,
} from "@/lib/llm/client";
import type { AiSettings } from "@/lib/config/ai-settings";

/**
 * 报价单 AI 抽取接口（md 文本 / 图片 → 结构化 CalCase 字段）。
 *
 * 方法学红线（与校准模块一致，且不可破）：
 *   - 只提取源文件明确出现的值，绝不推测、绝不补全缺失字段。
 *   - 尤其禁止补全「材料/加工/人工/设计/财务」五维拆分——原文没给分项金额就不写。
 *   - 锚（纸价/工价等）也只取原文白纸黑字写的，不反推。
 * 抽取结果回灌表单，由用户确认/补必填（确认环节是安全网）。
 *
 * POST body: { kind:"md"|"image", text?, imageBase64?, settings:AiSettings, productType, fieldSpecs:[{key,label,type,unit?}] }
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { kind, text, imageBase64, settings, productType, fieldSpecs } = body as {
    kind?: string;
    text?: string;
    imageBase64?: string;
    settings?: AiSettings;
    productType?: string;
    fieldSpecs?: { key: string; label: string; type: string; unit?: string }[];
  };

  if (kind !== "md" && kind !== "image") {
    return NextResponse.json({ ok: false, error: "kind 必须是 md 或 image" }, { status: 400 });
  }
  if (!settings || typeof settings !== "object") {
    return NextResponse.json({ ok: false, error: "缺少 AI 配置 settings" }, { status: 400 });
  }

  // Ollama 本地：映射到已拉取的专用模型（文本 qwen2.5:14b / 视觉 qwen2.5vl:7b）；云端用用户配置
  const extractSettings: AiSettings =
    settings.provider === "ollama"
      ? { ...settings, modelName: kind === "image" ? "qwen2.5vl:7b" : "qwen2.5:14b" }
      : settings;

  if (!isLlmConfigured(extractSettings)) {
    return NextResponse.json(
      { ok: false, error: "LLM 未配置：请在配置中心填写 Ollama 地址或云端密钥" },
      { status: 400 }
    );
  }

  const fieldsDesc = (fieldSpecs ?? [])
    .map((f) => `- ${f.key}（${f.label}${f.unit ? `，单位${f.unit}` : ""}，类型${f.type}）`)
    .join("\n");

  const system = `你是包装成本校准数据提取助手。从用户提供的${
    kind === "image" ? "报价单图片" : "报价单文本"
  }中提取结构化字段，用于成本校准。

规则（极重要，违反会污染校准数据）：
1. 只提取原文/图片中明确出现的值。绝不推测、绝不补全缺失字段。
2. 尤其禁止补全「材料/加工/人工/设计/财务」五维拆分——若原文没给分项金额，不要写这些键。
3. 数字保留原值（元/个/mm/g 等），不要自行换算或估算。
4. 输出 JSON，字段 key 必须严格用下面列表的英文 key。

可提取字段（key 必须匹配）：
${fieldsDesc}
- actualTotal（实际总价，必填，数字，单位元）
- anchors（可选外部锚，仅当原文明确写出：paperPricePerTon 纸价元/吨、laborRatePerPiece 工价元/个、plateCost 制版费元、financeTotal 财务合计元）

输出格式：{"input":{...}, "actualTotal": number|null, "anchors": {...}|null}`;

  const userContent: LlmMessage["content"] =
    kind === "image"
      ? [
          { type: "text", text: "请提取这张报价单中的字段：" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${imageBase64 ?? ""}` },
          },
        ]
      : [{ type: "text", text: text || "" }];

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  try {
    const raw = await chatCompletion(messages, {
      settings: extractSettings,
      temperature: 0,
      timeoutMs: 60000,
    });
    const json = extractJsonObject(raw) as {
      input?: Record<string, unknown>;
      actualTotal?: number | null;
      anchors?: Record<string, unknown> | null;
    };
    return NextResponse.json({
      ok: true,
      productType,
      input: json.input ?? {},
      actualTotal: json.actualTotal ?? "",
      anchors: json.anchors ?? {},
      raw,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "AI 抽取失败：" + String(e) },
      { status: 502 }
    );
  }
}
