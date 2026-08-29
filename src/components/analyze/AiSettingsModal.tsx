"use client";

import { useEffect, useState } from "react";
import {
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
  TestTube2,
} from "lucide-react";
import {
  type AiSettings as AiSettingsType,
  getAiSettings,
  saveAiSettings,
  isLocalBase,
  OPENAI_PRESET,
  DISABLED_PRESET,
  LM_STUDIO_PRESET,
} from "@/lib/config/ai-settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

const PRESETS: {
  key: string;
  label: string;
  desc: string;
  value: AiSettingsType;
}[] = [
  {
    key: "lmstudio",
    label: "本地 LM Studio（推荐）",
    desc: "OpenAI 兼容 / 离线 · 所有模型统一部署",
    value: LM_STUDIO_PRESET,
  },
  {
    key: "openai",
    label: "云端 API",
    desc: "OpenAI / DeepSeek / 通义",
    value: OPENAI_PRESET,
  },
  { key: "disabled", label: "关闭 AI", desc: "纯规则速算", value: DISABLED_PRESET },
];

export function AiSettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AiSettingsType>(LM_STUDIO_PRESET);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // 打开时载入已保存配置
  useEffect(() => {
    if (!open) return;
    const savedCfg = getAiSettings();
    setSettings(savedCfg ?? LM_STUDIO_PRESET);
    setSaved(!!savedCfg);
    setTestResult(null);
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<AiSettingsType>) =>
    setSettings((s) => ({ ...s, ...patch }));

  const applyPreset = (p: AiSettingsType) => {
    setSettings(p);
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), 30000);
    try {
      const res = await fetch("/api/ai-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
        cache: "no-store",
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      const data = await res.json();
      setTestResult({
        ok: !!data.ok,
        message: data.message || (data.ok ? "连接成功" : "连接失败"),
      });
    } catch (e) {
      window.clearTimeout(timeout);
      const raw = e instanceof Error ? e.message : String(e);
      const isTimeout =
        raw.includes("timeout") ||
        raw.includes("aborted");
      const message = isTimeout
        ? "连接超时或中断：请确认后端已启动且端口正确，或检查代理/VPN 拦截"
        : raw.includes("fetch")
          ? "网络异常，无法发起测试请求"
          : `网络异常：${raw}`;
      setTestResult({ ok: false, message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    saveAiSettings(settings);
    setSaved(true);
    onClose();
  };

  const isDisabled = settings.provider === "disabled";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-brand-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-violet-600" />
            <h2 className="text-lg font-bold text-brand-900">
              AI 模型配置中心
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-lg text-brand-400 hover:text-brand-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {/* 预设快捷切换 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.value)}
                className={
                  settings.provider === p.value.provider &&
                  settings.baseUrl === p.value.baseUrl
                    ? "rounded-lg border-2 border-violet-600 bg-violet-50 px-2 py-3 text-center"
                    : "rounded-lg border border-brand-200 bg-white px-2 py-3 text-center hover:bg-brand-50"
                }
              >
                <div className="text-xs font-semibold text-brand-900">
                  {p.label}
                </div>
                <div className="mt-0.5 text-[11px] text-brand-500">{p.desc}</div>
              </button>
            ))}
          </div>

          {isDisabled ? (
            <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-brand-600">
              已选择「关闭 AI」。系统将仅使用确定性规则速算，AI 解析 / 实时行情 /
              SQE 诊断将回退到内置逻辑。
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="label">API 地址 (Base URL)</label>
                <input
                  className="input-field"
                  placeholder="http://localhost:1234（LM Studio）或 https://api.openai.com/v1"
                  value={settings.baseUrl}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                />
                <p className="mt-1 text-xs text-brand-400">
                  LM Studio 默认 <code>http://localhost:1234</code>（本机所有模型统一部署于此）；
                  云端填 OpenAI 兼容端点（代码会自动规范化为 /v1）。
                </p>
              </div>

              {settings.provider === "openai-compatible" &&
                (isLocalBase(settings.baseUrl) ? (
                  <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-brand-600">
                    本地兼容端点（如 LM Studio）：通常不校验密钥，API Key 可留空。
                  </p>
                ) : (
                  <div>
                    <label className="label">API Key</label>
                    <input
                      className="input-field"
                      type="password"
                      placeholder="sk-..."
                      value={settings.apiKey}
                      onChange={(e) => update({ apiKey: e.target.value })}
                    />
                  </div>
                ))}

              <div>
                <label className="label">模型名称 (Model)</label>
                <input
                  className="input-field"
                  placeholder="qwen2.5 / gemma2 / deepseek-chat / gpt-4o-mini"
                  value={settings.modelName}
                  onChange={(e) => update({ modelName: e.target.value })}
                />
              </div>

              <div>
                <label className="label">视觉模型（选填，LM Studio 专用小模型）</label>
                <input
                  className="input-field"
                  placeholder="qwen2.5-vl-3b（建议填，与 27B 分载轮换；留空则复用主模型）"
                  value={settings.visionModel ?? ""}
                  onChange={(e) => update({ visionModel: e.target.value })}
                />
                <p className="mt-1 text-xs text-brand-400">
                  视觉解析建议单独填一个小视觉模型（如 qwen2.5-vl-3b，约 2.5GB），
                  与 NLP 主模型 qwen3.8-27b 同在 LM Studio、由 JIT 自动轮换，互不占显存、不冲突。
                  留空则回退复用主模型。
                </p>
              </div>

              {/* 测试连接 */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="btn-secondary inline-flex items-center gap-1.5"
                >
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <TestTube2 className="h-4 w-4" />
                  )}
                  {testing ? "测试中…" : "测试连接"}
                </button>
                {testResult && (
                  <span
                    className={
                      testResult.ok
                        ? "inline-flex items-center gap-1 text-sm text-green-600"
                        : "inline-flex items-center gap-1 text-sm text-red-500"
                    }
                  >
                    {testResult.ok ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-brand-100 px-6 py-4">
          <span className="text-xs text-brand-400">
            {saved
              ? "✓ 配置已保存（下次发起分析时生效）"
              : "配置仅保存在本机浏览器"}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">
              取消
            </button>
            <button onClick={handleSave} className="btn-primary">
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
