/**
 * Next.js 服务启动钩子：在服务端启动时拉起网络行情定时刷新。
 * 仅在 nodejs 运行时执行，避免 edge 运行时报错。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNetworkCron } = await import(
      "@/lib/knowledge-base/network-cron"
    );
    startNetworkCron();
  }
}
