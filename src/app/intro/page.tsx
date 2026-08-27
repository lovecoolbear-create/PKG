"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Cpu,
  CheckCircle2,
  Loader2,
  ArrowRight,
  Shield,
  BarChart3,
  Zap,
  FileText,
  Share2,
  CircleSlash,
} from "lucide-react";
import {
  getAiSettings,
  isSettingsUsable,
  type AiSettings,
} from "@/lib/config/ai-settings";
import { aiReadyStore, type AiReadyStatus } from "@/lib/ai-ready-store";

type WarmStage = "idle" | "warming" | "ready" | "failed";

const FEATURES = [
  {
    icon: Shield,
    title: "透明可解释",
    desc: "每个成本维度都有明确的计算依据与假设说明，置信度评级让您了解估算可靠程度。",
  },
  {
    icon: BarChart3,
    title: "五维成本拆解",
    desc: "材料、工艺（含设备）、人工、制版、财务 五维精细拆解，制造成本与商业成本清晰分类。",
  },
  {
    icon: Zap,
    title: "优化建议",
    desc: "自动识别成本优化空间，提供可操作的 VAVE 方向建议，助力供应链降本。",
  },
];

const STEPS = [
  {
    step: "01",
    title: "上传资料",
    desc: "上传设计图纸（PDF/图片）和产品照片，系统自动识别基本特征",
  },
  {
    step: "02",
    title: "补充信息",
    desc: "填写订单数量、尺寸、材质、印刷方式等关键参数，实时查看信息完整度",
  },
  {
    step: "03",
    title: "获取报告",
    desc: "生成多维度成本报告，支持 PDF 导出与分享链接，方便团队讨论",
  },
];

export default function IntroPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usable, setUsable] = useState(false);
  const [stage, setStage] = useState<WarmStage>("idle");
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const s = getAiSettings();
    setSettings(s);
    const ok = !!s && isSettingsUsable(s);
    setUsable(ok);
    if (!s) {
      aiReadyStore.set({ status: "unconfigured", message: "未配置 AI，可离线使用" });
    } else if (s.provider === "disabled") {
      aiReadyStore.set({ status: "disabled", message: "AI 已关闭，纯规则速算" });
    }
  }, []);

  async function warmup() {
    if (!settings || !usable) return;
    setStage("warming");
    setMsg("正在连接模型服务并等待就绪…");
    setLog(["已读取本地配置"]);
    try {
      const res = await fetch("/api/ai/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        model?: string;
        status?: string;
      };
      if (data.ok) {
        setStage("ready");
        setMsg(data.message ?? "模型已就绪");
        setLog((p) => [...p, "已触发模型加载", "模型就绪 ✓"]);
        aiReadyStore.set({
          status: "online",
          model: data.model ?? settings.modelName,
          message: data.message ?? "",
        });
      } else {
        setStage("failed");
        setMsg(data.message ?? "预热失败，请重试或离线进入");
        setLog((p) => [...p, `模型未就绪：${data.message ?? ""}`]);
        if (data.status) {
          aiReadyStore.set({
            status: data.status as AiReadyStatus,
            message: data.message ?? "",
          });
        }
      }
    } catch {
      setStage("failed");
      setMsg("预热请求异常，可离线进入工作台");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-900 via-brand-800 to-brand-900 text-white">
      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Sparkles className="h-8 w-8 text-accent-orange" />
          <span className="text-xl font-semibold">包装降本分析工作台</span>
        </div>

        {/* Hero */}
        <section className="mt-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            专业、透明的包装成本拆解与 VAVE 工作台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">
            上传设计图纸，补充关键参数，快速获取五维成本拆解与优化建议；
            并可绑定 AI 副驾驶，基于你的资料给出可溯源的解读与谈判策略。
          </p>
          <p className="mt-4 text-sm text-brand-300">
            本工具提供估算参考，不构成正式报价
          </p>
        </section>

        {/* Features */}
        <section className="mt-12 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-white/10 bg-white/5 p-6"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-orange/20">
                <f.icon className="h-5 w-5 text-accent-orange" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-brand-200">{f.desc}</p>
            </div>
          ))}
        </section>

        {/* Steps */}
        <section className="mt-10">
          <h2 className="text-center text-xl font-semibold text-brand-100">
            三步完成成本分析
          </h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.step}
                className="relative rounded-xl bg-white/5 p-5 pl-16"
              >
                <span className="absolute left-4 top-4 text-3xl font-bold text-brand-300">
                  {s.step}
                </span>
                <h3 className="text-base font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-brand-200">{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* AI warmup card */}
        <section className="mt-12 rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-accent-orange" />
            <h2 className="text-lg font-semibold">本地 AI 模型预热</h2>
          </div>
          <p className="mt-2 text-sm text-brand-200">
            工作台内置 AI 副驾驶（基于本地 LM Studio / Ollama）。进入前可先连接并加载模型，
            状态灯将在工作台内实时可见。
          </p>

          {!usable && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">
              <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {settings?.provider === "disabled"
                  ? "AI 已关闭，将使用纯规则速算（离线）。可直接进入工作台。"
                  : "尚未配置 AI 模型。可在工作台内随时配置，或先离线进入。"}
              </span>
            </div>
          )}

          {usable && (
            <div className="mt-4">
              <button
                type="button"
                onClick={warmup}
                disabled={stage === "warming"}
                className="inline-flex items-center gap-2 rounded-lg bg-accent-orange px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-60"
              >
                {stage === "warming" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Cpu className="h-4 w-4" />
                )}
                {stage === "warming" ? "正在加载并连接…" : "连接并加载本地模型"}
              </button>

              {(stage === "warming" || stage === "ready" || stage === "failed") && (
                <div className="mt-4 space-y-1.5">
                  {log.map((line, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm text-brand-200"
                    >
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      {line}
                    </div>
                  ))}
                  {stage === "warming" && (
                    <div className="flex items-center gap-2 text-sm text-brand-200">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {msg}
                    </div>
                  )}
                  {stage === "ready" && (
                    <div className="flex items-center gap-2 text-sm text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                      {msg}
                    </div>
                  )}
                  {stage === "failed" && (
                    <div className="flex items-center gap-2 text-sm text-rose-300">
                      <CircleSlash className="h-4 w-4" />
                      {msg}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Enter CTA */}
        <section className="mt-10 flex flex-col items-center gap-4">
          <Link
            href="/work"
            className="inline-flex items-center gap-2 rounded-lg bg-white px-8 py-3 text-base font-semibold text-brand-900 hover:bg-brand-100"
          >
            {stage === "ready" ? "进入工作台（AI 已就绪）" : "进入工作台"}
            <ArrowRight className="h-5 w-5" />
          </Link>
          <div className="flex items-center gap-4 text-sm text-brand-300">
            <Link href="/admin/knowledge" className="hover:text-white">
              知识库
            </Link>
            <Link href="/calibration-intake" className="hover:text-white">
              校准录入
            </Link>
            <Link href="/vave" className="hover:text-white">
              VAVE 降本
            </Link>
            <Link href="/ai" className="hover:text-white">
              AI 资料室
            </Link>
          </div>
          <p className="text-xs text-brand-400">
            AI 未就绪也可离线进入；工作台内可随时在左下角状态灯处配置模型。
          </p>
        </section>
      </div>
    </div>
  );
}
