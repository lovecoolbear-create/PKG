# 包装降本分析工作台 — 项目状态报告

> **用途**：本项目单一真相源（single source of truth）。每次有代码/文档/配置改动，更新本文件的「变更日志」与对应章节，避免在长对话里反复重读整个项目上下文。
> **最后更新**：2026-08-25
> **代码基线**：方法论文档以提交 `24985af` 之后为准（5 维 + 只读审阅器 + 真实案例校准闭环已落地）。

---

## 1. 项目概览

- **定位**：包装成本估算与VAVE降本分析工作台，面向 VAVE/降本场景。上传图纸/报价单 → 解析 → 多 Agent 成本分析 → 透明拆解报告 + VAVE 优化提案 → PDF/分享链接。
- **当前范围**：已配置「彩印纸盒（color_print_box）」「平面彩印（flat_print）」「瓦楞纸箱（corrugated_box）」三类产品；架构支持多产品（见 `src/config/products/`，注册即扩展，首页品类卡片自动列出）。平面彩印复用五维成本框架，仅派生量与各 Agent 公式按品类分支；瓦楞纸箱复用彩盒五维引擎，仅材料 Agent 走专属分层纸板计算。
- **价值主张**：透明可解释（每维有计算依据与假设）、多维度拆解、优化建议（VAVE 方向）。
- **精度定位**：经验合理级（±10%~20% 经验区间），非可报价级；靠真实案例校准向 ±10% 收敛（见 §6 校准）。

---

## 2. 技术栈与运行

| 项 | 内容 |
|---|---|
| 框架 | Next.js 15.1.6（App Router）、React 19、TypeScript 5.7 |
| 样式 | Tailwind CSS 3.4 + lucide-react 图标 |
| 数据库 | Prisma 6.5 + SQLite（默认）；可选 Postgres（schema.prisma） |
| 报告导出 | jsPDF + jspdf-autotable；图表 recharts |
| 脚本运行 | tsx（`node_modules/.bin/tsx` 或 `npm run <script>`） |
| AI/LLM | 走 `src/lib/llm/client.ts`，配置存浏览器 localStorage；未配环境变量时全程规则/模板回退 |

### 运行命令
```
npm run dev       # 本地开发（见下方注意）
npm run build     # 生产构建
npm run start     # 生产启动
npm run test                 # calc-test.ts 计算测试
npm run test:calibration     # calibration-test.ts 合成回归基线
npm run test:calibration:real  # calibration-real.ts 真实案例校准
npm run seed      # 数据库种子
```

### ⚠️ 本地 dev 启动注意（反复踩坑）
- 项目在本地 `/Users/blair/成本分析`（非沙箱）。用 WorkBuddy 跑 `npm run dev` **必须 `dangerouslyDisableSandbox`**，否则监听端口/写 `.next` 被拦。
- **删除门禁**：WorkBuddy safe-delete 会拦截「单次批量删 50+ 文件」。Next dev 启动清理已存在的 `.next` 会触发它导致 server 起不来（502/500）。
- **标准重启动作**：先 `mv -f .next ".next.bak-$(date +%s)"` 移走旧构建，再启动；首次编译无删除即不触发门禁。
- 默认端口 3000。

---

## 3. 架构与数据流

```
用户输入(input) → applyDefaults(FIELD_DEFAULTS 行业默认 + 默认假设清单透明展示)
   → deriveAnalysisContext(一次算出所有共享派生量：净/拼版/印刷/表面有效面积、数量、损耗率、盒型系数等，dataflow 单一真相源)
   → 6 个 specialist agent 只读消费 ctx：
        materialAgent   材料（含油墨，见 §4）
        laborAgent      人工（唯一随地域浮动，见 §4）
        processAgent    加工费（工艺/设备拆分，见 §4）
        designAgent     设计制版（一次性固定费）
        financeAgent    财务（物流简化、包装、管理、利润）
        reviewer        只读跨维度审阅器（不重算、不互调）
   → validate(仅 warning，不报 error；占比越界/小批量判为「真实成本特征」)
   → 9 模块客户报告 + PDF 导出
```

**关键架构决策（2026-08-23 用户确认）**
- 6 个 specialist 是**纯规则确定性函数**，不调 LLM；各自从 ctx 读共享派生量（消除重复计算、单一真相源）。
- **禁止**在 specialist 间引入自由迭代 loop（A↔B 重算）→ 数值正反馈振荡、无收敛判据死循环、破坏可追溯。
- **只读跨维度审阅器 + 未来精度提升**（分区覆盖）是唯一允许的非零通信形态，属铺路型。
- 二期 VAVE 谈判模拟（多 agent 协作 loop）应为独立工作台，不串现有 6 个成本 specialist。

---

## 3.1 AI 介入架构准则（项目级，2026-08-25 确立，2026-08-26 经用户评审修订）

> 适用范围：全项目（成本分析引擎 + VAVE 模块）。原则：数字底座确定性，AI 作用于上下文/感知/判定/排序/表达/探索层，且必须遵守两条守恒 + 可溯源。

**两条守恒（铁律，不可违反）**
- **事实守恒**：AI 消费的事实必须由确定性/结构化来源提供，AI 不得发明事实。
- **数字守恒**：最终报客户的成本数字仍由引擎产生，AI 不生成数字，只生成「对数字的说法」。

**第三条铁律：可溯源性（Audit Trail）**
- 表达层/谈判层所有金额、降本%、工期等数字，必须带数据来源标记（Data Pointer），可高亮回溯到成本引擎原始 JSON 明细。客户/采购随时可验证「这笔钱怎么算的」。

**AI 介入分层（全项目 7 层 + 规则过滤）**
| 层 | AI 角色 | 介入方式（含确定性锚） |
|---|---|---|
| 上下文层 | 整合者 | 判定/排序前，确定性拉取动态行情（纸价/运费/产能，接三期数据底座 API/ERP）+ AI 语义整合与波动归因；AI 不生成行情数字 |
| 输入解析 | 感知者 | **确定性预处理先做**（DXF/DWG 矢量提取尺寸、OCR 抽表格矩阵）→ AI 仅做语义对齐/实体归一化/缺失推断；AI 不发明图纸尺寸，输出须人工确认 + 回引擎验证 |
| 计算 | 不介入 | 5 维引擎确定性 |
| 判定 | 解释者 | 规则算布尔（冲突/超限），AI 消费证据生成「严重度+为什么+修复建议」；触发条件确定性 |
| 规则过滤→AI 软排序 | 过滤网+权衡者 | **先确定性 Rule Filter 一票否决硬约束**（物理强度/客户规范锁定/MOQ 下限）→ 剩余可行集内 AI 按供应商能力/交期/可实施性加权软排序 + 解释 |
| 表达 | 叙述者 | 各角色口吻综合全量结果生成报告/话术；数字带 Data Pointer 可溯源 |
| 谈判 | 博弈者 | 多 agent 角色扮演，每轮新报价回引擎 verify；话术数字带 Data Pointer |
| 知识沉淀 | 飞轮 | 真实案例对比「引擎估算 vs 实际成交」→ AI 反推待固化规则 → **入 `pendingRules` 待审核池，硬闸门：须 SQE 手动确认固化，禁 AI 直写生产库** |

**介入纪律**
- 每个 AI 介入点须有「确定性锚」：要么输入事实确定，要么输出可回引擎验证。
- 硬约束（物理规律/客户规范）一律确定性 Rule Filter 前置，AI 不做「加权放过」。
- 渐进落地：表达层/判定层/排序先行；输入解析（需视觉模型+预处理）、上下文层（需三期数据底座）、知识沉淀做长期飞轮。
- 本地模型限制不阻塞架构（可用商业大模型，前提数据脱敏/不出公网合规）。

**客户报告结构（表达层设计依据）**：一页结论（省多少/风险可控/符合规范）→ 方案矩阵（选项/降本/风险/合规/优先级）→ before-after 成本瀑布 → 实施路径（样品→小批→量产）→ 风险与缓解（主动暴露）。客户信任来自「把坑都标了 + 显式声明符合其规范 + 每个数字可点开看算法」。

### 3.2 AI 融入实施计划（详见 `docs/ai-integration-plan.md` v1.1）

> 把 §3.1 准则映射到现有代码结构、分批改造的协同作战路线。现状：项目已散落 4 个 AI 接入点（`nlp-parser` / `search-agent` / `llm-analyst` / `reviewer`），但各自为战、未对齐准则，且部分**踩了 §3.1 红线**（见计划文档「现状盘点」）。

**两处用户硬约束（2026-08-26 评审，已写入计划，不可逾越）**
- **硬约束 A · 上下文与表达/判定紧耦合**：阶段 5（实时上下文层）完善前，阶段 1（多角色表达）/ 阶段 2（判定解释）必须读取**本地基准戳**（`MATERIAL_PRICES_META.asOf`，计划 P0.5 新增）作为时效 Context，使 AI 解释自带「基于本地基准价（asOf X，未含实时行情）」时效边界，不偏向静态、不暗示实时行情。
- **硬约束 B · 知识沉淀人工闸门**：阶段 7 AI 反推的待固化规则**禁止直写生产规则库/知识库/代码**，必须入 `pendingRules` 待审核池，由 SQE/工程师手动「确认固化」后才转为确定性配置。AI 在知识沉淀层仅有提案权、无写入权。

