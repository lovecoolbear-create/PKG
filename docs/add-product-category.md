# 新增产品品类操作手册（add-product-category）

> 目的：让「加一个新品类」变成有章可循的操作，而不是每次重读整个项目。
> 适用范围：纸 / 塑 / 木 / 缓冲 / 标签等包装品类的扩展。
> 状态：本文档是**操作说明**，不假设「填模板就完事」——品类差异很大，必须按 §2 分级判断再动手。

---

## 1. 先说结论：加品类到底改什么

代码已具备良好的**数据驱动地基**，但**算法层与 UI 表现层仍有散落 `if (productType === ...)` 分支**。因此改动面取决于新品类与现有家族的相似度（见 §2）。

| 已数据驱动（通常**不改代码**） | 需判断（可能改代码） | 几乎必改 |
|---|---|---|
| 前端表单字段（`InfoFormStep` 全读 `config.fields`，自动渲染） | `analysis-context.ts` 派生量算法（面积 / 拼版利用率 / 盒型默认） | `config/products/<x>.ts` 新建 + `index.ts` 注册 |
| 配方库（`CostItem.productType` 是一等字段，按品类分维度） | `specialists.ts` 的 material/labor/process 品类分支函数 | `golden-cases.json` 补该品类回归用例 |
| 维度结构（5 维通用：material/labor/process/design_plate/finance_other） | `engine-bridge.ts` 的 `factsOf` 事实暴露 | —— |
| 注册表（`getProductConfig` 按 code 查） | `rule-lifecycle.ts` 的 VAVE boxType 派生 | —— |
| | `report-copy.ts` + 前端 12 处**单位标签硬编码**（`'册/张' : '只'`） | —— |

> ⚠️ **单位标签散落**：目前 `'册/张' : '只'` 在前端 `ReportStep`/`VaveWorkbench` 等 12+ 处 + `report-copy.ts` 硬编码。理想做法是把它收进 `ProductTypeConfig`（见 §6 待办），但在那之前，新品类若单位不是「只」，必须**逐处同步**这些硬编码，否则报告/谈判/VAVE 会显示错单位。

---

## 2. 分级判断（核心：先定级，再动手）

| 级别 | 典型例子 | 改动面 | 是否写算法 |
|---|---|---|---|
| **A 同家族**（仍是盒型，参数不同） | 新增「牛皮纸盒」「礼品天地盖」「开窗盒」 | 仅 `config/<x>.ts`（字段/选项/单位/默认拼版利用率）+ 注册 + 复用/微调配方 + 补 golden case。**前端表单零改。** | 否（复用 box 分支） |
| **B 近家族**（算法有差异，但同属一维体系） | 瓦楞箱（已做的 `corrugated_box`）、平面彩印（`flat_print`） | A 全部 + 在 `specialists.ts` 写 `xxxMaterialAgent`/`xxxProcessAgent` 等品类分支函数 + `analysis-context.ts` 加派生量分支 | 是（材料/加工维度） |
| **C 异家族**（结构本质不同） | 标签（不干胶，无盒型、按张/卷）、缓冲（EPE/EPS，按重量/体积）、木托盘（另一套） | A+B 全部 + 新 `derive` 函数（面积/拼版算法重写）+ 新 `factsOf` 事实 + 全新配方组（seed 加一组） + 可能改维度占比预期 | 是（派生量 + 全维度） |

**判断口诀**：
- 有没有「盒型 / 糊盒 / 天地盖」→ 没有就大概率不是 box 家族（C 级）。
- 材料成本是按「面积×克重×吨价」还是「重量×单价」还是「按张」→ 后者就是 C 级。
- 不确定时，先按 B 级做，遇到公式对不上再升 C。

---

## 3. 标准流程（按级别裁剪）

### 必做（所有级别）
1. **建配置**：复制 `src/config/products/color-print-box.ts` 为 `<x>.ts`，改 `code/name/description/steps/fields/dimensions`。
   - `fields` 决定前端表单（数据驱动，自动渲染）。
   - `dimensions` 复用 5 个通用维度 key，只调 `expectedRatioRange` / `description`。
2. **注册**：在 `src/config/products/index.ts` 的 `productRegistry` 加一行 + import。
3. **补回归**：在 `scripts/golden-cases.json` 的 `cases` 加 1~3 个该品类用例（覆盖专色 / 无专色 / 边界数量），并在 `scripts/golden-baseline.json` 给对应预期值（先用现有引擎跑出真实值填进去，再锁回归）。
4. **验证**：`npm run test:golden` + `npm run test:recipe-coverage` + `npx tsx scripts/verify-recipe-coverage.ts` 全绿。

