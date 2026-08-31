/**
 * API 数据链路端到端测试（需 dev server 在跑）
 * ----------------------------------------------------------------
 * 用真实 HTTP 打各条数据链路，验证「解析 / 批量 / 会话 / VAVE / 词典 / 校准 /
 * 分享 / 鉴权」这些引擎测试覆盖不到的链路，重点抓：
 *   - 500（未捕获异常）
 *   - 应 400 却 200（非法输入放行）
 *   - 应 401/403 却 200（鉴权失效）
 *   - 返回结构缺字段
 *
 * 用法：npm run test:api   （BASE 默认 http://localhost:3000）
 */
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import nodePath from "path";
import { spawn } from "child_process";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else {
    fail++;
    fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`);
}

async function j(fetchRes: Response): Promise<any> {
  const t = await fetchRes.text();
  try {
    return JSON.parse(t);
  } catch {
    return { __raw: t.slice(0, 200) };
  }
}

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
  provideReadyDesign: false,
  deliveryLocation: "east_china",
  targetDelivery: "standard",
};

async function main() {
  // ========== 1. NLP 解析（无 AI → 规则回退） ==========
  section("1. /api/parse 自然语言解析");
  {
    const r = await fetch(`${BASE}/api/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "做一个彩盒，200x150x80mm，350g白卡，5000个，四色印刷，覆哑膜",
        productType: "color_print_box",
      }),
    });
    const d = await j(r);
    check("解析返回 200", r.status === 200, `status=${r.status}`);
    check("解析出 input", !!d.input, JSON.stringify(d).slice(0, 120));
    // 注：productType 由前端已选品类决定，NLP 不返回；此处断言实际解析字段
    check("识别到数量", d.input?.quantity === 5000, String(d.input?.quantity));
    check("识别到三连尺寸 length", d.input?.length === 200, String(d.input?.length));
    console.log(`  qty=${d.input?.quantity} L×W×H=${d.input?.length}x${d.input?.width}x${d.input?.height} confidence=${d.confidence}`);
  }
  {
    const r = await fetch(`${BASE}/api/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    check("空文本应 400", r.status === 400, `status=${r.status}`);
  }

  // ========== 2. VAVE 分析 ==========
  section("2. /api/vave/analyze");
  {
    const r = await fetch(`${BASE}/api/vave/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productType: "color_print_box", input: BOX_INPUT }),
    });
    const d = await j(r);
    check("VAVE 分析返回 200", r.status === 200, `status=${r.status}`);
    check("返回 report 且五维齐全", d.report?.dimensions?.length === 5, String(d.report?.dimensions?.length));
    check("返回总价 > 0", (d.report?.totalCost?.max ?? 0) > 0, String(d.report?.totalCost?.max));
  }
  {
    const r = await fetch(`${BASE}/api/vave/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productType: "color_print_box" }),
    });
    check("缺 input 应 400", r.status === 400, `status=${r.status}`);
  }

  // ========== 3. 批量导入（xlsx） ==========
  section("3. /api/batch/analyze 批量导入");
  {
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const { buildTemplateHeaders, buildSampleRow } = await import("../src/lib/batch/template");
    const { getProductConfig } = await import("../src/config/products");
    const cfg = getProductConfig("color_print_box")!;
    const headers = buildTemplateHeaders(cfg);
    // 直接用「官方模板示例行」当基线：用户下载模板→照示例填→导入这条路径必须能跑通。
    // 若示例行自身都缺必填字段，等于模板开箱即坏。
    const sample = buildSampleRow(cfg);
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => (row[h] = sample[i] ?? ""));
    row[headers[0]] = "测试产品A";

    const ws = XLSX.utils.json_to_sheet([row]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "batch.xlsx");
    form.append("productType", "color_print_box");
    const r = await fetch(`${BASE}/api/batch/analyze`, { method: "POST", body: form });
    const d = await j(r);
    check("批量导入返回 200", r.status === 200, `status=${r.status}`);
    check("导入成功 1 行", d.ok === true && d.success === 1, JSON.stringify({ ok: d.ok, success: d.success, failed: d.failed, msg: d.message }));
    check("结果含报告", !!d.results?.[0]?.report?.totalCost?.max, JSON.stringify(d.results?.[0]?.report?.totalCost ?? {}));
    if (d.errors?.length) console.log("  行错误：", JSON.stringify(d.errors));
    console.log(`  total=${d.total} success=${d.success} failed=${d.failed}`);
  }
  // 4 个品类的「官方示例行」都必须能原样导入成功（模板开箱即用）
  {
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const { buildTemplateHeaders, buildSampleRow } = await import("../src/lib/batch/template");
    const { getProductConfig, getAllProductTypes } = await import("../src/config/products");
    for (const cfg of getAllProductTypes()) {
      const pt = cfg.code;
      const headers = buildTemplateHeaders(cfg);
      const sample = buildSampleRow(cfg);
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => (row[h] = sample[i] ?? ""));
      row[headers[0]] = `E2E-${pt}`;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([row]), "Sheet1");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "b.xlsx");
      form.append("productType", pt);
      const r = await fetch(`${BASE}/api/batch/analyze`, { method: "POST", body: form });
      const d = await j(r);
      check(
        `示例行可导入：${pt}`,
        d.ok === true && d.success === 1,
        JSON.stringify(d.errors ?? d.message ?? d).slice(0, 200)
      );
    }
    // 反向断言：名称含「示例」的行必须被跳过，不能混进分析结果
    const cfg = getAllProductTypes()[0];
    const headers = buildTemplateHeaders(cfg);
    const sample = buildSampleRow(cfg);
    const onlySample: Record<string, unknown> = {};
    headers.forEach((h, i) => (onlySample[h] = sample[i] ?? ""));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([onlySample]), "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "s.xlsx");
    form.append("productType", cfg.code);
    const r = await fetch(`${BASE}/api/batch/analyze`, { method: "POST", body: form });
    const d = await j(r);
    check(
      "示例行被跳过不进分析",
      d.ok === false && String(d.message ?? "").includes("未找到有效数据行"),
      JSON.stringify(d).slice(0, 160)
    );
  }
  {
    const form = new FormData();
    form.append("productType", "color_print_box");
    const r = await fetch(`${BASE}/api/batch/analyze`, { method: "POST", body: form });
    check("批量未传文件应 400", r.status === 400, `status=${r.status}`);
  }
  {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.txt");
    form.append("productType", "not_a_type");
    const r = await fetch(`${BASE}/api/batch/analyze`, { method: "POST", body: form });
    check("未知品类应 400", r.status === 400, `status=${r.status}`);
  }

  // ========== 4. 会话 + 分享 ==========
  section("4. /api/sessions 与分享");
  {
    const r = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productType: "color_print_box" }),
    });
    const d = await j(r);
    check("创建会话 200", r.status === 200, `status=${r.status}`);
    check("返回 sessionId", !!d.sessionId || !!d.id, JSON.stringify(d).slice(0, 120));

    const r2 = await fetch(`${BASE}/api/sessions`, { method: "GET" });
    check("会话列表 200", r2.status === 200, `status=${r2.status}`);
  }
  {
    const r = await fetch(`${BASE}/api/share/definitely-not-a-real-token`);
    check("无效分享 token 应 404", r.status === 404, `status=${r.status}`);
  }

  // ========== 5. 词典审核 ==========
  section("5. /api/dictionary 待审词典");
  {
    const r = await fetch(`${BASE}/api/dictionary`);
    const d = await j(r);
    check("词典 GET 200", r.status === 200, `status=${r.status}`);
    check("返回 pending 数组", Array.isArray(d.pending), JSON.stringify(d).slice(0, 120));
  }

  // ========== 6. 校准案例 ==========
  section("6. /api/calibration/cases");
  {
    const r = await fetch(`${BASE}/api/calibration/cases`);
    const d = await j(r);
    check("校准案例 GET 200", r.status === 200, `status=${r.status}`);
    check("返回 count 与 cases", typeof d.count === "number" && Array.isArray(d.cases), JSON.stringify(d).slice(0, 120));
    console.log(`  source=${d.source} count=${d.count}`);
  }

  // ========== 7. VAVE 规则检索 ==========
  section("7. /api/vave/rules/* 规则库");
  {
    const r = await fetch(`${BASE}/api/vave/rules/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productType: "color_print_box", query: "降克重", limit: 5 }),
    });
    check("规则检索 200", r.status === 200, `status=${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/api/vave/rules`);
    check("规则列表 200", r.status === 200, `status=${r.status}`);
  }

  // ========== 8. AI 状态（离线） ==========
  section("8. /api/ai/status");
  {
    const r = await fetch(`${BASE}/api/ai/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: null }),
    });
    const d = await j(r);
    check("未配置 AI 返回 unconfigured", d.status === "unconfigured", JSON.stringify(d).slice(0, 120));
  }

  // ========== 9. 鉴权边界 ==========
  section("9. 管理接口鉴权");
  {
    // /api/admin/formula 为 fail-closed。两种合法拒绝：
    //   403 = 未配 FORMULA_ADMIN_TOKEN；401 = 已配 token 但请求头缺失/不对。
    // 本仓库 .env 配了 token，故本地为 401；公网若漏配则为 403。二者都不允许 200。
    const r = await fetch(`${BASE}/api/admin/formula`);
    check("公式管理未授权应 401/403（fail-closed）", r.status === 401 || r.status === 403, `status=${r.status}`);
  }
  {
    // /api/admin/knowledge-base 为 fail-open（既定设计）：未配 KB_ADMIN_TOKEN 时开放
    const r = await fetch(`${BASE}/api/admin/knowledge-base`);
    const d = await j(r);
    check("知识库管理未配 token 开放（fail-open，本地预期）", r.status === 200, `status=${r.status}`);
    check("知识库返回 count", typeof d.count === "number", JSON.stringify(d).slice(0, 120));
    if (r.status === 200) {
      console.log("  ⚠️  知识库管理接口 fail-open：公网部署前必须配置 KB_ADMIN_TOKEN（见 §6/§7）");
    }
  }

  // ========== 10. 报价扫描（无 LLM 兜底） ==========
  section("10. /api/import/quote-scan");
  {
    // 真实 PDF：验证 pdf-to-img 渲染 + 无视觉模型时的优雅降级（必须 200+ok:false，不能 500）
    let pdfBytes: Buffer | null = null;
    try {
      const chrome =
        process.env.CHROME_BIN ??
        [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/usr/bin/google-chrome",
        ].find((p) => fs.existsSync(p));
      if (chrome) {
        const html = `<html><body><table border="1"><tr><th>产品名称</th><th>彩盒尺寸</th><th>材质</th><th>数量</th><th>单价</th></tr><tr><td>礼盒A</td><td>200*150*80mm</td><td>350g白卡</td><td>5000</td><td>2.35</td></tr></table></body></html>`;
        const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "scan-"));
        const h = `${dir}/q.html`;
        const out = `${dir}/q.pdf`;
        await fsp.writeFile(h, html);
        await new Promise<void>((res, rej) => {
          const p = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", `--print-to-pdf=${out}`, `file://${h}`]);
          p.on("close", (c) => (c === 0 ? res() : rej(new Error("chrome code=" + c))));
        });
        pdfBytes = await fsp.readFile(out);
      }
    } catch {
      pdfBytes = null;
    }
    if (pdfBytes && pdfBytes.length > 1000) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }), "quote.pdf");
      const r = await fetch(`${BASE}/api/import/quote-scan`, { method: "POST", body: form });
      const d = await j(r);
      check("真实 PDF 不 500（渲染或优雅降级）", r.status !== 500, `status=${r.status} ${JSON.stringify(d).slice(0, 200)}`);
      check(
        "PDF 降级时返回可读错误码",
        d.ok === true || ["NO_VISION_MODEL", "NO_TABLE", "UNKNOWN_PRODUCT_TYPE"].includes(String(d.code)),
        JSON.stringify({ ok: d.ok, code: d.code, msg: d.message }).slice(0, 220)
      );
      console.log(`  PDF(${Math.round(pdfBytes.length / 1024)}KB) → code=${d.code ?? "-"} ok=${d.ok}`);
    } else {
      console.log("  ⚠️ 未找到 Chrome，跳过真实 PDF 渲染用例");
    }
  }
  {
    const form = new FormData();
    form.append("file", new Blob(["not a pdf"], { type: "text/plain" }), "bad.txt");
    const r = await fetch(`${BASE}/api/import/quote-scan`, { method: "POST", body: form });
    check("非 PDF/图片应 400 而非 500", r.status === 400, `status=${r.status}`);
  }

  // ========== 11. 客户报价 xlsx（与扫描件共用后段确定性管线） ==========
  section("11. /api/import/customer-quote");
  {
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const headers = [
      "产品名称",
      "彩盒尺寸",
      "材质",
      "克重",
      "盒型",
      "印刷方式",
      "色数",
      "表面处理",
      "是否糊盒",
      "数量",
      "单价",
    ];
    const rows = [
      headers,
      ["礼盒A", "200*150*80mm", "350g白卡", "350", "tuck_end", "胶印", "4", "哑膜", "是", 5000, 2.35],
      ["礼盒B", "300*200*100mm", "250g白卡", "250", "tuck_end", "胶印", "4", "无", "是", 3000, 3.1],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "报价");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "quote.xlsx");
    const r = await fetch(`${BASE}/api/import/customer-quote`, { method: "POST", body: form });
    const d = await j(r);
    check("客户报价导入 200", r.status === 200, `status=${r.status} ${JSON.stringify(d).slice(0, 160)}`);
    check("自动识别品类为彩盒", d.productType === "color_print_box", String(d.productType));
    check("解析出 2 行", d.rowCount === 2, String(d.rowCount));
    check("识别到客户单价", d.hasPrice === true, JSON.stringify(d.products?.[0]?.price ?? {}));
    const p0 = d.products?.[0];
    check("解析出尺寸 200x150x80", p0?.input?.length === 200 && p0?.input?.width === 150 && p0?.input?.height === 80, JSON.stringify(p0?.input ?? {}));
    check("材质文本解析出白卡 350g", p0?.input?.material === "white_card" && Number(p0?.input?.grammage) === 350, JSON.stringify({ m: p0?.input?.material, g: p0?.input?.grammage }));
    check("每行都有估算", !!p0?.estimate?.perUnit && !!d.products?.[1]?.estimate?.perUnit, JSON.stringify(p0?.estimate ?? {}));
    check("估算单价有限且非负", Number.isFinite(p0?.estimate?.perUnit) && p0.estimate.perUnit > 0, String(p0?.estimate?.perUnit));
    // 客户价 vs 我方估算：对比页依赖这两个数的差值
    check("客户单价进入 price 桶而非 input", p0?.price?.unitPrice === 2.35 && p0?.input?.unitPrice === undefined, JSON.stringify(p0?.price ?? {}));
    console.log(`  品类=${d.productType} 行数=${d.rowCount} 客户价=${p0?.price?.unitPrice} 我方估算=${p0?.estimate?.perUnit?.toFixed?.(3)}`);
  }
  {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.txt");
    const r = await fetch(`${BASE}/api/import/customer-quote`, { method: "POST", body: form });
    check("客户报价非 xlsx 不 500", r.status !== 500, `status=${r.status}`);
  }

  // ========== 12. 其余路由冒烟（重点：不允许 500） ==========
  section("12. 其余路由冒烟");
  {
    const smoke: { path: string; method: "GET" | "POST"; body?: unknown }[] = [
      { path: "/api/ai/warmup", method: "POST", body: {} },
      { path: "/api/calibration/extract", method: "POST", body: {} },
      { path: "/api/vave/distill", method: "POST", body: {} },
      { path: "/api/vave/negotiate", method: "POST", body: {} },
      { path: "/api/vave/rules/convert", method: "POST", body: {} },
      { path: "/api/vave/rules/sweep", method: "POST", body: {} },
      { path: "/api/parse-image", method: "POST", body: {} },
      { path: "/api/sessions/not-a-real-id", method: "GET" },
      { path: "/api/sessions/not-a-real-id/share", method: "POST", body: {} },
      { path: "/api/vave/rules/retrieve", method: "POST", body: {} },
    ];
    for (const s of smoke) {
      const r = await fetch(`${BASE}${s.path}`, {
        method: s.method,
        headers: { "content-type": "application/json" },
        body: s.method === "POST" ? JSON.stringify(s.body ?? {}) : undefined,
      });
      check(`${s.method} ${s.path} 不 500`, r.status !== 500, `status=${r.status}`);
    }
  }

  // ========== 13. 附件上传 ==========
  section("13. /api/upload");
  {
    const mk = (name: string, type: string, body: BlobPart) => {
      const f = new FormData();
      f.append("file", new Blob([body], { type }), name);
      f.append("category", "design");
      f.append("productType", "color_print_box");
      return f;
    };
    // 非 multipart（JSON）→ 应 400，而不是 500
    const r0 = await fetch(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    check("非 multipart 应 400（不 500）", r0.status === 400, `status=${r0.status}`);
    // 空表单 → 400 未选择文件
    const empty = new FormData();
    const r1 = await fetch(`${BASE}/api/upload`, { method: "POST", body: empty });
    check("空表单应 400", r1.status === 400, `status=${r1.status}`);
    // 不支持的格式 → 400
    const r2 = await fetch(`${BASE}/api/upload`, { method: "POST", body: mk("a.txt", "text/plain", "x") });
    check("不支持格式应 400", r2.status === 400, `status=${r2.status}`);
    // 合法 PNG → 200 且返回可访问 url
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const r3 = await fetch(`${BASE}/api/upload`, { method: "POST", body: mk("t.png", "image/png", new Uint8Array(png)) });
    const d3 = await j(r3);
    check("合法 PNG 上传 200", r3.status === 200, `status=${r3.status} ${JSON.stringify(d3).slice(0, 160)}`);
    check("返回 url 与反馈文案", !!d3.file?.url && !!d3.feedback, JSON.stringify(d3).slice(0, 200));
    if (d3.file?.url) {
      const r4 = await fetch(`${BASE}${d3.file.url}`);
      check("上传产物可访问", r4.status === 200, `status=${r4.status} ${d3.file.url}`);
    }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fails.length) {
    console.log("\n失败项：");
    fails.forEach((f) => console.log("  ❌ " + f));
    process.exit(1);
  } else {
    console.log("✅ API 数据链路全部通过");
  }
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
