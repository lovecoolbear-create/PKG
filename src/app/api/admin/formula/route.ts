/**
 * 成本配方管理接口（F5）
 * ----------------------------------------------------------------
 * 安全：**fail-closed**（src/lib/admin-auth.ts）。未配置 FORMULA_ADMIN_TOKEN
 * 时一律 403，与知识库页面的 fail-open 相反——公式是核心资产，公网部署
 * 若忘了配 token 也不能被任意读写。
 *
 * GET    /api/admin/formula?productType=xxx          列出配方行与审计日志
 * PUT    /api/admin/formula  { id, patch, reason }   更新成本项（写审计）
 * POST   /api/admin/formula  { action:"reload" }     刷新配方缓存
 * POST   /api/admin/formula  { action:"try-run", draft? }  试算（可带未保存草稿，不写库）
 * POST   /api/admin/formula  { action:"create", item }     新增成本项
 * POST   /api/admin/formula  { action:"archive", id }      归档（软删，不真丢数据）
 * POST   /api/admin/formula  { action:"rollback", auditId } 回滚到某次改动之前
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { checkAdminAuth } from "@/lib/admin-auth";
import {
  reloadRecipes,
  getRecipeCacheInfo,
  withRecipeOverrides,
} from "@/lib/cost-formula/loader";
import { validateCostItem } from "@/lib/cost-formula";
import { validateCostItemPatch } from "@/lib/cost-formula/validate";
import { getProductConfig } from "@/config/products";
import { runOrchestrator } from "@/lib/agents/orchestrator";
import type { AiSettings } from "@/lib/config/ai-settings";

export const maxDuration = 60;

/** 试算一律关闭 AI，保证可复现（与黄金基线同一口径） */
const AI_OFF: AiSettings = {
  provider: "disabled",
  baseUrl: "",
  apiKey: "",
  modelName: "",
};

function deny(reason: string, status: 401 | 403) {
  return NextResponse.json({ ok: false, error: reason }, { status });
}

/** 新增时的白名单：品类/维度不能任意填，否则会造出永远不被引擎读取的"孤儿配方" */
const PRODUCT_TYPES = ["color_print_box", "corrugated_box", "flat_print"];
const DIMENSIONS = [
  "material",
  "labor",
  "process",
  "design_plate",
  "finance_other",
];

export async function GET(request: NextRequest) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return deny(auth.reason, auth.status);

  const productType = request.nextUrl.searchParams.get("productType") || undefined;
  const items = await prisma.costItem.findMany({
    where: productType ? { productType } : undefined,
    orderBy: [
      { productType: "asc" },
      { dimension: "asc" },
      { sortOrder: "asc" },
    ],
  });
  const audit = await prisma.costItemAudit.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // 逐项静态校验：让「数据已经坏了」在打开页面时就能看见，而不是等报价算错
  const itemsWithHealth = items.map((i) => ({
    ...i,
    health: validateCostItem(i),
  }));

  return NextResponse.json({
    ok: true,
    items: itemsWithHealth,
    audit,
    cache: getRecipeCacheInfo(),
  });
}

export async function PUT(request: NextRequest) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return deny(auth.reason, auth.status);

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    patch?: Record<string, unknown>;
    reason?: string;
  };

  if (!body.id || !body.patch) {
    return NextResponse.json(
      { ok: false, error: "缺少 id 或 patch" },
      { status: 400 }
    );
  }

  const before = await prisma.costItem.findUnique({ where: { id: body.id } });
  if (!before) {
    return NextResponse.json({ ok: false, error: "成本项不存在" }, { status: 404 });
  }

  // ── 写库前置校验 ────────────────────────────────────────────────────
  // 早期版本这里零校验：坏 JSON 直接写库，求值器把它当空对象算成 0，
  // 结果报价少算 60% 且全程无任何提示。**宁可 400，绝不静默少算。**
  const check = validateCostItemPatch(body.patch, before);
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, error: check.error, field: check.field },
      { status: 400 }
    );
  }

  const updated = await prisma.costItem.update({
    where: { id: body.id },
    data: body.patch as never,
  });

  // 审计留痕：改动前后都记（用户决策：免审批但必须有日志）
  await prisma.costItemAudit.create({
    data: {
      costItemId: body.id,
      action: "update",
      before: JSON.stringify(before),
      after: JSON.stringify(updated),
      reason: body.reason ?? null,
    },
  });

  // 改动立即生效（清缓存），无需重启
  await reloadRecipes();

  return NextResponse.json({ ok: true, item: updated });
}

