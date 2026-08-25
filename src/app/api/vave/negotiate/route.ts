import { NextRequest, NextResponse } from "next/server";
import type { AnalysisInput } from "@/types";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { getProductConfig } from "@/config/products";
import { simulateNegotiation } from "@/lib/vave/negotiation-agent";
import type { AiSettings } from "@/lib/config/ai-settings";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      baseInput?: AnalysisInput;
      productType?: string;
      targetPerUnit?: number;
      aiSettings?: AiSettings;
    };
    const { baseInput, productType, targetPerUnit, aiSettings } = body;
    if (!baseInput || !productType) {
      return NextResponse.json({ error: "缺少 baseInput 或 productType" }, { status: 400 });
    }
    const config = getProductConfig(productType);
    if (!config) {
      return NextResponse.json({ error: "未知产品类型" }, { status: 400 });
    }

    const baseReport = await runOrchestrator({
      sessionId: `neg-base-${Date.now()}`,
      config,
      input: baseInput,
      aiSettings,
    });

    const result = await simulateNegotiation(
      baseInput,
      productType,
      baseReport,
      aiSettings,
      typeof targetPerUnit === "number" ? targetPerUnit : undefined
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Negotiation simulate error:", error);
    return NextResponse.json({ error: "谈判模拟失败" }, { status: 500 });
  }
}
