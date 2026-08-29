/**
 * 管理后台鉴权（fail-closed）
 * ----------------------------------------------------------------
 * 与 `/api/admin/knowledge-base` 现有的 `checkAuth`（**fail-open**：未配 token
 * 则开放，方便本地调试）不同，本模块一律 **fail-closed**：未配置环境变量时直接拒绝。
 *
 * 为什么必须 fail-closed：
 *  - 公式是本项目核心资产（护城河）。公网部署若沿用 fail-open 且忘记配 token，
 *    公式与知识库将可被任意读写；
 *  - 用户注册登录（按角色控制权限）属三期之后，而公网部署属一期，中间存在
 *    "公网已上线、但还没有用户系统"的窗口期——这段时间只能靠本模块兜底。
 *
 * 过渡期双保险（见 docs/formula-management-design.md §7.2）：
 *   1. fail-closed 鉴权（本模块）
 *   2. 公网构建不注册 /admin/formula 路由（页面根本不打包）
 *
 * 三期接入用户系统后，本模块改为按角色（role）鉴权，接口保持不变。
 */

import type { NextRequest } from "next/server";

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * 校验管理令牌（fail-closed）。
 *
 * @param request NextRequest
 * @param envVar  环境变量名，默认 FORMULA_ADMIN_TOKEN
 * @param header  请求头名，默认 x-admin-token
 */
export function checkAdminAuth(
  request: NextRequest,
  envVar = "FORMULA_ADMIN_TOKEN",
  header = "x-admin-token"
): AdminAuthResult {
  const expected = process.env[envVar];

  // fail-closed：未配置 → 一律拒绝（与知识库页面的 fail-open 相反）
  if (!expected || !expected.trim()) {
    return {
      ok: false,
      status: 403,
      reason: `未配置 ${envVar}，管理接口按 fail-closed 拒绝访问`,
    };
  }

  const provided = request.headers.get(header);
  if (!provided || provided !== expected) {
    return { ok: false, status: 401, reason: "管理令牌无效或缺失" };
  }

  return { ok: true };
}

/**
 * 是否允许暴露公式管理页。
 * 公网构建可通过 FORMULA_ADMIN_ENABLED=false 彻底关闭（路由不提供能力）。
 * 默认 true（由 fail-closed 的 token 校验兜底）。
 */
export function isFormulaAdminEnabled(): boolean {
  return process.env.FORMULA_ADMIN_ENABLED !== "false";
}
