// VAVE 项目存储层（localStorage 版，一期 MVP）
// 落库(Prisma)归三期，本期零后端改动，仅浏览器本地存储，验证联动体验。
import type {
  AnalysisInput,
  AnalysisReport,
  CostProject,
  ProjectSummary,
} from "@/types";

const STORAGE_KEY = "vave_cost_projects";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 列出全部项目（按创建时间倒序） */
export function listProjects(): CostProject[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CostProject[];
    if (!Array.isArray(arr)) return [];
    return arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function getProject(id: string): CostProject | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

/** 保存为项目（名称缺省时按产品类型+日期生成），返回新项目 */
export function saveProject(
  name: string,
  input: AnalysisInput,
  report: AnalysisReport
): CostProject {
  const project: CostProject = {
    id: genId(),
    name:
      name.trim() ||
      `${report.productTypeName} · ${new Date().toLocaleDateString("zh-CN")}`,
    createdAt: new Date().toISOString(),
    input,
    report,
  };
  const all = listProjects();
  all.unshift(project);
  if (isBrowser()) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return project;
}

export function deleteProject(id: string): void {
  if (!isBrowser()) return;
  const all = listProjects().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * 由 report 现场派生项目摘要（不落库，避免与 AnalysisReport 字段漂移）。
 * summary 字段路径严格对齐 AnalysisReport 真实结构：
 * - totalCostPerUnit ← report.totalCost.perUnit.max
 * - dimensionRatios ← report.dimensions[].ratio（键为维度 code）
 * - costDrivers ← report.costDrivers（顶层）
 * - optimizationHints ← report.optimizationHints（顶层）
 * - areaMetrics ← 材料维(dimension==="material")?.areaMetrics
 */
export function deriveProjectSummary(project: CostProject): ProjectSummary {
  const r = project.report;
  const dimensionRatios: Record<string, number> = {};
  for (const d of r.dimensions) dimensionRatios[d.dimension] = d.ratio;
  const material = r.dimensions.find((d) => d.dimension === "material");
  return {
    totalCostPerUnit: r.totalCost.perUnit.max,
    totalCostMin: r.totalCost.min,
    totalCostMax: r.totalCost.max,
    dimensionRatios,
    costDrivers: r.costDrivers ?? [],
    optimizationHints: r.optimizationHints ?? [],
    areaMetrics: material?.areaMetrics ?? undefined,
  };
}
