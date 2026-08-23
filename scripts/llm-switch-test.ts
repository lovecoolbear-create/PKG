import http from "node:http";
import { isLlmConfigured } from "@/lib/llm/client";
import { parseNaturalLanguage } from "@/lib/agents/nlp-parser";
import type { AiSettings } from "@/lib/config/ai-settings";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL  ${msg}`);
  }
}
const asAi = (o: Record<string, string>) => o as unknown as AiSettings;

async function main() {
  // —— mock LLM 服务：根据请求文本动态返回可被 sanitize 解析的结构化 JSON ——
  // 行为模拟两种 LLM 现实：
  //  A) 文本明确提到 "350g" 时，返回 grammage=350（正确提取）
  //  B) 文本未提克重时，LLM 仍瞎填 grammage=300（模拟用户报告的「总是 350」类编造）
  const buildContent = (userText: string) => {
    const obj: Record<string, unknown> = {
      boxType: "rigid_cover",
      material: "white_card",
      quantity: 3000,
      surfaceTreatment: "matte_laminate",
      needGluing: true,
    };
    if (/350\s*(?:g|克|gsm)/i.test(userText)) {
      obj.grammage = "350"; // 文本真有克重 → 正确提取
    } else {
      obj.grammage = "300"; // 文本无克重 → 模拟 LLM 编造
    }
    return JSON.stringify(obj);
  };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let userText = "";
        try {
          const parsed = JSON.parse(body);
          const msgs = parsed?.messages ?? [];
          userText = (msgs.find((m: any) => m.role === "user")?.content ?? "").toString();
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: buildContent(userText) } }] }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const text = "我要做 3000 个海鲜礼盒，要防水，高级一点天地盖";

  console.log("## 单元层：isLlmConfigured 对 aiSettings 的识别");
  assert(
    isLlmConfigured(asAi({ provider: "ollama", baseUrl: "http://x:11434", modelName: "qwen2.5" })) === true,
    "本地 Ollama 有 baseUrl => 已配置（bug 防回归核心）"
  );
  assert(
    isLlmConfigured(asAi({ provider: "ollama", baseUrl: "", modelName: "" })) === false,
    "本地 Ollama 无 baseUrl => 未配置"
  );
  assert(isLlmConfigured(asAi({ provider: "disabled" })) === false, "disabled => 未配置");
  assert(
    isLlmConfigured(asAi({ provider: "openai-compatible", apiKey: "sk-x", baseUrl: "https://api.openai.com/v1", modelName: "gpt-4o-mini" })) === true,
    "openai 有 key => 已配置"
  );
  assert(isLlmConfigured() === false, "无参且无 env => 未配置");

  console.log("\n## 集成层：parseNaturalLanguage 双向行为");
  const r1 = await parseNaturalLanguage(text, asAi({ provider: "ollama", baseUrl, modelName: "mock-llm" }));
  assert(r1.source === "llm", "正向：传入本地 Ollama 配置 => 真正调用 LLM 且 source=llm");
  assert(
    r1.input.boxType === "rigid_cover" && Number(r1.input.quantity) === 3000,
    "正向：LLM 解析结果进入结构化入参（天地盖 / 3000）"
  );
  assert(!!r1.note && r1.note.includes("大模型已解析"), "正向：备注为「大模型已解析」文案");

  console.log("\n## 克重审计：未提及克重时 LLM 编造必须被丢弃");
  const rFake = await parseNaturalLanguage(
    "我要做 3000 个海鲜礼盒，要防水，高级一点天地盖",
    asAi({ provider: "ollama", baseUrl, modelName: "mock-llm" })
  );
  const fakeDefaulted = new Set(rFake.defaults.map((d) => d.field));
  assert(rFake.input.grammage === "350", "文本无克重 → LLM 编造的 300 被丢弃，克重回落系统默认 350");
  assert(
    fakeDefaulted.has("grammage"),
    "文本无克重 → 克重出现在「系统默认」而非「已识别」（避免误导为 LLM 推断）"
  );

  console.log("\n## 克重审计：文本明确提及克重时被正确识别");
  const rReal = await parseNaturalLanguage(
    "我要做 3000 个海鲜礼盒，350g，要防水，高级一点天地盖",
    asAi({ provider: "ollama", baseUrl, modelName: "mock-llm" })
  );
  const realDefaulted = new Set(rReal.defaults.map((d) => d.field));
  assert(rReal.input.grammage === "350", "文本含 350g → 克重被识别为 350");
  assert(
    !realDefaulted.has("grammage"),
    "文本含 350g → 克重属于「已识别」参数，不列入系统默认"
  );

  const r2 = await parseNaturalLanguage(text, undefined);
  assert(r2.source === "rule", "回退：无配置 => source=rule（关键词规则解析）");
  assert(r2.input.boxType === "rigid_cover", "回退：关键词仍解析出 天地盖/高级 => rigid_cover");
  assert(r2.input.surfaceTreatment === "matte_laminate", "回退：防水 => 哑膜（matte_laminate）");

  const r3 = await parseNaturalLanguage(text, asAi({ provider: "disabled" }));
  assert(r3.source === "rule", "回退：disabled => source=rule");

  server.close();
  console.log(`\n结果：${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
