# 成本分析逐步完善执行计划（真实案例校准闭环）

> 目的：用真实工厂成交价反推引擎常数，把估算从「经验合理」收敛到「可报价级准确」。
> 状态：引擎结构已稳（5 维 + 只读审阅）；已有 `scripts/calibration-test.ts`（经验价带版）作回归基线；用户**尚无真实案例**。

---

## 阶段 0 — 攒真实案例（用户负责，我不动）

> **2026-08-31 更新：不用手写 JSON 了。** 打开 `/calibration-intake`：
> 1. 「批量导入」→ 下载 xlsx 模板（选好品类，列自动生成）→ 按列填（一单一行）
> 2. 上传填好的表格，或直接从 Excel 复制粘贴
> 3. 逐行预览：红色=阻断（缺案例标识/总价），琥珀=提示（缺高影响参数、口径没写、没外部锚），绿色=通过
> 4. 点「确认导入 N 条」→ 只写通过的行；顶部进度看板显示距 10 例还差多少
> 5. 攒够一批点「跑一轮校准」，页面直接出偏差汇总（或终端 `npm run test:calibration:real`）

每收到一张工厂报价单，按统一模板记一笔（输入参数 + 实际报价拆解 + 来源）。以下 JSON 结构即页面表单背后的落盘格式，了解即可，不需要手填。

**案例模板** `calibration-cases.example.json`（复制为 `calibration-cases.json` 后逐单追加）：

```json
{
  "caseId": "2026-客户A-白卡彩盒",
  "input": {
    "length": 200, "width": 150, "height": 80, "quantity": 5000,
    "material": "white_card", "grammage": "350", "printMethod": "offset",
    "colorCount": "4", "surfaceTreatment": "matte_laminate",
    "needGluing": true, "boxType": "tuck_end",
    "laborRegion": "east_china", "deliveryLocation": "east_china"
  },
  "actual": {
    "total": 6800,
    "material": 2900, "labor": 520, "process": 1500,
    "design_plate": 700, "finance_other": 1180
  },
  "actualLabor": {
    "total": 520, "unit": 0.104, "hours": 18,
    "hourlyRate": 28, "headcount": 2, "setupHours": 0.5,
    "note": "计件+计时混合；含换线/调机0.5h；华东厂"
  },
  "meta": { "supplier": "某厂", "date": "2026-08", "note": "含16%税；打样费已含在 design_plate" }
}
```

> 完整字段字典见 `docs/calibration-guide.md`；模板已含两个示范案例（彩盒华东 / 精品盒华南烫金），覆盖五维 + actualLabor 明细。

**起步量**：10–20 单，覆盖 彩盒 / 瓦楞 / 精品盒 / 不同地域 即可跑第一轮。

**填写注意**：
- `input` 字段要与系统 `AnalysisInput` 一致（盒型代码、材质代码、地域代码等）。
- `actual` 能拆到分维度最好（材料/人工/加工/设计/财务）；只有总价也行，至少能算总单价偏差。
- `meta.note` 记清口径（含税？含运？打样费是否单列），口径不清的案例校准会失真。

---

## 阶段 1 — 校准脚本吃真实数据（我来做）

用新建的 `scripts/calibration-real.ts`（读 `calibration-cases.json`，走真实 Agent 路径）：
- 对每个案例走**真实 Agent 计算路径**（与线上报告同源，不重写公式）。
- 自动算 **引擎估算 vs 实际** 的总价偏差 + 单只偏差 + 分维度金额偏差 + 分维度占比偏差(pp)。
- 越界项标红（金额偏差 |%|>15% 或 占比偏差 >8pp），输出逐案例对照表 + `cost-calibration-real.md`。
- 报告内附「偏差解读与反向调参指引」（逐维度对应常数清单）。

模板字段字典与填写铁律见 `docs/calibration-guide.md`。

> 旧的 `scripts/calibration-test.ts`（硬编码行业经验价带版）保留为纯合成回归基线（`npm run test:calibration`），与真实案例校准（新阶段 1）并行使用。

---

## 阶段 2 — 反推常数（我来做）

- 哪个维度系统性偏离 → 定位对应常数（纸价静态表 / 损耗率 / 地域系数 / 设计制版费 / 油墨 42 元/kg 等）。
- 调后重跑，直到偏差收敛到 **±10%** 内。
- 这就是「逐步完善」的迭代闭环：攒一批 → 校准 → 修正 → 再攒。

---

## 阶段 3 — 系统化数据底座（路线图三期）

- 纸价行情 API、多地域费率、企业历史成交价库，替换静态假设。
- 图纸 → RFQ → 回收报价闭环。

---

## 分工一句话
**你只做阶段 0（攒案例，丢进 JSON）。阶段 1/2 我来。攒到一批就喊我。**
