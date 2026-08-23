# 成本分析公式逻辑审计（2026-08-23）

## 总评
- **架构 / 逻辑流：连贯、可信。** `deriveAnalysisContext` 一次算共享派生量 → 5 个 Specialist 只读消费 → `reviewAnalysis` 只读审阅（不改数字）→ orchestrator 汇总校验。单真相源，无重复计算，不会因迭代跑偏。
- **知识库回退：安全。** 所有费率优先读 KB，读不到回退代码常量，DB 抖动有冷却重试。
- **可信度问题集中在「参数取值 / 几何假设」，不在流程。** 绝大多数公式有行业依据；以下标注三档，❌ 为不可直接采信需修正的部分。

---

## 逐项可信度

### ✅ 高可信（逻辑严谨、取值有行业依据）
| 公式 | 位置 | 说明 |
|---|---|---|
| 材料重量 `calculatePaperWeight` | cost-rules | 拼版利用率 util + 动态损耗 lossRate 双因子，物理含义分离合理 |
| 数量阶梯折扣 `getQuantityDiscount` | cost-rules | 行业惯例 |
| 印刷费 `(qty/1000)×rate×色数 + 起步托底` | specialists.processAgent | 千印计价正确；数码无起步价处理得当 |
| 制版 / 专色 / 刀模 / 贴窗 | specialists | 结构与口径清晰 |
| 财务（管理6% + 利润8% + 物流%） | specialists.financeAgent | 行业参考值，已透明标注 disclaimer + confidence |
| 审阅器 / 校验 / 默认假设降置信度 | reviewer / orchestrator / question-engine | 只读不改数字；假设透明化展示 |

### ⚠️ 中可信（近似假设，标注即可，不影响主判断）
| 项 | 位置 | 说明 |
|---|---|---|
| 展开面积公式 `calculateExpandedArea` | cost-rules | 标准扣底盒公式；对异形/特殊盒型有偏差 |
| **表面处理面积口径不一致** | processAgent vs materialAgent | 表面费用用 `netAreaM2×qty`（未含拼版利用率 util），材料用纸用 `imposedAreaM2`（含 util）。同张印版，表面膜面积应≥材料用纸口径，当前低估约 15% |
| **人工地域系数实现偏简** | laborAgent | 仅对 flat `0.05 元/个` 乘 `getRegionMultiplier`；`LABOR_REGIONS` 的 hourly rate / `gluingHoursPerThousand` 等字段未真正驱动基数，属死配置，仅比率生效 |
| 设计费 800 / 打样 300·150 | designAgent | 固定估算，已标注 estimate |

### ❌ 低可信 / 需修正（结构性错误，数字不可直接采信）
1. **天地盖精品盒（rigid_cover）几何系统性低估**
   - 当前用 tuck-end 展开公式 + **单 footprint** 算面纸与灰板。真实天地盖为 lid + base 两件，面积≈**2×**，灰板应≈2× footprint。
   - 面纸克重默认沿用 `white_card 350g`；真实常用 157g 面纸 + 灰板，当前面纸偏重。
   - 现状仅靠 `util=0.72` + `复杂度1.35` 部分补偿，**仍系统性低估 rigid 成本**。
   - 影响：勾选"天地盖精品盒"的报告数字不可直接采信。

2. **人工地域 与 交付地域 是两套互不映射的体系，易静默失效**
   - `laborRegion`（华南 = `south_china_dg`）与 `deliveryLocation`（华南 = `south_china`）是不同 code 集，无映射关系。
   - 用户只选交付地、未单独回答 `laborRegion` 问题时，`laborRegion` 默认华东 → 系数恒为 **1.0**，"各地人工费不一样"的意图落空，且界面出现两个地域选择器（标签还不完全一致），易混淆。

---

## 修正优先级建议
- **P0**：修正 rigid_cover 几何（lid+base 双件面积、面纸克重分流为薄面纸+灰板）。
- **P1**：统一地域体系——`deliveryLocation` 自动推导 `laborRegion`，或合并为单一地域选择器。
- **P2**：表面处理 / 裱坑面积改用 `imposedAreaM2`（与材料用纸口径一致）；清理 `LABOR_RATE` / `EQUIPMENT_RATE` 等死配置。

（本报告基于代码现状静态审计，未跑实测数值；如需要可补一组 rigid / 华南 的样例数值验证。）

---

## 修复记录（2026-08-23，同日晚）

| 项 | 状态 | 改动 |
|---|---|---|
| ❌ P0 天地盖几何低估 | ✅ 已修复 | `BoxTypeConfig` 增 `pieceCount`（rigid_cover=2）；materialAgent 面纸/灰板面积 ×pieceCount；精品盒面纸改用典型薄面纸 `RIGID_FACE_GRAMMAGE=157g`（与普通克重区分，报告中标注假设） |
| ❌ P1 地域系数静默失效 | ✅ 已修复 | `labor-regions` 增别名映射 `south_china→south_china_dg` 与 `resolveLaborRegion`；`deriveAnalysisContext` 的 `laborRegion` 回退到 `deliveryLocation`；从 `FIELD_DEFAULTS` 移除 `laborRegion`（避免静默默认华东）；`orchestrator` 的 `regionDefaulted` 与标签走别名解析 |
| ⚠️ P2 表面/裱坑面积口径 | ✅ 已修复 | 全覆盖工艺（哑膜/亮膜/UV）表面处理面积改用 `imposedAreaM2×数量`；局部工艺（烫金/凹凸）保持 `netAreaM2×数量×coverage`；裱坑加工费改用 `imposedAreaM2×数量` |
| P2 死配置清理 | ✅ 已修复（2026-08-23 晚） | `LABOR_RATE=28` 彻底删除（无任何引用，纯死常量）；`EQUIPMENT_RATE=45` 标记 `@deprecated` 并移除 seed 条目与 `PROCESS_RATE_FALLBACK` 的 `equipment_rate` 映射；admin 页面 `unitOf` 的 `equipment` 分支一并删除。二者均不参与任何 Agent 计算，知识库 `equipment_rate` 不再作为"看似生效"的种子数据出现。注：`LABOR_REGIONS` 的 `gluingHoursPerThousand` 仍为死字段，但属盒型配置内部残留、不影响计算，留待后续盒型配置梳理时一并清理 |

验证：`tsc` 通过；`scripts/calc-test.ts` 全部断言 PASS（天地盖单件 ¥3.5 结构合理；华南交付地驱动人工系数 0.857、人工 ¥192.83 < 华东 ¥225）。
