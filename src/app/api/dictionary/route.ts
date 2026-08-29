// ========== 待审词典审核 API（人工确认式学习闭环） ==========
// GET    /api/dictionary            列出待审候选（含可确认字段选项）
// POST   /api/dictionary            人工确认/拒审：{ action: "confirm"|"reject", id, targetField?, targetValue? }
// 所有写动作仅由人工交互触发；AI 代码路径不调用本文件。

import { NextRequest, NextResponse } from "next/server";
import { getProductConfig } from "@/config/products";
import {
  listPending,
  confirmCandidate,
  rejectCandidate,
} from "@/lib/parse/dict-store";

export const runtime = "nodejs";

/** GET：待审候选 + 每个候选可确认的字段选项（来自品类 config.fields，含 select 的 value 选项） */
export async function GET() {
  try {
    const pending = listPending();
    const enriched = pending.map((c) => {
      const cfg = getProductConfig(c.productType);
      const fields = (cfg?.fields ?? []).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
      }));
      return { ...c, fields };
    });
    return NextResponse.json({ ok: true, pending: enriched });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action;
    if (action === "confirm") {
      const { id, targetField, targetValue } = body;
      if (!id || !targetField)
        return NextResponse.json(
          { ok: false, error: "缺少 id 或 targetField" },
          { status: 400 },
        );
      const ov = confirmCandidate(id, String(targetField), targetValue ? String(targetValue) : undefined);
      return NextResponse.json({ ok: true, override: ov });
    }
    if (action === "reject") {
      const { id } = body;
      if (!id)
        return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
      const ok = rejectCandidate(String(id));
      return NextResponse.json({ ok, rejected: ok });
    }
    return NextResponse.json(
      { ok: false, error: "未知 action（应为 confirm/reject）" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
