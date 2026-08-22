import { NextRequest, NextResponse } from "next/server";
import {
  listKnowledgeEntries,
  reloadKnowledgeBase,
  upsertKnowledgeEntry,
  type UpsertKnowledgeEntryInput,
} from "@/lib/knowledge-base";
import { fetchMaterialPrices } from "@/lib/material-prices/fetcher";
import { MATERIAL_LABELS } from "@/lib/cost-rules";

/**
 * 知识库管理接口（增量刷新）
 * ----------------------------------------------------------------
 * GET    /api/admin/knowledge-base?category=material_price   列出条目
 * POST   /api/admin/knowledge-base  { "action": "reload" }   刷新内存缓存
 * PUT    /api/admin/knowledge-base  { category, key, value, ... }  新增/更新条目并即时刷新
 *
 * 安全：若配置了 KB_ADMIN_TOKEN 环境变量，则要求请求头 x-admin-token 与之匹配；
 * 未配置时本地开放（便于本地调试与演示）。
 */
function checkAuth(request: NextRequest): boolean {
  const token = process.env.KB_ADMIN_TOKEN;
  if (!token) return true; // 未配置则开放
  return request.headers.get("x-admin-token") === token;
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const category = request.nextUrl.searchParams.get("category") || undefined;
  const entries = await listKnowledgeEntries(category);
  return NextResponse.json({ count: entries.length, entries });
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  if (body.action === "reload") {
    const res = await reloadKnowledgeBase();
    return NextResponse.json({ ok: true, ...res });
  }
  // 网络刷新区：拉取外部行情（无 Key / 失败时优雅回退本地基准），返回供前端展示
  if (body.action === "refresh-network") {
    const { material, grammage, surfaceTreatment } = body as {
      material?: string;
      grammage?: string;
      surfaceTreatment?: string;
    };
    if (!material || !grammage) {
      return NextResponse.json(
        { error: "material / grammage 为必填" },
        { status: 400 }
      );
    }
    const result = await fetchMaterialPrices({
      material,
      grammage,
      surfaceTreatment,
    });
    return NextResponse.json({ ok: true, material, grammage, ...result });
  }
  // 网络刷新区：将行情价采纳为内部人工基准（写入 material_price，source=network_adopted）
  if (body.action === "adopt-network") {
    const { material, grammage, price } = body as {
      material?: string;
      grammage?: string;
      price?: number;
    };
    if (!material || !grammage || typeof price !== "number") {
      return NextResponse.json(
        { error: "material / grammage / price 均为必填" },
        { status: 400 }
      );
    }
    const entry = await upsertKnowledgeEntry({
      category: "material_price",
      key: `${material}:${grammage}`,
      value: {
        value: price,
        material,
        grammage,
        unit: "元/吨",
      },
      source: "network_adopted",
      confidence: 75,
      tags: [material, `${grammage}g`, "network_adopted"],
    });
    return NextResponse.json({ ok: true, entry });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function PUT(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const { category, key, value } = body as UpsertKnowledgeEntryInput;
  if (!category || !key || value === undefined) {
    return NextResponse.json(
      { error: "category / key / value 均为必填" },
      { status: 400 }
    );
  }
  const entry = await upsertKnowledgeEntry({
    category,
    key,
    value,
    source: body.source,
    confidence: body.confidence,
    tags: body.tags,
  });
  return NextResponse.json({ ok: true, entry });
}
