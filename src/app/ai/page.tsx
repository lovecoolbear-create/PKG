"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 旧 AI 工作台已并入统一工作台 /work（中栏对话 + 右栏结构化产出），保留本路由仅作跳转兼容
export default function AiWorkspacePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/work");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
      <div className="text-center">
        <p className="text-base font-medium">正在跳转到新工作台…</p>
        <p className="mt-1 text-sm text-slate-400">AI 副驾驶已内置在工作台内</p>
      </div>
    </div>
  );
}
