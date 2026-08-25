"use client";

import Link from "next/link";
import { BarChart3 } from "lucide-react";

interface ThreeColumnLayoutProps {
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
}

export function ThreeColumnLayout({ left, center, right }: ThreeColumnLayoutProps) {
  return (
    <div className="min-h-screen bg-brand-50">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-brand-200 bg-white">
        <div className="flex items-center justify-between px-4 py-3 lg:px-6">
          <Link href="/" className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-brand-800" />
            <span className="text-base font-semibold text-brand-900">
              包装降本分析工作台
            </span>
          </Link>
          <span className="hidden text-xs text-brand-400 sm:block">
            估算参考 · 非正式报价
          </span>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px]">
        {/* Left sidebar */}
        <aside className="hidden w-64 shrink-0 border-r border-brand-200 bg-white p-5 lg:block xl:w-72">
          {left}
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 p-4 lg:p-6">{center}</main>

        {/* Right sidebar */}
        <aside className="hidden w-72 shrink-0 border-l border-brand-200 bg-white p-5 xl:block">
          {right}
        </aside>
      </div>

      {/* Mobile bottom nav for completeness */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-brand-200 bg-white p-3 lg:hidden">
        <div className="flex items-center justify-between text-sm">
          <span className="text-brand-500">信息完整度</span>
          <span className="font-semibold text-brand-800">
            {/* filled by parent via data attribute */}
          </span>
        </div>
      </div>
    </div>
  );
}
