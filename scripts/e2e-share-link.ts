/**
 * 分享链接端到端验证（2026-08-30 建立，§6「分享链接端到端验证」未完成项）
 *
 * 前置：dev server 已启动（默认 http://localhost:3000，可用 BASE_URL 覆盖）。
 * 覆盖链路：
 *   ① 取一个已完成会话（status=completed 且带 resultData）
 *   ② POST /api/sessions/[id]/share      → 生成 token + url
 *   ③ GET  /api/share/<token>             → 取回报告，且金额与源会话一致
 *   ④ GET  /share/<token>                 → 页面路由可达（HTML 非 404/错误页）
 *   ⑤ 无效 token                           → 必须 404（不能把无效链接当有效）
 *
 * 注意：分享页是客户端组件（useEffect 内 fetch），本脚本只能验证「页面路由可达」，
 * 「报告真的渲染出来」需另用浏览器打开确认（见 §8 变更日志）。
 */
import { prisma } from "@/lib/db";

const BASE = process.env.BASE_URL || "http://localhost:3000";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${got !== undefined ? ` → 实际 ${String(got)}` : ""}`);
  }
}

async function main() {
  // ① 找一个已完成、带结果数据的会话
  const session = await prisma.analysisSession.findFirst({
    where: { status: "completed" },
    orderBy: { createdAt: "desc" },
  });
  if (!session?.resultData) {
    console.error(
      "❌ 没有可分享的已完成会话（status=completed 且有 resultData）。请先在页面上跑一次成本分析。"
    );
    process.exit(1);
  }
  const source = JSON.parse(session.resultData);
  console.log(`① 找到已完成会话：${session.id}`);
  check("① 源会话带 resultData", !!source, "");

  // ② 生成分享链接
  const shareRes = await fetch(`${BASE}/api/sessions/${session.id}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInDays: 7 }),
  });
  const shareData = await shareRes.json();
  if (!shareRes.ok) {
    console.error("❌ 生成分享链接失败：", shareRes.status, shareData);
    process.exit(1);
  }
  const { token, url, expiresAt } = shareData as {
    token?: string;
    url?: string;
    expiresAt?: string;
  };
  check("② 生成接口返回 200", shareRes.status === 200, shareRes.status);
  check("② 返回 token", !!token, token);
  check("② 返回可用 url", !!url && url.includes(`/share/${token}`), url);
  check("② 返回过期时间", !!expiresAt, expiresAt);
  console.log(`   → 分享链接：${url}`);

  // ③ 读取分享报告，并核对与源会话一致（防止分享出去的是错报告）
  const getRes = await fetch(`${BASE}/api/share/${token}`);
  const getData = await getRes.json();
  check("③ 读取接口返回 200", getRes.status === 200, getRes.status);
  check("③ 返回报告对象", !!getData.report, "");
  check(
    "③ 报告总成本与源会话一致",
    getData.report?.totalCost?.max === source?.totalCost?.max,
    `分享=${getData.report?.totalCost?.max} 源=${source?.totalCost?.max}`
  );
  check("③ 返回过期时间", !!getData.expiresAt, getData.expiresAt);
  check(
    "③ 浏览量已自增",
    typeof getData.viewCount === "number" && getData.viewCount >= 1,
    getData.viewCount
  );

  // ④ 分享页路由可达
  // 注意：分享页是客户端组件，服务端首屏只渲染 loading 壳（报告由 useEffect 拉取），
  // 因此这里做「正面向」校验——命中本页（有 loading 壳）且不是 Next 的 404 页。
  // 不能简单 grep "404"：Next dev 会把内置 not-found 边界塞进 RSC payload，必然含 404 字样。
  const pageRes = await fetch(`${BASE}/share/${token}`);
  const html = await pageRes.text();
  check("④ 分享页返回 200", pageRes.status === 200, pageRes.status);
  // 不能 grep 页面里的 "404" 字样：Next(dev) 会把内置 not-found 边界写进 RSC payload，
  // 任何正常页面都必然含 "404: This page could not be found."。唯一可靠的判别是 <title>。
  const title = (html.match(/<title>([^<]*)<\/title>/) || ["", ""])[1];
  check("④ 命中的是分享页而非 Next 404 页", !title.startsWith("404"), title);
  check(
    "④ 服务端渲染出 loading 壳（客户端组件预期行为）",
    html.includes("animate-spin"),
    ""
  );

  // ⑤ 无效 token 必须 404
  const badRes = await fetch(`${BASE}/api/share/definitely_invalid_token_0000`);
  check("⑤ 无效 token 返回 404", badRes.status === 404, badRes.status);

  console.log(`\n分享链接端到端验证：通过 ${pass} / ${pass + fail}`);
  if (fail === 0) {
    console.log("✅ 数据链路已走通（生成 → 读取 → 页面可达 → 无效 token 兜底）");
    console.log(`   浏览器打开确认渲染：${url}`);
  } else {
    console.log(`❌ ${fail} 项失败`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("运行异常：", e);
  process.exit(1);
});
