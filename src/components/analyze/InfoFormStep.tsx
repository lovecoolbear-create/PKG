"use client";

import { useState } from "react";
import { Sparkles, Loader2, ScanLine, X } from "lucide-react";
import type {
  AnalysisInput,
  ClarificationQuestion,
  ProductField,
  ProductTypeConfig,
} from "@/types";
import { getLaborRegionOptions } from "@/lib/cost-rules/labor-regions";
import { generateQuestions } from "@/lib/agents/question-engine";
import type { NlpParseResult } from "@/lib/agents/nlp-parser";
import { getAiSettings } from "@/lib/config/ai-settings";

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

  // AI 智能一键填单（自然语言解析）
  const [nlText, setNlText] = useState("");
  const [nlLoading, setNlLoading] = useState(false);
  const [nlResult, setNlResult] = useState<NlpParseResult | null>(null);

  // AI 图纸视觉解析
  const [drawingPreviews, setDrawingPreviews] = useState<
    { id: string; url: string; name: string }[]
  >([]);
  const [drawingImages, setDrawingImages] = useState<
    { dataUrl: string; mime: string }[]
  >([]);
  const [drawingLoading, setDrawingLoading] = useState(false);
  const [drawingResult, setDrawingResult] = useState<NlpParseResult | null>(
    null
  );

  /** 将解析结果回填到表单（标记为已回答） */
  const applyParseResult = (data: NlpParseResult | null) => {
    if (!data) return;
    Object.entries(data.input || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== "")
        onAnswered(k, v as string | number | boolean);
    });
  };

  const handleNlParse = async () => {
    const text = nlText.trim();
    if (!text || nlLoading) return;
    setNlLoading(true);
    setNlResult(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, aiSettings: getAiSettings() ?? undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setNlResult(data);
        applyParseResult(data);
      } else {
        setNlResult({
          input: {},
          defaults: [],
          confidence: 0,
          source: "rule",
          note: data.error || "解析失败，请手动填写",
        });
      }
    } catch {
      setNlResult({
        input: {},
        defaults: [],
        confidence: 0,
        source: "rule",
        note: "网络异常，请手动填写或重试",
      });
    } finally {
      setNlLoading(false);
    }
  };

  const handleDrawingFiles = async (
    fileList: FileList | null
  ) => {
    if (!fileList || fileList.length === 0 || drawingLoading) return;
    setDrawingResult(null);
    const accepted: { dataUrl: string; mime: string }[] = [];
    const previews: { id: string; url: string; name: string }[] = [];

    for (const file of Array.from(fileList)) {
      try {
        if (file.type === "application/pdf") {
          const pages = await pdfFileToDataUrls(file);
          for (const p of pages) {
            accepted.push(p);
            previews.push({
              id: `${file.name}-${Math.random()}`,
              url: p.dataUrl,
              name: file.name,
            });
          }
        } else if (file.type.startsWith("image/")) {
          const img = await imageFileToDataUrl(file);
          accepted.push(img);
          previews.push({
            id: `${file.name}-${Math.random()}`,
            url: img.dataUrl,
            name: file.name,
          });
        }
      } catch {
        // 单文件失败跳过
      }
    }

    if (accepted.length === 0) {
      setDrawingResult({
        input: {},
        defaults: [],
        confidence: 0,
        source: "rule",
        note: "未能读取所选文件，请确认是图片或 PDF，并在浏览器允许读取。",
      });
      return;
    }
    // 限制最多 4 张
    const capped = accepted.slice(0, 4);
    setDrawingImages(capped);
    setDrawingPreviews(previews.slice(0, 4));

    setDrawingLoading(true);
    try {
      const res = await fetch("/api/parse-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: capped,
          aiSettings: getAiSettings() ?? undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDrawingResult(data);
        applyParseResult(data);
      } else {
        setDrawingResult({
          input: {},
          defaults: [],
          confidence: 0,
          source: "rule",
          note: data.error || "图纸解析失败，请手动填写",
        });
      }
    } catch {
      setDrawingResult({
        input: {},
        defaults: [],
        confidence: 0,
        source: "rule",
        note: "网络异常，请手动填写或重试",
      });
    } finally {
      setDrawingLoading(false);
    }
  };

  const removeDrawing = (id: string) => {
    setDrawingPreviews((prev) => prev.filter((p) => p.id !== id));
    // 预览与 images 一一对应，按索引删除
    const idx = drawingPreviews.findIndex((p) => p.id === id);
    if (idx >= 0) {
      setDrawingImages((prev) => prev.filter((_, i) => i !== idx));
    }
  };

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

      {/* AI 智能一键填单（自然语言解析） */}
      <div className="card border-2 border-violet-300 bg-violet-50/50 p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-600" />
          <h3 className="text-sm font-semibold text-violet-900">
            AI 智能一键填单
          </h3>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700">
            大模型自然语言解析
          </span>
        </div>
        <p className="mt-1 text-xs text-violet-700">
          直接用大白话描述需求即可，例如「做 3000 个海鲜礼盒，要防水，做高级一点的天地盖」。系统将解析并自动填充参数。
        </p>
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <textarea
              className="input-field min-h-[64px] resize-y"
              placeholder="用一句话描述你的包装需求…"
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleNlParse();
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleNlParse}
            disabled={nlLoading || !nlText.trim()}
            className="btn-primary shrink-0 py-2.5"
          >
            {nlLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                解析中
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                智能解析
              </>
            )}
          </button>
        </div>
        {nlResult && (
          <div className="mt-3 rounded-lg border border-violet-200 bg-white/70 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={
                  nlResult.source === "llm"
                    ? "rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-700"
                    : "rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
                }
              >
                {nlResult.source === "llm" ? "大模型解析" : "关键词规则解析"}
              </span>
              <span className="text-brand-600">
                置信度 <strong>{nlResult.confidence}%</strong>
              </span>
              {nlResult.note && (
                <span className="text-brand-400">{nlResult.note}</span>
              )}
            </div>
            <NlpResultFields result={nlResult} config={config} />
          </div>
        )}
      </div>

      {/* AI 图纸视觉解析 */}
      <div className="card border-2 border-violet-300 bg-violet-50/50 p-5">
        <div className="flex items-center gap-2">
          <ScanLine className="h-5 w-5 text-violet-600" />
          <h3 className="text-sm font-semibold text-violet-900">
            AI 图纸视觉解析
          </h3>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700">
            上传图纸自动读参
          </span>
        </div>
        <p className="mt-1 text-xs text-violet-700">
          上传包装图纸 / 结构图 / 刀版图（支持图片或 PDF），AI 将读取盒型、尺寸、材质与工艺并自动填充。需配置支持视觉的模型（如本地 Ollama 的 qwen2.5vl）。
        </p>
        <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-violet-400 bg-white px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50">
          <ScanLine className="h-4 w-4" />
          选择图纸文件
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => handleDrawingFiles(e.target.files)}
            disabled={drawingLoading}
          />
        </label>
        {drawingPreviews.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {drawingPreviews.map((p) => (
              <div key={p.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.name}
                  className="h-20 w-20 rounded border border-violet-200 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeDrawing(p.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-red-500 p-0.5 text-white"
                  disabled={drawingLoading}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {drawingLoading && (
          <div className="mt-3 flex items-center gap-2 text-xs text-violet-700">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在识别图纸中…
          </div>
        )}
        {drawingResult && (
          <div className="mt-3 rounded-lg border border-violet-200 bg-white/70 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
                视觉解析
              </span>
              <span className="text-brand-600">
                置信度 <strong>{drawingResult.confidence}%</strong>
              </span>
              {drawingResult.note && (
                <span className="text-brand-400">{drawingResult.note}</span>
              )}
            </div>
            <NlpResultFields result={drawingResult} config={config} />
          </div>
        )}
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

/* ----------------------------------------------------------------------------
 * 图纸文件 → dataURL 的浏览器端预处理（图片降采样 + PDF 首页渲染）
 * 统一输出 JPEG，控制体积，避免超过服务端请求体上限（Vercel 函数体硬限 4.5MB）。
 * -------------------------------------------------------------------------- */

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 图片文件：加载后降采样到最长边 1280px，转 JPEG */
async function imageFileToDataUrl(
  file: File
): Promise<{ dataUrl: string; mime: string }> {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objUrl);
    const MAX = 1280;
    let { width, height } = img;
    if (width > MAX || height > MAX) {
      const ratio = Math.min(MAX / width, MAX / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    ctx.drawImage(img, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** PDF 文件：浏览器端渲染首页为图片（pdfjs worker 已离线化到 /public） */
async function pdfFileToDataUrls(
  file: File
): Promise<{ dataUrl: string; mime: string }[]> {
  const pdfjs = await import("pdfjs-dist");
  // 离线 worker：指向 /public 下的本地副本，避免依赖外部 CDN
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const out: { dataUrl: string; mime: string }[] = [];
  // 最多解析前 4 页，控制体积
  const maxPages = Math.min(doc.numPages, 4);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    // 目标宽度约 1100px，保持比例
    const scale = Math.min(2, 1100 / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    out.push({
      dataUrl: canvas.toDataURL("image/jpeg", 0.85),
      mime: "image/jpeg",
    });
  }
  return out;
}

/**
 * 解析结果展示：区分「大模型/规则已识别的参数」与「系统补全的默认值」。
 * - 已识别：从文本或图纸中提取的确定字段，用紫色高亮。
 * - 默认值：用户未提及、由系统套用工程基准的字段，用琥珀色并附原因。
 */
function NlpResultFields({
  result,
  config,
}: {
  result: NlpParseResult;
  config: ProductTypeConfig;
}) {
  const defaultedFields = new Set(result.defaults.map((d) => d.field));

  const recognized: { label: string; value: string }[] = [];
  for (const f of config.fields) {
    if (defaultedFields.has(f.key)) continue;
    const raw = result.input[f.key];
    if (raw === undefined || raw === "") continue;
    let value: string;
    if (f.type === "boolean") {
      value = raw ? "是" : "否";
    } else if (f.options && f.options.length > 0) {
      value = f.options.find((o) => o.value === String(raw))?.label ?? String(raw);
    } else {
      value = String(raw);
    }
    recognized.push({ label: f.label, value });
  }

  if (recognized.length === 0 && result.defaults.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {recognized.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-violet-700">
            已识别参数
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recognized.map((r, i) => (
              <span
                key={i}
                className="rounded bg-violet-100 px-2 py-0.5 text-xs text-violet-800"
                title="从描述/图纸中识别"
              >
                {r.label}：{r.value}
              </span>
            ))}
          </div>
        </div>
      )}
      {result.defaults.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-amber-700">
            系统默认值（请核对）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {result.defaults.map((d, i) => (
              <span
                key={i}
                className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                title={d.reason}
              >
                {d.label}：{String(d.value)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
