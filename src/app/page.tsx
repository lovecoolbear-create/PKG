import Link from "next/link";
import {
  BarChart3,
  Shield,
  Zap,
  ArrowRight,
  FileText,
  Share2,
  Database,
  Layers,
  FileSpreadsheet,
} from "lucide-react";
import { ProjectListCard } from "@/components/vave/ProjectListCard";
import { getAllProductTypes } from "@/config/products";

export default function HomePage() {
  const productTypes = getAllProductTypes();
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-brand-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-7 w-7 text-brand-800" />
            <span className="text-lg font-semibold text-brand-900">
              成本分析
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/knowledge"
              className="btn-secondary inline-flex items-center gap-1.5"
            >
              <Database className="h-4 w-4" />
              知识库
            </Link>
            <Link
              href="/vave"
              className="btn-secondary inline-flex items-center gap-1.5"
            >
              <Layers className="h-4 w-4" />
              VAVE 降本
            </Link>
            <Link
              href="/batch"
              className="btn-secondary inline-flex items-center gap-1.5"
            >
              <FileSpreadsheet className="h-4 w-4" />
              批量分析
            </Link>
            <Link href="/analyze" className="btn-primary">
              开始分析
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-gradient-to-b from-brand-900 to-brand-800 text-white">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            包装降本分析工作台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">
            专业、透明的多维度成本估算工具。上传设计图纸，补充关键参数，
            快速获取成本拆解与优化建议。
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/analyze"
              className="inline-flex items-center gap-2 rounded-lg bg-accent-orange px-8 py-3 text-base font-medium text-white hover:bg-orange-600"
            >
              开始成本分析
              <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              href="/vave"
              className="inline-flex items-center gap-2 rounded-lg border border-white/40 px-8 py-3 text-base font-medium text-white hover:bg-white/10"
            >
              <Layers className="h-5 w-5" />
              VAVE 降本分析
            </Link>
          </div>
          <p className="mt-6 text-sm text-brand-300">
            本工具提供估算参考，不构成正式报价
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold text-brand-900">
          为什么选择我们的成本分析
        </h2>
        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          <div className="card p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-100">
              <Shield className="h-6 w-6 text-brand-700" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-brand-900">
              透明可解释
            </h3>
            <p className="mt-2 text-sm text-brand-600">
              每个成本维度都有明确的计算依据与假设说明，置信度评级让您了解估算可靠程度。
            </p>
          </div>
          <div className="card p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-100">
              <BarChart3 className="h-6 w-6 text-brand-700" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-brand-900">
              多维度拆解
            </h3>
            <p className="mt-2 text-sm text-brand-600">
              材料、工艺、人工、设备、制版、财务等六大维度精细拆解，制造成本与商业成本清晰分类。
            </p>
          </div>
          <div className="card p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-100">
              <Zap className="h-6 w-6 text-brand-700" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-brand-900">
              优化建议
            </h3>
            <p className="mt-2 text-sm text-brand-600">
              自动识别成本优化空间，提供可操作的 VAVE
              方向建议，助力供应链降本。
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-brand-200 bg-white py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-2xl font-bold text-brand-900">
            三步完成成本分析
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "上传资料",
                desc: "上传设计图纸（PDF/图片）和产品照片，系统自动识别基本特征",
              },
              {
                step: "02",
                title: "补充信息",
                desc: "填写订单数量、尺寸、材质、印刷方式等关键参数，实时查看信息完整度",
              },
              {
                step: "03",
                title: "获取报告",
                desc: "生成多维度成本报告，支持 PDF 导出与分享链接，方便团队讨论",
              },
            ].map((item) => (
              <div key={item.step} className="relative pl-16">
                <span className="absolute left-0 top-0 text-4xl font-bold text-brand-200">
                  {item.step}
                </span>
                <h3 className="text-lg font-semibold text-brand-900">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm text-brand-600">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="card flex items-start gap-4 p-6">
            <FileText className="mt-1 h-5 w-5 shrink-0 text-accent-orange" />
            <div>
              <h3 className="font-semibold text-brand-900">PDF 报告导出</h3>
              <p className="mt-1 text-sm text-brand-600">
                一键导出专业 PDF 成本分析报告，便于存档与内部审批
              </p>
            </div>
          </div>
          <div className="card flex items-start gap-4 p-6">
            <Share2 className="mt-1 h-5 w-5 shrink-0 text-accent-orange" />
            <div>
              <h3 className="font-semibold text-brand-900">分享报告链接</h3>
              <p className="mt-1 text-sm text-brand-600">
                生成带有效期的分享链接，方便客户团队内部转发讨论
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 产品类别选择（首页入口：先选品类再进入对应分析流程） */}
      <section className="border-t border-brand-200 bg-brand-50 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-2xl font-bold text-brand-900">
            选择产品类别
          </h2>
          <p className="mt-2 text-center text-sm text-brand-500">
            不同品类采用对应的成本结构与计算公式，进入后开始成本分析
          </p>
          <p className="mt-3 text-center text-sm text-brand-600">
            同一品类有多个产品要一起分析？前往{" "}
            <Link href="/batch" className="font-medium text-accent-orange hover:underline">
              批量分析
            </Link>
            （上传 Excel 一键出汇总表）
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {productTypes.map((p) => (
              <Link
                key={p.code}
                href={`/analyze?product=${p.code}`}
                className="card group p-6 transition hover:shadow-md"
              >
                <h3 className="text-lg font-semibold text-brand-900">
                  {p.name}
                </h3>
                <p className="mt-2 text-sm text-brand-600">{p.description}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent-orange">
                  开始分析
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 我的项目（localStorage 存储，可进入 VAVE） */}
      <ProjectListCard />

      {/* CTA */}
      <section className="border-t border-brand-200 bg-brand-900 py-16 text-white">
        <div className="mx-auto max-w-6xl px-6 text-center">
          <h2 className="text-2xl font-bold">准备好开始了吗？</h2>
          <p className="mt-2 text-brand-300">
            上传您的产品资料，获取第一份成本分析报告
          </p>
          <Link href="/analyze" className="btn-accent mt-6 inline-flex">
            开始分析
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-brand-200 bg-white py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-6 text-center text-sm text-brand-500">
          <Link href="/admin/knowledge" className="text-brand-600 hover:text-brand-800">
            知识库管理
          </Link>
          <p>© 2026 成本分析工具 · 估算结果仅供参考，不构成正式报价</p>
        </div>
      </footer>
    </div>
  );
}
