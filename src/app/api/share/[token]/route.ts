import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const shared = await prisma.sharedReport.findUnique({
      where: { token },
      include: {
        session: {
          include: { productType: true },
        },
      },
    });

    if (!shared) {
      return NextResponse.json({ error: "链接无效" }, { status: 404 });
    }

    if (new Date() > shared.expiresAt) {
      return NextResponse.json({ error: "链接已过期" }, { status: 410 });
    }

    await prisma.sharedReport.update({
      where: { id: shared.id },
      data: { viewCount: { increment: 1 } },
    });

    const session = shared.session;

    return NextResponse.json({
      report: session.resultData ? JSON.parse(session.resultData) : null,
      productTypeName: session.productType.name,
      sharedAt: shared.createdAt.toISOString(),
      expiresAt: shared.expiresAt.toISOString(),
      viewCount: shared.viewCount + 1,
    });
  } catch (error) {
    console.error("Share view error:", error);
    return NextResponse.json({ error: "获取分享报告失败" }, { status: 500 });
  }
}
