"use client";

import { cn } from "@/lib/utils";
import { AlertTriangle, Info, Lightbulb, HelpCircle } from "lucide-react";

interface SidebarPanelProps {
  stepTitle: string;
  stepDescription: string;
  hints?: string[];
  assumptions?: string[];
  optimizations?: { title: string; detail: string }[];
  missingFields?: { label: string; impact: string }[];
}

export function SidebarPanel({
  stepTitle,
  stepDescription,
  hints = [],
  assumptions = [],
  optimizations = [],
  missingFields = [],
}: SidebarPanelProps) {
  return (
    <div className="space-y-5">
      {/* Current step info */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-500">
          当前步骤
        </h3>
        <p className="mt-2 text-sm font-semibold text-brand-900">{stepTitle}</p>
        <p className="mt-1 text-sm text-brand-600">{stepDescription}</p>
      </div>

      {/* Missing fields warning */}
      {missingFields.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-orange-800">
            <AlertTriangle className="h-4 w-4" />
            缺少关键信息
          </div>
          <ul className="mt-2 space-y-2">
            {missingFields.slice(0, 4).map((f) => (
              <li key={f.label} className="text-xs text-orange-700">
                <span className="font-medium">{f.label}</span>
                <span className="text-orange-600"> — {f.impact}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Hints */}
      {hints.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-500">
            <Info className="h-3.5 w-3.5" />
            关键提示
          </div>
          <ul className="mt-2 space-y-2">
            {hints.map((hint, i) => (
              <li key={i} className="text-sm text-brand-600">
                • {hint}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Assumptions */}
      {assumptions.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-500">
            <HelpCircle className="h-3.5 w-3.5" />
            估算假设
          </div>
          <ul className="mt-2 space-y-1.5">
            {assumptions.map((a, i) => (
              <li key={i} className="text-xs text-brand-500">
                • {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Optimization hints */}
      {optimizations.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-500">
            <Lightbulb className="h-3.5 w-3.5" />
            可优化方向
          </div>
          <div className="mt-2 space-y-3">
            {optimizations.map((opt, i) => (
              <div
                key={i}
                className="rounded-lg border border-green-200 bg-green-50 p-3"
              >
                <p className="text-sm font-medium text-green-800">{opt.title}</p>
                <p className="mt-1 text-xs text-green-700">{opt.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Help */}
      <div className="rounded-lg bg-brand-100 p-4">
        <p className="text-xs text-brand-600">
          如需进一步做 VAVE 或供应链优化，欢迎联系我们获取专业支持。
        </p>
      </div>
    </div>
  );
}
