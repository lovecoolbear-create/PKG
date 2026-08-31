import { NextRequest, NextResponse } from "next/server";
import { getAllProductTypes, getProductConfig } from "@/config/products";
import { previewRows } from "@/lib/calibration/batch";
import { readCases, upsertCases } from "@/lib/calibration/store";
import { summarizeCoverage } from "@/lib/calibration/validate";

/**
 * 校准案例批量导入
 *
 * POST /api/calibration/batch
 *   body: { rows: Record<string, unknown>[], productType?: string, commit?: boolean }
 *   - commit=false（默认）：只做映射 + 校验，返回逐行预览（错误/提示），不写盘
 *   - commit=true：只写入**无 error** 的行；有 error 的行整行跳过并在响应里说明
 *
 * 铁律：映射与校验规则全部来自 src/lib/calibration/*，本路由不自带第二份规则。
 */

const MAX_ROWS = 500;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const rows = body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "rows 必须是非空数组（表格解析后的行）" },
      { status: 400 }
    );
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `单次最多导入 ${MAX_ROWS} 行，当前 ${rows.length} 行` },
      { status: 400 }
    );
  }

  const all = getAllProductTypes();
  const fallback = typeof body.productType === "string" ? body.productType : "";
  if (fallback && !getProductConfig(fallback)) {
    return NextResponse.json({ ok: false, error: `未知品类：${fallback}` }, { status: 400 });
  }
  const defaultProductType = fallback || all[0]?.code || "";

  const { preview, cases } = previewRows(
    rows as Record<string, unknown>[],
    all,
    defaultProductType
  );

  if (!body.commit) {
    return NextResponse.json({ ok: true, preview });
  }

  // 只提交无 error 的行
  const good = cases.filter((_, i) => preview.rows[i].errors.length === 0);
  if (!good.length) {
    return NextResponse.json({
      ok: false,
      preview,
      error: "没有任何一行通过校验，未写入任何数据",
    });
  }

  try {
    const count = upsertCases(good);
    // 覆盖度按**全量**案例统计（含历史），否则每批只看本批会误导
    const coverage = summarizeCoverage(readCases(false));
    return NextResponse.json({
      ok: true,
      preview,
      committed: good.length,
      skipped: cases.length - good.length,
      count,
      coverage,
      path: "calibration-cases.json",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, preview, error: "写入失败：" + String(e) }, { status: 500 });
  }
}
