/** 人工生产地域配置 - 可扩展 */

export interface LaborRegionConfig {
  code: string;
  label: string;
  /** 基础人工费率（元/小时） */
  baseRate: number;
  /** 糊盒额外工时（小时/千个） */
  gluingHoursPerThousand: number;
  /** 特殊工艺额外工时（小时/千个） */
  specialProcessHoursPerThousand: number;
  description: string;
}

export const LABOR_REGIONS: Record<string, LaborRegionConfig> = {
  east_china: {
    code: "east_china",
    label: "华东地区",
    baseRate: 28,
    gluingHoursPerThousand: 1.5,
    specialProcessHoursPerThousand: 0.8,
    description: "江浙沪皖等，制造业成熟，人工费率中等",
  },
  south_china_dg: {
    code: "south_china_dg",
    label: "华南地区（东莞一带）",
    baseRate: 24,
    gluingHoursPerThousand: 1.3,
    specialProcessHoursPerThousand: 0.7,
    description: "东莞、深圳、佛山等，印刷包装产业集中，人工费率相对较低",
  },
};

export const DEFAULT_LABOR_REGION = "east_china";

export function getLaborRegion(code?: string): LaborRegionConfig {
  return LABOR_REGIONS[code || DEFAULT_LABOR_REGION] ?? LABOR_REGIONS[DEFAULT_LABOR_REGION];
}

export function getLaborRegionOptions() {
  return Object.values(LABOR_REGIONS).map((r) => ({
    value: r.code,
    label: r.label,
  }));
}
