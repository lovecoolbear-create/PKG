import { NextRequest, NextResponse } from "next/server";
import { listRules } from "@/lib/vave/rule-store";

/** 列出降本规则库（可选按 status 过滤：ACTIVE | DEPRECATED | PENDING） */
export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get("status") ?? undefined;
    const rules = await listRules(status ?? undefined);
    return NextResponse.json({ ok: true, rules });
  } catch (error) {
    console.error("List rules error:", error);
    return NextResponse.json({ error: "列表获取失败" }, { status: 500 });
  }
}
