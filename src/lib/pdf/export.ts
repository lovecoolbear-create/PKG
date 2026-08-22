import type { AnalysisReport } from "@/types";

export async function generatePDFReport(report: AnalysisReport): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN_X = 14;
  const MARGIN_BOTTOM = 18;
  const CONTENT_W = pageWidth - MARGIN_X * 2;
  let y = 18;

  /** 空间不足时换页，返回新的 y */
  const ensure = (need: number): number => {
    if (y + need > pageHeight - MARGIN_BOTTOM) {
      doc.addPage();
      y = 18;
    }
    return y;
  };

  // 标题
  doc.setFontSize(18);
  doc.setTextColor(16, 42, 67);
  doc.text(`${report.productTypeName}成本分析报告`, pageWidth / 2, y, {
    align: "center",
  });
  y += 9;
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(
    `生成时间：${new Date(report.generatedAt).toLocaleString("zh-CN")}`,
    pageWidth / 2,
    y,
    { align: "center" }
  );
  y += 10;

  // 顶部醒目免责声明（动态高度，自动换行，避免截断）
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const discLines = doc.splitTextToSize(report.disclaimer, CONTENT_W - 8);
  const discBoxH = discLines.length * 5 + 8;
  y = ensure(discBoxH + 4);
  doc.setFillColor(255, 247, 237);
  doc.setDrawColor(234, 88, 12);
  doc.roundedRect(MARGIN_X, y, CONTENT_W, discBoxH, 2, 2, "FD");
  doc.setTextColor(234, 88, 12);
  doc.setFont("helvetica", "bold");
  discLines.forEach((ln: string, i: number) => {
    doc.text(ln, pageWidth / 2, y + 7 + i * 5, { align: "center" });
  });
  doc.setFont("helvetica", "normal");
  y += discBoxH + 8;

  // 成本总览
  y = ensure(40);
  doc.setFontSize(14);
  doc.setTextColor(16, 42, 67);
  doc.text("成本总览", MARGIN_X, y);
  y += 8;
  doc.setFontSize(11);
  doc.setTextColor(50, 50, 50);
  doc.text(
    `总成本区间：¥${report.totalCost.min.toLocaleString()} - ¥${report.totalCost.max.toLocaleString()}`,
    MARGIN_X,
    y
  );
  y += 6;
  doc.text(
    `单位成本：¥${report.totalCost.perUnit.min} - ¥${report.totalCost.perUnit.max} /个`,
    MARGIN_X,
    y
  );
  y += 6;
  doc.text(`整体置信度：${report.overallConfidence}%`, MARGIN_X, y);
  y += 6;
  doc.text(`信息完整度：${report.completeness}%`, MARGIN_X, y);
  y += 12;

  // 成本维度拆解表
  y = ensure(40);
  doc.setFontSize(14);
  doc.setTextColor(16, 42, 67);
  doc.text("成本维度拆解", MARGIN_X, y);
  y += 4;

  const tableData = report.dimensions.map((d) => [
    d.dimensionLabel,
    `¥${d.estimatedAmount.toLocaleString()}`,
    `${d.ratio}%`,
    `${d.confidence}%`,
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (doc as any).autoTable({
    startY: y,
    head: [["成本维度", "估算金额", "占比", "置信度"]],
    body: tableData,
    theme: "grid",
    headStyles: { fillColor: [36, 59, 83], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    margin: { left: MARGIN_X, right: MARGIN_X },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 10;

  // 成本拆解明细 (Cost Breakdown) —— 扁平化所有维度的分项 breakdown
  const breakdownRows: string[][] = [];
  for (const d of report.dimensions) {
    if (!d.breakdown || d.breakdown.length === 0) continue;
    for (const b of d.breakdown) {
      breakdownRows.push([
        d.dimensionLabel,
        b.label,
        `¥${b.amount.toLocaleString()}`,
        b.note ?? "",
      ]);
    }
  }
  if (breakdownRows.length > 0) {
    y = ensure(24);
    doc.setFontSize(14);
    doc.setTextColor(16, 42, 67);
    doc.text("成本拆解明细 (Cost Breakdown)", MARGIN_X, y);
    y += 5;

    // 材料数据源状态标注（避免跨页断裂，随表格标题同行）
    if (report.materialPriceSources) {
      const paperEntry = report.materialPriceSources.entries.find(
        (e) => e.category === "paper"
      );
      const live = paperEntry?.live === true;
      const estimate = !report.materialPriceSources.hasFallback && !live;
      const label = live
        ? "行情实时检索"
        : estimate
          ? "AI 模型估算（非实时）"
          : `本地权威基准（更新时间：${new Date(report.materialPriceSources.fetchedAt).toLocaleString("zh-CN")}）`;
      doc.setFontSize(8);
      doc.setTextColor(
        live ? 16 : estimate ? 109 : 185,
        live ? 129 : estimate ? 40 : 88,
        live ? 129 : estimate ? 217 : 12
      );
      doc.text(`材料数据源：${label}`, MARGIN_X, y);
      y += 4;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc as any).autoTable({
      startY: y,
      head: [["维度", "分项", "金额", "说明"]],
      body: breakdownRows,
      theme: "striped",
      headStyles: { fillColor: [36, 59, 83], textColor: 255, fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      margin: { left: MARGIN_X, right: MARGIN_X },
      rowPageBreak: "avoid",
      columnStyles: {
        2: { halign: "right" },
        3: { cellWidth: 60 },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 10;
  }

  // AI 包装 SQE 专家诊断
  if (report.sqeDiagnosis) {
    const title =
      report.sqeDiagnosis.source === "llm"
        ? "AI 包装 SQE 专家诊断（大模型生成）"
        : "AI 包装 SQE 专家诊断（模板诊断）";
    const text = report.sqeDiagnosis.text;
    const lines = doc.splitTextToSize(text, CONTENT_W - 8);
    const boxH = 12 + lines.length * 5;
    y = ensure(boxH + 8);
    doc.setFillColor(245, 240, 255);
    doc.setDrawColor(139, 92, 246);
    doc.roundedRect(MARGIN_X, y, CONTENT_W, boxH, 2, 2, "FD");
    doc.setFontSize(11);
    doc.setTextColor(109, 40, 217);
    doc.setFont("helvetica", "bold");
    doc.text(title, MARGIN_X + 3, y + 7);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    doc.text(lines, MARGIN_X + 3, y + 11);
    y += boxH + 6;
  }

  // 制造 vs 商业
  y = ensure(20);
  doc.setFontSize(11);
  doc.setTextColor(50, 50, 50);
  doc.text(
    `制造成本：¥${report.manufacturingCost.total.toLocaleString()} (${report.manufacturingCost.ratio}%)`,
    MARGIN_X,
    y
  );
  y += 6;
  doc.text(
    `商业与财务成本：¥${report.commercialCost.total.toLocaleString()} (${report.commercialCost.ratio}%)`,
    MARGIN_X,
    y
  );
  y += 12;

  // 优化建议
  if (report.optimizationHints.length > 0) {
    y = ensure(20);
    doc.setFontSize(14);
    doc.setTextColor(16, 42, 67);
    doc.text("优化建议", MARGIN_X, y);
    y += 8;
    doc.setFontSize(9);
    for (const hint of report.optimizationHints) {
      y = ensure(14);
      doc.setTextColor(16, 185, 129);
      doc.text(`• ${hint.title}`, MARGIN_X, y);
      y += 5;
      doc.setTextColor(80, 80, 80);
      const lines = doc.splitTextToSize(hint.summary, CONTENT_W);
      doc.text(lines, MARGIN_X + 4, y);
      y += lines.length * 4 + 4;
    }
  }

  // 材料价格来源
  if (report.materialPriceSources) {
    y = ensure(20);
    doc.setFontSize(14);
    doc.setTextColor(16, 42, 67);
    doc.text("材料价格来源", MARGIN_X, y);
    y += 6;
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const summ = doc.splitTextToSize(
      `摘要：${report.materialPriceSources.summary}（获取时间：${new Date(
        report.materialPriceSources.fetchedAt
      ).toLocaleString("zh-CN")}）`,
      CONTENT_W
    );
    doc.text(summ, MARGIN_X, y);
    y += summ.length * 4 + 2;
    for (const e of report.materialPriceSources.entries) {
      y = ensure(8);
      const line = `• ${e.item}：${e.price} ${e.unit}（${e.isFallback ? "回退默认" : "实时获取"}｜来源：${e.source}）`;
      const lines = doc.splitTextToSize(line, CONTENT_W);
      doc.text(lines, MARGIN_X, y);
      y += lines.length * 4 + 1;
    }
    y += 4;
  }

  // 生产地域
  if (report.laborRegion) {
    y = ensure(8);
    doc.setFontSize(9);
    doc.setTextColor(50, 50, 50);
    doc.text(
      `生产地域：${report.laborRegion.label}${report.laborRegion.isDefault ? "（默认）" : ""}`,
      MARGIN_X,
      y
    );
    y += 8;
  }

  // 采用默认假设的字段 + 置信度扣分项
  if (report.defaultAssumptions && report.defaultAssumptions.length > 0) {
    const penalty = report.defaultConfidencePenalty ?? 0;
    const headLines = doc.splitTextToSize(
      `当前采用 ${report.defaultAssumptions.length} 项默认假设${
        penalty > 0 ? `（整体置信度已下调约 ${penalty} 分，单维度上限 25 分）` : ""
      }`,
      CONTENT_W
    );
    const blockH = 14 + headLines.length * 4 + report.defaultAssumptions.length * 6;
    y = ensure(blockH + 6);
    doc.setFillColor(254, 243, 199);
    doc.setDrawColor(217, 119, 6);
    doc.roundedRect(MARGIN_X, y, CONTENT_W, blockH, 2, 2, "FD");
    doc.setFontSize(11);
    doc.setTextColor(180, 83, 9);
    doc.setFont("helvetica", "bold");
    doc.text("当前采用的默认假设", MARGIN_X + 3, y + 7);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(146, 64, 14);
    headLines.forEach((ln: string, i: number) => {
      doc.text(ln, MARGIN_X + 3, y + 11 + i * 4);
    });
    let ay = y + 11 + headLines.length * 4 + 3;
    doc.setTextColor(80, 80, 80);
    for (const a of report.defaultAssumptions) {
      const line = `• ${a.label}：${a.assumedValue} — ${a.reason}`;
      const lines = doc.splitTextToSize(line, CONTENT_W - 6);
      doc.text(lines, MARGIN_X + 3, ay);
      ay += lines.length * 4 + 1.5;
    }
    y += blockH + 6;
  }

  // 底部醒目免责声明
  const footLines = doc.splitTextToSize(
    `${report.disclaimer} 本报告基于行业基准规则与公开/估算行情生成，实际价格以工厂正式报价与合同约定为准。`,
    CONTENT_W - 8
  );
  const footBoxH = footLines.length * 5 + 10;
  y = ensure(footBoxH + 6);
  doc.setFillColor(255, 247, 237);
  doc.setDrawColor(234, 88, 12);
  doc.roundedRect(MARGIN_X, y, CONTENT_W, footBoxH, 2, 2, "FD");
  doc.setFontSize(9);
  doc.setTextColor(234, 88, 12);
  doc.setFont("helvetica", "bold");
  footLines.forEach((ln: string, i: number) => {
    doc.text(ln, pageWidth / 2, y + 8 + i * 5, { align: "center" });
  });
  doc.setFont("helvetica", "normal");
  y += footBoxH + 4;

  // 页脚（每页小字免责 + 页码）
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(report.disclaimer, pageWidth / 2, pageHeight - 8, {
      align: "center",
    });
    doc.text(`第 ${i} / ${pageCount} 页`, pageWidth - MARGIN_X, pageHeight - 8, {
      align: "right",
    });
  }

  return doc.output("blob");
}

export function downloadPDF(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
