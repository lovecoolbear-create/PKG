# 客户报告输出规范（v2）

> 目标：让报告**专业、透明、可转化**——客户看得懂、愿意信、愿意继续聊。
> 适用范围：彩印纸盒（color_print_box）。本规范是 `ReportStep.tsx` / `pdf/export.ts` 渲染与 `orchestrator.ts` 组装的**唯一对齐依据**。
> 配套实现：`src/types/index.ts`（数据结构）、`src/lib/report-copy.ts`（文案常量）、`src/lib/agents/orchestrator.ts`（组装）、`src/components/analyze/ReportStep.tsx`（渲染）。

---

## 〇、模块固定顺序（不可调整）

```
1 total_range    → 总成本区间 + 单只价格区间
2 structure      → 五维成本结构占比（加工费拆「纯工艺 / 设备·开机」）
3 drivers        → 主要成本驱动点说明
4 completeness   → 信息完整度 + 默认假设清单（独立透明）
5 confidence     → 各维度置信度 + 整体置信度
6 small_batch    → 小批量特殊提示（越界才显示）
7 optimization   → 初步优化方向（埋钩，不含完整方案）
8 disclaimer     → 明确免责声明
9 cta            → 转化入口文案
```

---

## 一、报告数据结构定义

### 1.1 字段总览

| 字段 | 类型 | 来源 | 说明 |
| --- | --- | --- | --- |
| `totalCost.min/max` | number | orchestrator 汇总各维度 `amountRange` | 总成本区间（元） |
| `totalCost.perUnit` | `{min,max}` | `totalCost / quantity` | 单只价格区间（元/个） |
| `dimensions[]` | `AgentResult[]` | 5 个 specialist | 五维金额、占比、区间、basis、assumptions、confidence、breakdown |
| `completeness` | number(0–100) | orchestrator | 信息完整度百分比 |
| `defaultAssumptions[]` | `DefaultAssumption[]` | 输入缺省解析 | **独立透明展示**的默认假设清单 |
| `overallConfidence` | number | 各维度 confidence 加权 | 整体置信度 |
| `optimizationHints[]` | `OptimizationHint[]` | question-engine / 模板 | 1–3 条优化方向（埋钩） |
| `disclaimer` | string | `DISCLAIMER` 常量 | 免责声明 |
| `costDrivers[]` | `CostDriver[]` | `generateCostDrivers()` | 金额前 3 的驱动点 |
| `smallBatchNote` | `SmallBatchNote` | `buildSmallBatchNote()` | 小批量提示（含数量敏感） |
| `ctaCopy` | string | `CTA_COPY` 常量 | 转化入口文案 |
| `sectionOrder` | `ClientSectionKey[]` | `SECTION_ORDER` 常量 | 锁定上方 9 顺序 |

### 1.2 关键类型（TypeScript）

```ts
// ===== 维度输出（specialist 产出，已有）=====
export interface AgentResult {
  dimension: string;            // material | labor | process | design_plate | finance
  dimensionLabel: string;       // 材料成本 | 人工成本 | 加工费（含设备）| 设计与制版 | 财务与其他
  estimatedAmount: number;
  amountRange: [number, number];
  ratio: number;                // 占总额 %
  basis: string[];
  assumptions: string[];
  confidence: number;
  risks: string[];
  breakdown?: {
    label: string;
    amount: number;
    note?: string;
    kind?: "process" | "equipment";  // 加工费维度专用：纯工艺 / 设备·开机
  }[];
}

// ===== 默认假设（独立透明展示）=====
export interface DefaultAssumption {
  field: string;
  label: string;
  assumedValue: string;
  reason: string;               // 为什么用这个默认、影响哪个维度
}

// ===== 成本驱动点（派生）=====
export interface CostDriver {
  dimension: string;
  dimensionLabel: string;
  amount: number;
  ratio: number;
  reason: string;               // 该维度最贵分项的 note 或 basis[0]
}

// ===== 小批量提示（派生，含数量敏感）=====
export interface SmallBatchNote {
  visible: boolean;             // design_plate.ratio > expectedMax 才 true
  dimension: string;
  ratio: number;                // 当前设计制版占比 %
  expectedMin: number;          // 预期区间下限（默认 3）
  expectedMax: number;          // 预期区间上限（默认 10）
  fixedFee: number;             // 设计制版固定费总额（制版+设计+打样）
  currentPerPiece: number;      // 当前批量下摊到单只（fixedFee/quantity）
  suggestions: { quantity: number; perPiece: number }[]; // 2× / 5× 批量摊薄
  message: string;              // 三段式解释文案（SMALL_BATCH_MESSAGE）
}

// ===== 优化方向（埋钩）=====
export interface OptimizationHint {
  id: string;
  title: string;
  summary: string;
  detail: string;
  potentialSaving: string;      // 如 "约 8%–15%"，措辞用"可评估"
  category: "material" | "process" | "design" | "logistics";
}

export type ClientSectionKey =
  | "total_range" | "structure" | "drivers" | "completeness"
  | "confidence" | "small_batch" | "optimization" | "disclaimer" | "cta";

// 组装产物：AnalysisReport 已含 costDrivers / smallBatchNote / ctaCopy / sectionOrder
```

