import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import { NAME_HEADER, rowToInput, type BatchResultRow } from "@/lib/batch/template";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface RowError {
  name: string;
  message: string;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const productType = String(form.get("productType") ?? "");

    const config = getProductConfig(productType);
    if (!config) {
      return Response.json(
        { ok: false, message: `未知产品类型: ${productType}` },
        { status: 400 }
      );
    }
    if (!(file instanceof File)) {
      return Response.json(
        { ok: false, message: "未收到文件" },
        { status: 400 }
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return Response.json(
        {
          ok: false,
          message: `文件过大（约 ${Math.round(file.size / 1024 / 1024)}MB），上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`,
        },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const xlsxMod = await import("xlsx");
    const XLSX = ((xlsxMod as any).default ?? xlsxMod) as typeof import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      return Response.json(
        { ok: false, message: "Excel 无工作表" },
        { status: 400 }
      );
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets[sheetName],
      { defval: "" }
    );

    // 过滤空行与示例行（名称含「示例」）
    const dataRows = rows.filter((r) => {
      const nm = r[NAME_HEADER] ?? r["name"];
      if (!nm || String(nm).trim() === "") return false;
      if (String(nm).includes("示例")) return false;
      return true;
    });

    if (dataRows.length === 0) {
      return Response.json(
        { ok: false, message: "未找到有效数据行（请删除示例行并填写产品）" },
        { status: 400 }
      );
    }
    if (dataRows.length > MAX_ROWS) {
      return Response.json(
        {
          ok: false,
          message: `数据行数 ${dataRows.length} 超过上限 ${MAX_ROWS} 行，请拆分上传`,
        },
        { status: 400 }
      );
    }

    const results: BatchResultRow[] = [];
    const errors: RowError[] = [];

    for (const row of dataRows) {
      const name = String(row[NAME_HEADER] ?? row["name"] ?? "未命名");
      try {
        const { name: rowName, input, raw, errors: parseErrors } = rowToInput(row, config);
        if (parseErrors && parseErrors.length) {
          errors.push({ name, message: `缺少必填字段：${parseErrors.join("、")}` });
          continue;
        }
        const report = await runOrchestrator({
          sessionId: randomUUID(),
          config,
          input,
        });
        results.push({ name: rowName, raw, report });
      } catch (e) {
        errors.push({
          name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return Response.json({
      ok: true,
      productType,
      productTypeName: config.name,
      total: dataRows.length,
      success: results.length,
      failed: errors.length,
      results,
      errors,
    });
  } catch (e) {
    return Response.json(
      { ok: false, message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