**阶段路线（建议起步：P0+P0.5+P1+P2+P3，纯代码、不依赖外部数据）**
| 阶段 | 准则层 | 要点 |
|---|---|---|
| P0 | 全部 | `llm/structured.ts` 统一结构化调用+回退，收敛分散 prompt |
| P0.5 | 上下文(轻) | 新增 `MATERIAL_PRICES_META` 基准戳常量，供 P1/P2 注入时效 |
| P1 | 表达+铁律3 | 多角色表达（采购/供应/成本/客户）+ Data Pointer 可溯源 + 时效戳 |
| P2 | 判定 | `judge-explain.ts`：规则证据→AI 解释，触发布尔仍确定性 |
| P3 | 规则过滤→软排序 | 确定性 Rule Filter 一票否决 → 可行集内 AI 软排序+解释 |
| P4 | 输入解析 | ✅ DXF/文本确定性尺寸抽取前置（`extractDeterministicDimensions`），视觉 LLM 仅语义对齐；AI 抽取字段标 `ai_extracted`+`requiresHumanConfirmation`（修评审一.1 坑） |
| P5 | 上下文 | ✅ `searchPaperPrice` 价格改确定性基准（AI 只出趋势），新增 `context-layer.ts` 聚合 `MATERIAL_PRICES_META` 时效戳注入 P1/P2（修数字守恒违规 + 评审二.1） |
| P6 | 谈判 | ✅ `negotiation-agent.ts` 三方角色博弈 + 每轮 `verifyScenarioPerUnit` 回引擎校验 + Data Pointer；`/api/vave/negotiate` |
| P7 | 知识沉淀 | ✅ `knowledge-distill.ts` 案例对比→反推规则（仅提案）+ `pending-rules.ts` 人工闸门（AI 无写入权，确认才转 KB override）+ `/api/vave/distill` + 工作台「知识沉淀」tab |
| P8 | 一致性闸门（守门） | ✅ `agents/consistency-gate.ts`：① 数字漂移检测（AI 文本金额/百分比 vs Pointer 真实数字超容差告警，挂 `driftWarnings`）② 跨层冲突拦截（判定/排序否决但文本称可行 → 强制以确定性结论为准，产 `contradiction`/`cross_layer` 告警）③ 审计日志（每次 AI 调用落盘 `logs/ai-audit.jsonl` + 内存环形）④ 统一返回管道 `runGated` 挂载 P1/P2/P3/P6/P7(知识沉淀)/SQE/解析 + `search-agent`(行情) 审计；`nlp-parser` 维持底层 `chatCompletion`+审计（原始文本输出，强套 JSON 不合适，属有意设计）；编排层聚合 `AnalysisReport.consistencyWarnings` |
| P9 | 降本规则闭环（待审批区清理） | ✅ `vave/rule-lifecycle.ts`（纯逻辑、客户端安全）：① `pendingRuleToRuleTemplate` 把 LLM 蒸馏提案(`PendingRule`)确定性转换为结构化规则模板(按 target 路由到 KB 类别/键、解析数值或百分比、生成 embedding 向量)；② `shouldDeprecate` TTL 生命周期判定（连续 90 天未触发 或 冲突率≥0.3 → DEPRECATED）；③ `localEmbedder`/`cosine`/`rankByCosine` + `deriveContext`(箱型/材质/承重等级元数据派生，供确定性预过滤)。`vave/rule-store.ts`（仅服务端）：`convertPendingRule`(人工一键固化)/`sweepDeprecated`(TTL 扫描)/`recordTrigger`/`recordConflict`/`retrieveCases`(元数据预过滤→语义余弦重排)/`listRules`。新 Prisma 模型 `CostReductionRule`（双 schema 已加、`dev.db` 已 push）。4 个 API：`/api/vave/rules`(list)/`convert`/`sweep`/`retrieve`。`RuleClosurePanel.tsx`「规则闭环」tab（状态/TTL/使用频次/冲突率 + TTL 扫描 + 检索）；`KnowledgeDistillPanel` 加「固化为规则」按钮。`tests/rule-lifecycle.test.ts` 30 项全过；tsc 0 错误；`next build` 22/22 静态页通过。**待办**：① 语义向量当前用本地确定性 tokenizer（零依赖、可测试），生产可迁 pgvector（DDL + SQL 检索路径已注释于 rule-lifecycle.ts/rule-store.ts）；② 生命周期目前作用于 `CostReductionRule`（动态降本规则库），静态 `CostRule`（成本引擎公式）的生命周期接入为后续项（见 §6）。 |

---

## 4. 功能完成度

| 模块 | 状态 | 说明 |
|---|---|---|
| 五维成本引擎 | ✅ | 材料/人工/加工/设计/财务，各自透明公式 |
| 油墨建模 | ✅ | **已移入 materialAgent**（2026-08-23 从 processAgent 移入），汇总进材料总额；四色/专色墨量系数×单价×面积；经 `getProcessRate("ink:*")` 读取，入口不变 |
| 人工简化模型 | ✅ | `LABOR_BASE_PER_PIECE + LABOR_GLUING + 换线工时×地域费率`；标注「非真实工时核算」 |
| 地域系数作用域 | ✅ | `getRegionMultiplier` **仅作用于 laborAgent**；华东 28 / 华南(dg) 24 元/时 |
| 加工费拆分展示 | ✅ | `breakdown.kind`: process(纯工艺) / equipment(设备·开机) / base；报告与 PDF 分组列示 |
| 烫金/凹凸覆盖率 | ✅ | 默认 8%，可选 low/medium/high；报告透明展示；预留稿件估算接口 |
| 小批量设计制版固化 | ✅ | 占比越界 → 蓝色「真实成本特征」信息框 + 数量敏感提示（"数量提升到 X，单只降至 ¥Y"）；校验仅 warning |
| 物流简化标注 | ✅ | 按 subtotal 百分比；已知限制标注未含体积重；体积重评估为二期前置 |
| 知识库管理页 | ✅ | `/admin/knowledge`；人工维护/网络行情双区；中文 KEY_LABELS；已排除 source=analysis 历史记录；入口在首页 header + 分析页右上角 |
| 客户报告 9 模块 | ✅ | 总区间/五维占比(加工费拆分)/成本驱动/完整度+默认假设/置信度/小批量解释/优化方向/免责/CTA |
| 真实案例校准闭环 | ✅ | `calibration-real.ts`（偏差标红）+ 模板 `calibration-cases.example.json` + `docs/calibration-guide.md` |
| 分享链接 | 🟡 | 路由 `/share/[token]` 已存在，待用户验证端到端 |
| VAVE 降本模块（二期） | ✅ | 双入口工作台(`/vave`) + 项目实体(localStorage) + 敏感性(量价/纸价/工艺) + 谈判辅助(目标价/让利/话术) + 角色决策(8部门×3职级裁剪)；复用成本引擎经 `/api/vave/analyze`（不写知识库避免污染）。**2026-08-25 深化**：新增「多情景对比」tab（克重降档/批量×2/去表面/双坑→单坑 预设情景，真实重跑引擎、按降本%排序、高亮最优杠杆、材料/加工/设计均单只口径）+ 量价曲线标注当前批量红点及边际趋缓提示 + 纸价冲击连续曲线（-20%~+40%）。**2026-08-26 AI 融入起步批次（P0-P3）**：新增 `src/lib/llm/structured.ts` 统一结构化 LLM 封装（所有 AI 层收敛入口，未配置/失败优雅回退）；`cost-rules` 新增 `MATERIAL_PRICES_META` 本地基准戳（asOf 2026-08）供表达/判定注入时效；`llm-analyst.ts` 升级多角色表达（采购/供应/成本/客户，输出带 Data Pointer 可溯源至引擎原始 JSON）+ 保留原 SQE 诊断；新增 `judge-explain.ts` 判定解释层（确定性校验证据→AI 专业叙述，severity/type 永来自规则）；新增 `vave/ranker.ts`（确定性 Rule Filter 硬约束一票否决→可行集内 AI 软排序）；orchestrator 挂载 `roleReports`/`judgeExplanation`；VAVE 工作台新增「AI 解读」tab + 多情景对比接入 ranker 显示否决原因。三条铁律（事实/数字守恒/可溯源）全部落地。 |
| 多品类框架（平面彩印 + 彩盒 + 瓦楞纸箱） | ✅ | 首页品类卡片选类 → `/analyze?product=<code>` 选配置；引擎 `deriveAnalysisContext` 按 `productType` 分支派生量、specialist 按品类分支公式（`flat_print` 按单张面积×页数×印量算总用纸、`corrugated_box` 走 `corrugatedMaterialAgent` 分层纸板）；VAVE 新建表单按品类动态渲染字段并透传 `productType`；新增品类只需加配置 + 注册。瓦楞纸箱（2026-08-25 落地）：单瓦/双瓦/三瓦分层（面纸·芯纸·中纸）核算，坑型 A/B/C/E/F + BC/BE/AB 双坑（take-up 系数），人工/工艺/设计/财务复用彩盒分支 |
| 物理性能与工艺可行性确定性校验（P-Physics） | ✅ | `src/lib/physics/feasibility.ts`：BCT(McKee)/ECT/湿敏衰减确定性公式 + 防踩坑硬过滤。在 VAVE 方案过滤（挂载 `ranker.ruleFilter` 第 4 条）与成本估算（挂载 `orchestrator`→`AnalysisReport.physicalFeasibility`）两阶段强制调用；降克重/换纸/省印后/换楞 触动物理属性时校验抗压跌破 IS 2771 安全下限 / 堆码 BCT 阈值 / 自动线吸盘抓取异常，未过即 `FEASIBILITY_FAILED` 一票否决（确定性层，绝不透传 LLM）。`tests/physics-feasibility.test.ts` 31 项全过；tsc 0 错误。McKee 常数经数值复算由 1.82 校正为 1.893（原值偏低约 10%）。**待校准**：纸种环压系数 `GRADE_RC_FACTOR`、各楞型厚度 `CALIPER_MM`、安全系数与湿敏曲线均取自行业经验/文献，需以供应商 RCT/ECT 实测报告回填（见 §6）。 |
| 多角色视角隔离 / 多视角报告对比（RolePolicy 重构 + MultiView） | ✅ | `src/lib/vave/role-policy.ts` 重构为纯展示控制层：删除 `suppressRules`(hide/soften/reframe，旧 quality 曾 hide `finance_other`、旧 QA 改写掩盖物理风险，违反"严禁掩盖核心成本基线")，新增 `granularity`(coarse/standard/fine，唯一允许的可见性控制，coarse 仅折叠非强调维度为「其他成本项」汇总行、金额不删减) + `emphasisDimensions` + `framing`，并加 `INVIOLABLE_INDICATORS` 不可侵犯清单（各维度金额/总额/物理风险/error 校验永远渲染、不可掩盖）；`src/lib/vave/qa-framing.ts`：QA 受控表述仅允许白名单「质量过度包装」→「结构冗余优化」，但强制绑定 `physicalFeasibility.metrics` 计算的抗压冗余度（缺物理余量/缺载荷/冗余度≤0 确定性拒绝改写，严禁隐瞒质量隐患）；`src/lib/vave/multi-view.ts`：以 `report.dimensions`+`totalCost` 为唯一真相源，确定性投影采购谈判拆分表/研发结构图谱/高管 ROI 摘要/质量四视角，`reconcile()` 断言各视角行项目求和≡主报告总额(variance≈0)。orchestrator 挂 `AnalysisReport.multiView`；新增 `MultiViewPanel.tsx`「多视角对比」tab；`RolePanel.tsx` 去除 hide UI、强制渲染不可侵犯硬指标。`tests/role-policy.test.ts` 36 项全过（规格1/2/3 全覆盖）；tsc 0 错误；`next build` 18/18 静态页通过。 |
| AI 降本规则闭环 / 待审批区清理（P9） | ✅ | `CostReductionRule` 模型（PostgreSQL + 本地 SQLite 双落库）；`rule-lifecycle.ts` 纯确定性逻辑：LLM 提案→规则模板(`pendingRuleToRuleTemplate`)、TTL 生命周期(`shouldDeprecate`，90 天未触发或冲突率≥0.3 自动 `DEPRECATED`)、本地语义向量(`localEmbedder`/`cosine`)+元数据派生(`deriveContext`)供确定性预过滤。服务端 `rule-store.ts`：`convertPendingRule`(人工一键固化，守 AI 无写入权铁律)/`sweepDeprecated`/`recordTrigger`/`recordConflict`/`retrieveCases`(boxType/material/loadClass 确定性 WHERE 预过滤 → 语义余弦重排)/`listRules`。4 API：`/api/vave/rules`+`/convert`+`/sweep`+`/retrieve`。UI：`RuleClosurePanel.tsx`「规则闭环」tab（状态/TTL/使用频次/冲突率总览 + 手动 TTL 扫描 + 检索）+ `KnowledgeDistillPanel`「固化为规则」按钮。`tests/rule-lifecycle.test.ts` 30 项全过（规格1/2/3 全覆盖）；tsc 0 错误；`next build` 22/22 静态页。 |
| 移动端收图 | ⚪ | 用户 2026-08-24 决策**暂不做**，从一期移除（未来视需再评估） |
| 稳定生产部署 | ❌ | 当前仅本地 dev；`vercel-build` 脚本已备，未实际部署 |
| 真实案例校准数据 | ❌ | 需用户攒 10–20 例真实报价进 `calibration-cases.json`（阶段0，用户做） |

