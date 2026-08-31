import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * 一键跑校准（本地/内网专用）
 *
 * POST /api/calibration/run -> 执行 scripts/calibration-real.ts，返回汇总 + 完整报告(md)
 *
 * 安全说明：执行的命令是**固定常量**，不接受任何用户输入，不存在命令注入。
 * 但依赖 fs 写入与本地进程，公网部署（Serverless）不适用——与校准案例存储同一前提。
 */

const TIMEOUT_MS = 180_000;
const REPORT_PATH = resolve(process.cwd(), "cost-calibration-real.md");

export interface RunSummary {
  targetPct: number;
  inTarget: number;
  total: number;
  /** 各维度越界频次 */
  dims: { dim: string; count: number; total: number }[];
}

function parseSummary(stdout: string): RunSummary | null {
  const head = stdout.match(/总价落入\s*±(\d+)%\s*目标：(\d+)\/(\d+)\s*例/);
  if (!head) return null;

  const dims: { dim: string; count: number; total: number }[] = [];
  let inSection = false;
  for (const line of stdout.split("\n")) {
    if (line.includes("分维度越界频次")) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*(\S+?)\s*:\s*(\d+)\/(\d+)\s*例越界\s*$/);
    if (m) dims.push({ dim: m[1], count: Number(m[2]), total: Number(m[3]) });
    else if (line.trim() === "" && dims.length) break;
  }

  return {
    targetPct: Number(head[1]),
    inTarget: Number(head[2]),
    total: Number(head[3]),
    dims,
  };
}

export async function POST() {
  const bin = resolve(process.cwd(), "node_modules/.bin/tsx");
  const cmd = existsSync(bin) ? bin : "npx";
  const args = existsSync(bin)
    ? ["scripts/calibration-real.ts"]
    : ["tsx", "scripts/calibration-real.ts"];

  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolvePromise(null); // null = 超时
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => stdout.push(String(d)));
    proc.stderr.on("data", (d) => stderr.push(String(d)));
    proc.on("error", () => {
      clearTimeout(timer);
      resolvePromise(-1);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? 0);
    });
  });

  const out = stdout.join("");
  const err = stderr.join("");

  if (exitCode === null) {
    return NextResponse.json(
      { ok: false, error: `校准脚本超过 ${TIMEOUT_MS / 1000}s 未结束，已终止`, stdout: out.slice(-4000) },
      { status: 504 }
    );
  }
  if (exitCode === -1) {
    return NextResponse.json(
      { ok: false, error: "无法启动校准脚本（tsx 未安装？）", stderr: err.slice(-2000) },
      { status: 500 }
    );
  }

  const summary = parseSummary(out);
  let report = "";
  if (existsSync(REPORT_PATH)) {
    try {
      report = readFileSync(REPORT_PATH, "utf8");
    } catch {
      report = "";
    }
  }

  return NextResponse.json({
    ok: exitCode === 0,
    exitCode,
    summary,
    report,
    stdoutTail: out.slice(-4000),
    stderr: err.slice(-2000),
  });
}
