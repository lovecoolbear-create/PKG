# 全流程系统测试报告 · 2026-08-31

## 结论

15 项套件全部通过，与基线零偏差；`tsc` 0 错误。
过程中修掉 1 类高隐蔽的测试环境缺陷（浏览器 E2E「静默全红」）和 1 类点击时序假失败——**都不是产品缺陷**。

## 一、确定性套件（9 项，不依赖 dev server）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 黄金基线回归 | `npm run test:golden` | 11/11（容差 0.5%，连跑两次一致） |
| 配方覆盖 | `npm run test:recipe-coverage` | 5 维 × 11/11 全配方驱动，无静默回退 |
| 输入护栏 | `npm run test:guardrail` | 16/16 |
| 装订费率 | `npm run test:binding` | 28/28 |
| VAVE 敏感性内核 | `npm run test:kernel` | 19/19 |
| 单位归一 | `npm run test:unit-norm` | 14/14 |
| NLP 解析 | `npm run test:nlp` | 43/43 |
| 全流程引擎 | `npm run test:full-flow` | 94/94 |
| 标签品类对比 | `npm run test:label` | 5/5 |

## 二、E2E 套件（6 项，需 dev server 在 3000）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| API 数据链路 | `npm run test:api` | 62/62 |
| 分享链接 | `npm run test:share` | 14/14 |
| 前端路由走查（12 路由） | `npm run test:frontend` | 12/12，console 错误 0 |
| 交互向导（新建→选品类→步骤 2） | `npm run test:frontend-flow` | 5/5 |
| 分享报告浏览器渲染 | `npm run test:frontend-report` | 通过，console 错误 0 |
| 打印 PDF（中文/金额/单位） | `npm run test:print-pdf` | 5/5 |

## 三、本次修复

### 1. 浏览器 E2E「静默全红」陷阱（隐蔽度最高）

- **现象**：交互向导 0 通过 / 5 失败，但 console 错误 0、页面渲染正常；单独用诊断脚本点同样的按钮却能成功。
- **根因**：上一轮无头 Chrome 没退干净，继续占用 `--remote-debugging-port`。新脚本启动的 Chrome 绑不上端口，而 `waitForDevtools()` 只检查 `/json/version` 能否连上——于是连上了**僵尸旧实例**：页面能开、无报错，但所有点击与断言静默失效。
- **处置**：新增 `scripts/lib/cdp-port.ts`（`releaseStalePort`），在 `verify-frontend-flow` / `verify-frontend-console` / `verify-frontend-report` 三处**启动前 + 收尾**各调一次。实测已回收 9334 端口上的历史残留（PID 64929、65022），跑完端口自动归零。
- **两个实现约束**：
  - macOS 上 `ps` 被系统策略禁用（`Operation not permitted`），只能靠 `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` 解析 PID + 进程名，且仅清理 Chrome/Chromium 系监听者，不误伤 dev server。
  - `process.exit()` 写在 try 块内会跳过 finally 的收尾清理，已改为 `exitCode` 变量 + finally 之后统一退出。

### 2. 点击时序假失败

`verify-frontend-flow.ts` 新增 `waitForButton()`：等目标按钮真正挂载（React hydration 完成）后再点击，消除「弹窗/步骤刚出现就点」导致的连锁失败。

## 四、环境状态

- `tsc --noEmit`：0 错误。
- CDP 端口 9333 / 9334 / 9337：跑前跑后均为空。
- 以上已同步写入 `PROJECT_STATUS.md` §8 变更日志与 §7 风险。
