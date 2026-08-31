"use client";

import { useState } from "react";

/**
 * 一键跑校准：服务端执行 scripts/calibration-real.ts，回传汇总与完整报告。
 * 省掉"开终端敲命令"这一步，攒够案例后点一下就能看到偏差。
 */

interface DimRow {
  dim: string;
  count: number;
  total: number;
}

interface RunResult {
  ok: boolean;
  exitCode: number;
  summary: { targetPct: number; inTarget: number; total: number; dims: DimRow[] } | null;
  report: string;
  stdoutTail: string;
  stderr: string;
}

export function CalibrationRunner({ caseCount }: { caseCount: number | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/calibration/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok && !data.summary) {
        setErr(data.error || "校准执行失败");
        setResult(null);
      } else {
        setResult(data as RunResult);
        if (data.error) setErr(String(data.error));
      }
    } catch (e) {
      setErr("请求失败：" + String(e));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!result?.report) return;
    const blob = new Blob([result.report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cost-calibration-real_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const enough = (caseCount ?? 0) > 0;

  return (
    <section className="card mb-5 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-brand-900">跑校准</h2>
          <p className="mt-1 text-xs text-brand-500">
            对全部已录案例跑真实 Agent 路径，输出「引擎估算 vs 实际报价」偏差。等价于终端执行{" "}
            <code className="rounded bg-brand-50 px-1">npm run test:calibration:real</code>。
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={run} disabled={busy || !enough}>
          {busy ? "运行中…（约数十秒）" : "跑一轮校准"}
        </button>
      </div>

      {!enough && (
        <p className="text-sm text-amber-700">还没有案例，先录入或批量导入再跑。</p>
      )}

      {err && <p className="text-sm text-red-700">错误：{err}</p>}

      {result?.summary && (
        <div className="mt-3">
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <span className="text-sm text-brand-800">
              总价落入 ±{result.summary.targetPct}%：
              <strong className="ml-1 text-base">
                {result.summary.inTarget}/{result.summary.total}
              </strong>
            </span>
            <button className="btn btn-ghost btn-sm" onClick={download} disabled={!result.report}>
              下载完整报告 md
            </button>
          </div>

          {result.summary.dims.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-brand-600">分维度越界频次</p>
              <div className="space-y-1">
                {result.summary.dims.map((d) => (
                  <div key={d.dim} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 text-brand-700">{d.dim}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-brand-100">
                      <div
                        className="h-full rounded-full bg-amber-500"
                        style={{ width: `${Math.round((d.count / Math.max(1, d.total)) * 100)}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-brand-500">
                      {d.count}/{d.total}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-brand-500">
                某一维度越界集中 → 该维度常数是主因，按报告「偏差解读与反向调参指引」逐条反推。
              </p>
            </div>
          )}

          {result.report && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-brand-700">
                查看完整报告（markdown）
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-brand-50 p-3 text-xs text-brand-800">
                {result.report}
              </pre>
            </details>
          )}
        </div>
      )}

      {result && !result.summary && result.stdoutTail && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-brand-50 p-3 text-xs text-brand-800">
          {result.stdoutTail}
        </pre>
      )}
    </section>
  );
}
