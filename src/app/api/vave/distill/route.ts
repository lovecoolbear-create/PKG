import { NextRequest, NextResponse } from "next/server";
import type { AnalysisInput } from "@/types";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { getProductConfig } from "@/config/products";
import { distillCaseToRules } from "@/lib/vave/knowledge-distill";
import type { AiSettings } from "@/lib/config/ai-settings";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      baseInput?: AnalysisInput;
      productType?: string;
      actualPerUnit?: number;
      actualChoices?: string;
      aiSettings?: AiSettings;
    };
    const { baseInput, productType, actualPerUnit, actualChoices, aiSettings } = body;
    if (!baseInput || !productType || typeof actualPerUnit !== "number") {
      return NextResponse.json({ error: "缺少 baseInput / productType / actualPerUnit" }, { status: 400 });
    }
    const config = getProductConfig(productType);
    if (!config) {
      return NextResponse.json({ error: "未知产品类型" }, { status: 400 });
    }

    const baseReport = await runOrchestrator({
      sessionId: `distill-base-${Date.now()}`,
      config,
      input: baseInput,
      aiSettings,
    });

    // 铁律：distill 仅「提案」，返回 PendingRule[]（status=pending），绝不写 KB
    const rules = await distillCaseToRules({
      baselineInput: baseInput,
      baselineReport: baseReport,
      actualPerUnit,
      actualChoices,
      aiSettings,
    });

    return NextResponse.json(rules);
  } catch (error) {
    console.error("Distill error:", error);
    return NextResponse.json({ error: "知识反推失败" }, { status: 500 });
  }
}
