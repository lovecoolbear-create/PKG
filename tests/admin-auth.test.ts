/**
 * 管理后台鉴权护栏（F1）
 * ----------------------------------------------------------------
 * 锁死 fail-closed 语义：未配置令牌时必须拒绝，绝不能退回"开放"。
 * 这是公网部署后保护公式（核心资产）的唯一兜底，测试不可省。
 */
import { checkAdminAuth, isFormulaAdminEnabled } from "@/lib/admin-auth";
import type { NextRequest } from "next/server";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

/** checkAdminAuth 只用到 request.headers.get()，用最小 mock 即可 */
function mockRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Map(Object.entries(headers)) } as unknown as NextRequest;
}

const KEY = "FORMULA_ADMIN_TOKEN";
const savedToken = process.env[KEY];
const savedEnabled = process.env.FORMULA_ADMIN_ENABLED;

console.log("=== 管理后台鉴权 fail-closed（F1）===\n");

try {
  console.log("▸ 规格1：未配置令牌时必须拒绝（fail-closed）");
  delete process.env[KEY];
  const noToken = checkAdminAuth(mockRequest({}));
  assert(noToken.ok === false, "未配置令牌时鉴权不通过");
  if (!noToken.ok) {
    assert(noToken.status === 403, `返回 403（实际 ${noToken.status}）`);
    assert(noToken.reason.includes("fail-closed"), "原因说明含 fail-closed");
  }
  const withHeaderButNoEnv = checkAdminAuth(
    mockRequest({ "x-admin-token": "anything" })
  );
  assert(withHeaderButNoEnv.ok === false, "未配置 env 时，即使带任意令牌也拒绝");

  console.log("\n▸ 规格2：令牌不匹配 / 缺失时拒绝");
  process.env[KEY] = "correct-token";
  const missing = checkAdminAuth(mockRequest({}));
  assert(missing.ok === false, "请求未带头时拒绝");
  if (!missing.ok) assert(missing.status === 401, `返回 401（实际 ${missing.status}）`);

  const wrong = checkAdminAuth(mockRequest({ "x-admin-token": "wrong-token" }));
  assert(wrong.ok === false, "令牌错误时拒绝");
  if (!wrong.ok) assert(wrong.status === 401, "错误令牌返回 401");

  console.log("\n▸ 规格3：令牌正确时通过");
  const ok = checkAdminAuth(mockRequest({ "x-admin-token": "correct-token" }));
  assert(ok.ok === true, "令牌正确时鉴权通过");

  console.log("\n▸ 规格4：自定义环境变量名 / 请求头名");
  process.env.OTHER_ADMIN_TOKEN = "other-token";
  const custom = checkAdminAuth(
    mockRequest({ "x-custom-token": "other-token" }),
    "OTHER_ADMIN_TOKEN",
    "x-custom-token"
  );
  assert(custom.ok === true, "支持自定义 env 名与头名");
  delete process.env.OTHER_ADMIN_TOKEN;

  console.log("\n▸ 规格5：公式管理页总开关");
  delete process.env.FORMULA_ADMIN_ENABLED;
  assert(isFormulaAdminEnabled() === true, "默认启用");
  process.env.FORMULA_ADMIN_ENABLED = "false";
  assert(isFormulaAdminEnabled() === false, "FORMULA_ADMIN_ENABLED=false 时关闭");
} finally {
  // 还原环境，避免影响同进程后续测试
  if (savedToken == null) delete process.env[KEY];
  else process.env[KEY] = savedToken;
  if (savedEnabled == null) delete process.env.FORMULA_ADMIN_ENABLED;
  else process.env.FORMULA_ADMIN_ENABLED = savedEnabled;
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
