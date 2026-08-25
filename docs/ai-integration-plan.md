# AI 融入实施计划（v1.1，2026-08-26）

> 本计划依据 `PROJECT_STATUS.md §3.1` 确立的 **三条铁律 + 7 层架构准则** 制定，目标是把准则中的 AI 部分逐一映射到现有代码结构（agent / 组件 / 路由），实现"协同作战"。
>
> - 三条铁律：**事实守恒 / 数字守恒 / 可溯源性（Audit Trail，Data Pointer）**
> - 7 层：**上下文 → 输入解析 → 计算 → 判定 → 规则过滤→AI 软排序 → 表达 → 谈判 → 知识沉淀**
> - 介入纪律：每个 AI 介入点须有「确定性锚」；硬约束 Rule Filter 前置一票否决；商业模型可用前提数据脱敏/不出公网。

---

## 0. 现状盘点（已浏览确认）

项目里**已散落 4 个 AI 接入点，但各自为战、未对齐准则**，融入重点是"按准则重新定位已有 AI 点 + 补齐缺失层 + 强制三条铁律"，不是从零建 AI。

| 现有模块 | 对应准则层 | 状态 | 需纠偏 |
|---|---|---|---|
| `src/lib/llm/client.ts` | 基础设施 | `chatCompletion` + 回退 + `extractJsonObject` 已满足"确定性锚+回退" | 各模块各自拼 prompt 分散，需收敛 |
| `src/lib/agents/nlp-parser.ts` | 输入解析 | 已做 `parseDrawingImage` / `parseNaturalLanguage` | ❌ 踩评审坑：CAD 直接喂视觉 LLM，无 DXF/OCR 确定性预处理 |
| `src/lib/material-prices/search-agent.ts` | 上下文 | 已做行情检索+回退 | ❌ 轻微违反数字守恒：让 LLM 直接返回 `price` 数字；且无基准戳 |
| `src/lib/agents/llm-analyst.ts` | 表达 | 已做单一 SQE 诊断 | 无角色化、无 Data Pointer 可溯源 |
| `src/lib/agents/reviewer.ts` + orchestrator 校验 | 判定 | 规则证据已产出 | 无 AI 解释层（message 硬编码） |
| `src/components/vave/ScenarioPanel.tsx` 排序 | 推荐排序 | 纯数字排序 | 无"规则过滤→AI 软排序" |
| `src/lib/vave/negotiation.ts` | 谈判 | 纯规则话术模板 | 无多 agent 博弈 |
| 知识沉淀 | — | 完全缺失 | — |

---

## 1. 阶段划分与依赖

> **两条用户硬约束（来自 2026-08-26 评审，必须落地）：**
> - **【微调 1 · 上下文与表达/判定的紧耦合】**：阶段 5（全量上下文层）完善前，阶段 1/2 必须读取**本地基准戳**作为时效 Context，确保 AI 解释带时效性说明（避免偏向静态）。
> - **【微调 2 · 知识沉淀人工闸门】**：阶段 7 的 AI 反推规则**绝不能直接 WriteBack 生产规则库**，必须进 `pendingRules` 待审核池，由 SQE/工程师手动「确认固化」后才转为确定性配置。

| 阶段 | 准则层 | 改造动作 | 前置依赖 | 优先级 |
|---|---|---|---|---|
| P0 基础对齐 | 全部 | 新增 `llm/structured.ts`：统一「带 JSON schema 的结构化调用 + 回退」封装，收敛分散 prompt | 无 | 前置 |
| P0.5 基准戳 | 上下文（轻量） | 新增 `MATERIAL_PRICES_META = { asOf, source }` 常量（如 `asOf:"2026-08"`），供阶段 1/2/3 注入时效 Context | 无 | 前置 |
| P1 表达层 | 表达 + 第三条铁律 | `llm-analyst` 升级多角色（采购/供应/成本/客户）表达；输出带 **Data Pointer**（数字引用引擎字段 key，前端可高亮回原始 JSON）；**注入本地基准戳做时效说明** | P0, P0.5 | 先做 |
| P2 判定解释 | 判定 + P0.5 | 新增 `agents/judge-explain.ts`：消费 reviewer/校验的结构化证据 → AI 生成「严重度+为什么+修复建议」；规则文案回退；**注入本地基准戳** | P0, P0.5 | 先做 |
| P3 排序 | 规则过滤→AI 软排序 | 前置确定性 **Rule Filter**（物理强度/客户规范/MOQ 一票否决）→ `vave/ranker.ts` 可行集内 AI 加权软排序+解释 | P0 | 先做 |
| P4 输入解析纠偏 | 输入解析 | `parseDrawingImage` 前加确定性预处理（DXF 矢量提取尺寸 / OCR 抽表矩阵）→ AI 仅语义对齐，不读图抽尺寸 | 视觉模型 + 矢量解析 | 后做 |
| P5 上下文收口 | 上下文 | `search-agent` 行情数字改**确定性提取**（Web/API 数值抽取），AI 只整合归因；接入 `pendingRules` 之外的行情缓存 | 三期数据底座 | 后做 |
| P6 谈判博弈 | 谈判 | `vave/negotiation-agent.ts`：多 agent 角色扮演，每轮回引擎 verify，话术带 Data Pointer | P1, P3 | 后做 |
| P7 知识沉淀 | 知识沉淀 | `vave/knowledge-distill.ts`：真实案例对比 → AI 反推待固化规则 → 入 **`pendingRules` 待审核池**（UI 展示，SQE 手动确认才固化） | 真实案例数据 | 后做 |
| **P8 一致性闸门** | 全层（守门） | `agents/consistency-gate.ts`：**① 数字漂移检测**（扫描 AI 文本金额/百分比 vs Pointer 真实数字，超容差告警）；**② 跨层冲突拦截**（判定否决但文本称可行 → 强制以确定性结论为准；排序否决方案被称可行 → 强制替换否决理由）；**③ 审计日志**（每次 AI 调用输入/引擎 KV/输出落盘 `logs/ai-audit.jsonl` + 内存环形）；统一返回管道 `runGated` 挂载于 P1/P2/P3/P6/SQE/解析 | P0 | **已完成** |