### 1.3 派生字段生成位置

| 字段 | 生成函数 | 逻辑 |
| --- | --- | --- |
| `costDrivers` | `generateCostDrivers(results)` | 按 `estimatedAmount` 降序取前 3，reason = 该维度最贵 breakdown 的 `note` 或 `basis[0]` |
| `smallBatchNote` | `buildSmallBatchNote(results, config, quantity)` | `design_plate.ratio > expectedMax` → `visible=true`，否则 `false` |
| `ctaCopy` | 常量 `CTA_COPY` | 固定文案，预留可配置 |
| `sectionOrder` | 常量 `SECTION_ORDER` | 锁定 9 顺序，前端严格按序渲染 |
| `defaultAssumptions` | 输入解析 | 每处缺省都生成一条，**独立数组**专供模块 4 |

---

## 二、渲染 / 组装逻辑建议

### 2.1 组装（orchestrator）

- `sectionOrder` 一律用 `SECTION_ORDER` 常量，**不允许前端自定义顺序**。
- `costDrivers` / `smallBatchNote` / `ctaCopy` 在 `runOrchestrator` 收尾时一次性组装进 `AnalysisReport`，前端不做二次计算。
- 所有金额以**区间**呈现（单点 → 被当成承诺，风险高）。

### 2.2 各模块渲染规则

| # | 模块 | 渲染方式 | 视觉 / 条件 |
| --- | --- | --- | --- |
| 1 | 总成本区间 + 单只价 | **顶部 Hero 横幅**：左总区间、中单只区间、右整体置信度 | 永远置顶；数字加粗；区间浅色底色 |
| 2 | 五维结构占比 | **可视化（饼/环图）+ 并排表格**；加工费拆两行小计 | 图兜底表格；加工费必须拆「纯工艺 / 设备·开机」 |
| 3 | 成本驱动点 | **3 张焦点卡**：维度 + 金额 + 占比 + 一句话原因 | 永远展示前 3 贵项 |
| 4 | 完整度 + 默认假设 | **琥珀色卡片**：顶部「完整度 XX%」，下方**独立**清单 | 清单独立成块；`defaultAssumptions.length===0` 时显示「无默认假设，输入完整」 |
| 5 | 置信度 | **整体徽章 + 各维度进度条** | 补「各维度为何下调」（usedDefaults 驱动） |
| 6 | 小批量提示 | **蓝色 info 框（真实成本特征）** | 仅 `smallBatchNote.visible=true` 插入；否则整块不渲染 |
| 7 | 优化方向 | **1–3 条折叠卡** | 只给方向+潜在空间，不展开方案；为 VAVE 埋钩 |
| 8 | 免责声明 | **顶部 + 底部双 banner（橙）** | 固定 `DISCLAIMER` |
| 9 | 转化入口 | **底部 CTA 横幅（深）** | 固定 `CTA_COPY` + 动作按钮 |

### 2.3 加工费拆分渲染规则（模块 2 强制）

加工费维度的 `breakdown` 每项带 `kind`：
- `kind: "process"` → 归入**「纯工艺加工费」**小计：印刷运行费、表面处理、模切、贴窗。（注：油墨为印刷耗材，已在材料维度单列，不在此组）
- `kind: "equipment"` → 归入**「设备 · 开机相关费用」**小计：开机托底、专色调色/洗车、刀模费（一次性）。
- 结构占比表中，加工费一行下方必须展开这两个小计（或在表外单列两行）。
- 无独立设备费时（开机费已含入印刷运行费），该小计显示「本单无独立设备/开机固定费」，**不漏计、不重复计**。
- 模块 2 文案注明：「加工费含设备相关分摊，已按纯工艺 / 设备·开机拆分列示」。

