/**
 * 前端主流程交互走查：新建分析向导 → 选品类 → 进入表单
 * ----------------------------------------------------------------
 * 用无头 Chrome + CDP 模拟真实用户点击流，验证：
 *   1. 工作台「新建成本分析」能打开品类选择弹窗
 *   2. 选择品类后进入步骤 1（上传资料）
 *   3. 点「下一步」能进入步骤 2 表单，且不崩、无 console 错误
 *
 * 这是最易出 hidden bug 的交互链路之一：状态切换、弹窗、步骤条、表单渲染。
 * 报告生成后的渲染由 verify-frontend-report.ts 覆盖。
 *
 * 用法：npm run test:frontend-flow   （需 dev server 在跑）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import fsp from "fs/promises";
import { releaseStalePort } from "./lib/cdp-port";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9337);

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

async function evalExpr(cdp: Cdp, sid: string, expr: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
  return r.result?.value;
}

/** 等待含指定文案的按钮出现在 DOM 中（弹窗/步骤切换后 React 需要时间挂载事件） */
async function waitForButton(cdp: Cdp, sid: string, text: string, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await evalExpr(
      cdp,
      sid,
      `Array.from(document.querySelectorAll('button')).filter(b => (b.innerText||'').includes(${JSON.stringify(text)})).length`
    );
    if (typeof n === "number" && n > 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * 取 AI 副驾驶输入框的 disabled 状态。
 * 页面上有多个 textarea（步骤 2 的自然语言解析框也在），必须按 placeholder 精确识别，
 * 取 document.querySelector('textarea') 第一个会命中表单框，断言就假通过了。
 */
async function chatTextareaDisabled(cdp: Cdp, sid: string): Promise<boolean | null> {
  const r = await evalExpr(
    cdp,
    sid,
    `(() => {
      const el = Array.from(document.querySelectorAll('textarea')).find((t) => {
        const p = t.placeholder || '';
        return p.startsWith('问点什么') || p.startsWith('AI 离线');
      });
      return el ? el.disabled : null;
    })()`,
  );
  return typeof r === "boolean" ? r : null;
}

async function waitForText(cdp: Cdp, sid: string, substr: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const text = await evalExpr(cdp, sid, `(document.body ? document.body.innerText : '').slice(0,3000)`);
    if (String(text ?? "").includes(substr)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("⚠️  未找到 Chrome，跳过前端交互走查");
    return;
  }
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdp-flow-"));
  await releaseStalePort(PORT);
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
  let pass = 0;
  let fail = 0;
  let exitCode = 0;

  function check(name: string, cond: boolean, detail = "") {
    if (cond) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`);
    }
  }

  try {
    await waitForDevtools();
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const cdp = new Cdp();
    await cdp.connect(ver.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    cdp.listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        issues.push({ kind: "exception", text: String(d.exception?.description ?? d.text).split("\n")[0] });
      } else if (m.method === "Runtime.consoleAPICalled") {
        const t = m.params.type;
        if (t === "error" || t === "warning") {
          const text = (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ");
          if (!BENIGN.some((re) => re.test(text))) issues.push({ kind: t, text: String(text).slice(0, 240) });
        }
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        if (e.level === "error" && !BENIGN.some((re) => re.test(e.text ?? ""))) {
          issues.push({ kind: "server-log", text: String(e.text ?? "").slice(0, 240) });
        }
      }
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);

    // 1. 打开工作台
    await cdp.send("Page.navigate", { url: `${BASE}/work` }, sessionId);
    await waitForText(cdp, sessionId, "新建成本分析", 20000);
    // 等待 React hydration 完成、按钮可交互
    await new Promise((r) => setTimeout(r, 3000));

    // 2. 点「新建成本分析」
    await evalExpr(cdp, sessionId, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => (b.innerText||'').includes('新建成本分析'));
        if (!btns.length) return 'no btn';
        btns[0].click();
        return 'clicked';
      })()
    `);
    await new Promise((r) => setTimeout(r, 2500));

    // 3. 品类选择弹窗出现
    const categoryShown = await waitForText(cdp, sessionId, "选择品类，开始新的成本分析", 8000);
    check("品类选择弹窗出现", categoryShown);

    // 4. 选「彩印纸盒」（等品类卡片按钮挂载完成再点）
    await waitForButton(cdp, sessionId, "彩印纸盒", 8000);
    await new Promise((r) => setTimeout(r, 500));
    await evalExpr(cdp, sessionId, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => (b.innerText||'').includes('彩印纸盒'));
        if (!btns.length) return 'no category';
        btns[0].click();
        return 'clicked category';
      })()
    `);
    await new Promise((r) => setTimeout(r, 1500));
    await waitForText(cdp, sessionId, "步骤 1", 10000);
    check("进入步骤 1（上传资料）", await waitForText(cdp, sessionId, "上传设计图纸与产品照片", 3000));

    // 5. 点「下一步」到步骤 2（等按钮挂载完成再点）
    await waitForButton(cdp, sessionId, "下一步", 8000);
    await new Promise((r) => setTimeout(r, 500));
    await evalExpr(cdp, sessionId, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => (b.innerText||'').trim() === '下一步');
        if (!btns.length) return 'no next';
        btns[0].click();
        return 'next';
      })()
    `);
    await new Promise((r) => setTimeout(r, 3000));

    // 6. 步骤 2 表单出现
    const step2Shown = await waitForText(cdp, sessionId, "补充产品关键信息", 8000);
    check("进入步骤 2 表单", step2Shown);

    // 7. 步骤 2 里有 NLP 解析入口和必填字段
    const hasNlp = await evalExpr(cdp, sessionId, `document.body.innerText.includes('智能解析')`);
    const hasGenerate = await evalExpr(cdp, sessionId, `document.body.innerText.includes('生成报告')`);
    check("步骤 2 有智能解析入口", hasNlp === true);
    check("步骤 2 有生成报告按钮", hasGenerate === true);

    // 8. 右栏「AI 结构化产出」面板随工作页出现
    check("右栏 AI 结构化产出面板存在", await waitForText(cdp, sessionId, "AI 结构化产出", 5000));

    // 9. 中栏 AI 副驾驶必须给出确定状态：离线占位 或 可提问建议，二者必居其一
    const aiState = await evalExpr(
      cdp,
      sessionId,
      `(() => {
        const t = document.body.innerText;
        return {
          offline: t.includes('AI 副驾驶离线'),
          ready: t.includes('问点什么') || t.includes('试试'),
        };
      })()`,
    );
    const st = (aiState ?? {}) as { offline?: boolean; ready?: boolean };
    check("AI 副驾驶给出确定状态（离线占位或可提问）", st.offline === true || st.ready === true);

    // 10. 离线时输入框必须禁用（不能让用户点了发送才报错）
    if (st.offline === true) {
      check("离线态输入框已禁用", (await chatTextareaDisabled(cdp, sessionId)) === true);
    } else {
      console.log("  · AI 在线，跳过离线禁用断言");
    }

    // 11. 离线降级独立场景：注入 disabled 配置，必须显式占位 + 输入框禁用，
    //     而不是等用户点完发送才弹一条 ⚠️。不依赖本机 LM Studio 是否在跑。
    await evalExpr(
      cdp,
      sessionId,
      `localStorage.setItem('ai_settings', JSON.stringify({ provider: 'disabled' }))`,
    );
    await cdp.send("Page.navigate", { url: `${BASE}/work?product=color_print_box` }, sessionId);
    await waitForText(cdp, sessionId, "AI 副驾驶", 20000);
    await new Promise((r) => setTimeout(r, 3000));
    check(
      "离线降级：显示「AI 副驾驶离线」占位",
      await waitForText(cdp, sessionId, "AI 副驾驶离线", 10000),
    );
    check("离线降级：输入框禁用", (await chatTextareaDisabled(cdp, sessionId)) === true);
    await evalExpr(cdp, sessionId, `localStorage.removeItem('ai_settings')`);

    // 12. 右栏产出分桶回归：切工作页不串味、切回能恢复。
    //     以前是「切换即清空」，切走再切回右栏凭空变空，而中栏对话还在 —— 口径不一致。
    //     这里注入种子产出，只验证归属与恢复，不依赖真实 AI 对话（避免 27B 慢查询拖垮测试）。
    const SEED_KEY = "ai_artifact:analyze:color_print_box";
    const seedArtifact = {
      hints: ["ZZ分桶测试提示"],
      strategies: [],
      effects: [],
      results: [],
      updatedAt: Date.now(),
      round: 3,
      sourceLabel: "当前成本分析",
    };
    await evalExpr(
      cdp,
      sessionId,
      `localStorage.setItem(${JSON.stringify(SEED_KEY)}, ${JSON.stringify(JSON.stringify(seedArtifact))})`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/work?product=color_print_box` }, sessionId);
    await waitForText(cdp, sessionId, "AI 结构化产出", 20000);
    await new Promise((r) => setTimeout(r, 2500));
    check(
      "产出归属：彩盒工作页载入自己的产出",
      await waitForText(cdp, sessionId, "ZZ分桶测试提示", 6000),
    );
    check("产出标注轮次「第 3 轮」", await waitForText(cdp, sessionId, "第 3 轮", 3000));

    await cdp.send("Page.navigate", { url: `${BASE}/work?product=corrugated_box` }, sessionId);
    await waitForText(cdp, sessionId, "AI 结构化产出", 20000);
    await new Promise((r) => setTimeout(r, 2500));
    const leaked = await evalExpr(cdp, sessionId, `document.body.innerText.includes('ZZ分桶测试提示')`);
    check("产出不串味：瓦楞工作页看不到彩盒的产出", leaked === false);

    await cdp.send("Page.navigate", { url: `${BASE}/work?product=color_print_box` }, sessionId);
    await waitForText(cdp, sessionId, "AI 结构化产出", 20000);
    await new Promise((r) => setTimeout(r, 2500));
    check(
      "产出可恢复：切回彩盒工作页产出仍在",
      await waitForText(cdp, sessionId, "ZZ分桶测试提示", 6000),
    );

    await evalExpr(cdp, sessionId, `localStorage.removeItem(${JSON.stringify(SEED_KEY)})`);

    const hard = issues.filter((i) => i.kind !== "console.warning");
    console.log(`\n=== 前端交互向导走查：${pass} 通过 / ${fail} 失败，console 错误 ${hard.length} ===`);
    if (hard.length) {
      console.log("异常/错误：");
      hard.forEach((i) => console.log(`  [${i.kind}] ${i.text}`));
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const shotPath = `/tmp/frontend-flow-step2.png`;
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("  截图:", shotPath);

    cdp.close();
    // 注意：不要在这里 process.exit —— 会跳过 finally 里的收尾清理，
    // 把脏端口留给下一轮（下一轮会连上僵尸 Chrome，点击全部静默失效）
    exitCode = fail || hard.length ? 1 : 0;
  } finally {
    proc.kill("SIGKILL");
    await releaseStalePort(PORT, true).catch(() => {});
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