---

## 2. 关键设计细节

### P0 `llm/structured.ts`（统一结构化调用）
- 封装 `callStructuredLLM({ system, user, schema, fallback })`，内部用 `extractJsonObject` 解析，失败/无 LLM 时走 `fallback`（确定性规则文案）。
- 所有 AI 层（P1/P2/P3/P6）统一经此入口，杜绝散落 prompt；满足「确定性锚 + 回退」精神。

### P0.5 `MATERIAL_PRICES_META`（本地基准戳）—— 微调 1 落地
- 在 `cost-rules/index.ts` 增加：`export const MATERIAL_PRICES_META = { asOf: "2026-08", source: "本地权威基准价（知识库）", note: "未含实时行情，价格仅供参考" };`
- P1/P2 的 prompt 注入：`基于本地基准价（asOf ${META.asOf}，未配置实时行情）`，使 AI 解释自带时效边界，不暗示"实时行情"。

### P1 表达层（多角色 + Data Pointer + 时效）—— 微调 1 落地
- 角色：`procurement`（采购压价视角）/ `supplier`（供应守价视角）/ `cost`（成本专家）/ `client`（客户决策视角）。
- 输出结构：`{ role, headline, points[], pointers: [{ text, dimensionKey, fieldPath }] }`，其中 `pointers` 引用引擎 `dimensions[].estimatedAmount` / `totalCost.perUnit` 等字段，前端悬停高亮原始 JSON（满足第三条铁律）。
- 时效：每条结论附带 `asOf` 说明（来自 P0.5）。

### P2 判定解释（规则证据 → AI 叙述）
- 输入：reviewer 产出的结构化 `validationIssues`（type / currentValue / threshold / overAmount）。
- AI 只消费这些事实，生成「严重度 + 为什么 + 修复建议」；**触发布尔仍由规则算**，AI 不决定是否超限。
- 无 LLM 时回退现有硬编码 message。

### P3 排序（硬约束前置 + AI 软排序）
- **Rule Filter（确定性，一票否决）**：物理强度不满足 / 客户规范锁定 / MOQ 不达标 → 直接剔除，不进 AI 排序。
- **AI 软排序（可行集内）**：对通过过滤的方案，按供应商能力 / 交期 / 质量风险加权排序；输出每项「为什么排这」须结构化可追溯（依据来自输入字段/知识库/强度公式），不凭空说"不现实"。
- 渐进：AI 跑出的稳定模式可沉淀为 Rule Filter 规则（见 P7）。

### P4 输入解析纠偏（评审一.1 落地）
- 确定性预处理必须先于 AI：`DXF/DWG` 矢量解析提取尺寸、OCR 抽报价单表格矩阵 → AI 仅做**语义对齐 / 实体归一化 / 缺失推断**，不读图抽尺寸。
- 输出须人工确认 + 回引擎验证（满足事实守恒）。

### P5 上下文收口（评审二.1 落地，依赖三期数据底座）
- 行情数字由确定性管道（Web 数值抽取 / ERP API）拉取，**AI 不得生成行情数字**，只做语义整合与波动归因。
- 修复现有 `search-agent.ts` 让 LLM 直接返回 `price` 的违规（数字守恒）。
- 在 P1/P2 已用本地基准戳（P0.5）过渡，P5 只把"本地戳"升级为"实时戳"。