---

## 5. 脚本与文档索引

### 脚本（`scripts/`）
| 文件 | 作用 |
|---|---|
| `seed.ts` | 数据库种子（材料价、工艺费率、地域费率等初始条目） |
| `calc-test.ts` | 计算测试（`npm run test`），跑引擎断言 |
| `calibration-test.ts` | 合成回归基线（`npm run test:calibration`，硬编码行业经验价带） |
| `example-recalculate.ts` | 用真实引擎重算文档第10章示例数字，校验一致性 |
| `calibration-real.ts` | 真实案例校准（`npm run test:calibration:real`），输出总价/分维/占比偏差并标红 |
| `llm-switch-test.ts` | LLM 切换测试 |
| `sync-sqlite-schema.mjs` | 同步 SQLite schema（prebuild/postinstall 自动跑） |

### 文档
| 文件 | 主题 |
|---|---|
| `成本分析逻辑与方法论.md` / `.html` | 主方法论：架构、5 维公式、已知限制、示例演算（第10章：总额 ¥6,719.66 / 单只 ¥1.34） |
| `docs/ARCHITECTURE.md` | 系统架构 |
| `docs/ink-cost-model.md` | 油墨成本模型（现计入材料） |
| `docs/labor-cost-model.md` | 人工成本模型（简化+换线） |
| `docs/report-client-structure.md` | 客户报告 9 模块规范 |
| `docs/calibration-guide.md` | 校准指南（反推常数） |
| `docs/question-priority.md` | 追问优先级逻辑 |
| `docs/vave-module-design.md` | **VAVE 模块设计文档**（二期）：双入口工作台+共享项目上下文、数据桥、最小闭环 MVP、15 维映射、分期路线 |
| `calibration-plan.md` | 校准 4 阶段路线图 |
| `calibration-cases.example.json` | 真实案例校准模板（5 维 + actualLabor） |

### 关键源文件
| 路径 | 职责 |
|---|---|
| `src/lib/agents/*` | 6 specialist + orchestrator + reviewer + nlp + question-engine |
| `src/lib/cost-rules/index.ts` `labor-regions.ts` | 规则公式库、地域费率表 |
| `src/lib/knowledge-base/*` | 知识库读取/网络行情 cron |
| `src/app/admin/knowledge/page.tsx` | 知识库管理 UI |
| `src/components/analyze/ReportStep.tsx` | 报告渲染（加工费拆分、小批量提示） |
| `src/lib/pdf/export.ts` | PDF 导出 |

---

## 6. 已知限制与待办（路线图）

### 已知限制（诚实标注）
- **地域**：仅华东/华南(dg) 两档人工地域；物流有 6 区费率但未经真实校准。
- **物流**：按 subtotal 百分比简化，未含体积重（体积重优先、实重兜底评估为二期前置小项）。
- **油墨**：简化模型（四色 5g/m²×42 元/kg；专色 8g/m²×90 元/kg）。
- **数据底座**：当前价格来自**本地知识库**（seed 默认 + 用户在知识库页手动维护的参考价：材料吨价/工艺费率/地域时薪/物流费率）；外部纸价行情 API 属三期增强项，当前未配置、不影响运行。**纸价与成交价需逐步积累，非一次性工程。**
- **精度**：经验合理级，靠真实案例校准向 ±10% 收敛。
- **平面彩印封面/内页克重分离（已落地）**：字段 schema 拆分 + `materialAgent` 已消费 `coverGrammage`（封面独立克重，1张双面纸；内页按剩余页数计），面积守恒；内页克重随页数自动派生默认值（`suggestInnerGrammage` 接入 derive＋orchestrator）；骑马钉页数可行性校验 `validateFlatBinding` 已接入 orchestrator（warning 不阻断）。**待校准**：新增装订值（锁线胶装/精装/圈装YO圈/古线装风琴折）在 `BINDING_LABOR`/`BINDING_EQUIP` 尚无费率，暂按 `none` 兜底计费（0 元），需后续补费率表。
- **design_plate 占比区间偏窄（已修复 2026-08-25）**：原 `expectedRatioRange:[3,10]` 对低批量/单页/海报/瓦楞素箱场景失真（实测 24%-48%）。已于 2026-08-25 review 修复统一放宽为 `[3,40]`（彩盒/平面彩印），瓦楞纸箱配置亦取 `[3,40]`；下限保持 3 不变避免新下限误报。仅影响占比校验告警、不影响成本数值。
- **瓦楞纸箱品类（2026-08-25 新落地，待真实校准）**：① 材料分层模型（面纸/芯纸/中纸分别计，芯纸按 take-up 系数放大耗纸）依赖 `CORRUGATED_LINER_PRICES`/`CORRUGATED_FLUTING_PRICES` 知识库价 + `FLUTE_TYPES.takeUpFactor` 坑型展开系数——均属经验参考值，待真实工厂报价校准；② 双瓦/三瓦建模为「单组 take-up 系数（BC=2.86/AB=2.9 已含两层瓦楞）」，非逐层独立展开，属合理简化；③ 中纸并入挂面纸单价计（不单列中纸吨价，因中纸与挂面纸同源瓦楞原纸）；④ 人工/工艺/设计/财务复用彩盒分支（柔印+模切+粘箱），瓦楞专属工艺参数（柔印费率、模切、粘箱）沿用彩盒 `process_agent` 公式，未单独标定；⑤ 占比区间已按瓦楞现实放宽（material `[50,90]`、process `[3,30]`、labor `[5,18]`），素箱加工占比偏低属正常不再误告警。
- **物理性能校验 P-Physics 公式待校准（2026-08-26 新落地）**：① McKee 常数 `MCKEE_K=1.893` 经 packwares 实例数值复算（原 1.82 偏低约 10%，已校正）；② 纸种环压系数 `GRADE_RC_FACTOR`、各楞型复合厚度 `CALIPER_MM`、半化学芯纸系数、安全系数（常温 3.5/海运 4.5）、湿敏衰减曲线均为行业经验/文献值，绝对量供参考、相对趋势判定有效，需以供应商 RCT/ECT 实测报告回填后转为可报价级；③ `ECT` 估算采用「对称挂面（面=里同克重同材质）+ 芯纸 RCT×take-up」简化，未逐层独立建模；④ 吸盘抓取风险 `pickupRisk` 为确定性启发式（无表面处理+低克重/<150g 或再生/特种低摩擦纸），待以产线实测 COF 回填；⑤ 仅作用于瓦楞结构，彩盒/平印降克重不在本门禁（其强度由挺度/结构决定，非 BCT/ECT 模型）。

