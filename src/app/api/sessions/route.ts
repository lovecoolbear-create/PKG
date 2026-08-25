import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensureProductType } from "@/lib/seed";
import { getDefaultProductType, getProductConfig } from "@/config/products";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const productTypeCode = body.productType || "color_print_box";

    let pt = await prisma.productType.findUnique({
      where: { code: productTypeCode },
    });
    if (!pt) pt = await ensureProductType();

    const session = await prisma.analysisSession.create({
      data: {
        productTypeId: pt.id,
        inputData: JSON.stringify(body.inputData || {}),
        uploadedFiles: body.uploadedFiles
          ? JSON.stringify(body.uploadedFiles)
          : null,
        completeness: body.completeness || 0,
        status: "draft",
      },
    });

    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    console.error("Create session error:", error);
    return NextResponse.json(
      { error: "创建分析会话失败" },
      { status: 500 }
    );
  }
}

export async function GET() {
  const configs = await prisma.productType.findMany();
  return NextResponse.json({
    productTypes: configs.map((p) => p.code),
  });
}
