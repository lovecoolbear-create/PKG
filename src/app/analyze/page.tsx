"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 旧分析页已合并到统一工作台 /work，保留本路由仅作跳转兼容
export default function AnalyzePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/work");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
      <div className="text-center">
        <p className="text-base font-medium">正在跳转到新工作台…</p>
        <p className="mt-1 text-sm text-slate-400">成本分析与 VAVE 已合并为统一入口</p>
      </div>
    </div>
  );
}
