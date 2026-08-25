import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "包装降本分析工作台 | 专业B2B包装成本估算与VAVE工具",
  description:
    "透明、专业的包装成本估算与VAVE降本分析工具，覆盖纸/塑/木缓冲等多品类。上传图纸，快速获取多维度成本拆解与优化建议。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
