/**
 * 双面积模型（理论面积 + 实际生产面积）验证脚本
 * 跑真实引擎，确认：
 *  - 矩形盒 + 全张纸 + 每版只数 → 真实利用率/实际生产面积
 *  - 异形图形清单 dielineShapes → computeDielineArea 累计
 *  - 无全张纸时回退盒型默认拼版利用率
 *  - dielineAreaMm2 直接覆盖优先
 */
import { deriveAnalysisContext } from "@/lib/agents/analysis-context";
import { computeDielineArea } from "@/lib/cost-rules";
import { materialAgent } from "@/lib/agents/specialists";
import type { DielineShape, AnalysisInput } from "@/types";

function run(label: string, input: AnalysisInput) {
  const ctx = deriveAnalysisContext(input);
  const mat = materialAgent(ctx);
  console.log(`\n=== ${label} ===`);
  console.log(
    `  理论面积(mm²): ${ctx.dielineAreaMm2}  净面积(m²/个): ${ctx.netAreaM2.toFixed(5)}`
  );
  console.log(
    `  理论使用占比: ${(ctx.utilization * 100).toFixed(1)}%  sheetBased: ${ctx.sheetBased}`
  );
  console.log(`  实际生产面积(m²/个): ${ctx.productionAreaM2.toFixed(5)}`);
  console.log(
    `  areaMetrics: 理论 ${(mat.areaMetrics?.theoreticalAreaCm2 ?? 0).toFixed(0)}cm² / 占比 ${(
      (mat.areaMetrics?.utilization ?? 0) * 100
    ).toFixed(1)}% / 生产 ${mat.areaMetrics?.productionAreaM2.toFixed(4)}m² / sheetBased ${mat.areaMetrics?.sheetBased}`
  );
}

// 案例1：矩形盒 + 全张纸 700×1000 + 每版 12 只
run("案例1 矩形 L/W/H + 拼版(700x1000,12只)", {
  length: 100,
  width: 80,
  height: 50,
  quantity: 5000,
  sheetSize: { w: 700, h: 1000 },
  piecesPerSheet: 12,
});

// 案例2：异形图形清单 + 拼版
const shapes: DielineShape[] = [
  { type: "rect", w: 100, h: 50 },
  { type: "triangle", b: 40, h: 20 },
  { type: "circle", r: 15 },
];
console.log(
  "\ncomputeDielineArea(shapes) =",
  computeDielineArea(shapes),
  "mm²  (应=100*50 + 40*20/2 + π*15² = 5000+400+706.9 = 6106.9)"
);
run("案例2 异形图形清单 + 拼版(700x1000,10只)", {
  length: 100,
  width: 80,
  height: 50,
  quantity: 3000,
  dielineShapes: shapes,
  sheetSize: { w: 700, h: 1000 },
  piecesPerSheet: 10,
});

// 案例3：无全张纸 → 回退盒型默认拼版利用率
run("案例3 无拼版(回退盒型默认)", {
  length: 100,
  width: 80,
  height: 50,
  quantity: 5000,
});

// 案例4：dielineAreaMm2 直接覆盖 + 拼版
run("案例4 直接覆盖理论面积 185000 + 拼版(700x1000,12只)", {
  length: 100,
  width: 80,
  height: 50,
  quantity: 5000,
  dielineAreaMm2: 185000,
  sheetSize: { w: 700, h: 1000 },
  piecesPerSheet: 12,
});

// 案例5：新增图形类型逐个公式核验（确定性，不依赖模型估面积）
const newShapes: DielineShape[] = [
  { type: "ellipse", a: 60, b: 30 }, // π*60*30 = 5654.87
  { type: "sector", r: 40, angleDeg: 90 }, // ½*40²*(π/2) = 1256.64
  { type: "semicircle", r: 25 }, // ½*π*25² = 981.75
  { type: "parallelogram", b: 50, h: 30 }, // 50*30 = 1500
  { type: "rhombus", d1: 40, d2: 24 }, // ½*40*24 = 480
  { type: "annulus", rOuter: 50, rInner: 20 }, // π*(50²-20²) = 6597.34
  { type: "segment", r: 30, angleDeg: 60 }, // ½*30²*(π/3 - sin(π/3)) = 81.65
  { type: "regularPolygon", sides: 6, sideLen: 20 }, // 6*20²/(4*tan(π/6)) = 1039.23
];
console.log(
  "\ncomputeDielineArea(新增类型) =",
  computeDielineArea(newShapes).toFixed(2),
  "mm²  (应≈ 5654.87+1256.64+981.75+1500+480+6597.34+81.65+1039.23 = 17591.48)"
);
run("案例5 全图形类型 + 拼版(700x1000,4只)", {
  length: 100,
  width: 80,
  height: 50,
  quantity: 2000,
  dielineShapes: newShapes,
  sheetSize: { w: 700, h: 1000 },
  piecesPerSheet: 4,
});

