# 架构扩展说明

## 1. 扩展到其他产品类型

当前架构通过 **配置驱动** 实现产品类型扩展，核心扩展点：

### 配置文件 (`src/config/products/`)

每个产品类型一个配置文件，包含：

| 配置项 | 作用 | 示例 |
|--------|------|------|
| `fields` | 动态表单字段 | 数量、尺寸、材质等 |
| `dimensions` | 成本维度定义 | 材料、工艺、人工等 |
| `steps` | 分析流程步骤 | 上传→填表→报告 |

### 扩展步骤

以新增「瓦楞纸箱」为例：

```typescript
// src/config/products/corrugated-box.ts
export const corrugatedBoxConfig: ProductTypeConfig = {
  code: "corrugated_box",
  name: "瓦楞纸箱",
  fields: [/* 瓦楞纸特有字段：楞型、边压强度等 */],
  dimensions: [/* 可能增加"印刷成本"维度 */],
  steps: [/* 同上 */],
};
```

```typescript
// src/config/products/index.ts
import { corrugatedBoxConfig } from "./corrugated-box";
productRegistry.corrugated_box = corrugatedBoxConfig;
```

### Agent 扩展

- 通用 Agent（人工、设备、财务）可跨产品复用
- 产品特有 Agent 在 `specialists.ts` 中添加
- Orchestrator 通过 `config.dimensions` 动态调度

## 2. 知识库逐步完善

### 数据沉淀路径

```
用户分析 → AnalysisSession（原始数据）
         → KnowledgeEntry（结构化提取）
         → CostRule（规则提炼）
         → Agent 参数更新（更准确估算）
```

### 知识条目类型

| category | 用途 | 示例 |
|----------|------|------|
| `material_price` | 材料单价 | 白卡纸 350g = 5600元/吨 |
| `process_rate` | 工艺费率 | 哑膜 0.8元/m² |
| `labor_rate` | 人工费率 | 28元/小时 |
| `rule` | 计算规则 | 展开面积公式 |
| `feedback` | 用户反馈 | 实际报价 vs 估算偏差 |

### 迭代训练接口（预留）

- `KnowledgeEntry.confidence`: 条目置信度，随验证次数提升
- `KnowledgeEntry.source`: 区分来源（分析自动提取 / 人工录入 / 导入 / 反馈校正）
- `AnalysisSession.agentLogs`: Agent 执行日志，可用于回溯与调优
- 后续可对接 LLM fine-tuning 或 RAG 检索增强

## 3. 后续模块预留

| 模块 | 预留接口 | 说明 |
|------|----------|------|
| 用户登录 | `AnalysisSession` 增加 `userId` | NextAuth / Clerk |
| 历史记录 | 按 `userId` 查询 Session | 已有完整 Session 模型 |
| VAVE 模块 | `OptimizationHint` + 报告 CTA | 已有优化建议框架 |
| AI 增强 | Agent Prompt 模板 | 当前规则驱动，可逐步引入 LLM |
| 工厂对接 | `CostRule` + API | 规则库可对接工厂 ERP |

## 4. 成本计算策略

当前采用 **规则公式优先 + AI 辅助预留**：

- 关键数字来自 `cost-rules/` 中的参考表和公式
- Agent 负责应用规则、生成结构化输出
- 后续可在 Agent 中引入 LLM 做：
  - 图纸识别（盒型、尺寸提取）
  - 异常检测（参数合理性）
  - 优化建议生成
  - 但核心计算仍走规则引擎
