// ============================================================================
// 派生字地开发用的 SQLite schema
// ----------------------------------------------------------------------------
// prisma/schema.prisma（PostgreSQL）是唯一的权威源，包含所有 model 定义，
// 用于部署到 Vercel / Neon。本地开发用 SQLite，只需把 datasource 的
// provider 改成 sqlite 即可（本项目的 model 未使用任何 PG 专有类型，
// 因此同一份 model 可同时用于两种数据源）。
//
// 本脚本从 schema.prisma 自动生成 schema.sqlite.prisma，保证两者 model
// 永远单源、自动同步，避免「只改了一份」导致另一方缺表/字段的上线隐患。
//
// 运行：node scripts/sync-sqlite-schema.mjs（已被 postinstall/prebuild/db:* 调用）
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcPath = resolve(root, "prisma/schema.prisma");
const outPath = resolve(root, "prisma/schema.sqlite.prisma");

const src = readFileSync(srcPath, "utf8");

// 仅替换与数据源相关的两处，model 定义原样保留
const out = src
  // datasource provider: postgresql -> sqlite（全局替换，注释中的同名文本一并改掉无妨）
  .replace(/provider = "postgresql"/g, 'provider = "sqlite"')
  // 本地无需 Vercel 的 linux 二进制目标
  .replace(/binaryTargets = \[[\s\S]*?\]/, 'binaryTargets = ["native"]');

writeFileSync(outPath, out);
console.log(
  "[sync-sqlite-schema] regenerated prisma/schema.sqlite.prisma from schema.prisma (provider=sqlite)"
);
