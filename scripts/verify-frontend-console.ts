/**
 * 前端主流程浏览器走查（需 dev server 在跑）
 * ----------------------------------------------------------------
 * 用本机 Chrome + CDP（零依赖，Node 22 自带 WebSocket）逐条路由做三件事：
 *   1. 页面是否真的渲染出内容（不是白屏 / 不是 Next 错误边界 / 不是 Application error）
 *   2. 有没有未捕获异常（Runtime.exceptionThrown）
 *   3. 有没有 console.error / 服务端报错日志
 *
 * 引擎测试和 API 测试都碰不到浏览器侧：水合失败、客户端组件抛错、
 * undefined 读属性、图标组件报错……这些只在真实渲染时才会暴露。
 *
 * 用法：npm run test:frontend   （BASE 默认 http://localhost:3000）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import fsp from "fs/promises";
import { releaseStalePort } from "./lib/cdp-port";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9333);

interface RouteCase {
  path: string;
  /** 页面必须出现的关键文案（证明渲染的是该页面本身，而不是空壳/错误边界） */
  mustContain: string[];
  /** 该路由预期会打到 404 的接口（如失效分享 token），不算缺陷 */
  allowApi404?: boolean;
  note?: string;
}

const ROUTES: RouteCase[] = [
  { path: "/", mustContain: ["成本"], note: "首页介绍" },
  { path: "/work", mustContain: ["工作台", "成本"], note: "三栏工作台" },
  { path: "/analyze", mustContain: ["成本"], note: "单品分析" },
  { path: "/vave", mustContain: ["VAVE", "降本"], note: "VAVE 分析" },
  { path: "/batch", mustContain: ["批量"], note: "批量导入" },
  { path: "/ai", mustContain: ["AI"], note: "AI 工作台" },
  { path: "/import/compare", mustContain: ["没有可对比的导入结果"], note: "无数据的空态是设计如此" },
  { path: "/calibration-intake", mustContain: ["报价"], note: "报价单录入" },
  { path: "/admin/formula", mustContain: ["公式"], note: "fail-closed，可能显示未授权" },
  { path: "/admin/knowledge", mustContain: ["知识"], note: "fail-open，本地可访问" },
  { path: "/intro", mustContain: ["成本", "AI"], note: "载入页" },
  {
    path: "/share/definitely-not-a-real-token",
    mustContain: ["返回首页"],
    allowApi404: true,
    note: "失效链接：应给友好错误态而非白屏",
  },
];

/** Next 开发态噪声，不算缺陷 */
const BENIGN = [
  /Download the React DevTools/i,
  /Fast Refresh/i,
  /\[HMR\]/i,
  /third-party cookie/i,
  /Autofill/i,
  /favicon/i,
  /Download the Apollo/i,
];