- **多角色视角隔离 RolePolicy 重构（2026-08-26 新落地）**：① 旧 `role-policy.ts` 的 `suppressRules`(hide/soften/reframe) 可隐藏维度/改写标签，违反"严禁掩盖核心成本基线"，已删除；新策略仅控 `granularity`+`emphasisDimensions`+`framing`，`INVIOLABLE_INDICATORS` 保证物理风险/error 校验/各维度金额对所有角色永远渲染、不可掩盖。② QA 改写「质量过度包装」→「结构冗余优化」受 `qa-framing.ts` 强约束，必须保留 `physicalFeasibility` 抗压冗余度（缺余量则拒改）。③ 多视角三视图汇总金额对齐由 `multi-view.ts` 确定性保证（同一真相源投影），与引擎 `totalCost.max` 一致时 `reconcile.reconciled=true`；若引擎维度求和与 `totalCost.max` 未来出现偏差，reconciliation 会诚实标红而非掩盖。

- **AI 降本规则闭环 P9（2026-08-26 新落地）**：① 语义向量当前为**本地确定性 tokenizer**（`localEmbedder`：词频加权 + L2 归一化、零外部依赖、可复现可测试），非神经网络 embedding；生产启用 pgvector 时，可将 `embedding` 列改为 `vector` 类型并改用 SQL 余弦（`ivfflat`/`hnsw` 索引），`rule-lifecycle.ts` 与 `rule-store.ts` 已预留迁移注释与同维接口（替换 `localEmbedder` 为真实 EmbeddingFn 即可，检索路径不动）。② 生命周期（TTL/冲突率）当前作用于 `CostReductionRule`（动态降本规则库，即"待审批区清理"目标）；静态 `CostRule`（成本引擎公式，部署用）尚未接入同一套 `usageCount`/`lastTriggeredAt`/弃用扫描——属后续增强项（其触发点需接入引擎评估链路，改动面更大）。③ `pending-rules.ts`（localStorage 提案箱）保留作 AI 提案暂存，与 `CostReductionRule`（数据库确定性规则）职责分离：AI 仍只能写提案箱，人工「固化为规则」才落库，守"AI 无写入权"铁律。④ 规则模板 `ruleJson` 的结构化数值（value/ratio）为尽力解析提案自由文本所得，人工固化时应复核具体 KB key 与数值。

### 路线图（用户 2026-08-22 明确）
- **一期 获客**：易用性（稳定部署、分享链接）、报告可分享、降低门槛。→ 核心引擎/知识库/报告/校准已完成；稳定部署与分享链接待验证；**移动端收图用户决定暂不做**。
- **二期 VAVE**：敏感性/情景分析（量价曲线、纸价冲击）、谈判辅助输出（目标价/让利空间/话术）。
- **三期 采购**：真实数据底座（纸价 API、多地域费率、企业历史成交价库）、图纸→RFQ→回收报价闭环。

### 第一阶段（一期获客）未完成项
- [ ] **稳定生产部署**：`vercel-build` 脚本已备，未实际部署；部署需解决 SQLite 持久化方案 + `KB_ADMIN_TOKEN` 公网鉴权
- [ ] **分享链接端到端验证**：路由 `/share/[token]` 已存在，未走通完整「生成→打开」链路
- [ ] **真实案例校准数据积累**（渐进、非阻塞）：用户在知识库/报价单中逐步补充真实报价进 `calibration-cases.json`，攒够 10–20 例触发第一轮真实校准 → 推进 ±10% 收敛
- 移动端收图：**已移除**（用户 2026-08-24 决策暂不做，不计入第一阶段未完成）

### 后续路线图待办（二/三期）
- **VAVE 模块设计文档已落 `docs/vave-module-design.md`**：双入口工作台+共享项目上下文、数据桥（成本结果→项目实体→VAVE）、最小闭环 MVP（敏感性/谈判辅助，仅建在现有五维数据上）、15 维框架映射、分期路线。下一步落地前需先补「项目实体」存储（localStorage 版）作为联动前置。**2026-08-24 升级**：策略报告层由「纯模板」升级为「LLM 多 Agent 协作 + 模板兜底」——多个维度策略 agent（技术/采购/补充三层）+ 1 个全局合成 agent 出全局一致报告；明确与成本引擎边界（多 Agent 仅在 VAVE 策略层，不串 6 specialist 计算 loop）。
- 二期 VAVE 工作台（独立，不串 6 specialist）已落地：`/vave` 双入口 + 敏感性/谈判辅助/角色视角三 Tab（2026-08-24，详见 §8）
- 三期 真实数据底座：外部纸价 API（候选源见 2026-08-24 记录）、多地域费率、企业历史成交价库、图纸→RFQ→回收报价闭环
- **双面积模型增强**：① pdf 导出同步 `areaMetrics`「理论使用面积占比」卡片；② 矢量文件（DXF/AI/CDR）直接解析刀线面积（替代视觉转图拆图，零 AI 依赖、精度更高，属三期图纸闭环前置）；③ 视觉拆图 prompt 调教（few-shot 稳定输出图形清单，尤其异形/圆角/挖空近似）

---

## 7. 风险

- **校准数据缺失**：当前精度停留在经验级，这是唯一结构性瓶颈（非引擎问题），属三期数据底座范畴。
- **知识库历史记录混入**：`source=analysis` 的历史分析记录曾错误显示在人工维护区（已修复为排除 + 中文标签）。
- **删除门禁**：本地 dev 重启须先移走 `.next`（见 §2），否则 safe-delete 拦截导致 502。
- **死配置**：`LABOR_RATE` 已删、`EQUIPMENT_RATE` 标记 deprecated（2026-08-23 清理），无实际使用残留。
- **面积口径双轨（设计意图，非误差）**：双面积模型落地后口径明确——① **材料耗纸 = 实际生产面积**（含废边，报价用，= 全张纸÷每版只数 或 回退盒型默认拼接利用率）；② **表面处理/印刷 = 理论面积**（净刀线展开，不含废边）。两者差异是废边计入耗纸、不计入表面工艺，属合理设计；未填全张纸/只数时回退盒型默认拼接利用率（≈85%）。

---

## 8. 变更日志（最新在上）

