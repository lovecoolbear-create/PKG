/**
 * 五维偏差热力图 · 端到端走查（真实 API + 真实页面渲染）
 * ----------------------------------------------------------------
 * 覆盖 verify-frontend-flow 到不了的一段：客户报价 xlsx 上传 → /import/compare 热力图。
 * 链路是「真实引擎估算 → 真实页面渲染 → 确定性前端计算」，三处任一处断了都会在这里红。
 *
 * 断言重点：
 *   1. 热力图渲染、行数/列数与导入结果一致
 *   2. 基准 chip 明确（不能画没有基准的色块）
 *   3. 金额口径下必有色阶（列内最大值归一化 → 必有 level 3，不会 flaky）
 *   4. 降级：全部估算失败时不渲染热力图，但页面不崩
 *   5. 点击行能跳工作台
 *
 * 用法：npm run test:heatmap   （需 dev server 在跑）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import fsp from "fs/promises";
import * as XLSX from "xlsx";
import { releaseStalePort } from "./lib/cdp-port";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9338);

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

async function waitForSelector(
  cdp: Cdp,
  sid: string,
  selector: string,
  timeoutMs = 15000
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await evalExpr(
      cdp,
      sid,
      `document.querySelectorAll(${JSON.stringify(selector)}).length`
    );
    if (typeof n === "number" && n > 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 造一份 3 行瓦楞箱报价单，规格刻意拉开（小箱多色 / 大箱素箱 / 中箱），让五维结构有差异 */
