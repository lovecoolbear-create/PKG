import { NextRequest, NextResponse } from "next/server";
import { getDefaultProductType, getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import type { AnalysisInput } from "@/types";

/**
 * VAVE 分析入口（与 /api/sessions 的 POST 不同）：
 * - 复用同一成本引擎 runOrchestrator，保证 VAVE 永远建立在成本分析之上；
 * - 故意【不写】knowledgeEntry（source=analysis），避免敏感性多次重跑污染知识库；
 * - 不更新任何 session，仅返回客观 AnalysisReport 供 VAVE 策略层消费。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const inputData = body.input as AnalysisInput | undefined;
    if (!inputData || typeof inputData !== "object") {
      return NextResponse.json({ error: "缺少有效的 input" }, { status: 400 });
    }

    const config = getProductConfig(body.productType) ?? getDefaultProductType();
    const sessionId = `vave_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const report = await runOrchestrator({
      sessionId,
      config,
      input: inputData,
      skippedKeys: body.skippedKeys || [],
      aiSettings: body.aiSettings,
    });

    return NextResponse.json({ report });
  } catch (error) {
    console.error("VAVE analyze error:", error);
    return NextResponse.json({ error: "分析失败" }, { status: 500 });
  }
}