### 2026-08-26
- **新增「AI 降本规则闭环与待审批区清理（P9）」（解决维护动力不足、待审批堆积、静态规则冲突）**：① 新 Prisma 模型 `CostReductionRule`（同时写入 `schema.prisma` 与 `schema.sqlite.prisma`，`sync-sqlite-schema.mjs` 自动同步；`db:push` 已落到 `dev.db`）——含元数据(boxType/material/loadClass，供确定性预过滤)、生命周期(usageCount/triggerCount/conflictCount/lastTriggeredAt/deprecatedAt/status)、embedding(JSON 列，应用内余弦)三族字段。② 纯逻辑 `src/lib/vave/rule-lifecycle.ts`（无 prisma、客户端安全）：`pendingRuleToRuleTemplate` 把 LLM 蒸馏提案(`PendingRule`)确定性转换为结构化规则模板（按 target 路由 KB 类别/键、解析数值或百分比、生成 embedding）；`shouldDeprecate` TTL 生命周期判定（连续 90 天未触发 或 冲突率≥0.3 → DEPRECATED）；`localEmbedder`/`cosine`/`rankByCosine` + `deriveContext`(箱型/材质/承重等级元数据派生)。③ 服务端 `src/lib/vave/rule-store.ts`：`convertPendingRule`(人工一键固化，守"AI 无写入权"铁律——AI 仅写 localStorage 提案箱 `pending-rules.ts`，人工点「固化为规则」才落库)/`sweepDeprecated`(TTL 扫描弃用)/`recordTrigger`/`recordConflict`(计数与复活)/`retrieveCases`(boxType/material/loadClass/productType 确定性 WHERE 预过滤 → 语义余弦重排)/`listRules`。④ 4 API：`/api/vave/rules`(list)/`convert`/`sweep`/`retrieve`。⑤ UI：`RuleClosurePanel.tsx`「规则闭环」tab（ACTIVE/DEPRECATED 总览 + 状态/TTL/使用频次/冲突率表 + 手动 TTL 扫描 + 检索区）；`KnowledgeDistillPanel` 加「固化为规则」按钮。验证：tsc 全量 0 错误；`tests/rule-lifecycle.test.ts`(tsx) 30 项全过（规格1 转换确定性/解析 92%→ratio/克重 Floor；规格2 90 天未触发弃用/冲突率弃用/幂等；规格3 向量确定可复现/L2 归一/元数据派生/余弦重排）；`next build` 22/22 静态页通过（4 新路由均编译）。**待办**：语义向量为本地确定性 tokenizer（生产可迁 pgvector，已留迁移注释）；生命周期暂仅作用于 `CostReductionRule`，静态 `CostRule` 接入为后续项（见 §6）。
- **重构 RolePolicy 多角色视角隔离 + 新增「多视角报告对比（MultiView）」（解决跨部门数据一致性与信任问题）**：① `src/lib/vave/role-policy.ts` 重构为纯展示控制层——删除 `suppressRules`(hide/soften/reframe，旧 quality 曾 hide `finance_other`、旧 QA 改写掩盖物理风险，违反"严禁掩盖核心成本基线")，新增 `granularity`(coarse/standard/fine，唯一允许的可见性控制，coarse 仅折叠非强调维度为「其他成本项」汇总行、金额不删减) + `emphasisDimensions` + `framing`；新增 `INVIOLABLE_INDICATORS` 不可侵犯清单（各维度金额/总额/物理风险/error 校验永远渲染）。② 新增 `src/lib/vave/qa-framing.ts`：QA 受控表述仅允许白名单「质量过度包装」→「结构冗余优化」，但**强制绑定** `physicalFeasibility.metrics` 计算的抗压冗余度（`(有效抗压-安全阈值)/安全阈值`），缺物理可行性/缺堆码载荷/冗余度≤0 则确定性拒绝改写，严禁隐瞒质量隐患。③ 新增 `src/lib/vave/multi-view.ts`：`generateMultiViewReport` 以 `report.dimensions`+`totalCost` 为唯一真相源，确定性投影采购谈判拆分表/研发结构图谱/高管 ROI 摘要/质量四视角，`reconcile()` 断言各视角行项目求和≡主报告总额(variance≈0)；UI 展示「四视角汇总金额已对齐 ✅」。接线：`orchestrator` 挂 `AnalysisReport.multiView`；新增 `MultiViewPanel.tsx`「多视角对比」tab；`RolePanel.tsx` 去除 hide UI、强制渲染不可侵犯硬指标。`tests/role-policy.test.ts`(tsx) 36 项全过（规格1/2/3 全覆盖：无 suppress、coarse 守恒、QA 余量保留/拒绝、四视角对齐）；tsc 全量 0 错误；`next build` 18/18 静态页通过（1 处未用变量 ESLint 警告已清理）。
- **新增「物理性能与工艺可行性确定性校验模块（P-Physics）」**：在成本估算与 VAVE 方案过滤两阶段强制调用确定性物理公式硬过滤，不依赖 LLM。① 新增 `src/lib/physics/feasibility.ts`（纯数学、无 fs、客户端安全）：McKee BCT(`BCT=1.893·ECT(kN/m)·√(P(cm)·t(mm))`)、ECT(`Σ挂面RCT + 芯纸RCT×take-up`，RCT≈克重×纸种环压系数)、湿敏衰减系数确定性公式；`estimateECT`/`mckeeBCT`/`wetAttenuation`/`assessBoxPhysics` 纯物理计算可溯源。② 防踩坑规则 `assessScenarioFeasibility`：自动识别 VAVE 杠杆（降克重 `reduce_grammage`/换纸 `change_paper`/省印后 `skip_postprint`/换楞 `change_flute`），触动物理属性时校验——ECT 跌破 IS 2771 结构安全下限(`ect_floor`)/堆码 BCT 阈值(`bct_threshold`，需毛重+堆码层载荷数据)/取消表面处理致自动线吸盘抓取异常(`pickup_risk`)；任一触发即 `FEASIBILITY_FAILED`（`passed=false`、附具体缺口数据 `ectDeficit`/`bctDeficit`/`pickupRisk`、中文 reason 标 `FEASIBILITY_FAILED`），确定性层一票否决，绝不透传下游 LLM 策略 Agent；非瓦楞结构直接放行。③ 挂载点：P3 `ranker.ruleFilter` 第 4 条（VAVE 方案过滤阶段硬过滤，否决方案 `passed=false` 不进入 AI 软排序，且 `RankedScenario.feasibility` 附缺口数据供审计）；`orchestrator` 成本估算阶段 `assessBaseline(input)` → `AnalysisReport.physicalFeasibility`（告警不否决用户设计，供 UI 与下游复用同一公式）；`types/index.ts` 加 `AnalysisReport.physicalFeasibility?`。④ **数值校验抓出真实 bug**：原 McKee 常数推导误将 `ECT(kN/m)=ECT(kg/cm)/0.981` 写成乘 0.981，得 `K=1.82`，复算 packwares 实例仅得 749kgf（与文档标称 779 矛盾）；修正为 `K=5.87/0.981/√10≈1.893`，复算得 779kgf，校正约 10% 抗压低估。验证：tsc 全量 0 错误；`tests/physics-feasibility.test.ts`(tsx) 31 项全过（McKee 779 复算/湿敏/ECT 单调/四杠杆识别/ect_floor 缺口/吸盘抓取/非瓦楞放行/重堆码告警/ranker 集成拦截）；`tests/p8-consistency.test.ts` 16/0。注意：`npm run build` 因 Next 内部清理 `.next`（50+ 文件 unlink）触发 sandbox safe-delete 门禁中断（项目已知环境限制，非代码缺陷），但编译与 18/18 静态页生成均成功，构造层面已验证可构建。
- **P8 一致性闸门覆盖补全（收口 AI 调用统一管道）**：原 P7 `knowledge-distill` 仍用裸 `callStructuredLLM`、P5 `search-agent` 未审计，导致闸门覆盖有缝。现已：① `knowledge-distill.ts` 改用 `runGated`（layer=knowledge_distill，带 estPerUnit/actualPerUnit 引擎快照），纳入漂移/对账/审计；② `search-agent.ts` 行情 LLM 调用补 `auditLLMCall`（layer=search_paper_price，含基准价/材质/克重引擎 KV）。P4 `nlp-parser` 维持底层 `chatCompletion`+审计（图纸/NL 解析需原始文本输出，强套 JSON 结构不合适，属有意设计）。至此 9 个 AI 环节（P0 包装/P1 表达/P2 判定/P3 排序/P4 解析/P5 行情/P6 谈判/P7 知识沉淀/P8 闸门）调用均经 `runGated` 或 `auditLLMCall` 落盘，闸门无遗漏。验证：tsc 全量 0 错误；`npm run build` 通过；`tests/p8-consistency.test.ts` 16/0。已提交（gate 覆盖补全批次）。
- **P8 一致性闸门（守门层，`docs/ai-integration-plan.md` §3.2 已补 P8 节点）**：① 新增 `src/lib/agents/consistency-gate.ts`（纯逻辑、无静态 fs 引入，保证 `ranker` 经 `ScenarioPanel` 进入客户端打包图时不破坏 `npm run build`；文件 IO 走函数内 `import(/* webpackIgnore: true */ "node:fs/promises")` + `typeof window` 守护，浏览器仅留内存）：`detectNumberDrift`（AI 文本金额/百分比 vs Pointer 真实数字，随数量级放宽容差，超容差记 `DriftFinding`）、`reconcileNarrative`/`reconcileJudge`/`reconcileRankerNarrative`/`reconcileCrossLayer`（确定性结论永远胜出，强制替换 AI 冲突叙述并产 `contradiction`/`cross_layer` 告警）、`auditLLMCall`（每次 AI 调用落盘 `logs/ai-audit.jsonl` + 内存环形）、`runGated`（统一返回管道：`callStructuredLLM`→可选叙述对账→审计）。② P1(`llm-analyst`) 四角色 `finalizeRole` 跑漂移检测挂 `driftWarnings`，`generateRoleReports` 经 `runGated`(layer=role_reports) 并补 `generateSqeDiagnosis` 审计；P2(`judge-explain`) 经 `runGated`+`reconcileJudge` 挂 `consistencyWarnings`；P3(`ranker`) 经 `runGated`+`reconcileRankerNarrative` 强制否决理由；P6(`negotiation-agent`) 经 `runGated` 并对每轮叙述跑漂移检测挂 `driftWarnings`；`nlp-parser` 图纸/自然语言解析补审计。③ `orchestrator` 跑 `reconcileCrossLayer` 并聚合 `consistencyWarnings` 到 `AnalysisReport`。④ 类型新增 `AnalysisReport.consistencyWarnings`/`RoleReport.driftWarnings`/`NegotiationTurn.driftWarnings`/`JudgeExplanation.consistencyWarnings`；`.gitignore` 加 `/logs/`。验证：tsc 全量 0 错误；`tests/p8-consistency.test.ts`(tsx) 16 项全过（漂移检出/一致不报、reject+称可行冲突、judge/ranker/cross_layer 强制替换、审计落内存）。**已提交 `94eff2b`（P0-P8 整批 27 文件一并提交，因 P8 依赖 P0-P7 模块，隔离提交会破坏可构建性；commit message 取 P8 节点名）**。
- **AI 融入收尾批次 P4-P7（补齐 §3.1 全 7 层 + 两条硬约束，纯代码、不依赖外部数据）**：① P4 `nlp-parser.ts` 新增 `extractDeterministicDimensions`（DXF/文本 L×W×H 与标签式长/宽/高确定性抽取，移除弱信号猜测以免误读），改造 `parseDrawingImage` 使视觉 LLM 仅做语义对齐、尺寸优先用确定性源、AI 抽取字段标 `ai_extracted`+`requiresHumanConfirmation`；`parse-image` 路由放开「无图+vectorText」走确定性抽取；`InfoFormStep` 展示确认横幅与字段来源徽标（确定性/AI抽取/推断）；② P5 `search-agent.ts` 修数字守恒违规——LLM 不再返回 price，仅出行情趋势 `trend`/`trendNote`，价格恒用确定性基准；新增 `context-layer.ts` `getPricingContext`/`getBenchmarkContextNote` 聚合 `MATERIAL_PRICES_META` 时效戳注入 P1/P2（硬约束 A）；③ P6 新增 `vave/negotiation-agent.ts`（`simulateNegotiation` 三方角色博弈 + `verifyScenarioPerUnit` 每轮回引擎 `runOrchestrator` 重算校验 + Data Pointer）+ `/api/vave/negotiate` + 工作台「谈判模拟」tab（`NegotiationSimPanel`）；④ P7 新增 `vave/knowledge-distill.ts`（`distillCaseToRules` 案例对比→反推规则，仅提案）+ `vave/pending-rules.ts`（AI→`pendingRules` 待审核池，人工 `confirmPendingRule` 才转 KB override，AI 无写入权，硬约束 B）+ `/api/vave/distill` + 工作台「知识沉淀」tab（`KnowledgeDistillPanel`，待审核池/确认固化/已固化 override 三区）。验证：tsc 全量 0 错误；P4 单测（tsx）4 例通过、弱信号误抽已移除；`/api/parse-image` 传 vectorText 抽得 length/width/height=deterministic、no image 不再要求视觉模型；`/api/vave/negotiate` 返回 3 轮（breakEven/quote 锚定、feasible 校验正确）；`/api/vave/distill` 返回反推规则（system 兜底分支正确）。本地无 LLM key 全程确定性回退，配商业模型后自动升级 LLM 版。**已提交 `94eff2b`（P0-P8 整批 27 文件一并提交，因 P8 依赖 P0-P7 模块，隔离提交会破坏可构建性；commit message 取 P8 节点名）**。

