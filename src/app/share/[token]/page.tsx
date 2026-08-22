"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { BarChart3, Loader2, AlertCircle } from "lucide-react";
import { ReportStep } from "@/components/analyze/ReportStep";
import type { AnalysisReport } from "@/types";

export default function SharePage() {
  const params = useParams();
  const token = params.token as string;

  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expiresAt, setExpiresAt] = useState<string>("");

  useEffect(() => {
    async function loadReport() {
      try {
        const res = await fetch(`/api/share/${token}`);
        const data = await res.json();
        if (res.ok) {
          setReport(data.report);
          setSessionId(data.report?.sessionId || "");
          setExpiresAt(data.expiresAt);
        } else {
          setError(data.error || "加载失败");
        }
      } catch {
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    }
    loadReport();
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-red-400" />
        <p className="text-lg font-medium text-brand-800">{error}</p>
        <Link href="/" className="btn-primary">
          返回首页
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="border-b border-brand-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-brand-800" />
            <span className="text-base font-semibold text-brand-900">
              成本分析报告
            </span>
          </Link>
          {expiresAt && (
            <span className="text-xs text-brand-400">
              链接有效期至{" "}
              {new Date(expiresAt).toLocaleDateString("zh-CN")}
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-6">
        {report && <ReportStep report={report} sessionId={sessionId} />}
      </main>
    </div>
  );
}
