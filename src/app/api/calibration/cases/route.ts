import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * 校准案例读写 API（轻量版报价单录入的数据落点）
 *
 * 设计原则（与 calibration-real.ts 方法学一致）：
 *   - 仅做"数据入口"：把用户手填的供应商报价存成 CalCase，供校准脚本消费。
 *   - 不伪造维度拆解：actual 只强制 total；五维/锚/actualLabor 全可选。
 *   - 锚（paperPricePerTon 等）由用户填"独立外部参考"，API 只透传，不计算、不查表。
 *
 * GET  /api/calibration/cases  -> 返回当前案例数组 + 元信息
 * POST /api/calibration/cases -> 校验并追加一条案例，写回 calibration-cases.json
 *
 * 注：写入仓库根的 calibration-cases.json，仅适用于本地/内网部署（dev / 自托管）。
 */
const root = process.cwd();
const USER_PATH = resolve(root, "calibration-cases.json");
const EXAMPLE_PATH = resolve(root, "calibration-cases.example.json");

const DIM_KEYS = ["material", "labor", "process", "design_plate", "finance_other"] as const;
const ANCHOR_KEYS = [
  "paperPricePerTon",
  "laborRatePerPiece",
  "plateCost",
  "financeTotal",
] as const;

function readCases(allowExample = true): unknown[] {
  if (existsSync(USER_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(USER_PATH, "utf8"));
      if (Array.isArray(raw)) return raw;
    } catch {
      /* 损坏则降级 */
    }
  }
  if (allowExample && existsSync(EXAMPLE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
      if (Array.isArray(raw)) return raw;
    } catch {
      /* ignore */
    }
  }
  return [];
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function GET() {
  const cases = readCases(true);
  const source = existsSync(USER_PATH)
    ? "calibration-cases.json"
    : "calibration-cases.example.json（尚未创建 calibration-cases.json）";
  return NextResponse.json({ count: cases.length, source, cases });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  // ---- 基础校验 ----
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

  // actualLabor 可选结构化
  if (body.actualLabor && typeof body.actualLabor === "object" && !Array.isArray(body.actualLabor)) {
    const al: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.actualLabor)) {
      if (v !== undefined && v !== "") al[k] = v;
    }
    if (Object.keys(al).length > 0) out.actualLabor = al;
  }

  // ---- 读-改-写（无锁，本地单用户足够）----
  const cases = readCases(false);
  // 防重复 caseId（同 id 则覆盖）
  const idx = cases.findIndex((c: any) => c && c.caseId === caseId);
  if (idx >= 0) cases[idx] = out;
  else cases.push(out);

  writeFileSync(USER_PATH, JSON.stringify(cases, null, 2), "utf8");

  return NextResponse.json({ ok: true, count: cases.length, caseId, path: "calibration-cases.json" });
}