### 2.4 默认假设独立透明规则（模块 4 强制）

- `defaultAssumptions` **独立成块**，不和「缺失字段提示」混排。
- 每条显示：`字段名 → 套用默认值 → 原因/影响维度`。
- 明确告知「相关维度置信度已据此下调」，把不确定讲出来反而增信。
- 完整度 100% 时仍显示「信息完整，无默认假设」一句话，保持板块一致。

### 2.5 小批量三段式渲染规则（模块 6）

`smallBatchNote.visible=true` 时，按三段渲染：
1. **① 一次性固定费用**：文案 `message`（固定费说明）。
2. **② 当前批量正常现象**：`ratio% 高于常规 3%–10%，单只分摊 ¥currentPerPiece 属正常`。
3. **③ 数量提升提示**：遍历 `suggestions`，逐条 `若数量提升至 N 个，单只约降至 ¥X`。

### 2.6 语气与可信度纪律

- 全程**中性陈述**，禁「最低价 / 最优 / 保证省」。
- 金额一律**区间**，降低承诺风险。
- 默认假设、置信度下调**主动暴露**。
- 优化方向用「可进一步评估」，不预设客户一定省。

---

## 三、各模块示例文案

> 统一案例（小批量彩盒）：200×150×80 / **数量 800** / 白卡350 / 胶印4C / 哑膜 / 华东，设计制版 ¥2,350（制版4色×350 + 设计800 + 打样150）。
> 估算口径：总额 ¥4,200，单只 ¥5.25；占比 材料24% / 人工7% / 加工21%(纯工艺19%+设备2%) / 设计56% / 财务16%；完整度 92%；置信度 78%。

### 模块 1 · 总成本区间 + 单只价格区间
> **总成本区间：¥3,950 – ¥4,480**
> **单只价格区间：¥4.94 – ¥5.60 / 个**
> **整体置信度：78%（中等）**

### 模块 2 · 五维成本结构占比（加工费拆分）
> 材料成本 24% · 人工成本 7% · 加工费 21%（纯工艺加工费 19% + 设备·开机相关费用 2%）· 设计与制版 56% · 财务与其他 16%
>
> 加工费拆分明细：
> - 纯工艺加工费 ¥800：印刷运行费 + 哑膜 + 模切（油墨为印刷耗材，在材料维度单列，不在此组）
> - 设备 · 开机相关费用 ¥100：刀模费（一次性）
> - 注：加工费含设备相关分摊，已按纯工艺 / 设备·开机拆分列示。

### 模块 3 · 主要成本驱动点说明
> - **设计与制版（¥2,350，56%）**：制版费 4 色 × ¥350 + 设计费 ¥800 + 打样费 ¥150，为一次性固定投入。
> - **材料成本（¥1,008，24%）**：白卡 350g 面纸 + 损耗，受纸价波动影响。
> - **加工费（¥882，21%）**：以印刷运行与哑膜为主，刀模费一次性计入设备项。

### 模块 4 · 信息完整度 + 默认假设清单（独立透明）
> **信息完整度：92%**
>
> 下列字段未提供，已套用合理默认并据此估算（相关维度置信度已相应下调）：
> - **生产 / 交付地域** → 华东地区：默认按华东人工费率估算（人工维度置信度 −10）
> - **完稿文件** → 未提供：设计费按标准 ¥800 估算（设计维度置信度 −5）

### 模块 5 · 置信度说明
> 整体置信度 **78%（中等）**。各维度：材料 80 / 人工 68 / 加工 78 / 设计 75 / 财务 72。
> 因使用 2 项默认假设，整体置信度下调约 12 分；补充实际地域与完稿信息后可进一步提升。

### 模块 6 · 小批量特殊提示（触发示例见第四节）
> **真实成本特征**：设计与制版占比约 56%，明显高于常规区间（3%–10%）。这是一次性固定费用，当前批量下单只分摊较高属正常现象；批量提升后单只成本会明显下降——并非估算偏差。
> - 当前 800 个：单只分摊约 ¥2.94
> - 若提升至 1,600 个：单只约降至 ¥1.47
> - 若提升至 4,000 个：单只约降至 ¥0.59

### 模块 7 · 初步优化方向（埋钩，不给完整方案）
> - **提升订单量级**：当前数量偏少，固定费与开机成本分摊高，量级提升后单位成本通常可降 8%–15%。（可进一步评估）
> - **评估材质替代**：材料占比约 24%，在保挺度前提下可评估替代材质或克重空间。（可进一步评估）