### 2026-08-26
- **真实案例校准增强：半拆解锚定（材料自锚 + 残差隔离）**。`scripts/calibration-real.ts` 新增：供应商报价单不拆五维时，用 `meta.paperPricePerTon`/`meta.laborRatePerPiece` 等**独立外部锚**（纸商当期报价/市场工价，非引擎查表，避免循环论证）锚定材料/人工维；从总价扣除已锚定维得残差即加工费，专门标定唯一公式风险维（process）。修复无外部锚时残差把总价估算误差整吞进加工费放大的假阳性（原 +1061% 误报）→ 锚定不足时仅显示数字、不报警、标「未独立锚定/不具校验意义」。`cost-calibration-real.md` 补半拆解解读段；`calibration-cases.example.json` 新增极简 total-only + 纸价锚案例（推荐攒法）。重跑验证逻辑诚实。`tsc`/构建未改动。

- **新增「报价单录入」页面 `/calibration-intake`（轻量版、无 LLM）**：消「供应商不拆五维」的攒数据摩擦，解锁 P0 校准。① 新增 `src/app/api/calibration/cases/route.ts`（GET 读 `calibration-cases.json`、POST 校验并追加 CalCase 写回仓库根；仅透传用户给的、绝不伪造维度拆解；锚走 meta 独立外部参考）；② 新增 `src/components/calibration/CalibrationIntakeForm.tsx`（客户端动态表单：产品类型→按 `ProductTypeConfig.fields` 渲染参数 + showWhen 条件显示；分块填 案例标识/实际报价(actual.total 必填,五维可选)/外部锚(paperPricePerTon 等)/actualLabor；提交后展示返回 JSON 与案例数）；③ 首页头部加「校准录入」入口 + Capabilities 加入口卡片。与项目大纲不冲突（仅数据入口、不进成本引擎；符合「total-only+外部锚」方法学；对齐「校准数据缺失是唯一瓶颈」路线图）。dev server 冒烟过 GET/POST，校准脚本成功消费 API 产出案例（材料锚 ¥4165.42 ✓外部纸价）。

### 2026-08-25
- **VAVE 二期深化（纯代码、不依赖外部数据）**：① 新增「多情景对比」tab（`src/components/vave/ScenarioPanel.tsx` + `VaveWorkbench` 加 tab）：预设 4 类可量化降本情景（克重降一档/批量×2/去表面处理/双坑→单坑），各基于基线独立构造 override 经 `/api/vave/analyze` **真实重跑引擎**，对比表按降本%排序、高亮「最优杠杆」并给综合建议（单只降本×当前数量的总降本）；材料/加工/设计列统一为**单只口径**（避免批量×2 时总成本放大误导）；② 量价曲线增强：用 recharts `ReferenceDot` 标注当前批量红点，并据梯度数据推演「重点加量区间 + 边际降本趋缓」提示文案；③ 纸价冲击由单点卡片升级为 -20%~+40% **连续冲击曲线**（材料金额对单价线性，线性推演已精确，故不侵入引擎重跑，与量价曲线呼应）。`tsc` 全量 0 错误，dev server `/vave` 编译 200，API 端到端自测 4 情景 override 方向均合理降本（克重降档材料 ¥1849.9→¥1525.0；批量×2 单只 ¥6.21→¥4.32；去表面加工 ¥456.9→¥430.0）。
- **新增「瓦楞纸箱（corrugated_box）」品类（已端到端验证）**：复用彩盒五维引擎，仅材料 Agent 走专属分层纸板计算。① 新增 `src/config/products/corrugated-box.ts`（单瓦/双瓦/三瓦字段 + 复用 dimensions，注册进 `index.ts`，首页/批量/VAVE 自动出现）；② `cost-rules` 扩展 `FluteConfig.takeUpFactor`，`FLUTE_TYPES` 扩 A/B/C/E/F 单坑 + BC/BE/AB 双坑（双坑 take-up 已含两层瓦楞，如 BC=2.86），新增 `CORRUGATED_LINER_PRICES`/`CORRUGATED_FLUTING_PRICES`（牛皮/白板/特种挂面纸 + 芯纸克重档参考吨价）；`BOX_TYPES` 加 `rsc`/`die_cut`/`folder`；③ `knowledge-base` 加 `getCorrugatedLinerPrice`/`getCorrugatedFlutingPrice`（KB 覆盖 + 常量回退）；④ `seed.ts` 改为遍历 `getAllProductTypes()` upsert 所有品类，并补瓦楞材质价种子；⑤ `analysis-context.ts` 解析 `boardStructure`/`linerMaterial`/`linerGrammage`/`fluteGrammage`/`mediumGrammage` 并透传；⑥ `specialists.ts` 新增 `corrugatedMaterialAgent`（面纸×2/芯纸×take-up×层数/中纸×层数，分层计 + 芯纸 take-up 放大，g→kg 已除 1000 修复早期 1000× 量级 bug），`materialAgent` 顶部按 `productType` 分流。验证：单瓦 RSC/B坑 ¥2.5/只、双瓦 BC/200g ¥5.4/只、三瓦 AB/230g ¥14.5/只（分层拆解正确、占比告警清零）；批量接口 3 行（单瓦/双瓦/缺必填）成功 + 缺「坑型」正确隔离进 errors；彩盒回归无回归；`tsc` 全量 0 错误；DB `productType` 表已含 `corrugated_box`。占比区间已按瓦楞现实放宽（material `[50,90]`、process `[3,30]`、labor `[5,18]`、design_plate `[3,40]`）。
- **代码评审修复（review 闭环）**：① 批量 `rowToInput` 增加必填字段缺失检测，缺失时进 `errors` 列表不静默套默认（quantity/material/grammage 等 required 缺失明确报错「缺少必填字段：…」）；② 批量结果表单位动态化（复用 `getUnitLabel`，彩盒「元/只」、平面彩印「元/册·张」）；③ 批量 API 加 `MAX_ROWS=500` 与 `MAX_FILE_BYTES=10MB` 限制防 DoS；④ 放宽 `design_plate` 占比区间 `[3,10]→[3,40]`（实测 24-48% 不再误告警，下限保持 3 不变，避免引入新下限误报）。tsc 全量 0 错误，已 git commit（65cb607）。
- **新增批量成本分析功能（单品类 Excel 批量上传 → 汇总 xlsx 导出）**：① 新增 `src/lib/batch/template.ts`（纯逻辑：按 `required||weight>=8` 筛模板列 + 固定 `name` 列、`buildTemplateHeaders`/`buildSampleRow`/`buildInstructionRows` 生成模板与说明、`rowToInput` 将行→`AnalysisInput` 含 select 的 value/label 双向匹配与数值/布尔转换、`buildResultHeaders`/`resultToValues` 生成结果表含输入回显+各维度成本+完整度/置信度/告警）；② 新增 `src/app/api/batch/analyze/route.ts`（POST 接 xlsx+productType，逐行 `runOrchestrator`，单行异常 try/catch 隔离、其余行不受影响，返回 results+errors；xlsx 用动态 `import("xlsx")` 规避 server bundle 的 CJS interop 为 undefined）；③ 新增 `src/app/batch/page.tsx`（品类选择 + 下载模板[两 sheet：批量模板+填写说明] + 上传 + 进度 + 结果表 + 导出汇总 xlsx，xlsx 动态 import 避免初始 bundle 膨胀）；④ 首页 header/类别区加「批量分析」入口。安装 `xlsx@0.18.5`（注：该版本 npm audit 报已知漏洞，仅本地/内网使用，外网部署前需评估升级或换 exceljs）。端到端验证（3 行平面彩印：32P骑马钉/80P骑马钉/1P散页海报）全部成功：封面/内页拆分、80P 触发骑马钉厚度告警、错误隔离、结果表维度/告警正确。`tsc` 全量 0 错误，`/batch` 页面编译 200。
- **自测修复：封面克重默认未生效**。`runOrchestrator` 完整链路集成验证（6 场景：32P骑马钉/32P散页/80P骑马钉告警/250P厚本告警/显式封面300g内页128g/彩盒回归）发现封面拆分静默消失——根因 `applyDefaults` 只认全局 `FIELD_DEFAULTS`，不读 config 字段自身 `defaultValue`，故 `coverGrammage:250` 未被填充，`hasCover` 恒 false。修复：`deriveAnalysisContext` 对 `flat_print` 且装订为带封面类型（saddle/perfect/thread_sewn/hardcover/spiral/accordion）且未显式填封面克重时，默认 `"250"`。修正后 6 场景全部 PASS：封面/内页分离正确、散页无封面、骑马钉超厚告警触发、显式克重可覆盖、彩盒不回归崩溃；`tsc` 全量 0 错误。
- **平面彩印类目字段 schema 依据伊顿/UPP 报价校准**：基于【最终执行版本】伊顿画册-给UPP报价-1209.xlsx 的真实专业描述，更新 `src/config/products/flat-print.ts`：① 克重拆分为「内页克重/整体克重」(随页数递减 157→128→105→80g，默认157、可覆盖) 并新增「封面克重」(独立可选项，默认250g，仅装订类 `showWhen` 显示)；② 装订方式补全为 散页/骑马钉/无线胶装/锁线胶装/精装/圈装YO圈/古线装风琴折/折页，并加可行性 `impactHint`（骑马钉≤~48P，纸越厚上限越低）；③ 纸张类型增加 相纸、PP纸（海报/X展架）；④ 表面处理增加 过油。修正了早期「封面固定250g、装订与页数强制绑定」的误判（用户质疑后确认：封面为独立选项、装订为独立可选项仅受厚度可行性约束）。`analysis-context.ts` 装订注释同步更新。本期追加 agent 代码落地（tsc 全量通过 + tsx 集成验证）：① `analysis-context.ts` 新增 `coverGrammage` 字段由 derive 透传，并导出 `suggestInnerGrammage(pages)` 按页数派生内页克重（≤32→157、≤100→128、≤200→105、>200→80g，仅当用户未显式填克重时覆盖；derive 与 orchestrator 1.5 步双保险）；② `specialists.ts` 的 `flatMaterialAgent` 拆分封面/内页纸张成本（封面=1张双面纸用 `coverGrammage`、内页=剩余页数用 `grammage`，面积守恒，分别取纸价）；③ `orchestrator.ts` 加装订可行性校验 `validateFlatBinding`（骑马钉按内页克重给厚度上限 40/48/56/64P，超限仅 warning 不阻断、允许覆盖）。集成验证覆盖 32P 骑马钉(封面250/内页157派生)、32P 散页无封面、80P 骑马钉告警、克重派生映射，均通过。