### B 级追加
5. **派生量**：在 `src/lib/agents/analysis-context.ts` 的 `deriveAnalysisContext` 按 `pt === '<x>'` 加分支（或抽成 `derive<X>(ctx, input)` 函数）。
6. **维度算法**：在 `src/lib/agents/specialists.ts` 的 `materialAgent`/`laborAgent`/`processAgent` 加 `if (ctx.productType === '<x>') return xxxAgent(ctx)` 分支函数。
7. **事实暴露**：若新算法需要新派生量（如 `flatInnerPaperWeightKg`），在 `src/lib/cost-formula/engine-bridge.ts` 的 `factsOf` 补上，供配方 `{ctx:"..."}` 引用。

### C 级追加
8. **全新配方组**：在 `scripts/seed-recipes.ts` 加该品类的 `XXX_MATERIAL_ROWS` 等常量，并在 `seedProductTypeRecipes` 的映射里登记，跑 `npx tsx scripts/seed-recipes.ts` 入库。
9. **VAVE 规则**：若 `rule-lifecycle.ts` 的 boxType 派生需要该品类，补分支。

---

## 4. 必看文件清单（带每处改什么）

| 文件 | 级别 | 改什么 |
|---|---|---|
| `src/config/products/<x>.ts`（**新建**） | 全部 | 品类配置：code/name/fields/dimensions |
| `src/config/products/index.ts` | 全部 | `productRegistry` 注册 + import |
| `scripts/golden-cases.json` / `golden-baseline.json` | 全部 | 补回归用例 + 预期值 |
| `src/lib/agents/analysis-context.ts` | B/C | `deriveAnalysisContext` 加品类派生量分支 |
| `src/lib/agents/specialists.ts` | B/C | material/labor/process 加品类 Agent 分支函数 |
| `src/lib/cost-formula/engine-bridge.ts` | B/C | `factsOf` 补新派生量事实 |
| `scripts/seed-recipes.ts` | C | 加该品类配方常量组 + 登记映射 |
| `src/lib/vave/rule-lifecycle.ts` | C（若 VAVE 用 boxType） | boxType 派生补分支 |
| `src/lib/report-copy.ts` + 前端 12 处 | 全部（单位非「只」时） | 同步 `'册/张' : '只'` 硬编码（**建议改造见 §6**） |

---

## 5. 品类配置模板（骨架，带注释）

```typescript
import type { ProductTypeConfig } from "@/types";

export const myCategoryConfig: ProductTypeConfig = {
  code: "my_category",          // 全局唯一 snake_case
  name: "我的品类",
  description: "一句话说明适用场景",
  // steps 通常沿用 upload/info/report 三段，按需增删
  steps: [/* 复制 color-print-box.ts 的 steps，仅改 fieldKeys */],
  fields: [/* 决定前端表单，数据驱动自动渲染；unit 写进字段级 unit */],
  dimensions: [/* 复用 5 个通用维度 key，只调占比区间与描述 */],
  // —— 以下为可选增强字段（需先按 §6 做类型扩展）——
  // unitLabel: "只",            // 报告/VAVE 单位标签，替代散落硬编码
  // unitNoun: "盒",
  // deriveStrategy: "box",     // 'box' | 'flat' | 'corrugated' | 'custom'，驱动派生量分发
};
```

---

## 6. 已知技术债 / 未来优化方向（非本次操作范围）

- **① 单位标签收敛**：把 `'册/张' : '只'` 的 12+ 处硬编码收进 `ProductTypeConfig.unitLabel`，前端 / `report-copy.ts` 改读配置。低风险、高收益，能立刻消掉最刺眼的散落分支。
- **② 算法层策略插件化**：`deriveAnalysisContext` 的 `if flat` 分支改为按 `deriveStrategy` 分发；`specialists.ts` 的品类函数收成 `plugins/categories/<key>.ts` 插件，orchestrator 按 `categoryKey` 选。仅本质不同的品类才写插件。
- **③ 固化 Skill**：本手册即 `add-product-category` Skill 的文档底稿，已固化为可复用 Skill（见 `~/.workbuddy/skills/add-product-category/`），AI 加载即知流程，无需重读项目。

> 约定（写进代码评审）：**禁止新增 `productType === 'X'` 散落 if**；单位走配置；算法差异走策略分发 / 品类插件；配方优先于代码常量。

---

## 7. 验证清单（提交前必跑）

- [ ] `config/products/index.ts` 注册成功，`getProductConfig('<x>')` 能取到
- [ ] 前端 `/work` 新建会话选到该品类，表单字段正确渲染
- [ ] 该品类 golden case 进 `golden-cases.json` + `golden-baseline.json`
- [ ] `npm run test:golden` 9/9 + 新品类用例零漂移
- [ ] `npm run test:recipe-coverage`（或 `verify-recipe-coverage.ts`）断言该品类五维「配方驱动」、无回退
- [ ] 若单位非「只」，前端 / `report-copy.ts` 的单位硬编码已同步
- [ ] `tsc --noEmit` 0 错
