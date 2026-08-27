"use client";

import { useState } from "react";
import { getAllProductTypes } from "@/config/products";
import { CalibrationIntakeForm, type IntakeInitial } from "@/components/calibration/CalibrationIntakeForm";
import { CalibrationUpload } from "@/components/calibration/CalibrationUpload";

export default function CalibrationIntakePage() {
  const productTypes = getAllProductTypes();
  const [init, setInit] = useState<IntakeInitial | undefined>(undefined);
  const [initKey, setInitKey] = useState(0);
  const [parseSummary, setParseSummary] = useState<string | null>(null);

  return (
    <main className="min-h-screen bg-brand-50 py-8">
      <div className="mx-auto max-w-5xl px-6">
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
        <CalibrationIntakeForm key={initKey} productTypes={productTypes} initial={init} />
      </div>
    </main>
  );
}
