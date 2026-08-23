# 成本分析逐步完善执行计划（真实案例校准闭环）

> 目的：用真实工厂成交价反推引擎常数，把估算从「经验合理」收敛到「可报价级准确」。
> 状态：引擎结构已稳（5 维 + 只读审阅）；已有 `scripts/calibration-test.ts`（经验价带版）作回归基线；用户**尚无真实案例**。

---

## 阶段 0 — 攒真实案例（用户负责，我不动）

每收到一张工厂报价单，按统一模板记一笔（输入参数 + 实际报价拆解 + 来源）。

**案例模板** `calibration-cases.example.json`（复制为 `calibration-cases.json` 后逐单追加）：

```json
{
  "caseId": "2026-客户A-彩盒",
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
  "meta": { "supplier": "某厂", "date": "2026-08", "note": "含16%税" }
}
```

**起步量**：10–20 单，覆盖 彩盒 / 瓦楞 / 精品盒 / 不同地域 即可跑第一轮。

**填写注意**：
- `input` 字段要与系统 `AnalysisInput` 一致（盒型代码、材质代码、地域代码等）。
- `actual` 能拆到分维度最好（材料/人工/加工/设计/财务）；只有总价也行，至少能算总单价偏差。
- `meta.note` 记清口径（含税？含运？打样费是否单列），口径不清的案例校准会失真。

---

## 阶段 1 — 校准脚本吃真实数据（我来做）

把 `scripts/calibration-test.ts` 从「硬编码经验价带」改为「读 `calibration-cases.json`」：
- 对每个案例走**真实 Agent 计算路径**（与线上报告同源，不重写公式）。
- 自动算 **引擎估算 vs 实际** 的总单价偏差 + 分维度占比偏差。
- 越界项标红，输出逐案例对照表。

这步替换掉之前的经验区间校准。

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
