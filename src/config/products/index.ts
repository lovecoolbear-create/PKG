import type { ProductTypeConfig } from "@/types";
import { colorPrintBoxConfig } from "./color-print-box";

/**
 * 产品类型注册表
 * 扩展新产品：创建配置文件 → 在此注册 → 数据库 seed
 */
const productRegistry: Record<string, ProductTypeConfig> = {
  color_print_box: colorPrintBoxConfig,
};

export function getProductConfig(code: string): ProductTypeConfig | undefined {
  return productRegistry[code];
}

export function getAllProductTypes(): ProductTypeConfig[] {
  return Object.values(productRegistry);
}

export function getDefaultProductType(): ProductTypeConfig {
  return colorPrintBoxConfig;
}

export { productRegistry };
