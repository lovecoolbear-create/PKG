"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import { getAllProductTypes } from "@/config/products";
import { CalibrationIntakeForm, type IntakeInitial } from "@/components/calibration/CalibrationIntakeForm";
import { CalibrationBatchImport } from "@/components/calibration/CalibrationBatchImport";
import { CalibrationCoverage } from "@/components/calibration/CalibrationCoverage";
import { CalibrationRunner } from "@/components/calibration/CalibrationRunner";
import { CalibrationUpload } from "@/components/calibration/CalibrationUpload";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";

export default function CalibrationIntakePage() {
  const productTypes = getAllProductTypes();
  const [init, setInit] = useState<IntakeInitial | undefined>(undefined);
  const [initKey, setInitKey] = useState(0);
  const [parseSummary, setParseSummary] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  /** 案例集合变更（批量导入/删除）后递增，驱动看板与表单计数刷新 */
  const [refreshToken, setRefreshToken] = useState(0);
  const [caseCount, setCaseCount] = useState<number | null>(null);

  return (
    <main className="min-h-screen bg-brand-50 py-8">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-brand-500">
            上传报价单后 AI 将自动提取字段；提取前请先配置模型
          </span>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-violet-700"
          >
            <Settings className="h-4 w-4" />
            AI 模型配置
          </button>
        </div>
        <CalibrationCoverage
          productTypes={productTypes}
          refreshToken={refreshToken}
          onDeleted={() => setRefreshToken((t) => t + 1)}
          onCountChange={setCaseCount}
        />
        <CalibrationBatchImport
          productTypes={productTypes}
          onImported={() => setRefreshToken((t) => t + 1)}
        />
        <CalibrationRunner caseCount={caseCount} />
        <CalibrationUpload
          productTypes={productTypes}
          onParsed={(i, summary) => {
            setInit(i);
            setInitKey((k) => k + 1);
            setParseSummary(summary);
          }}
        />
        {parseSummary && (
          <div className="mb-5 rounded-lg border border-brand-200 bg-brand-100 p-3 text-sm text-brand-800">
            <span className="font-medium">解析提示：</span>
            {parseSummary}
          </div>
        )}
        <CalibrationIntakeForm
          key={initKey}
          productTypes={productTypes}
          initial={init}
          refreshToken={refreshToken}
          onSaved={() => setRefreshToken((t) => t + 1)}
        />
      </div>
      <AiSettingsModal open={aiOpen} onClose={() => setAiOpen(false)} />
    </main>
  );
}
