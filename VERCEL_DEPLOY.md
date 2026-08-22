# Vercel 部署指南（Neon Postgres）

成本分析工具的生产数据库使用 **Neon Postgres**，本地开发保留 **SQLite** 兼容。两者共用同一个 `DATABASE_URL` 环境变量，由各自 Prisma schema 的 `provider` 决定协议。

| 环境 | Schema | provider | DATABASE_URL |
|------|--------|----------|--------------|
| 本地开发 | `prisma/schema.sqlite.prisma` | sqlite | `file:./dev.db` |
| Vercel 生产 | `prisma/schema.prisma` | postgresql | Neon 连接串 |

---

## 1. 准备 Neon 数据库

1. 打开 https://neon.tech ，新建项目（免费层即可）。
2. 在 **Dashboard → Connection Details** 复制 **Connection string**（形如 `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`）。
3. 建议用 **Pooled connection**（含 `-pooler`）的字符串，Vercel Serverless 下连接数更稳。

## 2. 配置 Vercel 环境变量

在 Vercel 项目 → **Settings → Environment Variables** 添加：

```
DATABASE_URL = <上面复制的 Neon 连接串>
```

- 必须加到 **Production / Preview / Development** 全部环境（或至少 Production）。
- 不要带引号，直接粘连接串。

> 其它可选变量：`NEXT_PUBLIC_BASE_URL`（分享链接域名，不配则用请求 origin 自动生成，已内置兼容）。

## 3. 部署步骤

### 方式 A：Git 推送（推荐）

1. 把代码推到 GitHub / GitLab。
2. Vercel 导入该仓库 → Framework 选 **Next.js**（自动识别）。
3. 构建命令无需手动改：仓库里已配置 `vercel-build` 脚本，Vercel 会优先用它：

   ```bash
   # package.json 中已定义
   "vercel-build": "prisma generate && prisma migrate deploy && next build"
   ```

   - `prisma generate`：按 `schema.prisma`（postgresql）生成客户端；
   - `prisma migrate deploy`：把 `prisma/migrations/` 里的 SQL 应用到 Neon（首次自动建表）；
   - `next build`：正常构建。

4. 点击 **Deploy**。成功后生成公网地址 `https://<project>.vercel.app`。

### 方式 B：CLI

```bash
npx vercel            # 首次，按提示登录并关联
npx vercel --prod     # 生产部署
```

## 4. 首次上线后做什么

- **表结构**：`prisma migrate deploy` 在构建时已自动建好全部表。
- **种子数据**：首次发起一次分析（创建会话）时，代码里的 `ensureProductType()` 会自动 upsert 产品类型与基础成本规则，无需手动 seed。
  - 若想提前初始化，可在本地设好 `DATABASE_URL=Neon串` 后跑：`npm run db:generate && npm run db:migrate:deploy && npm run seed`。
- **分享链接**：部署后生成的分享 URL 会自动使用 Vercel 真实域名（`request.nextUrl.origin`），无需额外配置。

## 5. 本地 SQLite 开发（兼容说明）

本地 `.env` 保持：

```ini
DATABASE_URL="file:./dev.db"
```

常用命令（默认即 SQLite schema，无需切变量）：

```bash
npm run db:generate:sqlite   # 生成本地 sqlite 客户端
npm run db:push              # 同步表结构到 prisma/dev.db
npm run dev                  # 启动开发
npm run seed                 # 灌种子数据
```

> 本地 `db:push` 用的是 `schema.sqlite.prisma`，与 Vercel 的 `migrate deploy` 互不干扰。
> 注意：本地改了 `schema.prisma`（生产）后，运行 `prisma validate` 会因 `.env` 是 sqlite 协议而报 "URL must start with postgresql://" ——这是正常现象，不影响 Vercel 部署；Vercel 上的 `DATABASE_URL` 是真实 Postgres 串，校验即通过。

## 6. （可选）本地也用 Postgres 开发

若想本地完全复现生产行为：

```bash
export DATABASE_URL="<Neon 连接串或本地 postgres://...>"
npx prisma generate                 # 用 schema.prisma（postgres）
npx prisma migrate dev              # 本地用迁移而非 db push
npm run dev
```

## 7. 后续模型变更流程

1. 改 `schema.prisma`（生产）**与** `schema.sqlite.prisma`（本地）保持同步。
2. 本地生成迁移：`npx prisma migrate dev --name <描述>`（需连 Postgres，可用 Neon 的 dev 分支）。
3. 提交 `prisma/migrations/` 新目录。
4. 重新部署，Vercel 的 `migrate deploy` 会自动应用新迁移。

## 8. 排错

- **部署报 `P1001` / 连不上数据库**：检查 `DATABASE_URL` 是否配置、Neon 项目是否暂停（免费层 idle 后需 wake）、是否用了 pooler 串。
- **`P3018` 迁移冲突**：`prisma/migrations` 与数据库 `_prisma_migrations` 不一致，按 Prisma 提示 `migrate resolve` 或重置 Neon 分支。
- **本地 500 / 客户端协议错**：确认本地跑过 `npm run db:generate:sqlite`，且 `.env` 是 `file:./dev.db`。