interface Issue {
  route: string;
  kind: "exception" | "console.error" | "console.warning" | "server-log";
  text: string;
}

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
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome devtools 端口未就绪");
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
      this.ws.onerror = (e) => rej(new Error("WebSocket 连接失败: " + String(e)));
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
      /* ignore */
    }
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("⚠️  未找到 Chrome，跳过前端走查（可设置 CHROME_BIN）");
    return;
  }
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdp-"));
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

  const issues: Issue[] = [];
  let pass = 0;
  let fail = 0;
  const renderFails: string[] = [];

  try {
    await waitForDevtools();
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const cdp = new Cdp();
    await cdp.connect(ver.webSocketDebuggerUrl);

    for (const route of ROUTES) {
      const url = BASE + route.path;
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

      const local: Issue[] = [];
      const onMsg = (m: any) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === "Runtime.exceptionThrown") {
          const d = m.params.exceptionDetails;
          const text = d.exception?.description ?? d.text ?? "未知异常";
          local.push({ route: route.path, kind: "exception", text: String(text).split("\n")[0] });
        } else if (m.method === "Runtime.consoleAPICalled") {
          const type = m.params.type;
          if (type !== "error" && type !== "warning") return;
          const text = (m.params.args ?? [])
            .map((a: any) => a.value ?? a.description ?? a.type)
            .join(" ");
          if (BENIGN.some((re) => re.test(text))) return;
          local.push({
            route: route.path,
            kind: type === "error" ? "console.error" : "console.warning",
            text: String(text).slice(0, 240),
          });
        } else if (m.method === "Log.entryAdded") {
          const e = m.params.entry;
          if (e.level === "error") {
            if (BENIGN.some((re) => re.test(e.text ?? ""))) return;
            local.push({
              route: route.path,
              kind: "server-log",
              text: `${e.url ? e.url + " " : ""}${String(e.text).slice(0, 200)}`,
            });
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
        setTimeout(res, 90000); // Next dev 首次编译可能很慢，兜底继续
      });

      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      await new Promise((r) => setTimeout(r, 2500)); // 等客户端水合与副作用

      const ev = await cdp.send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({title: document.title, text: (document.body ? document.body.innerText : '').slice(0,4000)})",
          returnByValue: true,
        },
        sessionId
      );
      let snap: { title: string; text: string } = { title: "", text: "" };
      try {
        snap = JSON.parse(ev.result?.value ?? "{}");
      } catch {
        /* ignore */
      }
      const text = snap.text ?? "";
      // 真正的坏页判据：Next 错误边界 / 应用崩溃 / 落到 Next 内置 404（title 会变）
      const crashed =
        /Application error|Unhandled Runtime Error|Internal Server Error/i.test(text) ||
        /could not be found/i.test(snap.title ?? "");
      const missingCopy = route.mustContain.filter((c) => !text.includes(c));
      // 空态、错误态、未授权态都是合法渲染，只看是否崩溃 + 是否渲染出本页关键文案
      const contentOk = !crashed && missingCopy.length === 0;
      const hardLocal = local.filter((i) => i.kind !== "console.warning");
      const realIssues = route.allowApi404
        ? hardLocal.filter((i) => !/404/.test(i.text))
        : hardLocal;
      const routeOk = contentOk && realIssues.length === 0;

      if (routeOk) pass++;
      else fail++;
      if (!contentOk) renderFails.push(`${route.path}${crashed ? "(崩溃)" : ""}${missingCopy.length ? " 缺文案:" + missingCopy.join("/") : ""}`);
      // 允许「预期内的接口 404」（如失效分享 token）不进缺陷清单
      issues.push(...local.filter((i) => i.kind === "console.warning" || realIssues.includes(i)));

      console.log(
        `${routeOk ? "  ✓" : "  ✗"} ${route.path.padEnd(38)} 文本${String(text.length).padStart(5)}字  错误${realIssues.length} 警告${local.filter((i) => i.kind === "console.warning").length}${route.note ? "  (" + route.note + ")" : ""}`
      );

      cdp.listeners = cdp.listeners.filter((l) => l !== onMsg);
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }

    cdp.close();
  } finally {
    proc.kill("SIGKILL");
    await releaseStalePort(PORT, true).catch(() => {});
    await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n=== 前端走查：${pass} 通过 / ${fail} 失败（路由 ${ROUTES.length} 条）===`);
  const hard = issues.filter((i) => i.kind !== "console.warning");
  const warn = issues.filter((i) => i.kind === "console.warning");
  if (hard.length) {
    console.log("\n❌ 缺陷（异常 / console.error / 服务端错误）：");
    hard.forEach((i) => console.log(`   [${i.kind}] ${i.route}\n      ${i.text}`));
  }
  if (warn.length) {
    console.log("\n⚠️  警告（不阻断，建议处理）：");
    warn.slice(0, 20).forEach((i) => console.log(`   ${i.route}\n      ${i.text}`));
    if (warn.length > 20) console.log(`   …… 另有 ${warn.length - 20} 条`);
  }
  if (renderFails.length) {
    console.log("\n渲染异常路由：" + [...new Set(renderFails)].join(", "));
  }
  process.exit(hard.length || renderFails.length ? 1 : 0);
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
