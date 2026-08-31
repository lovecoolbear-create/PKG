/**
 * 校准案例存储（仓库根 calibration-cases.json）
 *
 * 仅适用于本地/内网部署（dev / 自托管）——公网部署需换成数据库，此处刻意不抽象过度。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const root = process.cwd();
export const USER_PATH = resolve(root, "calibration-cases.json");
export const EXAMPLE_PATH = resolve(root, "calibration-cases.example.json");

/**
 * 读取案例。
 * @param allowExample 用户文件不存在时是否回退示范文件（写操作必须传 false，否则会把示范数据固化进用户文件）
 */
export function readCases(allowExample = true): Record<string, any>[] {
  if (existsSync(USER_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(USER_PATH, "utf8"));
      if (Array.isArray(raw)) return raw;
    } catch {
      /* 损坏则降级 */
    }
  }
  if (allowExample && existsSync(EXAMPLE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
      if (Array.isArray(raw)) return raw;
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function caseSource(): string {
  return existsSync(USER_PATH)
    ? "calibration-cases.json"
    : "calibration-cases.example.json（尚未创建 calibration-cases.json）";
}

export function writeCases(cases: unknown[]): void {
  writeFileSync(USER_PATH, JSON.stringify(cases, null, 2), "utf8");
}

/** 按 caseId 覆盖或追加，返回写入后的总数 */
export function upsertCases(incoming: Record<string, any>[]): number {
  const cases = readCases(false);
  for (const item of incoming) {
    const idx = cases.findIndex((c) => c && c.caseId === item.caseId);
    if (idx >= 0) cases[idx] = item;
    else cases.push(item);
  }
  writeCases(cases);
  return cases.length;
}

export function deleteCase(caseId: string): { removed: boolean; count: number } {
  const cases = readCases(false);
  const next = cases.filter((c) => c && c.caseId !== caseId);
  const removed = next.length !== cases.length;
  if (removed) writeCases(next);
  return { removed, count: next.length };
}
