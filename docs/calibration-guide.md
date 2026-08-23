# 真实案例校准指引（模板字段 + 偏差解读 + 反向调参）

> 配合 `calibration-cases.example.json`（模板）与 `scripts/calibration-real.ts`（校准脚本）。
> 目标：攒到 10–20 张真实工厂报价单后，跑第一轮校准，把估算从「经验合理」收敛到「可报价级准确」（总价 ±10%）。

---

## 1. 案例模板字段字典（calibration-cases.json）

每个案例是一个对象，数组形式逐单追加。**复制 `calibration-cases.example.json` 为 `calibration-cases.json` 后填写，避免覆盖模板。**

```jsonc
{
  "caseId": "2026-客户A-白卡彩盒",          // 必填，唯一标识
  "input": {                                // 必填，与系统 AnalysisInput 一致
    "length": 200, "width": 150, "height": 80,
    "quantity": 5000,                       // 数量（必填，用于算单价）
    "material": "white_card",               // 材质代码：white_card/grey_board/...
    "grammage": "350",                      // 克重（字符串）
    "printMethod": "offset",               // 印刷方式：offset/flexo/digital
    "colorCount": "4",                      // 四色数
    "surfaceTreatment": "matte_laminate",   // 表面处理：none/matte_laminate/gloss_laminate/uv/foil/emboss
    "surfaceCoverageLevel": "medium",       // 可选：烫金/凹凸覆盖率 low4%/medium8%/high15%
    "spotColorCount": 0,                     // 可选：专色数
    "needGluing": true,                      // 是否糊盒
    "boxType": "tuck_end",                  // 盒型代码：tuck_end/rigid_cover/special_window/...
    "fluteType": "none",                     // 可选：瓦楞坑型 E_flute/B_flute/none
    "laborRegion": "east_china",            // 选填，省略则回退 deliveryLocation
    "deliveryLocation": "east_china"         // 交付地域：east_china/south_china
  },
  "actual": {                               // 必填：工厂实际报价拆解（五维 + 总价）
    "total": 6800,                          // 实际总价（必填）
    "material": 2900,                       // 五维实际金额（能拆则拆，至少留 total）
    "labor": 520,
    "process": 1500,
    "design_plate": 700,
    "finance_other": 1180
  },
  "actualLabor": {                          // 选填：人工明细，用于对比/反推人工常数
    "total": 520, "unit": 0.104, "hours": 18,
    "hourlyRate": 28, "headcount": 2, "setupHours": 0.5,
    "note": "计件+计时混合；含换线0.5h"
  },
  "meta": {                                 // 选填但强烈建议：口径决定校准是否失真
    "supplier": "某厂", "date": "2026-08",
    "note": "含16%税；打样费含在 design_plate；物流含在 finance_other"
  }
}
```

**填写铁律**
- `input` 字段值必须与系统代码一致（盒型/材质/地域/表面处理代码），否则引擎算的是另一盒型。
- `actual.total` 必填；五维能拆则拆——只有总价也能跑「总价偏差」，但拆到维度才能跑「分维度/占比偏差」。
- `meta.note` 写清口径：**含税？含运？打样费是否单列？** 口径不清的案例校准会失真，建议单独标记。
- 起步量：**10–20 单**，覆盖 彩盒 / 瓦楞 / 精品盒 / 不同地域，即可跑第一轮系统性校准。

---

## 2. 跑校准

```bash
npm run test:calibration:real            # 读 calibration-cases.json
npm run test:calibration:real <path>     # 指定案例文件
```

输出：
- 控制台摘要（越界项 ANSI 红色）
- `cost-calibration-real.md`（逐案例对照表 + 偏差解读与反向调参指引）

脚本计算：
- **总价偏差** = (引擎总价 − 实际总价) / 实际总价
- **单价偏差** = (引擎单价 − 实际单价) / 实际单价
- **分维度金额偏差** = (引擎维度金额 − 实际维度金额) / 实际维度金额
- **分维度占比偏差(pp)** = 引擎占比% − 实际占比%（实际占比 = 实际维度金额 / 实际总价）
- **越界判定**：分维度 `|金额偏差%| > 15%` **或** `|占比偏差| > 8pp` → 标红，提示复核对应常数。

---

## 3. 怎么解读偏差（三步）

1. **先看总价偏差**：≤ ±10% 即达「可报价级」，不必逐维度纠结。多数维度此消彼长，总价对即可接受。
2. **总价超标再看红色维度**：标红 = 该维度引擎与实际偏差超阈值。集中在某一维度 → 该维度常数是主因。
3. **反推方向**：
   - 引擎金额 **>** 实际 → 该维度常数偏大，应**下调**
   - 引擎金额 **<** 实际 → 该维度常数偏小，应**上调**
   - 用「金额偏差%」量级估调整幅度（如偏高 +25%，先把对应常数 ×0.8 试跑）。

---

## 4. 逐维度对应常数（越界时改这里）

| 维度 | 偏差含义 | 优先复核常数（`src/lib/cost-rules`、`src/lib/knowledge-base`） |
| --- | --- | --- |
| 材料成本 | 偏高→纸价表/克重映射偏高；偏低→反之 | `MATERIAL_PRICES` / `getMaterialPrice`、`grammage` 档位映射、`getDynamicLossRate` 损耗率 |
| 人工成本 | 偏高→基准单价/地域系数高；偏低→反之 | `LABOR_BASE_PER_PIECE`、`LABOR_GLUING_PER_PIECE`、`LABOR_SETUP_HOURS`（换线）、`getRegionMultiplier`（仅作用人工） |
| 加工费（含设备） | 偏高→印刷/表面/刀模/油墨系数高；偏低→反之 | 印刷 `PRINT_MIN_CHARGE`、油墨 `INK_CMYK_*`/`INK_SPOT_*`、表面 `SURFACE_TREATMENT_RATES`、刀模 `DIE_FORM_COST`、烫金 `SURFACE_COVERAGE_LEVELS`、设备开机/专色洗车项 |
| 设计与制版成本 | 占比高多为**固定费正常现象**（小批量尤甚） | 设计费基数、版费（刀模/烫金版）、打样费；`provideReadyDesign` 减免 |
| 财务与其他成本 | 偏高→管理/利润/物流率高；偏低→反之 | 管理费率、利润率、`LOGISTICS_RATES`（按 subtotal%，未按体积重/实重）、包装辅材费率 |

> **勿误判**：设计/制版是一次性固定费，小批量下占比天然偏高（15–35% 正常），红色多为「占比越界」而非「绝对额错」；真实差距在**绝对额**是否贴合该厂实际。

---

## 5. 迭代闭环

攒一批（10–20）→ 跑 `test:calibration:real` → 调越界维度常数 → 重跑 → 直到总价 ±10% → 再攒下一批。
长期（路线图三期）：接真实纸价 API、多地域费率、企业成交价库，替换静态假设消除残余偏差。
