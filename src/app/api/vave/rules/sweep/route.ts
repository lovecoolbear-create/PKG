import { NextRequest, NextResponse } from "next/server";
import { sweepDeprecated } from "@/lib/vave/rule-store";

export const maxDuration = 30;

/** 规格2：手动/定时触发 TTL 扫描，弃用连续 90 天未触发或高冲突率规则 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ttlDays?: number;
      conflictRateThreshold?: number;
    };
    const { deprecatedIds, scanned } = await sweepDeprecated({
      ttlDays: body.ttlDays,
      conflictRateThreshold: body.conflictRateThreshold,
    });
    return NextResponse.json({ ok: true, scanned, deprecatedIds });
  } catch (error) {
    console.error("Sweep rules error:", error);
    return NextResponse.json({ error: "TTL 扫描失败" }, { status: 500 });
  }
}
