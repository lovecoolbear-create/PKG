import { NextRequest, NextResponse } from "next/server";
import { caseSource, deleteCase, readCases, upsertCases } from "@/lib/calibration/store";
import { DIM_KEYS, validateCase, type CaseLike } from "@/lib/calibration/validate";

/**
 * 校准案例读写 API（轻量版报价单录入的数据落点）
 *
 * 设计原则（与 calibration-real.ts 方法学一致）：
 *   - 仅做"数据入口"：把用户手填的供应商报价存成 CalCase，供校准脚本消费。
 *   - 不伪造维度拆解：actual 只强制 total；五维/锚/actualLabor 全可选。
 *   - 锚（paperPricePerTon 等）由用户填"独立外部参考"，API 只透传，不计算、不查表。
 *
 * GET    /api/calibration/cases           -> 案例数组 + 元信息 + 覆盖度
 * POST   /api/calibration/cases           -> 校验并追加/覆盖一条，写回 calibration-cases.json
 * DELETE /api/calibration/cases?caseId=x  -> 删除指定案例
 *
 * 注：写入仓库根的 calibration-cases.json，仅适用于本地/内网部署（dev / 自托管）。
 */

const ANCHOR_KEYS = [
  "paperPricePerTon",
  "laborRatePerPiece",
  "plateCost",
  "financeTotal",
] as const;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function GET() {
  const cases = readCases(true);
  return NextResponse.json({
    count: cases.length,
    source: caseSource(),
    cases,
  });
}

export async function DELETE(req: NextRequest) {
  const caseId = (req.nextUrl.searchParams.get("caseId") ?? "").trim();
  if (!caseId) {
    return NextResponse.json({ ok: false, error: "缺少 caseId 查询参数" }, { status: 400 });
  }
  try {
    const { removed, count } = deleteCase(caseId);
    if (!removed) {
      return NextResponse.json(
        { ok: false, error: `未找到案例「${caseId}」（可能尚未创建 calibration-cases.json）` },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, caseId, count });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "删除失败：" + String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "请求体必须是对象" }, { status: 400 });
  }
  const caseId = typeof body.caseId === "string" ? body.caseId.trim() : "";
  if (!caseId) {
    return NextResponse.json({ ok: false, error: "caseId 不能为空" }, { status: 400 });
  }
  const input = body.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return NextResponse.json({ ok: false, error: "input 必须是对象" }, { status: 400 });
  }
  const actual = body.actual;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return NextResponse.json({ ok: false, error: "actual 必须是对象" }, { status: 400 });
  }
  if (!isFiniteNum(actual.total) || actual.total <= 0) {
    return NextResponse.json(
      { ok: false, error: "actual.total 必须是大于 0 的数字（实际总价，元）" },
      { status: 400 }
    );
  }

  // ---- 组装（只透传用户给的，绝不补维度拆解）----
  const cleanInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== "") cleanInput[k] = v;
  }

  const cleanActual: Record<string, number> = { total: actual.total };
  for (const k of DIM_KEYS) {
    if (isFiniteNum(actual[k])) cleanActual[k] = actual[k];
  }

  const meta: Record<string, unknown> = {};
  if (body.meta && typeof body.meta === "object") {
    for (const [k, v] of Object.entries(body.meta)) {
      if (v !== undefined && v !== "") meta[k] = v;
    }
  }
  for (const k of ANCHOR_KEYS) {
    if (isFiniteNum(actual[k])) meta[k] = actual[k]; // 兼容前端把锚放 actual 下的情况
  }

  const out: Record<string, unknown> = { caseId, input: cleanInput, actual: cleanActual };
  if (Object.keys(meta).length > 0) out.meta = meta;

  if (body.actualLabor && typeof body.actualLabor === "object" && !Array.isArray(body.actualLabor)) {
    const al: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.actualLabor)) {
      if (v !== undefined && v !== "") al[k] = v;
    }
    if (Object.keys(al).length > 0) out.actualLabor = al;
  }

  // 非阻断的质量提示随响应回传，前端据此提醒（不拦截入库）
  const issues = validateCase(out as CaseLike);

  try {
    const count = upsertCases([out]);
    return NextResponse.json({
      ok: true,
      count,
      caseId,
      path: "calibration-cases.json",
      warnings: issues.warnings.map((w) => w.message),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "写入失败：" + String(e) }, { status: 500 });
  }
}
