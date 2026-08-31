/**
 * 端到端报告渲染走查（HTTP + CDP 浏览器）
 * ----------------------------------------------------------------
 * 1. 创建 session → 2. 写入输入 → 3. 跑分析 → 4. 生成分享链接 →
 * 5. 用无头 Chrome 打开分享页，捕获 console 错误，断言报告正文出现。
 *
 * 这条链路覆盖：成本引擎 + 数据库存储 + 分享 token + 前端报告页渲染。
 *
 * 用法：npm run test:frontend-report   （BASE 默认 http://localhost:3000）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import fsp from "fs/promises";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9334);

const BOX_INPUT = {
  quantity: 5000,
  length: 200,
  width: 150,
  height: 80,
  material: "white_card",
  grammage: 350,
  boxType: "tuck_end",
  printMethod: "offset",
  colorCount: 4,
  spotColorCount: 0,
  surfaceTreatment: "matte_laminate",
  needGluing: true,
  deliveryLocation: "east_china",
  provideReadyDesign: false,
};

const BENIGN = [
  /Download the React DevTools/i,
  /Fast Refresh/i,
  /\[HMR\]/i,
  /third-party cookie/i,
  /Autofill/i,
  /favicon/i,
];

function findChrome(): string | null {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => fs.existsSync(p)) ?? null;
}

async function waitForDevtools(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome devtools 未就绪");
}

class Cdp {
  ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  listeners: ((m: any) => void)[] = [];
  async connect(url: string) {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error("WS 失败: " + String(e)));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else {
        this.listeners.forEach((l) => l(m));
      }
    };
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 120000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* */
    }
  }
}

async function j(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { __raw: t.slice(0, 200) };
  }
}

async function main() {
  // 1. 创建会话
  const r0 = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productType: "color_print_box" }),
  });
  const session = await j(r0);
  const sid = session.sessionId ?? session.id;
  if (!sid) throw new Error("未拿到 sessionId");
  console.log(`  session=${sid}`);

  // 2. 写入输入
  const r1 = await fetch(`${BASE}/api/sessions/${sid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputData: BOX_INPUT }),
  });
  if (!r1.ok) throw new Error("PATCH 输入失败: " + JSON.stringify(await j(r1)));

  // 3. 跑分析（POST 到 /api/sessions/<id>）
  console.log("  跑成本引擎…");
  const r2 = await fetch(`${BASE}/api/sessions/${sid}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const analyzed = await j(r2);
  if (!r2.ok || !analyzed.report) throw new Error("分析失败: " + JSON.stringify(analyzed).slice(0, 300));
  console.log(`  总成本 ${analyzed.report.totalCost.min.toFixed(3)}–${analyzed.report.totalCost.max.toFixed(3)} ${analyzed.report.totalCost.unit}`);

  // 4. 生成分享链接
  const r3 = await fetch(`${BASE}/api/sessions/${sid}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresInDays: 1 }),
  });
  const shared = await j(r3);
  const token = shared.token;
  if (!token) throw new Error("分享 token 生成失败: " + JSON.stringify(shared));
  console.log(`  share token=${token}`);

  // 5. 浏览器打开分享页
  const chrome = findChrome();
  if (!chrome) {
    console.log("⚠️  未找到 Chrome，跳过浏览器渲染检查");
    return;
  }
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdp-report-"));
  const proc: ChildProcess = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDir}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const issues: { kind: string; text: string }[] = [];
  try {
    await waitForDevtools();
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const cdp = new Cdp();
    await cdp.connect(ver.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    const onMsg = (m: any) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        issues.push({ kind: "exception", text: String(d.exception?.description ?? d.text).split("\n")[0] });
      } else if (m.method === "Runtime.consoleAPICalled") {
        if (m.params.type === "error" || m.params.type === "warning") {
          const text = (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ");
          if (!BENIGN.some((re) => re.test(text))) {
            issues.push({ kind: m.params.type, text: String(text).slice(0, 240) });
          }
        }
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        if (e.level === "error" && !BENIGN.some((re) => re.test(e.text ?? ""))) {
          issues.push({ kind: "server-log", text: String(e.text ?? "").slice(0, 240) });
        }
      }
    };
    cdp.listeners.push(onMsg);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);

    const loaded = new Promise<void>((res) => {
      const l = (m: any) => {
        if (m.sessionId === sessionId && m.method === "Page.loadEventFired") {
          cdp.listeners = cdp.listeners.filter((x) => x !== l);
          res();
        }
      };
      cdp.listeners.push(l);
      setTimeout(res, 90000);
    });

    await cdp.send("Page.navigate", { url: `${BASE}/share/${token}` }, sessionId);
    await loaded;
    await new Promise((r) => setTimeout(r, 4000));

    const ev = await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({title: document.title, text: (document.body ? document.body.innerText : '').slice(0,5000)})",
        returnByValue: true,
      },
      sessionId
    );
    const snap = JSON.parse(ev.result?.value ?? "{}");
    const text = snap.text ?? "";

    const must = ["总成本", "材料成本", "人工成本", "加工费", "设计与制版成本", "财务与其他成本"];
    const missing = must.filter((c) => !text.includes(c));
    const hard = issues.filter((i) => i.kind !== "console.warning");

    console.log(`  页面文本 ${text.length} 字，标题「${snap.title}」，console 错误 ${hard.length}`);
    console.log(`\n=== 结果：${hard.length === 0 && missing.length === 0 ? "通过" : "失败"} ===`);
    if (missing.length) console.log("缺文案：", missing.join(", "));
    if (hard.length) {
      console.log("异常/错误：");
      hard.forEach((i) => console.log(`  [${i.kind}] ${i.text}`));
    }

    // 顺手截个图
    await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId).then((res: any) => {
      const p = `/tmp/share-report-${token}.png`;
      fs.writeFileSync(p, Buffer.from(res.data, "base64"));
      console.log("  截图:", p);
    });

    cdp.close();
    process.exit(hard.length || missing.length ? 1 : 0);
  } finally {
    proc.kill("SIGKILL");
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
