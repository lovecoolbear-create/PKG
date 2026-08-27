"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { ArrowLeft, ArrowRight, Loader2, Layers } from "lucide-react";
import { UploadStep } from "@/components/analyze/UploadStep";
import { InfoFormStep } from "@/components/analyze/InfoFormStep";
import { ReportStep } from "@/components/analyze/ReportStep";
import { getDefaultProductType, getProductConfig } from "@/config/products";
import {
  writeInfoSource,
  clearInfoSource,
  formatReportContext,
} from "@/lib/ai-context";
import { saveProject } from "@/lib/project-store";
import { calculateCompleteness } from "@/lib/completeness";
import { getAiSettings } from "@/lib/config/ai-settings";
import type {
  AnalysisInput,
  AnalysisReport,
  UploadedFileMeta,
  CostProject,
} from "@/types";

export default function AnalyzeWorkView({
  productType,
  onExit,
  onSaved,
  onStep,
  onContext,
}: {
  productType: string;
  onExit: () => void;
  onSaved: (p: CostProject) => void;
  onStep?: (step: number) => void;
  onContext?: (label: string | null) => void;
}) {
  const config = useMemo(
    () => getProductConfig(productType) ?? getDefaultProductType(),
    [productType]
  );

  const STEP_HINTS: Record<number, string[]> =
    config.code === "flat_print"
      ? {
          0: [
            "上传设计稿或成品样图，系统将参考尺寸与工艺特征",
            "PDF 格式稿件识别效果最佳",
            "产品照片有助于确认纸张与表面处理效果",
          ],
          1: [
            "印量对纸张采购单价影响显著，建议填写准确数量",
            "成品尺寸请填 mm，用于计算单张用纸面积",
            "印刷色数请按实际设计稿填写，含专色需注明",
            "页数决定总印张数，海报请填 1",
          ],
          2: [
            "报告基于当前输入参数与行业经验规则估算",
            "置信度反映估算可靠程度，低置信度项建议与工厂核实",
          ],
        }
      : {
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

  const STEP_ASSUMPTIONS =
    config.code === "flat_print"
      ? [
          "按单张成品尺寸 × 页数 × 印量计算总用纸面积",
          "材料损耗率按 8% 计算",
          "人工费率按交付地域中等工厂水平（随地域浮动），设备与油墨按行业基准",
          "不含特殊认证、检测等额外费用",
        ]
      : [
          "按标准插口盒（Tuck End Box）盒型估算",
          "材料损耗率按 8% 计算",
          "人工费率按华东区域中等规模工厂水平（随生产地域浮动），设备与油墨按行业基准",
          "不含特殊认证、检测等额外费用",
        ];

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
  const [answeredKeys, setAnsweredKeys] = useState<string[]>([]);
  const [skippedKeys, setSkippedKeys] = useState<string[]>([]);

  const completeness = useMemo(
    () => calculateCompleteness(config, input),
    [config, input]
  );

  const summary = useMemo(() => {
    const items: { label: string; value: string }[] = [];
    if (input.quantity) items.push({ label: "数量", value: `${input.quantity} 个` });
    if (input.length && input.width && input.height) {
      items.push({ label: "尺寸", value: `${input.length}×${input.width}×${input.height} mm` });
    } else if (input.length && input.width) {
      items.push({ label: "尺寸", value: `${input.length}×${input.width} mm` });
    }
    const matField = config.fields.find((f) => f.key === "material");
    if (input.material && matField?.options) {
      const opt = matField.options.find((o) => o.value === input.material);
      if (opt) items.push({ label: "材质", value: opt.label });
    }
    return items;
  }, [input, config]);

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
    if (currentStep > 0 && currentStep < 2) setCurrentStep((s) => s - 1);
  };

  const handleSaveProject = () => {
    if (!report) return;
    const name = `${report.productTypeName}${input.quantity ? ` · ${input.quantity}个` : ""}`;
    const proj = saveProject(name, input, report);
    onSaved(proj);
  };

  const canProceed =
    currentStep === 0 ? true : currentStep === 1 ? completeness.score >= 40 : false;

  useEffect(() => {
    if (report) {
      writeInfoSource({
        scope: "analyze",
        source: `成本分析 · ${report.productTypeName}`,
        contextText: formatReportContext(report, input),
        updatedAt: Date.now(),
      });
      onContext?.(`成本分析 · ${report.productTypeName}`);
    } else {
      clearInfoSource();
      onContext?.(null);
    }
  }, [input, report, onContext]);

  useEffect(() => {
    onStep?.(currentStep);
  }, [currentStep, onStep]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  const stepConfig = config.steps[currentStep];

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm text-slate-500">
        <span className="rounded-full bg-brand-100 px-2.5 py-1 font-medium text-brand-700">
          {config.name}
        </span>
        <span className="text-xs">步骤 {currentStep + 1} / {config.steps.length} · {stepConfig?.title}</span>
      </div>

      {currentStep === 0 && (
        <UploadStep
          files={files}
          productType={config.code}
          onFilesChange={(newFiles) => {
            setFiles(newFiles);
            if (newFiles.length > files.length) {
              const latest = newFiles[newFiles.length - 1];
              setUploadFeedback((prev) => [
                ...prev,
                latest.category === "design"
                  ? config.code === "flat_print"
                    ? "已收到设计稿件，系统将参考尺寸与工艺进行成本估算"
                    : "已收到设计图纸，系统将参考盒型结构进行成本估算"
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
        <>
          <ReportStep report={report} sessionId={sessionId} />
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={handleSaveProject}
              className="btn-accent inline-flex items-center gap-2"
            >
              <Layers className="h-4 w-4" />
              保存为项目 → 进入 VAVE 降本
            </button>
          </div>
        </>
      )}

      {currentStep < 2 && (
        <div className="mt-8 flex items-center justify-between border-t border-brand-200 pt-6">
          <button
            onClick={currentStep === 0 ? onExit : handleBack}
            className="btn-secondary"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {currentStep === 0 ? "返回项目中心" : "上一步"}
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
  );
}
