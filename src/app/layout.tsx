import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "成本分析 | 专业B2B产品成本估算工具",
  description:
    "透明、专业的成本分析工具，当前支持彩印纸盒。快速获取多维度成本拆解与优化建议。",
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