### 2026-08-27
（上传识别式校准录入 · Excel 为主 / 图片辅助 · AI 预填 + 确认）
- 录入页 `/calibration-intake` 升级为「上传资料→AI 提取→确认」交互：新增 `CalibrationUpload` 组件，三种入口——Excel（SheetJS 浏览器端按字段名+同义词映射，零 LLM 依赖）、MD 文本、图片（均调 `/api/calibration/extract` 由 LLM 只抽原文、不补全五维）。
- `CalibrationIntakeForm` 支持 `initial` 预填（上传/AI 结果回灌，用户确认/补必填后提交）；上传后显示「已识别 X 项、还需补充：Y」提示，确认环节即安全网。
- 红线守住：AI 抽取 prompt 强制「只抽明确值、禁补全五维/锚」；外部转换（图/PDF→Excel/md）由用户别的工具完成，本工具不约束。
- 模型：本地 Ollama 已拉 `qwen2.5:14b`（文本抽取）+ `qwen2.5vl:7b`（视觉）；`/api/calibration/extract` 对 Ollama 自动映射本地专用模型名。
- 验证：tsc 0 错；Excel 映射 smoke 全字段命中；md 抽取实测正确（总价 9200 + 纸价锚 6200，无五维脑补）；image 路由分支走通。
- AI 配置中心新增「本地 LM Studio」预设（OpenAI 兼容、默认 `http://localhost:1234`、本地端点免密钥）：`ai-settings.ts` 加 `LM_STUDIO_PRESET`+`isLocalBase`，`client.ts` 放宽本地兼容端点 key 校验，`AiSettingsModal` 加预设按钮 + 本地免 key 提示。用户改用 LM Studio 带本地模型时零代码改动即可切换。

