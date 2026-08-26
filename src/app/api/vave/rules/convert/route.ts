import { NextRequest, NextResponse } from "next/server";
import type { AnalysisInput } from "@/types";
import type { PendingRule } from "@/lib/vave/knowledge-distill";
import { convertPendingRule } from "@/lib/vave/rule-store";

export const maxDuration = 30;

/**
 * 规格1：LLM 蒸馏提案 → 确定性 PostgreSQL 规则（一键转换）。
 * 仅由人工点击「固化为规则」触发；AI 代码路径不调用本接口（守「AI 无写入权」铁律）。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      rule?: PendingRule;
      input?: AnalysisInput;
      productType?: string;
    };
    const { rule, input, productType } = body;
    if (!rule || !input || !productType) {
      return NextResponse.json(
        { error: "缺少 rule / input / productType" },
        { status: 400 }
      );
    }
    if (!rule.id || !rule.target || !rule.proposedValue) {
      return NextResponse.json({ error: "rule 字段不完整" }, { status: 400 });
    }
    const created = await convertPendingRule(rule, input, productType);
    return NextResponse.json({ ok: true, rule: created });
  } catch (error) {
    console.error("Convert rule error:", error);
    return NextResponse.json({ error: "规则固化失败" }, { status: 500 });
  }
}