export async function POST(request: NextRequest) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return deny(auth.reason, auth.status);

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    /** 试算草稿：key = 成本项 id，value = 待套用的字段（不写库） */
    draft?: Record<string, Record<string, unknown>>;
    item?: Record<string, unknown>;
    id?: string;
    auditId?: string;
    reason?: string;
  };

  if (body.action === "reload") {
    const res = await reloadRecipes();
    return NextResponse.json({ ok: true, ...res });
  }

  if (body.action === "try-run") {
    // 可带草稿：把未保存的改动临时套用后试算（不写库、不留审计），
    // 让"改完先看影响再决定存不存"成为真的可行流程。
    const draft = (body.draft ?? {}) as Record<
      string,
      Partial<{ kind: string; params: string; conditions: string | null; enabled: boolean; weight: number }>
    >;
    // 草稿同样要全量校验——否则坏 JSON 会在试算里把成本项算成 0，
    // 给出"改了反而更便宜"的误导性结果，比不试算更危险。
    for (const [id, patch] of Object.entries(draft)) {
      const before = await prisma.costItem.findUnique({ where: { id } });
      if (!before) {
        return NextResponse.json(
          { ok: false, error: `草稿中的成本项 ${id} 不存在` },
          { status: 400 }
        );
      }
      const check = validateCostItemPatch(patch as Record<string, unknown>, before);
      if (!check.ok) {
        return NextResponse.json(
          { ok: false, error: `草稿校验未通过（${before.name}）：${check.error}` },
          { status: 400 }
        );
      }
    }

    const res = await withRecipeOverrides(draft, tryRun);
    if (res === null) {
      return NextResponse.json(
        { ok: false, error: "已有试算在运行，请稍后重试" },
        { status: 409 }
      );
    }
    return NextResponse.json({ ...res, withDraft: Object.keys(draft).length > 0 });
  }

  // ── 新增成本项 ──────────────────────────────────────────────────────
  // 只能改不能加的话，配方表就只是"硬编码的另一种写法"，加不了新收费项。
  // 新增一律以 status=draft 落库：**必须先试算确认影响，再手动启用**，
  // 避免手一抖就往每一份报价里塞进一笔钱。
  if (body.action === "create") {
    const it = (body.item ?? {}) as Record<string, unknown>;
    const productType = String(it.productType ?? "");
    const dimension = String(it.dimension ?? "");
    if (!PRODUCT_TYPES.includes(productType)) {
      return NextResponse.json(
        { ok: false, error: `未知品类「${productType}」` },
        { status: 400 }
      );
    }
    if (!DIMENSIONS.includes(dimension)) {
      return NextResponse.json(
        { ok: false, error: `未知维度「${dimension}」` },
        { status: 400 }
      );
    }
    const name = String(it.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: "成本项名不能为空" }, { status: 400 });
    }

    const draftItem = {
      name,
      kind: String(it.kind ?? "flat"),
      params: String(it.params ?? "{}"),
      conditions: it.conditions == null ? null : String(it.conditions),
    };
    const invalid = validateCostItem(draftItem);
    if (invalid) {
      return NextResponse.json(
        { ok: false, error: `校验未通过：${invalid}。已拒绝新增。` },
        { status: 400 }
      );
    }

    const created = await prisma.costItem.create({
      data: {
        productType,
        dimension,
        ...draftItem,
        weight: typeof it.weight === "number" ? it.weight : 1,
        sortOrder: typeof it.sortOrder === "number" ? it.sortOrder : 999,
        enabled: true,
        status: "draft", // 刻意不直接 active
        note: it.note == null ? null : String(it.note),
      },
    });
    await prisma.costItemAudit.create({
      data: {
        costItemId: created.id,
        action: "create",
        before: null,
        after: JSON.stringify(created),
        reason: body.reason ?? null,
      },
    });
    await reloadRecipes();
    return NextResponse.json({
      ok: true,
      item: created,
      hint: "已新增为「草稿」状态，引擎暂不采用。试算确认影响后，把状态改为 active 才生效。",
    });
  }

  // ── 归档（软删） ────────────────────────────────────────────────────
  // 不做物理删除：配方是审计对象，删了就没法回答"上个月那单为什么这么算"。
  if (body.action === "archive") {
    if (!body.id) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }
    const before = await prisma.costItem.findUnique({ where: { id: body.id } });
    if (!before) {
      return NextResponse.json({ ok: false, error: "成本项不存在" }, { status: 404 });
    }
    const updated = await prisma.costItem.update({
      where: { id: body.id },
      data: { status: "archived" },
    });
    await prisma.costItemAudit.create({
      data: {
        costItemId: body.id,
        action: "archive",
        before: JSON.stringify(before),
        after: JSON.stringify(updated),
        reason: body.reason ?? null,
      },
    });
    await reloadRecipes();
    return NextResponse.json({ ok: true, item: updated });
  }

  // ── 回滚到某次改动之前 ──────────────────────────────────────────────
  // 比"恢复出厂默认"更实用：审计里存了每次改动前的完整快照，
  // 直接按快照写回即可，且回滚本身也留一条审计。
  if (body.action === "rollback") {
    if (!body.auditId) {
      return NextResponse.json({ ok: false, error: "缺少 auditId" }, { status: 400 });
    }
    const entry = await prisma.costItemAudit.findUnique({
      where: { id: body.auditId },
    });
    if (!entry) {
      return NextResponse.json({ ok: false, error: "审计记录不存在" }, { status: 404 });
    }
    if (!entry.before) {
      return NextResponse.json(
        { ok: false, error: "这条是新增记录，没有「改动前」可回滚（如需撤销请归档）" },
        { status: 400 }
      );
    }

    let snap: Record<string, unknown>;
    try {
      snap = JSON.parse(entry.before);
    } catch {
      return NextResponse.json(
        { ok: false, error: "审计快照损坏，无法回滚" },
        { status: 500 }
      );
    }

    const current = await prisma.costItem.findUnique({
      where: { id: entry.costItemId },
    });
    if (!current) {
      return NextResponse.json({ ok: false, error: "成本项已不存在" }, { status: 404 });
    }

    const restore = {
      name: String(snap.name ?? current.name),
      kind: String(snap.kind ?? current.kind),
      params: String(snap.params ?? current.params),
      conditions: snap.conditions == null ? null : String(snap.conditions),
    };
    // 回滚同样要过校验：万一历史快照本身就是坏数据，不能借回滚绕过防线
    const invalid = validateCostItem(restore);
    if (invalid) {
      return NextResponse.json(
        { ok: false, error: `历史快照校验未通过：${invalid}，已拒绝回滚。` },
        { status: 400 }
      );
    }

    const updated = await prisma.costItem.update({
      where: { id: entry.costItemId },
      data: {
        ...restore,
        weight: typeof snap.weight === "number" ? snap.weight : current.weight,
        sortOrder:
          typeof snap.sortOrder === "number" ? snap.sortOrder : current.sortOrder,
        enabled: typeof snap.enabled === "boolean" ? snap.enabled : current.enabled,
        status: typeof snap.status === "string" ? snap.status : current.status,
      },
    });
    await prisma.costItemAudit.create({
      data: {
        costItemId: entry.costItemId,
        action: "rollback",
        before: JSON.stringify(current),
        after: JSON.stringify(updated),
        reason: body.reason ?? `回滚到审计 ${entry.id}（${entry.createdAt.toISOString()}）之前`,
      },
    });
    await reloadRecipes();
    return NextResponse.json({ ok: true, item: updated });
  }

  return NextResponse.json({ ok: false, error: "未知 action" }, { status: 400 });
}

