import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { nanoid } from "nanoid";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const expiresInDays = body.expiresInDays || 7;

    const session = await prisma.analysisSession.findUnique({
      where: { id },
    });

    if (!session || session.status !== "completed") {
      return NextResponse.json(
        { error: "报告尚未生成或会话不存在" },
        { status: 400 }
      );
    }

    const token = nanoid(16);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const shared = await prisma.sharedReport.create({
      data: {
        sessionId: id,
        token,
        expiresAt,
      },
    });

    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      request.nextUrl?.origin ||
      request.headers.get("origin") ||
      "http://localhost:3000";

    return NextResponse.json({
      token: shared.token,
      url: `${baseUrl}/share/${shared.token}`,
      expiresAt: shared.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("Share error:", error);
    return NextResponse.json({ error: "生成分享链接失败" }, { status: 500 });
  }
}
