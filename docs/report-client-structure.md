# 客户报告输出结构优化方案

> 目标：客户看得懂、愿意信、愿意继续聊。
> 现状：字段已齐全（`AnalysisReport` 含 totalCost / dimensions / completeness / defaultAssumptions / optimizationHints / disclaimer），但**模块顺序不固定、缺独立的「成本驱动说明」与「小批量提示」**。本方案定义目标结构、渲染规则、示例文案，可直接落地到 `ReportStep.tsx` 与 `orchestrator.ts`。

---

## 一、报告数据结构定义（TypeScript）

在 `src/types/index.ts` 新增以下类型，由 orchestrator 组装。已存在字段直接复用，新增 3 个派生结构（`costDrivers` / `smallBatchNote` / `ctaCopy`）。

```ts
// ===== 新增：成本驱动点 =====
export interface CostDriver {
  dimension: string;        // 维度 key
  dimensionLabel: string;   // 维度中文名
  amount: number;           // 金额（元）
  ratio: number;            // 占总额百分比
  reason: string;           // 为什么贵（来自 breakdown/basis 的提炼）
}

// ===== 新增：小批量特殊提示 =====
export interface SmallBatchNote {
  visible: boolean;         // 是否展示（设计/制版占比越界才 true）
  dimension: string;        // 触发维度（如 design_plate）
  ratio: number;            // 实际占比
  expectedMax: number;      // 预期上限（如 10%）
  message: string;          // 解释文案（固定模板）
}

// ===== 组装后的客户报告视图（orchestrator 产出，前端按 sectionOrder 渲染）=====
export interface ClientReport extends AnalysisReport {
  /** 模块固定顺序（前端严格按此渲染） */
  sectionOrder: ClientSectionKey[];
  /** 主要成本驱动点（取金额前 3，由 generateCostDrivers 生成） */
  costDrivers: CostDriver[];
  /** 小批量提示（设计/制版占比越界时 visible=true） */
  smallBatchNote: SmallBatchNote;
  /** 转化入口文案（固定模板，可配置） */
  ctaCopy: string;
}

export type ClientSectionKey =
  | "total_range"        // 1 总成本区间 + 单只价格区间
  | "structure"          // 2 五维成本结构占比
  | "drivers"            // 3 主要成本驱动点说明
  | "completeness"       // 4 信息完整度 + 默认假设清单
  | "confidence"         // 5 置信度说明
  | "small_batch"        // 6 小批量特殊提示
  | "optimization"       // 7 初步优化方向
  | "disclaimer"         // 8 免责声明
  | "cta";               // 9 转化入口
```

**派生字段生成位置（建议）**

| 字段 | 生成函数 | 说明 |
| --- | --- | --- |
| `costDrivers` | `generateCostDrivers(results)` in `orchestrator.ts` | 按 `estimatedAmount` 降序取前 3，reason 取该维度 `breakdown` 中最贵分项的 `note` 或 `basis[0]` |
| `smallBatchNote` | `buildSmallBatchNote(results, config)` | `design_plate.ratio > 该维预期上限` → `visible=true`，文案固定 |
| `ctaCopy` | 常量 `CTA_COPY` | 固定字符串，预留文案位 |
| `sectionOrder` | 常量固定数组 | 锁定下方 9 项顺序 |

---

## 二、渲染逻辑建议

### 2.1 固定顺序（不可调整）
```
total_range → structure → drivers → completeness → confidence → small_batch → optimization → disclaimer → cta
```

### 2.2 各模块渲染规则与视觉

| # | 模块 | 渲染方式 | 条件 / 视觉 |
| --- | --- | --- | --- |
| 1 | 总成本区间 + 单只价 | **顶部 Hero 横幅**：左总成本区间、中单只价区间、右整体置信度 | 永远置顶；数字加粗；区间用浅色背景突出 |
| 2 | 五维结构占比 | **饼图 + 并排表格**（维度 / 金额 / 占比） | 饼图复用现有 recharts；表格兜底（无图环境可读） |
| 3 | 成本驱动点 | **3 张「焦点卡」**：维度名 + 金额 + 占比 + 一句话原因 | 永远展示；取前 3 贵项；原因来自 `breakdown.note` |
| 4 | 完整度 + 默认假设 | **琥珀色卡片**：顶部「完整度 XX%」，下列默认假设清单 | 完整度永远展示；清单仅在 `defaultAssumptions.length>0` 展开 |
| 5 | 置信度说明 | **整体 + 各维度进度条/徽章** | 整体在 Hero 已显示；此处补「各维度置信度 + 为何下调」 |
| 6 | 小批量提示 | **高亮提示框**（蓝色 info） | 仅 `smallBatchNote.visible=true` 时插入；其余情况整块不渲染 |
| 7 | 优化方向 | **1–3 条折叠卡**（标题 + 潜在节约，点开看摘要） | 只给方向，不给完整方案；为 VAVE 埋钩 |
| 8 | 免责声明 | **顶部 + 底部双 banner**（橙色） | 固定文案；与现状一致 |
| 9 | 转化入口 | **底部 CTA 横幅**（深色） | 固定文案 + 一个动作按钮（联系/继续沟通） |

