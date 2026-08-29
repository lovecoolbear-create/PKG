// ========== 待审词典池：服务端 JSON 存储（仅服务端 import） ==========
// 人工确认式学习闭环：导入时捕获未收录的类目描述词 → 进待审池 → SQE 确认 →
// 落为覆盖（override）→ 下次同类表自动识别。只学描述词/别名映射，绝不碰价格/费率。
// 存储用服务端 JSON 文件，零迁移；接口抽象干净，后续可无感换 prisma。

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getProductConfig } from "@/config/products";
import { getSemanticFieldKeys } from "./column-map";

export type DictScope = "header" | "material_text";

export interface DictCandidate {
  id: string;
  token: string;
  productType: string;
  scope: DictScope;
  suggestedField?: string;
  confidence?: number;
  createdAt: string;
}

export interface DictOverride {
  id: string;
  token: string;
  productType: string;
  scope: DictScope;
  /** header: 语义字段 key；material_text: AnalysisInput 字段 key */
  targetField: string;
  /** material_text 专用：该片段映射到的规范值（如 "matte_laminate"） */
  targetValue?: string;
  addedAt: string;
}

interface DictFile {
  pending: DictCandidate[];
  overrides: DictOverride[];
}

export interface ResolvedOverrides {
  header: Record<string, string>;
  material: { token: string; field: string; value?: string }[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "dictionary-overrides.json");

function readFile(): DictFile {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DictFile>;
    return { pending: parsed.pending ?? [], overrides: parsed.overrides ?? [] };
  } catch {
    return { pending: [], overrides: [] };
  }
}

function writeFile(data: DictFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 字段白名单闸门（防任意键注入）：targetField 必须 ∈
 * 该品类 config.fields 的 key 或全局语义字段 key 之一。
 */
export function isValidTargetField(productType: string, field: string): boolean {
  const cfg = getProductConfig(productType);
  const fieldKeys = cfg ? cfg.fields.map((f) => f.key) : [];
  const semantic = getSemanticFieldKeys();
  return fieldKeys.includes(field) || semantic.includes(field);
}

/** 把导入时捕获的候选合并进待审池（去重：token+productType+scope 已存在则跳过） */
export function addCandidates(
  cands: Omit<DictCandidate, "id" | "createdAt">[],
): DictCandidate[] {
  const data = readFile();
  const inPending = new Set(
    data.pending.map((c) => `${c.token}|${c.productType}|${c.scope}`),
  );
  const inOverride = new Set(
    data.overrides.map((o) => `${o.token}|${o.productType}|${o.scope}`),
  );
  const added: DictCandidate[] = [];
  for (const c of cands) {
    const key = `${c.token}|${c.productType}|${c.scope}`;
    if (inPending.has(key) || inOverride.has(key)) continue;
    const full: DictCandidate = {
      ...c,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    data.pending.push(full);
    inPending.add(key);
    added.push(full);
  }
  if (added.length) writeFile(data);
  return added;
}

export function listPending(): DictCandidate[] {
  return readFile().pending;
}

export function confirmCandidate(
  id: string,
  targetField: string,
  targetValue?: string,
): DictOverride {
  const data = readFile();
  const idx = data.pending.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error("候选不存在或已被处理");
  const cand = data.pending[idx];
  if (!isValidTargetField(cand.productType, targetField)) {
    throw new Error(
      `非法 targetField: "${targetField}" 不在品类 ${cand.productType} 的字段白名单`,
    );
  }
  const ov: DictOverride = {
    id: randomUUID(),
    token: cand.token,
    productType: cand.productType,
    scope: cand.scope,
    targetField,
    targetValue: cand.scope === "material_text" ? targetValue : undefined,
    addedAt: new Date().toISOString(),
  };
  data.overrides.push(ov);
  data.pending.splice(idx, 1);
  writeFile(data);
  return ov;
}

export function rejectCandidate(id: string): boolean {
  const data = readFile();
  const idx = data.pending.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  data.pending.splice(idx, 1);
  writeFile(data);
  return true;
}

/** 解析期加载已确认的覆盖，供 column-map 即时生效 */
export function loadOverrides(): ResolvedOverrides {
  const data = readFile();
  const header: Record<string, string> = {};
  const material: ResolvedOverrides["material"] = [];
  for (const o of data.overrides) {
    if (o.scope === "header") header[o.token] = o.targetField;
    else material.push({ token: o.token, field: o.targetField, value: o.targetValue });
  }
  return { header, material };
}
