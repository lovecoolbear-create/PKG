/**
 * 校准闭环端到端验证（需 dev server 在 3000）
 *
 * 覆盖：案例读取 → 模板列生成 → 行映射与校验 → 批量预览 → 批量提交 → 删除 → 一键跑校准
 *
 * 关键回归点：
 *   1. **模板示例行必须能导入**（曾踩过同样的坑：批量模板示例行因硬编码表头导致空白行）
 *   2. 有阻断错误的行**不得**被写入
 *   3. 测试结束必须还原 calibration-cases.json 现场（原本不存在就删掉，避免污染真实数据）
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAllProductTypes } from "../src/config/products";
import {
  buildTemplateColumns,
  buildTemplateRow,
  mapRowToCase,
  parseClipboardTable,
} from "../src/lib/calibration/batch";
import { summarizeCoverage, validateCase } from "../src/lib/calibration/validate";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const USER_PATH = resolve(process.cwd(), "calibration-cases.json");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const hadUserFile = existsSync(USER_PATH);
  const backup = hadUserFile ? readFileSync(USER_PATH, "utf8") : null;
  console.log(
    hadUserFile
      ? `ℹ️  已存在 calibration-cases.json，测试结束将还原`
      : `ℹ️  尚未创建 calibration-cases.json，测试结束将删除测试产物`
  );

  try {
    // ===== 1. 案例读取 =====
    console.log("\n【1】GET /api/calibration/cases");
    const getRes = await fetch(`${BASE}/api/calibration/cases`);
    check("读取案例 200", getRes.ok, `HTTP ${getRes.status}`);
    const getData = await getRes.json();
    check("返回 count 与 cases 数组", typeof getData.count === "number" && Array.isArray(getData.cases));
    check("返回数据源标识", typeof getData.source === "string" && getData.source.length > 0);

    // ===== 2. 模板示例行（四个品类都必须能导入）=====
    console.log("\n【2】模板示例行 → 映射 → 校验");
    const all = getAllProductTypes();
    for (const cfg of all) {
      const cols = buildTemplateColumns(cfg);
      const row = buildTemplateRow(cfg, cols);
      const obj: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        obj[c.header] = row[i];
      });
      const mapped = mapRowToCase(obj, all, cfg.code);
      const { errors, warnings } = validateCase(mapped);
      check(
        `${cfg.name}：示例行无阻断错误`,
        errors.length === 0,
        errors.map((e) => e.message).join("；")
      );
      check(`${cfg.name}：示例行映射到正确品类`, mapped.productType === cfg.code);
      check(
        `${cfg.name}：示例行解析出实际总价`,
        typeof mapped.actual?.total === "number" && mapped.actual.total > 0
      );
      // 示例行刻意留空外部锚，应给出提示而非阻断
      check(
        `${cfg.name}：示例行给出质量提示（非阻断）`,
        warnings.length > 0 && errors.length === 0
      );
    }

    // ===== 3. 校验规则 =====
    console.log("\n【3】校验规则");
    const cbp = all[0];
    const noId = validateCase({ caseId: "", productType: cbp.code, input: {}, actual: { total: 100 } });
    check("缺 caseId → error", noId.errors.some((e) => e.field === "caseId"));

    const badTotal = validateCase({ caseId: "x", productType: cbp.code, input: {}, actual: { total: 0 } });
    check("总价为 0 → error", badTotal.errors.some((e) => e.field === "actual.total"));

    const unknownPt = validateCase({ caseId: "x", productType: "no_such", input: {}, actual: { total: 100 } });
    check("未知品类 → error", unknownPt.errors.some((e) => e.field === "productType"));

    const missingHi = validateCase({ caseId: "x", productType: cbp.code, input: {}, actual: { total: 100 } });
    check(
      "缺高影响参数 → warn（不阻断）",
      missingHi.errors.length === 0 && missingHi.warnings.some((w) => w.field === "input")
    );

    const dimMismatch = validateCase({
      caseId: "x",
      productType: cbp.code,
      input: { quantity: 1000, length: 100, width: 100, height: 50, material: "white_card", grammage: "350", printMethod: "offset", deliveryLocation: "east_china", surfaceTreatment: "none", needGluing: false },
      actual: { total: 1000, material: 100, labor: 100, process: 100, design_plate: 100, finance_other: 100 },
    });
    check(
      "五维合计与总价差 >2% → warn",
      dimMismatch.warnings.some((w) => w.field === "actual" && w.message.includes("五维合计")),
      dimMismatch.warnings.map((w) => w.message).join("|")
    );

    // ===== 4. 粘贴板解析 =====
    console.log("\n【4】粘贴表格解析");
    const tsv = "案例标识\t实际总价(元)\nE2E-粘贴\t1234";
    const parsed = parseClipboardTable(tsv);
    check("TSV 解析出 1 行", parsed.length === 1, JSON.stringify(parsed));
    const parsedCase = mapRowToCase(parsed[0], all, cbp.code);
    check("TSV 行解析出 caseId", parsedCase.caseId === "E2E-粘贴");
    check("TSV 行解析出总价", parsedCase.actual?.total === 1234);

    // ===== 5. 批量预览（commit=false，不写盘）=====
    console.log("\n【5】批量预览");
    const goodRow = (id: string) => {
      const cols = buildTemplateColumns(cbp);
      const sample = buildTemplateRow(cbp, cols);
      const obj: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        obj[c.header] = sample[i];
      });
      obj["案例标识"] = id;
      return obj;
    };
    const rows = [goodRow("E2E-批量-1"), goodRow("E2E-批量-2"), { 案例标识: "", 实际总价: -5 }];

    const prevRes = await fetch(`${BASE}/api/calibration/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, productType: cbp.code, commit: false }),
    });
    check("预览请求 200", prevRes.ok, `HTTP ${prevRes.status}`);
    const prevData = await prevRes.json();
    check("预览返回 3 行", prevData.preview?.totalRows === 3, JSON.stringify(prevData.preview?.totalRows));
    check("预览识别 2 行可导入", prevData.preview?.validRows === 2);
    check("预览识别 1 行阻断", prevData.preview?.invalidRows === 1);
    check("未写盘（预览不落库）", !hadUserFile ? !existsSync(USER_PATH) : true);

    // ===== 6. 批量提交 =====
    console.log("\n【6】批量提交（commit=true）");
    const commitRes = await fetch(`${BASE}/api/calibration/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, productType: cbp.code, commit: true }),
    });
    const commitData = await commitRes.json();
    check("提交 200", commitRes.ok, `HTTP ${commitRes.status}`);
    check("写入 2 例", commitData.committed === 2, JSON.stringify(commitData.committed));
    check("跳过 1 例", commitData.skipped === 1);
    check("已落盘 calibration-cases.json", existsSync(USER_PATH));
    check("返回覆盖度汇总", typeof commitData.coverage?.total === "number");

    const afterRes = await fetch(`${BASE}/api/calibration/cases`);
    const afterData = await afterRes.json();
    check(
      "GET 能读到新写入的案例",
      afterData.cases.some((c: any) => c.caseId === "E2E-批量-1")
    );

    // ===== 7. 覆盖度 =====
    console.log("\n【7】覆盖度统计");
    const cov = summarizeCoverage(afterData.cases);
    check("覆盖度 total 与案例数一致", cov.total === afterData.cases.length);
    check("覆盖度起步目标为 10", cov.target === 10);
    check(
      "覆盖度统计到品类分布",
      Object.keys(cov.byProductType).length > 0 && Object.values(cov.byProductType).every((v) => v > 0)
    );

    // ===== 8. 删除 =====
    console.log("\n【8】删除案例");
    const delRes = await fetch(`${BASE}/api/calibration/cases?caseId=E2E-%E6%89%B9%E9%87%8F-1`, {
      method: "DELETE",
    });
    const delData = await delRes.json();
    check("删除 200", delRes.ok, `HTTP ${delRes.status}`);
    check("删除成功标记 removed", delData.ok === true && delData.removed !== false);
    const afterDel = await (await fetch(`${BASE}/api/calibration/cases`)).json();
    check(
      "删除后读不到该案例",
      !afterDel.cases.some((c: any) => c.caseId === "E2E-批量-1")
    );
    const badDel = await fetch(`${BASE}/api/calibration/cases?caseId=`, { method: "DELETE" });
    check("缺 caseId → 400", badDel.status === 400);

    // ===== 9. 一键跑校准 =====
    console.log("\n【9】一键跑校准（执行真实脚本，约数十秒）");
    const runRes = await fetch(`${BASE}/api/calibration/run`, { method: "POST" });
    const runData = await runRes.json();
    check("跑校准接口 200", runRes.ok, `HTTP ${runRes.status}`);
    check("退出码 0", runData.exitCode === 0, JSON.stringify(runData.exitCode));
    check(
      "解析出总价命中汇总",
      runData.summary && typeof runData.summary.inTarget === "number" && runData.summary.total > 0,
      JSON.stringify(runData.summary)
    );
    check("返回完整 markdown 报告", typeof runData.report === "string" && runData.report.length > 200);
    check(
      "报告含反向调参指引",
      String(runData.report).includes("偏差解读与反向调参指引")
    );
  } finally {
    // ===== 还原现场 =====
    console.log("\n【清理】还原 calibration-cases.json");
    if (hadUserFile && backup !== null) {
      writeFileSync(USER_PATH, backup, "utf8");
      console.log("  ↩️  已还原原有文件");
    } else if (existsSync(USER_PATH)) {
      unlinkSync(USER_PATH);
      console.log("  🗑️  已删除测试产物（原本不存在）");
    }
  }

  console.log(`\n===== 通过 ${pass} / ${pass + fail} =====`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error("执行异常：", e);
  process.exitCode = 1;
});