### 2.3 关键条件逻辑（伪代码）
```ts
// 小批量提示触发：仅设计/制版占比越界
function buildSmallBatchNote(results, config): SmallBatchNote {
  const dim = results.find(r => r.dimension === "design_plate");
  const cfg = config.dimensions.find(d => d.key === "design_plate");
  const expectedMax = cfg?.expectedRatioRange[1] ?? 10;
  if (dim && dim.ratio > expectedMax) {
    return { visible: true, dimension: "design_plate", ratio: dim.ratio,
             expectedMax,
             message: "设计与制版为一次性固定费用，在较小批量下被较少数量分摊，故单只占比偏高。提升订单量后，该费用分摊到更多数量，单只成本将明显下降。" };
  }
  return { visible: false, ... };
}

// 成本驱动：取金额前 3
function generateCostDrivers(results): CostDriver[] {
  return [...results].sort((a,b)=>b.estimatedAmount-a.estimatedAmount)
    .slice(0,3)
    .map(r => ({
      dimension: r.dimension, dimensionLabel: r.dimensionLabel,
      amount: r.estimatedAmount, ratio: r.ratio,
      reason: (r.breakdown?.sort((x,y)=>y.amount-x.amount)[0]?.note) ?? r.basis[0] ?? ""
    }));
}
```

### 2.4 语气与可信度纪律
- 全程**中性陈述**，不出现「最低价」「最优」等夸大词。
- 所有金额标注为**区间**而非单点，降低"被当成承诺"的风险。
- 默认假设、置信度下调**主动暴露**，反而提升可信度（"敢把不确定讲出来"）。
- 优化方向用「可进一步评估」措辞，不预设客户一定会省。

---

## 三、示例文案（以彩盒 200×150×80 / 5000 / 白卡350 / 胶印4C / 哑膜 / 华东 为例）

> 该案例估算：总额 ¥6,529，单只 ¥1.31；维度占比 材料23% / 人工6% / 加工20% / 设计36% / 财务16%；完整度 92%；默认假设 1 项（交付地=华东）。

### 模块 1 · 总成本区间
> **总成本区间：¥6,150 – ¥6,900**
> **单只价格区间：¥1.23 – ¥1.38 / 个**
> **整体置信度：82%（较高）**

### 模块 2 · 五维成本结构占比
> 材料成本 23% · 人工成本 6% · 加工费（含设备）20% · 设计与制版 36% · 财务与其他 16%

### 模块 3 · 主要成本驱动点说明
> - **设计与制版（¥2,350，36%）**：主要为一次性制版费（4 色 × ¥350）+ 设计费 ¥800 + 打样费 ¥150，属固定投入。
> - **材料成本（¥1,481，23%）**：白卡 350g 面纸 + 损耗，受纸价波动影响。
> - **加工费（¥1,306，20%）**：印刷（4 色千印）+ 哑膜 + 模切 + 一次性刀模费为主。

### 模块 4 · 信息完整度 + 默认假设清单
> **信息完整度：92%**
> 以下字段未提供，已套用合理默认并据此估算（相关维度置信度已相应下调）：
> - **生产/交付地域**：华东地区 — 默认按华东制造业水平估算人工费率

### 模块 5 · 置信度说明
> 整体置信度 **82%（较高）**。各维度：材料 80 / 人工 72 / 加工 78 / 设计 75 / 财务 72。
> 因使用 1 项默认假设，整体置信度下调约 8 分；补充实际地域与完稿信息后可进一步提升。

### 模块 6 · 小批量特殊提示（触发）
> **提示**：本单设计与制版占比约 36%，明显高于常规区间（3%–10%）。这是因为设计与制版为**一次性固定费用**，在 5,000 的批量下被较少数量分摊，故单只占比偏高。**提升订单量后，该费用分摊到更多数量，单只成本将明显下降**——这并非估算偏差。

### 模块 7 · 初步优化方向（埋钩，不给完整方案）
> - **提升订单量级**：当前数量偏少，材料采购与开机成本分摊较高，量级提升后单位成本通常可降 8%–15%。（可进一步评估）
> - **评估材质替代**：材料占比约 23%，在保挺度前提下可评估替代材质或克重空间。（可进一步评估）

### 模块 8 · 免责声明
> ⚠ **本结果为估算，仅供参考，最终以正式报价为准。**

### 模块 9 · 转化入口文案
> 如需进一步做**成本优化（VAVE）或供应链诊断**，可继续沟通，我们提供深度成本拆解与落地方案。

---

## 四、落地检查清单

- [ ] `src/types/index.ts`：补 `CostDriver` / `SmallBatchNote` / `ClientReport` / `ClientSectionKey`
- [ ] `orchestrator.ts`：组装 `costDrivers`、`smallBatchNote`、`ctaCopy`、`sectionOrder`
- [ ] `ReportStep.tsx`：按 `sectionOrder` 重排；新增「成本驱动焦点卡」与「小批量提示框」两个区块
- [ ] 文案常量集中在 `src/lib/report-copy.ts`（便于后期 A/B 与多语言）
- [ ] PDF 导出同步按新顺序重排
