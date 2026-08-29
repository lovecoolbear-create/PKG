import { NextRequest } from "next/server";
import { getProductConfig, getAllProductTypes } from "@/config/products";
import { detectProductType } from "@/lib/parse/column-map";
import * as dictStore from "@/lib/parse/dict-store";
import { runImportPipeline } from "@/lib/parse/import-shared";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// 供 /import/compare/page.tsx 复用类型
export type { ImportEstimate, ImportProductRow } from "@/lib/parse/import-shared";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const forcedType = form.get("productType");
    const forcedTypeStr = typeof forcedType === "string" ? forcedType.trim() : "";

    if (!(file instanceof File)) {
      return Response.json({ ok: false, message: "未收到文件" }, { status: 400 });
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
      return Response.json({ ok: false, message: "Excel 无工作表" }, { status: 400 });
    }
    // header:1 → 数组的数组；首行为表头，其余为数据
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
      header: 1,
      defval: "",
      blankrows: false,
    });
    if (!matrix.length) {
      return Response.json({ ok: false, message: "未读取到任何数据" }, { status: 400 });
    }

    const headers = (matrix[0] ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);
    const dataMatrix = matrix
      .slice(1)
      .map((r) => (r ?? []).map((c) => (c == null ? "" : c)))
      .filter((r) => r.some((c) => String(c).trim() !== ""));

    if (!headers.length || !dataMatrix.length) {
      return Response.json(
        { ok: false, message: "未找到有效表头或数据行" },
        { status: 400 }
      );
    }
    if (dataMatrix.length > MAX_ROWS) {
      return Response.json(
        {
          ok: false,
          message: `数据行数 ${dataMatrix.length} 超过上限 ${MAX_ROWS} 行，请拆分上传`,
        },
        { status: 400 }
      );
    }

    // 品类识别：显式指定优先，否则按表头自动探测
    let productType = forcedTypeStr || detectProductType(headers) || "";
    const config = getProductConfig(productType);
    if (!config) {
      // 未识别品类：返回可用品类列表，供前端引导用户手动选品类后重试
      const availableTypes = getAllProductTypes().map((c) => ({
        code: c.code,
        name: c.name,
      }));
      return Response.json(
        {
          ok: false,
          code: "UNKNOWN_PRODUCT_TYPE",
          message:
            "无法自动识别表格品类，请指定品类后重试。可用品类见 availableTypes。",
          availableTypes,
        },
        { status: 400 }
      );
    }

    // 结构化映射 + 词典捕获 + 成本引擎估算，复用共享管线（扫描件导入同此）
    const overrides = dictStore.loadOverrides();
    const result = await runImportPipeline(
      productType,
      headers,
      dataMatrix as (string | number | undefined)[][],
      overrides
    );

    return Response.json({
      ok: true,
      productType: result.productType,
      productTypeName: result.productTypeName,
      hasPrice: result.hasPrice,
      newTerms: result.newTerms,
      rowCount: result.rowCount,
      products: result.products,
    });
  } catch (e) {
    return Response.json(
      { ok: false, message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
