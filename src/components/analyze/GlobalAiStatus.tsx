"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  Settings,
  Wifi,
  WifiOff,
  CircleDashed,
  PowerOff,
} from "lucide-react";
import {
  getAiSettings,
  isSettingsUsable,
  type AiSettings,
} from "@/lib/config/ai-settings";
import { AiSettingsModal } from "@/components/analyze/AiSettingsModal";

type Status =
  | "unconfigured"
  | "disabled"
  | "checking"
  | "online"
  | "offline";

const META: Record<
  Status,
  { label: string; dot: string; text: string; icon: ReactNode }
> = {
  unconfigured: {
    label: "AI 未配置",
    dot: "bg-slate-300",
    text: "text-slate-600",
    icon: <CircleDashed className="h-3.5 w-3.5" />,
  },
  disabled: {
    label: "AI 已关闭",
    dot: "bg-slate-400",
    text: "text-slate-600",
    icon: <PowerOff className="h-3.5 w-3.5" />,
  },
  checking: {
    label: "AI 检测中…",
    dot: "bg-amber-400 animate-pulse",
    text: "text-amber-600",
    icon: <CircleDashed className="h-3.5 w-3.5 animate-spin" />,
  },
  online: {
    label: "AI 在线",
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    icon: <Wifi className="h-3.5 w-3.5" />,
  },
  offline: {
    label: "AI 离线",
    dot: "bg-rose-500",
    text: "text-rose-600",
    icon: <WifiOff className="h-3.5 w-3.5" />,
  },
};

export function GlobalAiStatus() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<Status>("checking");
  const [detail, setDetail] = useState<string>("");
  const [open, setOpen] = useState(false);

  const probe = useCallback(async () => {
    const cfg: AiSettings | null = getAiSettings();
    if (!cfg) {
      setStatus("unconfigured");
      setDetail("");
      return;
    }
    if (cfg.provider === "disabled") {
      setStatus("disabled");
      setDetail("");
      return;
    }
    if (!isSettingsUsable(cfg)) {
      setStatus("unconfigured");
      setDetail("");
      return;
    }
    setStatus("checking");
    try {
      const res = await fetch("/api/ai-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: cfg }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (res.ok && data.ok) {
        setStatus("online");
      } else {
        setStatus("offline");
      }
      setDetail(data.message ?? "");
    } catch {
      setStatus("offline");
      setDetail("无法连接检测接口");
    }
  }, []);

  useEffect(() => {
    probe();
    const t = setInterval(probe, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", probe);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", probe);
    };
  }, [probe]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const meta = META[status];

  // 避免 SSR 与客户端路径不一致导致闪烁；新工作台 /work 与载入页 /intro 已自带 AI 状态入口
  if (!mounted || pathname === "/work" || pathname === "/intro") {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={detail || meta.label}
        className="fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-white"
      >
        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
        <span className={meta.text}>{meta.label}</span>
        <Settings className="h-3.5 w-3.5 text-slate-400" />
      </button>

      <AiSettingsModal
        open={open}
        onClose={() => {
          setOpen(false);
          // 配置可能已变更，关闭后重新探测在线状态
          probe();
        }}
      />
    </>
  );
}