/**
 * 试算：用当前配方跑 scripts/golden-cases.json 的全部用例，
 * 与 scripts/golden-baseline.json 比对，回报每个用例的通过情况与各维度偏差。
 * 让用户**在保存前**就看到改动的影响，而不是等提交后才发现。
 */
async function tryRun() {
  const cwd = process.cwd();
  const cases = JSON.parse(
    readFileSync(path.join(cwd, "scripts/golden-cases.json"), "utf8")
  ).cases as Array<{
    id: string;
    name: string;
    productType: string;
    input: Record<string, unknown>;
  }>;
  const baseline = JSON.parse(
    readFileSync(path.join(cwd, "scripts/golden-baseline.json"), "utf8")
  ) as Record<string, {
    dimensions: Record<string, number>;
    totalMin: number;
    perUnitMin: number;
    overallConfidence: number;
  }>;

  const results: Array<{
    id: string;
    name: string;
    passed: boolean;
    totalMin: number;
    baselineMin: number;
    driftPct: number;
    dims: Array<{ dim: string; actual: number; expected: number; driftPct: number }>;
  }> = [];

  for (const c of cases) {
    const config = getProductConfig(c.productType);
    if (!config) continue;

    const report = await runOrchestrator({
      sessionId: `tryrun-${c.id}`,
      config,
      input: c.input as never,
      skippedKeys: [],
      aiSettings: AI_OFF,
    });

    const want = baseline[c.id];
    const dims: Array<{
      dim: string;
      actual: number;
      expected: number;
      driftPct: number;
    }> = [];

    for (const d of report.dimensions) {
      const expected = want?.dimensions?.[d.dimension] ?? 0;
      const actual = Math.round(d.estimatedAmount * 100) / 100;
      const driftPct =
        expected === 0 ? 0 : Math.round(((actual - expected) / expected) * 10000) / 100;
      dims.push({ dim: d.dimension, actual, expected, driftPct });
    }

    const totalMin = Math.round(report.totalCost.min * 100) / 100;
    const baselineMin = want?.totalMin ?? 0;
    const driftPct =
      baselineMin === 0
        ? 0
        : Math.round(((totalMin - baselineMin) / baselineMin) * 10000) / 100;

    results.push({
      id: c.id,
      name: c.name,
      passed: dims.every((d) => Math.abs(d.driftPct) <= 0.5),
      totalMin,
      baselineMin,
      driftPct,
      dims,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    ok: true,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
    results,
  };
}
