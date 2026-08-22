"use client";

import { useState } from "react";
import type {
  AnalysisInput,
  ClarificationQuestion,
  ProductField,
  ProductTypeConfig,
} from "@/types";
import { getLaborRegionOptions } from "@/lib/cost-rules/labor-regions";
import { generateQuestions } from "@/lib/agents/question-engine";

interface InfoFormStepProps {
  config: ProductTypeConfig;
  input: AnalysisInput;
  onChange: (input: AnalysisInput) => void;
  answeredKeys: string[];
  skippedKeys: string[];
  onAnswered: (key: string, value: string | number | boolean) => void;
  onSkipped: (key: string) => void;
}

export function InfoFormStep({
  config,
  input,
  onChange,
  answeredKeys,
  skippedKeys,
  onAnswered,
  onSkipped,
}: InfoFormStepProps) {
  const groups = groupFields(config.fields);
  const regionOptions = getLaborRegionOptions();

  const updateField = (key: string, value: string | number | boolean) => {
    onChange({ ...input, [key]: value });
  };

  // 主动提问：按影响权重列出仍缺失的高影响字段（地域单独用上方选择器，这里排除）
  const pendingQuestions = generateQuestions(
    config,
    input,
    new Set(answeredKeys),
    new Set(skippedKeys)
  ).filter((q) => q.key !== "laborRegion");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-brand-900">补充产品关键信息</h2>
        <p className="mt-1 text-sm text-brand-600">
          请填写以下参数，信息越完整，成本估算越准确。带 * 号为必填项。
        </p>
      </div>

      {/* 生产地域选择（醒目，影响人工成本） */}
      <div className="card border-2 border-brand-300 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-brand-900">
              生产地域 <span className="text-brand-400">（影响人工成本）</span>
            </h3>
            <p className="mt-1 text-xs text-brand-500">
              未选择将默认按「华东地区」估算，并在报告中标注
            </p>
          </div>
          {!input.laborRegion && (
            <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700">
              当前：默认华东
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          {regionOptions.map((opt) => {
            const active = input.laborRegion === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onAnswered("laborRegion", opt.value)}
                className={
                  active
                    ? "rounded-lg border-2 border-brand-700 bg-brand-700 px-4 py-2 text-sm font-medium text-white"
                    : "rounded-lg border border-brand-300 bg-white px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 主动提问面板 */}
      {pendingQuestions.length > 0 && (
        <div className="card border border-amber-200 bg-amber-50/40 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-xs text-white">
              ?
            </span>
            为提升估算精度，请确认以下关键信息
          </h3>
          <p className="mt-1 text-xs text-amber-700">
            这些参数对成本影响较大，直接回答即可即时更新；暂不回答可点「跳过（用默认）」，系统将套用合理默认值并在报告中标注。
          </p>
          <div className="mt-4 space-y-3">
            {pendingQuestions.slice(0, 4).map((q) => (
              <QuestionCard
                key={q.key}
                question={q}
                value={input[q.key]}
                onAnswered={onAnswered}
                onSkipped={onSkipped}
              />
            ))}
            {pendingQuestions.length > 4 && (
              <p className="text-xs text-brand-500">
                还有 {pendingQuestions.length - 4} 项可在表单中补充，或继续生成报告由系统套用默认假设。
              </p>
            )}
          </div>
        </div>
      )}

      {Object.entries(groups).map(([groupName, fields]) => (
        <div key={groupName} className="card p-5">
          <h3 className="text-sm font-semibold text-brand-800">{groupName}</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                value={input[field.key]}
                onChange={(v) => updateField(field.key, v)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function QuestionCard({
  question,
  value,
  onAnswered,
  onSkipped,
}: {
  question: ClarificationQuestion;
  value: string | number | boolean | undefined;
  onAnswered: (key: string, value: string | number | boolean) => void;
  onSkipped: (key: string) => void;
}) {
  const [numText, setNumText] = useState("");

  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-900">
            {question.label}
          </p>
          <p className="mt-0.5 text-xs text-brand-600">{question.question}</p>
          <p className="mt-0.5 text-xs text-amber-700">
            影响：{question.impact}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
          高影响
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {question.type === "select" && (
          <select
            className="input-field flex-1"
            value={(value as string) || ""}
            onChange={(e) => onAnswered(question.key, e.target.value)}
          >
            <option value="">请选择</option>
            {question.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}

        {question.type === "number" && (
          <>
            <input
              type="number"
              className="input-field flex-1"
              placeholder={question.defaultLabel || "请输入"}
              value={numText}
              onChange={(e) => setNumText(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary shrink-0 py-2"
              disabled={!numText}
              onClick={() => onAnswered(question.key, Number(numText))}
            >
              确认
            </button>
          </>
        )}

        {question.type === "boolean" && (
          <div className="flex gap-2">
            <button
              type="button"
              className={
                value === true
                  ? "rounded-lg border-2 border-brand-700 bg-brand-700 px-4 py-2 text-sm font-medium text-white"
                  : "rounded-lg border border-brand-300 bg-white px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
              }
              onClick={() => onAnswered(question.key, true)}
            >
              是
            </button>
            <button
              type="button"
              className={
                value === false
                  ? "rounded-lg border-2 border-brand-700 bg-brand-700 px-4 py-2 text-sm font-medium text-white"
                  : "rounded-lg border border-brand-300 bg-white px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
              }
              onClick={() => onAnswered(question.key, false)}
            >
              否
            </button>
          </div>
        )}

        <button
          type="button"
          className="shrink-0 rounded-lg border border-dashed border-amber-300 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100"
          onClick={() => onSkipped(question.key)}
          title={
            question.defaultLabel
              ? `跳过将使用默认：${question.defaultLabel}`
              : "跳过将使用默认假设"
          }
        >
          跳过（用默认）
        </button>
      </div>
    </div>
  );
}

function groupFields(fields: ProductField[]): Record<string, ProductField[]> {
  const groups: Record<string, ProductField[]> = {};
  for (const field of fields) {
    const group = field.group || "其他";
    if (!groups[group]) groups[group] = [];
    groups[group].push(field);
  }
  return groups;
}

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ProductField;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const label = (
    <label className="label">
      {field.label}
      {field.required && <span className="text-red-500"> *</span>}
      {field.unit && (
        <span className="ml-1 text-xs font-normal text-brand-400">
          ({field.unit})
        </span>
      )}
    </label>
  );

  switch (field.type) {
    case "select":
      return (
        <div>
          {label}
          <select
            className="input-field"
            value={(value as string) || ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">请选择</option>
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );

    case "number":
      return (
        <div>
          {label}
          <input
            type="number"
            className="input-field"
            placeholder={field.placeholder}
            value={value !== undefined ? String(value) : ""}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      );

    case "boolean":
      return (
        <div className="flex items-center gap-3 pt-6">
          <input
            type="checkbox"
            id={field.key}
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-brand-300 text-brand-800 focus:ring-brand-500"
          />
          <label htmlFor={field.key} className="text-sm text-brand-700">
            {field.label}
          </label>
        </div>
      );

    case "text":
    default:
      return (
        <div className="sm:col-span-2">
          {label}
          <input
            type="text"
            className="input-field"
            placeholder={field.placeholder}
            value={(value as string) || ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}
