/**
 * CDP 测试端口工具
 * ----------------------------------------------------------------
 * 背景（2026-08-31 实测踩坑）：
 *   上一轮无头 Chrome 若没被彻底回收，会继续占着 --remote-debugging-port。
 *   新脚本再启动 Chrome 时绑不上端口，而 waitForDevtools() 只检查
 *   /json/version 是否可连 —— 结果连上了「僵尸旧实例」：
 *   页面能打开、console 错误 0，但所有点击/断言全部静默失败（全红）。
 *   这种失败极具迷惑性：看起来像前端坏了，其实是测试环境脏了。
 *
 * 因此浏览器类 E2E 在启动 Chrome 前必须先 releaseStalePort(PORT)，
 * 脚本收尾时也应静默调用一次，避免把脏环境留给下一轮。
 *
 * 识别策略（macOS 上 ps 被系统策略禁用，只能靠 lsof）：
 *   测试端口（9333/9334/9337）上「进程名是 Chrome/Chromium 系」的监听者，
 *   一律视为上一轮测试残留。用户日常浏览器不会监听这些端口。
 */
import { execSync } from "node:child_process";

interface PortProc {
  pid: number;
  cmd: string;
}

const CHROME_LIKE = /^(Google|Chromium|chrome|chromium|headless_shell)/i;

function procsOnPort(port: number): PortProc[] {
  let out = "";
  try {
    // -Fpc：只输出 p(PID) 与 c(进程名) 字段，便于解析
    out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpc`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return [];
  }
  const res: PortProc[] = [];
  let pid = -1;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c" && pid > 0) {
      res.push({ pid, cmd: val });
      pid = -1;
    }
  }
  return res;
}

/**
 * 清理端口上残留的上一轮测试 Chrome。
 * @param port CDP 调试端口
 * @param quiet 静默模式（脚本收尾时调用，不打提示）
 * @returns true 表示确实清理过
 */
export async function releaseStalePort(port: number, quiet = false): Promise<boolean> {
  const onPort = procsOnPort(port);
  if (!onPort.length) return false;

  const nonChrome = onPort.filter((p) => !CHROME_LIKE.test(p.cmd));
  const stale = onPort.filter((p) => CHROME_LIKE.test(p.cmd));
  if (!stale.length) {
    if (!quiet) {
      console.log(`⚠️  端口 ${port} 被非 Chrome 进程占用（${nonChrome.map((p) => `${p.cmd}:${p.pid}`).join(", ")}），已跳过清理`);
    }
    return false;
  }

  if (!quiet) {
    console.log(`⚠️  端口 ${port} 被上一轮无头 Chrome 残留占用（PID ${stale.map((p) => p.pid).join(", ")}），清理中…`);
  }
  for (const { pid } of stale) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  // 等端口真正释放（子进程可能继承监听 socket，需逐一收掉）
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (!procsOnPort(port).length) break;
    const again = procsOnPort(port).filter((p) => CHROME_LIKE.test(p.cmd));
    if (!again.length) break;
    for (const { pid } of again) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return true;
}
