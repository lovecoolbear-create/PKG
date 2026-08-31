"use client";

import { useState } from "react";
import { Sparkles, Loader2, ScanLine, X, Ruler, AlertCircle, CheckCircle2 } from "lucide-react";
import type {
  AnalysisInput,
  ClarificationQuestion,
  ProductField,
  ProductTypeConfig,
} from "@/types";
import { getLaborRegionOptions } from "@/lib/cost-rules/labor-regions";
import {
  generateQuestions,
  selectQuestionsForRound,
  getCompletenessPrompt,
} from "@/lib/agents/question-engine";
import { calculateCompleteness, isFieldVisible } from "@/lib/completeness";
import type { NlpParseResult } from "@/lib/agents/nlp-parser";
import { runInputGuardrail, type GuardrailIssue } from "@/lib/agents/input-guardrail";
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
  // 生产地域/交付地点已在上方醒目块单独处理，主分组不再重复渲染该字段
  const groups = groupFields(
    config.fields.filter((f) => f.key !== "deliveryLocation")
  );
  const regionOptions = getLaborRegionOptions();

  // AI 智能一键填单（自然语言解析）
  const [nlText, setNlText] = useState("");
  const [nlLoading, setNlLoading] = useState(false);
  const [nlResult, setNlResult] = useState<NlpParseResult | null>(null);
  /** 解析结果是否已确认填充（强制确认闸门：未确认前不回填表单） */
  const [nlConfirmed, setNlConfirmed] = useState(false);

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
  /** 图纸解析结果是否已确认填充 */
  const [drawingConfirmed, setDrawingConfirmed] = useState(false);

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
        body: JSON.stringify({
          text,
          aiSettings: getAiSettings() ?? undefined,
          productType: config.code,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // 强制确认闸门：先展示解析结果与校验，用户点「确认并填充」才回填，避免 AI 误填直接进表单
        setNlResult(data);
        setNlConfirmed(false);
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
        setDrawingConfirmed(false);
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

  const updateField = (
    key: string,
    value: string | number | boolean | object | undefined
  ) => {
    onChange({ ...input, [key]: value });
  };

  // 主动提问：按影响层级+权重列出仍缺失字段；每轮只推少量高影响项（地域单独用上方选择器，已并入 deliveryLocation）
  const allQuestions = generateQuestions(
    config,
    input,
    new Set(answeredKeys),
    new Set(skippedKeys)
  );
  const visibleQuestions = selectQuestionsForRound(allQuestions);
  const highMissing = allQuestions
    .filter((q) => q.priority === "high")
    .map((q) => ({ key: q.key, label: q.label, impact: q.impact }));
  const completenessResult = calculateCompleteness(config, input);
  const completenessPrompt = getCompletenessPrompt(
    completenessResult.score,
    highMissing
  );

  const missingKeys = new Set(completenessResult.missing.map((m) => m.key));
  const visibleMissing = completenessResult.missing.slice(0, 6);

  const scrollToField = (key: string) => {
    const el = document.getElementById(`field-${key}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-brand-400", "rounded-lg");
      setTimeout(() => el.classList.remove("ring-2", "ring-brand-400", "rounded-lg"), 1500);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-brand-900">补充产品关键信息</h2>
        <p className="mt-1 text-sm text-brand-600">
          请填写以下参数，信息越完整，成本估算越准确。带 * 号为必填项。
        </p>
      </div>

      {/* 吸顶完成度与未填提示 */}
      <div className="sticky top-0 z-10 -mx-2 border-b border-slate-200 bg-white/95 px-2 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            {completenessResult.score >= 90 ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertCircle className="h-4 w-4 text-amber-600" />
            )}
            信息完整度 {completenessResult.score}%
          </div>
          <span className="text-xs text-slate-500">
            已填 {completenessResult.filled.length} / {config.fields.filter((f) => isFieldVisible(f, input)).length} 项
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-2 rounded-full transition-all ${
              completenessResult.score >= 90 ? "bg-emerald-500" : completenessResult.score >= 60 ? "bg-brand-500" : "bg-amber-500"
            }`}
            style={{ width: `${completenessResult.score}%` }}
          />
        </div>
        {visibleMissing.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">未填项：</span>
            {visibleMissing.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => scrollToField(m.key)}
                title={m.impact}
                className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-100"
              >
                {m.label}
              </button>
            ))}
            {completenessResult.missing.length > visibleMissing.length && (
              <span className="text-xs text-slate-400">+{completenessResult.missing.length - visibleMissing.length}</span>
            )}
          </div>
        )}
        {visibleMissing.length === 0 && completenessResult.score < 100 && (
          <p className="mt-2 text-xs text-slate-500">剩余项为可选/高级参数，可直接生成报告。</p>
        )}
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
          {config.code === "flat_print"
            ? "直接用大白话描述需求即可，例如「做 5000 本 A4 画册，157g 铜版纸，四色胶装，覆哑膜」。系统将解析并自动填充参数。"
            : "直接用大白话描述需求即可，例如「做 3000 个海鲜礼盒，要防水，做高级一点的天地盖」。系统将解析并自动填充参数。"}
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
              <span
                className={
                  nlResult.confidence >= 80
                    ? "rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700"
                    : nlResult.confidence >= 60
                      ? "rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700"
                      : "rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700"
                }
              >
                置信度 {nlResult.confidence}%
              </span>
              {nlResult.note && (
                <span className="text-brand-400">{nlResult.note}</span>
              )}
            </div>
            <NlpResultFields result={nlResult} config={config} />
            <ParseConfirmGate
              result={nlResult}
              config={config}
              input={input}
              confirmed={nlConfirmed}
              onConfirm={() => {
                applyParseResult(nlResult);
                setNlConfirmed(true);
              }}
            />
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
          {config.code === "flat_print"
            ? "上传 PDF 设计稿或成品样图（支持图片或 PDF），AI 将读取尺寸、页数、材质与工艺并自动填充。需配置支持视觉的模型（如 LM Studio 的 qwen2.5-vl-3b）。"
            : "上传包装图纸 / 结构图 / 刀版图（支持图片或 PDF），AI 将读取盒型、尺寸、材质与工艺并自动填充。需配置支持视觉的模型（如 LM Studio 的 qwen2.5-vl-3b）。"}
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
              <span
                className={
                  drawingResult.confidence >= 80
                    ? "rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700"
                    : drawingResult.confidence >= 60
                      ? "rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700"
                      : "rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700"
                }
              >
                置信度 {drawingResult.confidence}%
              </span>
              {drawingResult.note && (
                <span className="text-brand-400">{drawingResult.note}</span>
              )}
            </div>
            <NlpResultFields result={drawingResult} config={config} />
            <ParseConfirmGate
              result={drawingResult}
              config={config}
              input={input}
              confirmed={drawingConfirmed}
              onConfirm={() => {
                applyParseResult(drawingResult);
                setDrawingConfirmed(true);
              }}
            />
          </div>
        )}
      </div>

      {/* 生产地域 / 交付地点（醒目，影响人工与物流成本；与下方表单二选一的唯一入口） */}
      <div id="field-deliveryLocation" className="card border-2 border-brand-300 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-brand-900">
              生产地域 / 交付地点 <span className="text-brand-400">（影响人工与物流成本）</span>
            </h3>
            <p className="mt-1 text-xs text-brand-500">
              未选择将默认按「华东地区」估算，并在报告中标注
            </p>
          </div>
          {!input.deliveryLocation && (
            <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700">
              当前：默认华东
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          {regionOptions.map((opt) => {
            const active = input.deliveryLocation === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onAnswered("deliveryLocation", opt.value)}
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

      {/* 理论面积与拼版（高级，用于理论成本与客户展示） */}
      {config.code === "color_print_box" ? (
        <div className="card border-2 border-sky-300 bg-sky-50/50 p-5">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-sky-600" />
            <h3 className="text-sm font-semibold text-sky-900">
              理论面积与拼版（高级）
            </h3>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
              理论成本 / 利用率
            </span>
          </div>
          <p className="mt-1 text-xs text-sky-700">
            用于向客户展示「理论使用面积占比」并核算真实耗纸。填「理论展开面积」将覆盖按尺寸的矩形展开估算；填「全张纸尺寸
            + 每版只数」将按真实拼版计算利用率与实际生产面积（报价用）。
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="f-dielineAreaMm2">理论展开面积 (mm²)</label>
              <input
                id="f-dielineAreaMm2"
                type="number"
                className="input-field"
                placeholder="如 180000"
                value={input.dielineAreaMm2 ?? ""}
                onChange={(e) =>
                  updateField(
                    "dielineAreaMm2",
                    e.target.value === "" ? undefined : Number(e.target.value)
                  )
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-piecesPerSheet">每版只数</label>
              <input
                id="f-piecesPerSheet"
                type="number"
                className="input-field"
                placeholder="如 12"
                value={input.piecesPerSheet ?? ""}
                onChange={(e) =>
                  updateField(
                    "piecesPerSheet",
                    e.target.value === "" ? undefined : Number(e.target.value)
                  )
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-sheetW">全张纸宽 (mm)</label>
              <input
                id="f-sheetW"
                type="number"
                className="input-field"
                placeholder="如 700"
                value={input.sheetSize ? (input.sheetSize.w || "") : ""}
                onChange={(e) =>
                  updateField("sheetSize", {
                    w: e.target.value === "" ? 0 : Number(e.target.value),
                    h: input.sheetSize?.h || 0,
                  })
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-sheetH">全张纸高 (mm)</label>
              <input
                id="f-sheetH"
                type="number"
                className="input-field"
                placeholder="如 1000"
                value={input.sheetSize ? (input.sheetSize.h || "") : ""}
                onChange={(e) =>
                  updateField("sheetSize", {
                    w: input.sheetSize?.w || 0,
                    h: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
              />
            </div>
          </div>
          {Array.isArray(input.dielineShapes) &&
            input.dielineShapes.length > 0 && (
              <p className="mt-2 text-xs text-sky-700">
                已从图纸识别出 {input.dielineShapes.length}{" "}
                个刀线图形（异形/开窗盒真实展开面积由图形累计得出）。
              </p>
            )}
          <p className="mt-2 text-xs text-brand-500">
            未填全张纸/只数时，按盒型默认拼版利用率（≈85%）估算；图形清单可由 AI
            图纸解析自动生成。
          </p>
        </div>
      ) : (
        <div className="card border-2 border-sky-300 bg-sky-50/50 p-5">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-sky-600" />
            <h3 className="text-sm font-semibold text-sky-900">
              拼版信息（高级）
            </h3>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
              理论成本 / 利用率
            </span>
          </div>
          <p className="mt-1 text-xs text-sky-700">
            用于核算画册/海报真实耗纸与利用率。填「单页成品面积」将覆盖按长×宽的估算；填「全张纸尺寸
            + 每版页数」将按真实拼版计算利用率与实际生产面积（报价用）。
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="f-dielineAreaMm2">单页成品面积 (mm²)</label>
              <input
                id="f-dielineAreaMm2"
                type="number"
                className="input-field"
                placeholder="如 60000"
                value={input.dielineAreaMm2 ?? ""}
                onChange={(e) =>
                  updateField(
                    "dielineAreaMm2",
                    e.target.value === "" ? undefined : Number(e.target.value)
                  )
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-piecesPerSheet">每版页数</label>
              <input
                id="f-piecesPerSheet"
                type="number"
                className="input-field"
                placeholder="如 16"
                value={input.piecesPerSheet ?? ""}
                onChange={(e) =>
                  updateField(
                    "piecesPerSheet",
                    e.target.value === "" ? undefined : Number(e.target.value)
                  )
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-sheetW">全张纸宽 (mm)</label>
              <input
                id="f-sheetW"
                type="number"
                className="input-field"
                placeholder="如 700"
                value={input.sheetSize ? (input.sheetSize.w || "") : ""}
                onChange={(e) =>
                  updateField("sheetSize", {
                    w: e.target.value === "" ? 0 : Number(e.target.value),
                    h: input.sheetSize?.h || 0,
                  })
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="f-sheetH">全张纸高 (mm)</label>
              <input
                id="f-sheetH"
                type="number"
                className="input-field"
                placeholder="如 1000"
                value={input.sheetSize ? (input.sheetSize.h || "") : ""}
                onChange={(e) =>
                  updateField("sheetSize", {
                    w: input.sheetSize?.w || 0,
                    h: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
              />
            </div>
          </div>
          {Array.isArray(input.dielineShapes) &&
            input.dielineShapes.length > 0 && (
              <p className="mt-2 text-xs text-sky-700">
                已从图纸识别出 {input.dielineShapes.length}{" "}
                个图形区域（用于核算单页/异形成品面积）。
              </p>
            )}
          <p className="mt-2 text-xs text-brand-500">
            未填全张纸/页数时，按平面默认拼版利用率估算；单页面积默认取「长×宽」。
          </p>
        </div>
      )}

      {/* 信息完整度 + 误差降低提示 */}
      <div
        className={
          completenessResult.score >= 90
            ? "card border border-emerald-200 bg-emerald-50/50 p-4"
            : completenessPrompt.level === "high"
              ? "card border border-red-200 bg-red-50/50 p-4"
              : "card border border-amber-200 bg-amber-50/40 p-4"
        }
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-brand-900">
            信息完整度
          </span>
          <span className="text-sm font-bold text-brand-700">
            {completenessResult.score}%
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-brand-100">
          <div
            className="h-2 rounded-full bg-brand-500"
            style={{ width: `${completenessResult.score}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-brand-600">{completenessPrompt.text}</p>
      </div>

      {/* 关键参数确认（只读提示，点击定位到下方表单对应输入框，避免与主表单重复录入） */}
      {visibleQuestions.length > 0 && (
        <div className="card border border-amber-200 bg-amber-50/40 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-xs text-white">
              ?
            </span>
            为提升估算精度，建议优先确认以下关键参数
          </h3>
          <p className="mt-1 text-xs text-amber-700">
            以下为对成本影响最大的参数。点击「去填写」可定位到下方对应输入框；其余项也可直接生成报告，由系统套用合理默认假设并在报告中标注。
          </p>
          <div className="mt-4 space-y-3">
            {visibleQuestions.map((q) => (
              <QuestionCard
                key={q.key}
                question={q}
                onLocate={() => scrollToField(q.key)}
              />
            ))}
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
                isMissing={missingKeys.has(field.key)}
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
  onLocate,
}: {
  question: ClarificationQuestion;
  onLocate: () => void;
}) {
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
        <span
          className={
            question.priority === "high"
              ? "shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700"
              : "shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
          }
        >
          {question.priority === "high" ? "高影响" : "建议补充"}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onLocate}
          className="btn-secondary shrink-0 py-2"
        >
          去填写
        </button>
        {question.defaultLabel && (
          <span className="text-xs text-slate-400">
            跳过将默认：{question.defaultLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 解析结果「强制确认」闸门：AI/规则解析出的字段不直接回填表单，
 * 先在此卡片展示解析值与确定性 Guardrail 校验结果，用户点「确认并填充」才写入。
 * - 存在 block 级校验（如数量≤0、枚举非法）时禁用确认，强制先修正；
 * - 仅 warn 级（如尺寸疑似单位混淆）仍允许确认，但明示风险。
 */
function ParseConfirmGate({
  result,
  config,
  input,
  confirmed,
  onConfirm,
}: {
  result: NlpParseResult;
  config: ProductTypeConfig;
  input: AnalysisInput;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  const guard = runInputGuardrail({ ...input, ...result.input }, config);
  const hasBlock = guard.blockers.length > 0;

  if (confirmed) {
    return (
      <div className="mt-2 flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已填充至表单（可继续在下方修改）
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {guard.issues.length > 0 && (
        <ul className="space-y-1">
          {guard.issues.map((iss: GuardrailIssue, i: number) => (
            <li
              key={i}
              className={
                iss.severity === "block"
                  ? "rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-700"
                  : "rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-700"
              }
            >
              {iss.severity === "block" ? "⛔ " : "⚠️ "}
              {iss.message}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onConfirm}
        disabled={hasBlock}
        className={
          hasBlock
            ? "btn-secondary w-full cursor-not-allowed py-2 opacity-60"
            : "btn-primary w-full py-2"
        }
      >
        {hasBlock ? "请先修正上方校验问题再填充" : "确认并填充以上参数"}
      </button>
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
  isMissing,
}: {
  field: ProductField;
  value: string | number | boolean | object | undefined;
  onChange: (v: string | number | boolean | undefined) => void;
  isMissing?: boolean;
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

  const wrapperCls = isMissing
    ? "rounded-lg border border-amber-300 bg-amber-50/30 p-2 -m-2 transition-colors"
    : "";
  const inputCls = isMissing ? "input-field border-amber-300 focus:border-brand-500" : "input-field";

  switch (field.type) {
    case "select":
      return (
        <div id={`field-${field.key}`} className={wrapperCls}>
          {label}
          <select
            className={inputCls}
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
        <div id={`field-${field.key}`} className={wrapperCls}>
          {label}
          <input
            type="number"
            className={inputCls}
            placeholder={field.placeholder}
            value={value !== undefined && value !== null ? String(value) : ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : Number(e.target.value))
            }
          />
        </div>
      );

    case "boolean":
      return (
        <div id={`field-${field.key}`} className={`flex items-center gap-3 pt-6 ${wrapperCls}`}>
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
        <div id={`field-${field.key}`} className={`sm:col-span-2 ${wrapperCls}`}>
          {label}
          <input
            type="text"
            className={inputCls}
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

  const sourceBadge: Record<string, { text: string; cls: string }> = {
    deterministic: { text: "确定性", cls: "bg-emerald-100 text-emerald-700" },
    ai_extracted: { text: "AI抽取", cls: "bg-red-100 text-red-700" },
    inferred: { text: "推断", cls: "bg-amber-100 text-amber-700" },
  };

  return (
    <div className="mt-3 space-y-2">
      {(() => {
        const c = result.confidence;
        const level =
          c >= 80
            ? { t: "高", cls: "bg-emerald-100 text-emerald-700" }
            : c >= 60
              ? { t: "中", cls: "bg-amber-100 text-amber-700" }
              : { t: "低", cls: "bg-red-100 text-red-700" };
        return (
          <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5">
            <span className="text-xs text-slate-600">解析整体置信度</span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${level.cls}`}>
              {level.t}（{c}%）
            </span>
          </div>
        );
      })()}
      {result.confidence < 70 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          ⚠️ 解析置信度偏低，文本中可能缺少品类/尺寸/工艺等关键参数或存在矛盾，生成报告前请逐字段核对。
        </div>
      )}
      {recognized.length === 0 && result.defaults.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          ⚠️ 未能从文本中提取到任何有效参数，已全部套用系统默认（{result.defaults.length} 项）。请确认品类与关键规格是否正确。
        </div>
      )}
      {result.requiresHumanConfirmation && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          ⚠️ 解析结果含 AI 抽取字段（尤其尺寸/工艺），请逐字段核对后再生成报告。
          确定性抽取的尺寸已标注「确定性」，其余须人工确认。
        </div>
      )}
      {recognized.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-violet-700">
            已识别参数
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recognized.map((r, i) => {
              const src = result.fieldSource?.[r.label] ?? result.fieldSource?.[config.fields.find((f) => f.label === r.label)?.key ?? ""];
              const badge = src ? sourceBadge[src] : undefined;
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded bg-violet-100 px-2 py-0.5 text-xs text-violet-800"
                  title="从描述/图纸中识别"
                >
                  {r.label}：{r.value}
                  {badge && (
                    <span className={`rounded px-1 text-[10px] ${badge.cls}`}>
                      {badge.text}
                    </span>
                  )}
                </span>
              );
            })}
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
