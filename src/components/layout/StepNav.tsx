"use client";

import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface Step {
  id: string;
  title: string;
}

interface StepNavProps {
  steps: Step[];
  currentStep: number;
  completeness: number;
  summary?: { label: string; value: string }[];
}

export function StepNav({
  steps,
  currentStep,
  completeness,
  summary,
}: StepNavProps) {
  return (
    <div className="space-y-6">
      {/* Steps */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-500">
          分析步骤
        </h3>
        <nav className="mt-3 space-y-1">
          {steps.map((step, index) => {
            const isActive = index === currentStep;
            const isCompleted = index < currentStep;
            return (
              <div
                key={step.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  isActive && "bg-brand-100 font-medium text-brand-900",
                  isCompleted && "text-brand-600",
                  !isActive && !isCompleted && "text-brand-400"
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                    isActive && "bg-brand-800 text-white",
                    isCompleted && "bg-accent-green text-white",
                    !isActive && !isCompleted && "bg-brand-200 text-brand-500"
                  )}
                >
                  {isCompleted ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                {step.title}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Completeness */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-500">
            信息完整度
          </h3>
          <span className="text-sm font-semibold text-brand-800">
            {completeness}%
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-brand-200">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              completeness >= 80
                ? "bg-accent-green"
                : completeness >= 50
                  ? "bg-accent-orange"
                  : "bg-red-400"
            )}
            style={{ width: `${completeness}%` }}
          />
        </div>
        {completeness < 80 && (
          <p className="mt-2 text-xs text-brand-500">
            补充更多信息可提高估算精度
          </p>
        )}
      </div>

      {/* Summary */}
      {summary && summary.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-500">
            项目摘要
          </h3>
          <dl className="mt-3 space-y-2">
            {summary.map((item) => (
              <div key={item.label} className="flex justify-between text-sm">
                <dt className="text-brand-500">{item.label}</dt>
                <dd className="font-medium text-brand-800">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