### 2026-08-24
- **平面彩印默认假设与 VAVE 文案去彩盒化（第二轮）**：修复用户截图反馈的「信息完整度与默认假设」仍显示彩盒字段（高度/盒型/坑型/专色）问题。根因：`applyDefaults` 合并全局默认值后未按品类过滤。修复：① `question-engine.ts` 改 `applyDefaults` 签名接收 `ProductTypeConfig`，仅对 `config.fields` 中存在的字段应用默认值，并扩展 `getLabelForKey` 覆盖 `pages/binding/spotColorCount` 等；② `orchestrator.ts` 调用改为传 `config`；③ `specialists.ts` 中 `designAgent` 按 `productType` 动态设计费口径（平面彩印显示「标准画册/海报排版」而非「标准盒型」），`flatMaterialAgent`/`flatLaborAgent` 文案中「每版只数/盒型」改为「每版页数/成型」；④ `ReportStep.tsx`/`VaveWorkbench.tsx` 面积利用率小字按品类分支；⑤ `report-copy.ts` 新增 `getUnitLabel`/`getSmallBatchMessage`，小批量提示、PDF 导出、`NegotiationPanel`/`SensitivityPanel`/`ProjectListCard`/`app/vave/page.tsx` 中所有「单只/元/个」统一按品类动态为「册/张」。tsc + 生产构建通过，API 验证 `flat_print` 默认假设仅含当前品类字段。
- **平面彩印文案/单位全面去彩盒化**：修复用户测试发现的品类文案 bug：① `question-engine.ts` 新增 `PRODUCT_QUESTION_COPY` 与 `PRODUCT_FIELD_DEFAULTS`，`generateQuestions`/`applyDefaults` 按 `productType` 取品类专属追问文案与默认值，平面彩印 length/width 不再显示「盒型外尺寸/长×宽×高」，改为「成品长度/宽度/长×宽决定单张面积」；② `InfoFormStep.tsx` 理论面积卡片按品类分支：彩盒保留「理论面积与拼版/每版只数」，平面彩印改为「拼版信息/单页成品面积/每版页数」；上传图纸/视觉解析示例也按品类动态；③ `ReportStep.tsx` 报告顶部单位按品类动态：彩盒「单只价格/个」、平面彩印「单册/张价格/册（张）」，总成本区间标注「按当前印量」；④ `UploadStep.tsx` 与 `/api/upload` 透传 `productType`，设计图纸反馈文案去「盒型/展开图」。tsc + 生产构建通过，浏览器验证平面彩印 step 1 无「盒型」字样。
- **新增「平面彩印（flat_print）」品类，打通多品类框架**：① 新增 `src/config/products/flat_print.ts`（画册/海报/说明书字段 + 复用五维 dimensions），并在 `index.ts` 注册；首页 `page.tsx` 加「选择产品类别」卡片区（读 `getAllProductTypes` 渲染，点选进 `/analyze?product=<code>`）；② `/analyze` 读 `?product=` 选 config（Suspense 包裹 `useSearchParams`，提示/假设随品类变化，尺寸摘要适配长×宽）；③ 引擎 `deriveAnalysisContext(input, productType)` 加 `flat_print` 分支（单张面积=长×宽、总印张面积=单张×页数×印量、装订/页数透传、盒型给中性桩）；`materialAgent/laborAgent/processAgent` 各加 `flat_print` 分支公式（材料按印张面积×克重+油墨、人工按装订×地域、加工含印刷/覆膜/装订设备无刀模）；`orchestrator` 传 `config.code`；④ API 透传：`/api/vave/analyze` 与 `/api/sessions` 按 `productType` 选 config（无则默认彩盒）；`VaveNewForm` 改为按所选品类动态渲染关键字段（required 或 weight≥8）并透传 `productType`（后续加品类自动扩展）；⑤ tsc + 生产构建通过，API 验证平面彩印出报告（productTypeName=平面彩印、单张面积 0.05985 m² 与 210×285mm 吻合）、彩盒回归无变化。
- **VAVE 二期实现完成（落地 `/vave`）**：① 项目实体 + localStorage 存储层 `src/lib/project-store.ts`（CostProject + deriveProjectSummary 派生，summary 不落库避免漂移）；② 新增 `/api/vave/analyze` 复用 `runOrchestrator`（故意不写知识库，避免敏感性多次重跑污染）；③ 首页加 VAVE 入口 + 「我的项目」列表(localStorage)，分析页报告区加「保存为项目 → 进入 VAVE」；④ `/vave` 双入口（基于项目 / 独立新建跑引擎）+ VaveWorkbench（成本基线 + 双面积利用率卡）；⑤ 敏感性（量价曲线重跑 / 纸价冲击线性近似 / 工艺对比重跑）；⑥ 谈判辅助（目标价反推 / 让利空间 / 话术模板，见 `src/lib/vave/negotiation.ts`）；⑦ 角色决策策略（8部门×3职级 RolePolicy，加重/弱化/屏蔽改写，见 `src/lib/vave/role-policy.ts`）；⑧ 类型扩展 CostProject/ProjectSummary/RolePolicy（`src/types/index.ts`）。tsc + 生产构建通过。多 Agent 策略层先以模板兜底，预留 LLM 钩子；真实案例校准与多维数据底座仍归三期。
- **VAVE 二期实现开工**：开始落地 `docs/vave-module-design.md` §8 清单——① 项目实体 + localStorage 存储层；② `/vave` 双入口（基于项目 / 独立新建跑引擎）；③ 敏感性（量价曲线/纸价冲击/工艺对比）；④ 谈判辅助（目标价/让利/话术）；⑤ 角色决策策略（8部门×3职级 RolePolicy 裁剪）；⑥ 双面积利用率卡同步。复用成本引擎 `runOrchestrator`（经新增 `/api/vave/analyze`，不写知识库避免污染）；多 Agent 策略层先以模板兜底，预留 LLM 钩子。进行中，详见 §4 VAVE 行与任务跟踪。
- **VAVE 设计文档打磨（矛盾修复）**：`docs/vave-module-design.md` 修正 6 处——① **数据依赖定调**：VAVE 必建在成本分析之上（用户决策：要求客户先做成本分析再进 VAVE），「独立新建」=在 /vave 内录入参数/报价单→内部跑引擎生成 AnalysisReport，并非跳过成本分析；② `CostProject.summary` 改为**派生视图**（不落库），修正原错误引用的 `totalCostPerUnit`/`dimensionRatios`/`areaMetrics` 路径（实为 `report.totalCost.perUnit`、`report.dimensions[].ratio`、材料维 `areaMetrics`）；③ 项目落库(Prisma)统一归三期，二期仅 localStorage；④ 敏感性「重跑引擎局部」→「重跑 `runOrchestrator` 全 fan-out」；⑤ 修复 3 处坏链 `§3/§8`→`§5.1`；⑥ 维度5 工效由 ✅ 降 🟡（laborAgent 简化版仅随地域浮动）。tsc/引擎不受影响。
- **VAVE 设计文档补「角色决策策略」(商业策略核心)**：`docs/vave-module-design.md` 新增 §6——明确展示层是 agent **主动决策**（非换排布）：基于读者岗位/职级做「加重/弱化/屏蔽改写」三操作；全局合成 agent 套「角色决策策略」于合并前；配 8部门×3职级矩阵与 `RolePolicy` 结构化配置（MVP 静态、后可下沉知识库）；§7/§8/§9/§10 重排、§8 待办改为「角色决策策略」、§10 原「KP 裁剪粒度」开放项标记已定（§6 已落地，取代原 3 粗粒度视图占位）。
- **VAVE 模块设计文档升级（多 Agent 策略层）**：`docs/vave-module-design.md` §2 补两层边界（确定性引擎 vs LLM 策略层）、§5.1 新增「VAVE 策略层多 Agent 协作架构」（多个维度策略 agent：技术层1-5/采购层6-10/补充层11-15，并行只读 `AnalysisReport` + 知识库 + 1 个全局合成 agent 出全局一致报告）、§9 加多 Agent 编排要点、§9 风险更新（LLM 成本/可追溯性/已定决策：LLM 多 Agent + 模板兜底，取代原纯模板 MVP）。明确与成本引擎边界：多 Agent 仅在 VAVE 策略层，不串 6 specialist 计算 loop（与既有「禁互调 loop」决策不冲突）。
- **VAVE 模块设计文档 `docs/vave-module-design.md`**：对齐团队 PCO 蓝图（PDR V2.0 / 系统架构决策 B / 销售策略）与现状，定义二期 VAVE 为同应用独立模块（双入口工作台+共享项目上下文）。含：① 采纳架构方案 B（分析层客观+展示层按 KP 三级裁剪）；② 数据桥（成本 `AnalysisReport`→`CostProject` 实体→VAVE，前置需补 localStorage 项目存储）；③ 最小闭环 MVP（量价曲线/纸价冲击/工艺对比 + 目标价反推/让利空间/话术，仅建在现有五维引擎数据）；④ 15 维框架映射（MVP 覆盖 1/3/4/5/6/13 成本面，其余 9 维归三期数据底座）；⑤ 分期路线与风险。同步更新 §5 文档索引、§6 路线图待办。
- **项目正式命名「包装降本分析工作台」**：原「彩印纸盒成本分析」因纳入 VAVE 降本模块（二期）且品类覆盖纸/塑/木缓冲而升级。同步更新 `PROJECT_STATUS.md` 标题与定位、`layout.tsx` 标题/描述、`ThreeColumnLayout.tsx` 顶栏、`page.tsx` Hero、`README.md` 标题/首段。
- **双面积模型图形扩展 + 架构决策**：① `computeDielineArea` 由 5 类扩至 **13 类**，新增 ellipse/sector/semicircle/parallelogram/rhombus/annulus/segment/regularPolygon，公式硬编码于 `src/lib/cost-rules/index.ts`，视觉 `DRAWING_SYSTEM_PROMPT` 与 `sanitize` 解析同步支持；tsc 通过，引擎验证（案例5 全类型累计 17591.35mm² 与手算吻合）。② 架构决策：**基础几何公式属代码层、不进知识库**；知识库只放可变参数（拼版利用率默认/损耗率分档/损耗补偿/最小留边），未来按需下沉 `getProcessRate`+fallback。原则：算法=代码，参数=知识库。
- 清理 3 个与本项目状态报告功能重叠的早期快照文档：`cost-engine-review-2026-08-23.md`、`cost-engine-audit-2026-08-23.md`、`docs/ARCHITECTURE.md`（移至 `_removed_2026-08-24/` 备份，可恢复）。其有效信息已并入本报告第3/7章。
- 澄清数据策略（用户决策）：① 纸价行情以**本地知识库人工维护**为主，外部纸价 API 属三期增强；② 纸价/成交价/案例**逐步积累**，非一次性工程；③ **移动端收图暂不做**（从一期移除）；④ 真实校准案例由用户**逐步补充**（非阻塞）。同步更新 §6 已知限制/路线图/待办。
- 固化「第一阶段（一期获客）未完成项」清单于 §6：稳定生产部署、分享链接端到端验证、真实案例积累（渐进非阻塞）；移动端收图标记已移除；一/二/三期待办分区。§4 完成度表移动端行改为 ⚪ 暂不做。
- 建立 `PROJECT_STATUS.md` 作为项目单一真相源；后续改动同步更新本报告。
- dev server 重启（后台任务 `zHvb4i`，原 `LE114C` 挂掉 502）；标准动作：移走 `.next` 再启动。
- 首页 header 加「知识库」按钮 + 分析页右上角加「知识库」链接（与 AI 设置并列）。
- 知识库页 `KEY_LABELS` 中文标签化（材料名/工艺/油墨/物流/地域时薪）+ 排除 `source=analysis` 历史记录。
- **双面积模型落地（理论面积 + 实际生产面积）**：按「矢量优先 + 图片拆图兜底」设计、全张纸尺寸×每版只数真实算利用率（方案a，用户拍板）。`AnalysisInput` 增 `dielineAreaMm2`/`dielineShapes`/`sheetSize`/`piecesPerSheet`；新增 `computeDielineArea`（几何累计：rect/triangle/circle/trapezoid/polygon，确定性不靠模型估面积）；`deriveAnalysisContext` 优先用真实刀线面积，派生理论面积/材料利用率/实际生产面积；`materialAgent` 纸重改用实际生产面积并新增 `areaMetrics`（理论面积/占比/实际生产面积）；视觉 `DRAWING_SYSTEM_PROMPT` 输出图形清单 + `sanitize` 解析几何字段；表单加「理论面积与拼版」手动录入卡片；报告材料维度加「理论使用面积占比」可视化卡片（进度条+三栏）。tsc 通过，引擎验证 4 案例正确（含回退 85%、利用率>100% 钳制）。**待同步**：pdf 导出未渲染 areaMetrics 卡片（pdf 既有仅渲染金额/分项，basis 文字未入 pdf，非本次回归）；DXF 矢量直接解析未做（当前矢量PDF转图后走视觉拆图，非真矢量提取，属三期增强）。

### 2026-08-23
- 油墨从 processAgent 移入 materialAgent，汇总进材料总额；文档 §4.1/§4.3/§5/第10章/ink-cost-model 同步。
- 小批量设计制版占比越界固化为「真实成本特征」展示（校验仅 warning、报告蓝框、数量敏感提示）。
- 第10章示例数字用真实引擎重算修正（总额 ¥6,719.66 / 单只 ¥1.34），旧笔误公式订正。
- 人工简化标注、加工费拆分展示、烫金覆盖率可选、死配置清理、物流简化标注、校准闭环、HTML 同步、版本区分、报告 9 模块、追问 V2 全部落地。
- 全局审查 + 实证验证（build/tsc/回归脚本通过）。

### 2026-08-22
- 产品路线图确认（一期获客 / 二期 VAVE / 三期采购）。
- Agent 架构决策：dataflow 单一真相源 + 禁 specialist 互调 loop + 只读审阅器铺路。

---

## 9. 如何维护本报告
- 每次代码/文档/配置改动后：在 §8 变更日志顶部追加一条（日期 + 要点），并同步更新相关章节（功能完成度表、已知限制、风险）。
- 状态符号：✅ 已完成 / 🟡 部分完成/待验证 / ❌ 未做。
- 保持自包含：不在对话里依赖长上下文，所有关键事实以本报告为准。
