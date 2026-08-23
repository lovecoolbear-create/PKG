"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Settings } from "lucide-react";
import { ThreeColumnLayout } from "@/components/layout/ThreeColumnLayout";
import { StepNav } from "@/components/layout/StepNav";
import { SidebarPanel } from "@/components/layout/SidebarPanel";
import { UploadStep } from "@/components/analyze/UploadStep";
import { InfoFormStep } from "@/components/analyze/InfoFormStep";
import { ReportStep } from "@/components/analyze/ReportStep";
import { getDefaultProductType } from "@/config/products";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";
import { getAiSettings } from "@/lib/config/ai-settings";
import { calculateCompleteness } from "@/lib/completeness";
import type {
  AnalysisInput,
  AnalysisReport,
  UploadedFileMeta,
} from "@/types";

const STEP_HINTS: Record<number, string[]> = {
  0: [
    "建议上传带尺寸的盒型展开图（刀线图）",
    "PDF 格式设计稿识别效果最佳",
    "产品照片有助于确认材质与表面处理效果",
  ],
  1: [
    "订单数量对材料单价影响显著，建议填写准确数量",
    "尺寸请填写外尺寸（mm），用于计算用纸面积",
    "印刷色数请按实际设计稿填写，含专色需注明",
  ],
  2: [
    "报告基于当前输入参数与行业经验规则估算",
    "置信度反映了估算可靠程度，低置信度项建议与工厂核实",
  ],
};

const STEP_ASSUMPTIONS = [
  "按标准插口盒（Tuck End Box）盒型估算",
  "材料损耗率按 8% 计算",
  "人工费率按华东区域中等规模工厂水平（随生产地域浮动），设备与油墨按行业基准",
  "不含特殊认证、检测等额外费用",
];

export default function AnalyzePage() {
  const router = useRouter();
  const config = getDefaultProductType();

  const [currentStep, setCurrentStep] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState<AnalysisInput>({
    needGluing: true,
    targetDelivery: "standard",
  });
  const [files, setFiles] = useState<UploadedFileMeta[]>([]);
  const [uploadFeedback, setUploadFeedback] = useState<string[]>([]);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // 主动提问：记录用户已回答 / 已跳过的字段
  const [answeredKeys, setAnsweredKeys] = useState<string[]>([]);
  const [skippedKeys, setSkippedKeys] = useState<string[]>([]);
  // AI 模型配置中心弹窗
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

  const completeness = useMemo(
    () => calculateCompleteness(config, input),
    [config, input]
  );

  const summary = useMemo(() => {
    const items: { label: string; value: string }[] = [];
    if (input.quantity) items.push({ label: "数量", value: `${input.quantity} 个` });
    if (input.length && input.width && input.height) {
      items.push({
        label: "尺寸",
        value: `${input.length}×${input.width}×${input.height} mm`,
      });
    }
    const matField = config.fields.find((f) => f.key === "material");
    if (input.material && matField?.options) {
      const opt = matField.options.find((o) => o.value === input.material);
      if (opt) items.push({ label: "材质", value: opt.label });
    }
    return items;
  }, [input, config]);

  // Create session on mount
  useEffect(() => {
    async function createSession() {
      setLoading(true);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productType: config.code }),
        });
        const data = await res.json();
        if (res.ok) setSessionId(data.sessionId);
      } finally {
        setLoading(false);
      }
    }
    createSession();
  }, [config.code]);

  const saveProgress = useCallback(async () => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputData: input, uploadedFiles: files }),
    });
  }, [sessionId, input, files]);

  const handleAnswered = (key: string, value: string | number | boolean) => {
    setInput((prev) => ({ ...prev, [key]: value }));
    setAnsweredKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setSkippedKeys((prev) => prev.filter((k) => k !== key));
  };

  const handleSkipped = (key: string) => {
    setSkippedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setAnsweredKeys((prev) => prev.filter((k) => k !== key));
  };

  const handleNext = async () => {
    if (currentStep === 1) {
      await saveProgress();
      setAnalyzing(true);
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skippedKeys,
            aiSettings: getAiSettings() ?? undefined,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          setReport(data.report);
          setCurrentStep(2);
        }
      } finally {
        setAnalyzing(false);
      }
    } else {
      if (currentStep === 0) await saveProgress();
      setCurrentStep((s) => s + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0 && currentStep < 2) {
      setCurrentStep((s) => s - 1);
    }
  };

  const canProceed =
    currentStep === 0
      ? true
      : currentStep === 1
        ? completeness.score >= 40
        : false;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  const stepConfig = config.steps[currentStep];

  return (
    <>
      {/* 右上角 AI 模型配置中心入口 */}
      <button
        type="button"
        onClick={() => setAiSettingsOpen(true)}
        className="fixed right-4 top-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-violet-700"
      >
        <Settings className="h-4 w-4" />
        AI 设置
      </button>

      <ThreeColumnLayout
        left={
        <StepNav
          steps={config.steps}
          currentStep={currentStep}
          completeness={completeness.score}
          summary={summary}
        />
      }
      center={
        <div>
          {currentStep === 0 && (
            <UploadStep
              files={files}
              onFilesChange={(newFiles) => {
                setFiles(newFiles);
                if (newFiles.length > files.length) {
                  const latest = newFiles[newFiles.length - 1];
                  setUploadFeedback((prev) => [
                    ...prev,
                    latest.category === "design"
                      ? "已收到设计图纸，系统将参考盒型结构进行成本估算"
                      : "已收到产品照片，有助于确认材质与工艺效果",
                  ]);
                }
              }}
              feedback={uploadFeedback}
            />
          )}
          {currentStep === 1 && (
            <InfoFormStep
              config={config}
              input={input}
              onChange={setInput}
              answeredKeys={answeredKeys}
              skippedKeys={skippedKeys}
              onAnswered={handleAnswered}
              onSkipped={handleSkipped}
            />
          )}
          {currentStep === 2 && report && sessionId && (
            <ReportStep report={report} sessionId={sessionId} />
          )}

          {/* Navigation buttons */}
          {currentStep < 2 && (
            <div className="mt-8 flex items-center justify-between border-t border-brand-200 pt-6">
              <button
                onClick={currentStep === 0 ? () => router.push("/") : handleBack}
                className="btn-secondary"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {currentStep === 0 ? "返回首页" : "上一步"}
              </button>
              <button
                onClick={handleNext}
                disabled={!canProceed || analyzing}
                className="btn-primary"
              >
                {analyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    分析中...
                  </>
                ) : currentStep === 1 ? (
                  <>
                    生成报告
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                ) : (
                  <>
                    下一步
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      }
      right={
        <SidebarPanel
          stepTitle={stepConfig?.title || ""}
          stepDescription={stepConfig?.description || ""}
          hints={STEP_HINTS[currentStep] || []}
          assumptions={currentStep >= 1 ? STEP_ASSUMPTIONS : []}
          missingFields={completeness.missing.map((m) => ({
            label: m.label,
            impact: m.impact,
          }))}
          optimizations={
            report?.optimizationHints.map((h) => ({
              title: h.title,
              detail: h.summary,
            })) || []
          }
        />
      }
    />

      <AiSettingsModal
        open={aiSettingsOpen}
        onClose={() => setAiSettingsOpen(false)}
      />
    </>
  );
}
