import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDefaultProductType, getProductConfig } from "@/config/products";
import { calculateCompleteness } from "@/lib/completeness";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { runInputGuardrail } from "@/lib/agents/input-guardrail";
import type { AnalysisInput } from "@/types";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await prisma.analysisSession.findUnique({
      where: { id },
      include: { productType: true },
    });

    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }

    return NextResponse.json({
      id: session.id,
      status: session.status,
      inputData: JSON.parse(session.inputData),
      uploadedFiles: session.uploadedFiles
        ? JSON.parse(session.uploadedFiles)
        : [],
      completeness: session.completeness,
      resultData: session.resultData ? JSON.parse(session.resultData) : null,
    });
  } catch (error) {
    console.error("Get session error:", error);
    return NextResponse.json({ error: "获取会话失败" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const existing = await prisma.analysisSession.findUnique({
      where: { id },
      include: { productType: true },
    });
    const config =
      getProductConfig(existing?.productType?.code ?? "") ?? getDefaultProductType();

    const inputData = body.inputData as AnalysisInput;
    const completeness = calculateCompleteness(config, inputData);

    const session = await prisma.analysisSession.update({
      where: { id },
      data: {
        inputData: JSON.stringify(inputData),
        uploadedFiles: body.uploadedFiles
          ? JSON.stringify(body.uploadedFiles)
          : undefined,
        completeness: completeness.score,
      },
    });

    return NextResponse.json({
      id: session.id,
      completeness: completeness.score,
      missing: completeness.missing,
    });
  } catch (error) {
    console.error("Update session error:", error);
    return NextResponse.json({ error: "更新会话失败" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const session = await prisma.analysisSession.findUnique({
      where: { id },
      include: { productType: true },
    });

    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }

    const config =
      getProductConfig(session.productType?.code) ?? getDefaultProductType();
    const inputData = JSON.parse(session.inputData) as AnalysisInput;

    // 输入层确定性 Guardrail：拦截 garbage-in，避免无效入参进入成本引擎
    const guardrail = runInputGuardrail(inputData, config);
    if (guardrail.hasBlocker) {
      await prisma.analysisSession.update({
        where: { id },
        data: { status: "failed" },
      });
      return NextResponse.json(
        {
          error: "输入校验未通过，请修正后重新生成",
          guardrail: {
            hasBlocker: true,
            issues: guardrail.issues,
          },
        },
        { status: 422 }
      );
    }

    await prisma.analysisSession.update({
      where: { id },
      data: { status: "analyzing" },
    });

    const report = await runOrchestrator({
      sessionId: id,
      config,
      input: inputData,
      skippedKeys: body.skippedKeys || [],
      aiSettings: body.aiSettings,
    });

    await prisma.analysisSession.update({
      where: { id },
      data: {
        status: "completed",
        resultData: JSON.stringify(report),
        totalCostMin: report.totalCost.min,
        totalCostMax: report.totalCost.max,
        confidence: report.overallConfidence,
        agentLogs: JSON.stringify({
          dimensions: report.dimensions.map((d) => ({
            dimension: d.dimension,
            confidence: d.confidence,
            amount: d.estimatedAmount,
          })),
          validationIssues: report.validationIssues,
        }),
      },
    });

    // 写入知识库
    await prisma.knowledgeEntry.create({
      data: {
        sessionId: id,
        category: "analysis_result",
        key: `${config.code}_${new Date().toISOString()}`,
        value: JSON.stringify({
          input: inputData,
          totalCost: report.totalCost,
          dimensions: report.dimensions.map((d) => ({
            dimension: d.dimension,
            amount: d.estimatedAmount,
            ratio: d.ratio,
          })),
        }),
        source: "analysis",
        confidence: report.overallConfidence,
        tags: JSON.stringify([config.code, "auto"]),
      },
    });

    return NextResponse.json({ report, guardrail: { issues: guardrail.warnings } });
  } catch (error) {
    console.error("Analyze error:", error);
    await prisma.analysisSession.update({
      where: { id: (await params).id },
      data: { status: "failed" },
    });
    return NextResponse.json({ error: "分析失败" }, { status: 500 });
  }
}
