/**
 * 打印 PDF 验证（浏览器打印路径）
 * ----------------------------------------------------------------
 * 旧 jsPDF 方案导出的 PDF 中文乱码，已改为浏览器 window.print() + print CSS。
 * 本脚本用 Chrome headless 的 print-to-pdf 走完整链路，再用 pdfjs 提取文本，
 * 确保中文可正常复制/检索。
 *
 * 前置：
 *  - dev server 已起在 SHOT or 传入 SHARE_URL
 *  - 本机有 Google Chrome（macOS）或可执行文件在 CHROME_BIN
 *
 * 用法：
 *   SHARE_URL=http://localhost:3000/share/xxx npx tsx scripts/verify-print-pdf.ts
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

pdfjs.GlobalWorkerOptions.workerSrc = path.join(
  process.cwd(),
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
);

const SHARE_URL =
  process.env.SHARE_URL || "http://localhost:3000/share/qCY42OXMAW2I9YDQ";

function findChrome(): string | null {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates =
    os.platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function printToPdf(url: string, out: string): Promise<void> {
  const chrome = findChrome();
  if (!chrome) throw new Error("未找到 Google Chrome，请设置 CHROME_BIN");
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=5000",
      `--print-to-pdf=${out}`,
      url,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
        reject(new Error(`Chrome 打印失败 code=${code}: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function extractText(pdfPath: string): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= Math.min(2, doc.numPages); i++) {
    const page = await doc.getPage(i);
    const text = await page.getTextContent();
    parts.push(
      text.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
    );
  }
  return parts.join("\n");
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`);
  }
}

async function main() {
  console.log("=== 打印 PDF 验证 ===");
  console.log(`  页面: ${SHARE_URL}\n`);

  const out = path.join(os.tmpdir(), `cost-print-verify-${Date.now()}.pdf`);
  await printToPdf(SHARE_URL, out);
  console.log(`  → PDF 已生成: ${out} (${fs.statSync(out).size} bytes)`);

  const text = await extractText(out);
  check("提取到中文文本", /成本分析报告/.test(text), "");
  check("免责声明中文正常", /本结果为估算，仅供参考，最终以正式报价为准/.test(text), "");
  check("金额数字正常", /¥\s*[\d,]+/.test(text), "");
  check("单位「只」正常", /单只价格区间|只/.test(text), "");
  check("五维维度名存在", /材料|加工|人工|设计|商业/.test(text), "");

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("脚本异常：", e.message || e);
  process.exit(1);
});