### 模块 8 · 免责声明
> ⚠ **本结果为估算，仅供参考，最终以正式报价为准。**

### 模块 9 · 转化入口文案
> 如需进一步做**成本优化、供应链诊断或 VAVE**，欢迎继续沟通，我们提供深度成本拆解与落地方案。

---

## 四、小批量解释：触发条件与完整示例

### 4.1 触发条件（伪代码）

```ts
function buildSmallBatchNote(results, config, quantity): SmallBatchNote {
  const dim = results.find(r => r.dimension === "design_plate");
  const cfg = config.dimensions.find(d => d.key === "design_plate");
  const expectedMin = cfg?.expectedRatioRange[0] ?? 3;
  const expectedMax = cfg?.expectedRatioRange[1] ?? 10;

  // 无设计制版维度 → 不触发
  if (!dim) return { visible: false, /* ... */ };

  const fixedFee = dim.estimatedAmount;                 // 制版+设计+打样 一次性
  const currentPerPiece =
    quantity > 0 ? fixedFee / quantity : 0;             // 当前单只分摊
  const suggestions = [2, 5].map(mult => ({             // 2× / 5× 批量摊薄
    quantity: Math.round(quantity * mult),
    perPiece: fixedFee / Math.round(quantity * mult),
  }));

  // 核心触发：设计制版占比 > 预期上限（默认 10%）
  if (dim.ratio > expectedMax) {
    return {
      visible: true,
      ratio: dim.ratio, expectedMin, expectedMax,
      fixedFee, currentPerPiece, suggestions,
      message: SMALL_BATCH_MESSAGE,                     // 三段式固定文案
    };
  }
  return { visible: false, /* ...保持字段完整... */ };
}
```

**触发 =** `design_plate.ratio > expectedMax`（默认 10%，可由产品配置 `expectedRatioRange` 覆盖）。
**不触发 =** 占比在 3%–10% 内，或小批量但设计费本身低（如客户提供完稿、免设计费）。

### 4.2 完整示例（数据来自 `smallBatchNote`）

**输入上下文**
- 数量 `quantity = 800`
- 设计与制版 `fixedFee = ¥2,350`，`ratio = 56%`（> 预期上限 10% → 触发）
- `currentPerPiece = 2350 / 800 = ¥2.94`
- `suggestions`:
  - `{ quantity: 1600, perPiece: 2350/1600 = ¥1.47 }`
  - `{ quantity: 4000, perPiece: 2350/4000 = ¥0.59 }`

**渲染输出**
```
[真实成本特征]
设计与制版（制版费 + 设计费 + 打样费）为一次性固定费用，不随数量按件计算。
在当前批量下，这笔固定费用被较少数量分摊，单只占比偏高属正常现象——
批量提升后，该费用分摊到更多数量，单只成本会明显下降。这是该类产品的真实成本特征，并非估算偏差。

① 一次性固定费用：制版 + 设计 + 打样合计 ¥2,350，不随数量变动。
② 当前批量正常现象：800 个时单只分摊约 ¥2.94，占比偏高属正常。
③ 数量提升提示：
   · 若数量提升至 1,600 个，单只约降至 ¥1.47；
   · 若数量提升至 4,000 个，单只约降至 ¥0.59。
```

**要点**：不当成错误、不当成估算偏差；用固定费 + 当前正常 + 数量敏感三段，把"贵"转成"可优化的杠杆"，自然衔接模块 7 的 VAVE 钩子。

---

## 五、落地检查清单

- [x] `src/types/index.ts`：`CostDriver` / `SmallBatchNote` / `ClientSectionKey` / `DefaultAssumption` / `OptimizationHint` 齐备
- [x] `orchestrator.ts`：组装 `costDrivers` / `smallBatchNote` / `ctaCopy` / `sectionOrder`
- [x] `report-copy.ts`：`SECTION_ORDER` / `DISCLAIMER` / `CTA_COPY` / `SMALL_BATCH_MESSAGE` 集中管理
- [x] `ReportStep.tsx`：按 `sectionOrder` 渲染；加工费按 `kind` 拆两组小计；默认假设独立块；小批量三段式
- [x] `pdf/export.ts`：同步 9 模块顺序与加工费拆分、小批量三段式
- [ ] 多语言 / A/B 文案：文案常量已隔离，后续直接替换 `report-copy.ts` 即可