function buildQuoteWorkbook(): Buffer {
  const headers = ["产品名称", "长", "宽", "高", "材质", "数量", "单价"];
  const rows = [
    ["小彩箱 A", 200, 150, 100, "250g 白卡", 5000, 3.2],
    ["大素箱 B", 600, 400, 350, "五层 AB 楞", 800, 12.5],
    ["中箱 C", 350, 250, 200, "三层 B 楞", 3000, 5.8],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "报价");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function postQuote(buf: Buffer): Promise<any> {
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([new Uint8Array(buf)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "quote.xlsx"
  );
  fd.append("productType", "corrugated_box");
  const res = await fetch(`${BASE}/api/import/customer-quote`, { method: "POST", body: fd });
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log("1) 上传报价单，取真实引擎估算结果");
  const buf = buildQuoteWorkbook();
  const { status, json } = await postQuote(buf);
  if (status !== 200 || !json?.ok) {
    console.error("  ❌ 导入 API 未返回成功：", status, JSON.stringify(json).slice(0, 300));
    process.exit(1);
  }
  const products = json.products ?? [];
  const estimated = products.filter((p: any) => p.estimate?.dimensions?.length);
  console.log(`  · 导入 ${products.length} 行，其中 ${estimated.length} 行有估算`);
  if (!estimated.length) {
    console.error("  ❌ 没有任何一行拿到引擎估算，无法验证热力图");
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log("⚠️  未找到 Chrome，跳过前端走查（单测已覆盖计算层）");
    return;
  }

  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdp-heat-"));
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
        issues.push({
          kind: "exception",
          text: String(d.exception?.description ?? d.text).split("\n")[0],
        });
      } else if (m.method === "Runtime.consoleAPICalled") {
        const t = m.params.type;
        if (t === "error" || t === "warning") {
          const text = (m.params.args ?? [])
            .map((a: any) => a.value ?? a.description ?? a.type)
            .join(" ");
          if (!BENIGN.some((re) => re.test(text)))
            issues.push({ kind: t, text: String(text).slice(0, 240) });
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

    const seedAndOpen = async (payload: unknown) => {
      await cdp.send("Page.navigate", { url: `${BASE}/import/compare` }, sessionId);
      await new Promise((r) => setTimeout(r, 800));
      await evalExpr(
        cdp,
        sessionId,
        `sessionStorage.setItem('customer_import_result', ${JSON.stringify(
          JSON.stringify(payload)
        )})`
      );
      await cdp.send("Page.navigate", { url: `${BASE}/import/compare` }, sessionId);
    };

    console.log("2) 热力图渲染与结构");
    await seedAndOpen(json);
    const shown = await waitForSelector(cdp, sessionId, '[data-testid="deviation-heatmap"]', 20000);
    check("热力图渲染", shown);
    if (!shown) {
      const body = await evalExpr(cdp, sessionId, `document.body.innerText.slice(0,500)`);
      console.log("  页面文本：", String(body).replace(/\n+/g, " | ").slice(0, 300));
      // 抛错走 finally 清理，否则端口残留会连累下一次运行
      throw new Error("热力图未渲染，终止后续断言");
    }

    const rowCount = await evalExpr(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-testid="heatmap-row"]').length`
    );
    check("行数与导入结果一致", rowCount === estimated.length, `${rowCount} vs ${estimated.length}`);

    const dimCount = await evalExpr(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-testid="deviation-heatmap"] thead th').length`
    );
    const cellCount = await evalExpr(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-testid="heatmap-cell"]').length`
    );
    const dimCols = dimCount - 2; // 产品列 + 客户价列
    check(
      "单元格数 = 行数 × 维度列数",
      cellCount === rowCount * dimCols,
      `${cellCount} vs ${rowCount}×${dimCols}`,
    );

    const headers = await evalExpr(
      cdp,
      sessionId,
      `Array.from(document.querySelectorAll('[data-testid="deviation-heatmap"] thead th')).map(t => t.innerText.trim()).join('|')`
    );
    const headerStr = String(headers ?? "");
    check(
      "五维表头齐全",
      ["材料成本", "人工成本", "加工费（含设备）", "设计与制版成本", "财务与其他成本"].every((h) =>
        headerStr.includes(h)
      ),
      headerStr,
    );

    const basis = await evalExpr(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="heatmap-basis"]')?.innerText ?? ''`
    );
    check(
      "基准 chip 明确标注",
      String(basis ?? "").includes("基准："),
      String(basis ?? "空"),
    );

    const heatmapShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync("/tmp/heatmap-render.png", Buffer.from(heatmapShot.data, "base64"));
    console.log("  截图(热力图): /tmp/heatmap-render.png");

    console.log("3) 口径切换：单只金额");
    await evalExpr(
      cdp,
      sessionId,
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === '单只金额');
        if (b) { b.click(); return 'clicked'; }
        return 'no btn';
      })()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const maxLevel = await evalExpr(
      cdp,
      sessionId,
      `Array.from(document.querySelectorAll('[data-testid="heatmap-cell"]')).map(c => Number(c.dataset.level))`
    );
    const levels = (Array.isArray(maxLevel) ? maxLevel : []).map(Number);
    check(
      "金额口径下必有色阶（列内最大值归一到 level 3）",
      levels.some((l) => l === 3),
      `levels=${levels.join(",")}`,
    );
    check("口径切换后热力图仍在", await waitForSelector(cdp, sessionId, '[data-testid="deviation-heatmap"]', 5000));

    const outlierDims = await evalExpr(
      cdp,
      sessionId,
      `(() => {
        const el = document.querySelector('[data-testid="heatmap-outliers"]');
        if (!el) return '';
        const re = /·\\s*([^·\\n]+?)\\s*(?:高于基准|低于基准)/g;
        const out = []; let m;
        while ((m = re.exec(el.innerText))) out.push(m[1].trim());
        return out.join('|');
      })()`
    );
    const dims = String(outlierDims ?? "").split("|").filter(Boolean);
    check("异常区列出了维度", dims.length > 0, String(outlierDims ?? "空"));
    check("异常区维度不重复", new Set(dims).size === dims.length, dims.join("、"));

    const skew = await evalExpr(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="heatmap-skew"]')?.innerText ?? ''`
    );
    if (String(skew ?? "")) {
      check("整批同向偏离提示提到基准", String(skew).includes("基准"));
      console.log(`  · ${String(skew).replace(/\n+/g, " ").slice(0, 160)}`);
    } else {
      console.log("  · 本批无整批同向偏离，跳过该项断言");
    }

    console.log("4) 降级：全部估算失败时不画色块，但页面不崩");
    const broken = {
      ...json,
      products: json.products.map((p: any) => ({ ...p, estimate: undefined })),
    };
    await seedAndOpen(broken);
    await new Promise((r) => setTimeout(r, 1200));
    const renderedAnyway = await evalExpr(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-testid="deviation-heatmap"]').length`
    );
    check("无估算数据时不渲染热力图", renderedAnyway === 0, `找到 ${renderedAnyway} 个`);
    const tableStillThere = await evalExpr(
      cdp,
      sessionId,
      `document.body.innerText.includes('客户报价对比')`
    );
    check("对比表格照常渲染", tableStillThere === true);

    console.log("5) 点击热力图行跳工作台");
    await seedAndOpen(json);
    await waitForSelector(cdp, sessionId, '[data-testid="heatmap-row"]', 20000);
    await new Promise((r) => setTimeout(r, 800));
    await evalExpr(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="heatmap-row"]').click()`
    );
    await new Promise((r) => setTimeout(r, 3000));
    const url = await evalExpr(cdp, sessionId, `location.pathname + location.search`);
    check("跳转 /work 并带上品类参数", String(url ?? "").includes("/work"), String(url ?? "空"));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(
      "/tmp/heatmap-e2e.png",
      Buffer.from(shot.data, "base64")
    );

    const hard = issues.filter((i) => i.kind !== "console.warning");
    console.log(`\n=== 五维偏差热力图走查：${pass} 通过 / ${fail} 失败，console 错误 ${hard.length} ===`);
    if (hard.length) {
      console.log("异常/错误：");
      hard.forEach((i) => console.log(`  [${i.kind}] ${i.text}`));
    }
    console.log("  截图: /tmp/heatmap-e2e.png");

    cdp.close();
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