### P6 谈判博弈（评审二.2 可溯源落地）
- 多 agent 角色扮演，每轮新报价回引擎 verify（数字守恒）；话术带 Data Pointer（可溯源）。

### P7 知识沉淀（评审二.2 人工闸门落地）—— 微调 2 硬约束
- 流程：`真实案例对比（引擎估算 vs 实际成交） → AI 反推待固化规则 → 写入 pendingRules 待审核池`。
- **硬闸门（不可逾越）**：`pendingRules` 中的规则**绝不直接 WriteBack 生产规则库 / 知识库 / 代码**。必须经 UI「待审核规则池」由 SQE / 工程师手动勾选「确认固化」，才转为确定性引擎配置（写入知识库或 cost-rules）。
- AI 在此层仅有「提案权」，无「写入权」——这是防止 AI 污染确定性底座的最后防线。

### P8 一致性闸门（守门层，2026-08-26 完成）

> 价值：把前 7 层"结构约束 + 确定性兜底"升级为"主动闭环自检"，回答"AI 会不会跑偏"——会，但被闸门拦住并留痕。

**① 数字漂移检测（`detectNumberDrift`）**
- 扫描 P1 多角色文本、P6 谈判每轮叙述中的金额（¥x.xx）/ 百分比（x%），与 `DataPointer` 指向的引擎真实数字比对。
- 容差随数量级放大（perUnit ¥6.21 用 0.15 绝对容差，材料 ¥1849 用 1 绝对容差），避免四舍五入误报；超容差记为 `DriftFinding`，挂到 `RoleReport.driftWarnings` / `NegotiationTurn.driftWarnings`。
- 设计取舍：默认**告警**（不静默改写 AI 自由文本，避免破坏可读性），仅在"确定性结论替换"场景才强制改写。

**② 跨层冲突拦截（叙述一致性）**
- 判定层：`reconcileJudge`——确定性 `severity=error` 但 AI 的 `why` 称"可行/无问题" → 强制替换为确定性结论，并产 `contradiction` 告警。
- 排序层：`reconcileRankerNarrative`——方案已被 Rule Filter 否决但 AI 排序理由称"可行/推荐" → 强制以否决理由替换，产告警。
- 跨层：`reconcileCrossLayer`——判定层存在 error 且表达层（客户/成本视角）宣称"无风险/风险可控" → 在叙述中标注"须以判定层确定性结论为准"，产 `cross_layer` 告警。
- 编排层（`orchestrator`）：聚合上述告警 + 各角色漂移，写入 `AnalysisReport.consistencyWarnings`。**确定性结论永远胜出**，AI 无否决权。

**③ 审计日志（`auditLLMCall`）**
- 每次 AI 调用（P1/P2/P3/P6/SQE 诊断/图纸&自然语言解析）记录：时间戳、层名、来源（llm/template）、模型、输入摘要、引擎关键 KV、输出文本、告警。
- 落盘：`logs/ai-audit.jsonl`（服务端动态 `import("node:fs/promises")`，`typeof window` 守护，**浏览器仅留内存**，保证客户端打包不引入 fs）。
- 内存环形（500 条）供调试；审计失败被吞掉，绝不阻塞主流程。

**统一返回管道（`runGated`）**
- P1/P2/P3/P6 全部经 `runGated` 出口：`callStructuredLLM` → 可选叙述对账 → `auditLLMCall`。`runGated` 不破坏既有层函数返回形态（返回 `{ result, warnings }`）。
- 安全边界：`consistency-gate.ts` 不得静态引入 `node:fs`（`ranker` 经 `ScenarioPanel` 进入客户端打包图），所有文件 IO 走函数内动态导入 + `webpackIgnore` 注释。

---

## 3. 建议起步（纯代码、不依赖外部数据）

**先做 P0 + P0.5 + P1 + P2 + P3**：
- 直接落地"可溯源"铁律（Data Pointer）与"规则过滤前置"原则；
- 不依赖视觉模型（P4）/ 三期数据底座（P5）/ 真实案例数据（P7）；
- 立刻验证准则落地效果，且正好覆盖你最在意的"表达/判定/排序"三层。

P4/P5/P6/P7 依赖前置能力，后做；其中 P5 的本地基准戳过渡（P0.5）已前置到先做批次，避免 P1/P2 偏向静态。

---

## 4. 变更日志

- **v1.0 (2026-08-25)**：初版 7 阶段计划，映射现有 AI 散点。
- **v1.1 (2026-08-26)**：吸收用户评审两条微调——
  1. 新增 P0.5「本地基准戳」+ 阶段 1/2 注入时效 Context（紧耦合，解决无实时行情时解释偏向静态）；
  2. 阶段 7 明确 `pendingRules` 人工闸门硬约束，AI 反推规则禁止直写生产库。
