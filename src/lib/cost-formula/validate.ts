/**
 * 配方写库校验（P0 防线）
 * ----------------------------------------------------------------
 * 独立成纯函数，便于单测——校验逻辑必须能被测试锁住，不能只活在
 * API 路由里（否则只有起服务才能验证，等于没验证）。
 *
 * 背景：早期 `/api/admin/formula` 的 PUT 对 params/conditions/kind 零校验，
 * 坏 JSON 直接写库后被求值器当成空对象算出 0，报价少算 60% 且全程无提示。
 * 这里是那次事故的第一道防线：**宁可拒绝保存，绝不静默少算**。
 */

import { validateCostItem } from "./schema";

/** 允许通过管理接口修改的字段（id / productType / dimension 等结构性字段不可改） */
export const PATCHABLE_FIELDS = [
  "name",
  "kind",
  "params",
  "conditions",
  "weight",
  "sortOrder",
  "enabled",
  "note",
  "status",
] as const;

/** status 只能是这三种；写别的值会让配方既不生效也看不出原因 */
export const VALID_STATUS = ["draft", "active", "archived"] as const;

export type PatchCheck =
  | { ok: true }
  | { ok: false; error: string; field?: string };

export interface PatchableCostItem {
  name: string;
  kind: string;
  params: string;
  conditions: string | null;
}

/**
 * 校验一次配方修改。
 *
 * 关键点：用「合并后的最终形态」校验，而不是只校验 patch 里带的字段。
 * 否则当用户只改 name 时，库里已存在的坏 params 会被悄悄放过。
 */
export function validateCostItemPatch(
  patch: Record<string, unknown>,
  before: PatchableCostItem
): PatchCheck {
  const badField = Object.keys(patch).find(
    (k) => !(PATCHABLE_FIELDS as readonly string[]).includes(k)
  );
  if (badField) {
    return {
      ok: false,
      error: `不允许修改字段「${badField}」`,
      field: badField,
    };
  }

  if (
    patch.status !== undefined &&
    !(VALID_STATUS as readonly string[]).includes(String(patch.status))
  ) {
    return {
      ok: false,
      error: `状态只能是 ${VALID_STATUS.join(" / ")}`,
      field: "status",
    };
  }

  if (patch.weight !== undefined && !Number.isFinite(Number(patch.weight))) {
    return { ok: false, error: "权重必须是数字", field: "weight" };
  }

  const merged: PatchableCostItem = {
    name: patch.name !== undefined ? String(patch.name) : before.name,
    kind: patch.kind !== undefined ? String(patch.kind) : before.kind,
    params: patch.params !== undefined ? String(patch.params) : before.params,
    conditions:
      patch.conditions !== undefined
        ? patch.conditions == null
          ? null
          : String(patch.conditions)
        : before.conditions,
  };

  const invalid = validateCostItem(merged);
  if (invalid) {
    return {
      ok: false,
      error: `校验未通过：${invalid}。已拒绝保存，数据库未改动。`,
      field: "params",
    };
  }

  return { ok: true };
}
