# 人工成本简化模型

> 状态：已落地（简化版）。人工独立于加工费，仅随地域浮动。
> 定位：量级参考 + 透明展示 + 可校准；**非真实工时核算**，后期用真实工厂人工数据迭代。

## 1. 为什么是简化模型

真实工厂人工 = 各工序**工时 × 小时费率**（或计件工资），受产线排程、技能等级、自动化程度、班制影响极大，难以在估算阶段精确还原。

当前采用「**固定元/个 × 盒型复杂度 + 糊盒 + 换线固定工时**」的简化结构，目的是：
- 在询价/获客阶段给出**量级合理**的人工参考，不误导客户以为这是精确工资核算；
- 保持公式透明、可解释、可被真实案例反推校准；
- 把人工与设备/油墨解耦（方案 B），避免地域系数错误放大设备地域差。

**明确边界**：本模型不是工时核算。报告与文档均标注「简化模型（非真实工时核算）」。

## 2. 公式

```
regionMultiplier   = getRegionMultiplier(laborRegion)   // 华东基准 1.0，仅作用于人工
regionHourlyRate   = getRegionRate(laborRegion)          // 地域小时费率（华东 28 元/小时，可 KB 覆盖）

baseLabor   = 数量 × LABOR_BASE_PER_PIECE(0.05) × boxType.complexityMultiplier   // 检验/整理
gluingCost  = 需糊盒 ? 数量 × LABOR_GLUING_PER_PIECE(0.025) : 0
setupLabor  = LABOR_SETUP_ENABLED ? LABOR_SETUP_HOURS(0.5) × regionHourlyRate : 0   // 换线/调机固定人工

amount = (baseLabor + gluingCost) × regionMultiplier + setupLabor
```
- `baseLabor` / `gluingCost` 为**按件变动**人工，乘地域系数；
- `setupLabor` 为**每单固定**人工（换线/调机），用地域小时费率直接计，不随数量变动。

## 3. 默认参数（可经知识库覆盖）

| 常量 | 默认值 | 含义 | 知识库键（覆盖用） |
| --- | --- | --- | --- |
| `LABOR_BASE_PER_PIECE` | 0.05 | 基准手工操作 元/个 | —（代码常量，可按地域在 `labor_regions` 细化） |
| `LABOR_GLUING_PER_PIECE` | 0.025 | 糊盒 元/个 | — |
| `LABOR_SETUP_HOURS` | 0.5 | 换线/调机固定工时 小时/单 | `process_rate::labor:setup_hours` |
| `LABOR_SETUP_ENABLED` | true | 是否计入换线固定人工 | —（开关） |
| 地域小时费率 | 华东 28 / 华南 24 元/小时 | 换线项小时费率基准 | `labor_rate::region:<code>` |

覆盖方式：在知识库 `process_rate` 分类下写入 `labor:setup_hours` 数值条目，引擎经 `getProcessRate()` 自动读取；地域小时费率经 `labor_rate::region:<code>` 覆盖。报告拆解行标注「（知识库覆盖）」或「（默认）」。

## 4. 已知简化与偏差方向

- **非工时核算**：未区分工序工时（印刷辅助/模切辅助/品检/包装），统一压成「元/个」近似，对自动化程度高的工厂偏**高估**人工、对纯手工厂偏**低估**。
- **复杂度系数粗略**：仅用盒型 `complexityMultiplier`（1.0/1.25/1.35）近似手工难度，未区分 internal 结构（如多个内托、特殊卡扣）。
- **糊盒单一费率**：不分自动糊盒机 vs 手工糊盒，统一 0.025 元/个。
- **换线项为常量**：`LABOR_SETUP_HOURS=0.5` 是经验均值，实际随产品切换难度（专色/烫金/异形刀模）差异大，复杂切换严重低估。
- **不含最小起订量/排产损耗**：未建模换线导致的产能占用与最小经济批量。

## 5. 小批量「换线/调机」固定人工简化项（评估结论）

**评估：建议计入（已落地为可选简化项）。**

理由：
- 小批量订单的真实痛点恰恰是**固定人工摊薄不足**——换线/调机/首件确认是每单必发生的固定投入，与数量无关，在小批量下被极少数量分摊，单只人工显著偏高。
- 不计入会导致小批量人工**系统性低估**，与用户反复关注的小批量成本特征（设计/制版固定费占比异常）同源，应一并显性展示。
- 实现成本低：复用现有地域小时费率，单常量 `LABOR_SETUP_HOURS` 即可，且可 KB 覆盖、可后续替换为「按切换难度分级」。

设计取舍：
- 计入**所有批量**（每单都发生换线），但大批量时其单只占比极低、影响可忽略，自然收敛；
- 不在报告里当作"误差"，而是作为「真实成本特征」与固定制版费同理展示；
- 用 `LABOR_SETUP_ENABLED` 开关保留关闭能力，便于校准对比。

后续可演进：把 `LABOR_SETUP_HOURS` 从常量改为按「印刷方式 × 表面处理 × 专色数」的切换难度分级表（如 plain < 专色 < 烫金），更贴近真实。

## 6. 校准路径（后期接真实数据）

1. 校准案例模板 `calibration-cases.example.json` 的 `actualLabor` 要求记录工厂**实际人工金额及构成**（见下），用于对比偏差。
2. 反推按件基准：实测计件人工 ÷ 数量 ÷ 复杂度 → 修正 `LABOR_BASE_PER_PIECE` / `LABOR_GLUING_PER_PIECE`。
3. 反推换线工时：实测换线总人工 ÷ 地域小时费率 → 修正 `LABOR_SETUP_HOURS`（或建分级表）。
4. 反推地域费率：各地实测小时工资 → 修正 `labor_regions` 的 `baseRate` 或知识库 `labor_rate`。
5. 系数写入知识库条目，无需改代码即可生效。

### 校准字段建议（写入 `actualLabor`）

| 字段 | 必填 | 含义 | 用途 |
| --- | --- | --- | --- |
| `total` | 是 | 工厂该单实际人工总金额（元） | 与估算 `labor` 对比总偏差 |
| `unit` | 否 | 实际单只人工（元/个） | 校验按件模型 |
| `hours` | 否 | 实际总工时（小时） | 反推工时结构 |
| `hourlyRate` | 否 | 实际平均小时工资（元/小时） | 反推地域费率 |
| `headcount` | 否 | 参与人数 | 校验排产 |
| `setupHours` | 否 | 实际换线/调机工时（小时） | 反推 `LABOR_SETUP_HOURS` |
| `note` | 否 | 计件/计时口径、自动化程度、班次说明 | 偏差归因 |

## 7. 落点

- 常量：`src/lib/cost-rules/index.ts`（`LABOR_*`）
- 知识库覆盖：`src/lib/knowledge-base/index.ts`（`labor:setup_hours` / `labor_rate::region:*`）
- 计算与展示：`src/lib/agents/specialists.ts`（`laborAgent` 的拆解行 / 依据 / 假设，假设中明确「简化模型非真实工时核算」）
- 报告标注：各维度「假设条件」列出简化模型说明；校准模板见 `calibration-cases.example.json`
