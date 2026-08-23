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
  // —— mock LLM 服务：模拟一个"爱编造"的 LLM ——
  // 无论用户说什么，都返回一组完整参数（材质/克重/印刷/色数/专色/表面处理）。
  // 测试目的就是验证 sanitize 的文本审计能否把无证据的编造字段丢回 defaults。
  const buildContent = (userText: string) => {
    const hasGrammage = /350\s*(?:g|克|gsm)/i.test(userText);
    const hasMaterial = /铜版/.test(userText);
    const hasColor = /四色|4色|4\s*色/.test(userText);
    return JSON.stringify({
      boxType: "rigid_cover",
      material: hasMaterial ? "coated_paper" : "white_card",
      grammage: hasGrammage ? "350" : "300",
      quantity: 3000,
      printMethod: "digital",
      colorCount: hasColor ? "4" : "4",
      spotColorCount: 1,
      surfaceTreatment: "gloss_laminate",
      needGluing: true,
    });
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

  console.log("\n## 全字段审计：LLM 编造的材质/印刷/色数/专色/表面处理在无证据时应归默认");
  const rAudit = await parseNaturalLanguage(
    "我要做 3000 个海鲜礼盒，要防水，高级一点天地盖",
    asAi({ provider: "ollama", baseUrl, modelName: "mock-llm" })
  );
  const auditDefaulted = new Set(rAudit.defaults.map((d) => d.field));
  assert(rAudit.input.boxType === "rigid_cover" && !auditDefaulted.has("boxType"), "文本含「天地盖」→ boxType 为已识别");
  assert(rAudit.input.quantity === 3000 && !auditDefaulted.has("quantity"), "文本含 3000 个 → 数量为已识别");
  assert(auditDefaulted.has("material"), "文本未提材质 → LLM 编造的材质被丢回默认组");
  assert(auditDefaulted.has("printMethod"), "文本未提印刷方式 → LLM 编造的数码印刷被丢回默认组");
  assert(auditDefaulted.has("colorCount"), "文本未提色数 → LLM 编造的四色被丢回默认组");
  assert(auditDefaulted.has("spotColorCount"), "文本未提专色 → LLM 编造的专色被丢回默认组");
  assert(auditDefaulted.has("surfaceTreatment"), "文本只提防水 → 表面处理由系统推断为哑膜并归入默认组");

  console.log("\n## 全字段审计：文本有材质/色数证据时 LLM 提取值被接受");
  const rAudit2 = await parseNaturalLanguage(
    "我要做 3000 个铜版纸礼盒，四色印刷，350g，天地盖",
    asAi({ provider: "ollama", baseUrl, modelName: "mock-llm" })
  );
  const auditDefaulted2 = new Set(rAudit2.defaults.map((d) => d.field));
  assert(!auditDefaulted2.has("material"), "文本含「铜版纸」→ 材质被识别，不进默认");
  assert(rAudit2.input.material === "coated_paper", "文本含「铜版纸」→ 材质识别为铜版纸");
  assert(!auditDefaulted2.has("colorCount"), "文本含「四色」→ CMYK 色数被识别，不进默认");
  assert(!auditDefaulted2.has("grammage"), "文本含「350g」→ 克重被识别，不进默认");
  assert(auditDefaulted2.has("printMethod"), "文本未提印刷方式 → 仍归默认");

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
