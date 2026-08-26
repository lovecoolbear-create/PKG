import { NextRequest, NextResponse } from "next/server";
import { retrieveCases } from "@/lib/vave/rule-store";

export const maxDuration = 30;

/**
 * 规格3：检索降本案例库。
 * 先按 boxType/material/loadClass/productType 做确定性元数据预过滤（SQL WHERE），
 * 再按 query 文本做语义向量余弦重排；无 query 则按使用频次降序。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      productType?: string;
      boxType?: string | null;
      material?: string | null;
      loadClass?: string | null;
      query?: string;
      limit?: number;
    };
    const rules = await retrieveCases(
      {
        productType: body.productType,
        boxType: body.boxType,
        material: body.material,
        loadClass: body.loadClass,
        limit: body.limit,
      },
      body.query
    );
    return NextResponse.json({ ok: true, rules });
  } catch (error) {
    console.error("Retrieve rules error:", error);
    return NextResponse.json({ error: "检索失败" }, { status: 500 });
  }
}
