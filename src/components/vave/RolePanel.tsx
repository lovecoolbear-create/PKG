"use client";

import { useState } from "react";
import {
  buildRolePolicy,
  DEPT_LABELS,
  LEVEL_LABELS,
  type RoleDept,
  type RoleLevel,
} from "@/lib/vave/role-policy";
import { buildInvariants } from "@/lib/vave/multi-view";
import type { AnalysisReport } from "@/types";

const DEPTS: RoleDept[] = [
  "procurement",
  "rd",
  "quality",
  "production",
  "finance",
  "sales",
  "exec",
  "customer",
];
const LEVELS: RoleLevel[] = ["exec", "manager", "director"];

const FRAMING_LABEL: Record<string, string> = {
  amount: "金额 / 总降本",
  ratio: "占比 / 结构",
  design: "设计 / 参数",
  relationship: "关系 / 协同",
};

const GRANULARITY_LABEL: Record<string, string> = {
  coarse: "粗（仅强调维度 + 其他项汇总，折叠明细）",
  standard: "标准（全部维度概要）",
  fine: "细（全部维度 + 子项明细）",
};

export function RolePanel({ report }: { report: AnalysisReport }) {
  const [dept, setDept] = useState<RoleDept>("procurement");
  const [level, setLevel] = useState<RoleLevel>("manager");
  const policy = buildRolePolicy(dept, level);

  const emphasisDims = report.dimensions
    .filter((d) => policy.emphasisDimensions.includes(d.dimension))
    .sort((a, b) => b.ratio - a.ratio);

  const invariants = buildInvariants(report);

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          角色决策策略（纯展示控制层）
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-brand-500">部门 / 岗位</p>
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value as RoleDept)}
              className="mt-1 w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            >
              {DEPTS.map((d) => (
                <option key={d} value={d}>
                  {DEPT_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-brand-500">职级</p>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as RoleLevel)}
              className="mt-1 w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-brand-900 p-3 text-white">
          <p className="text-sm font-semibold">{policy.label}</p>
          <p className="mt-1 text-xs text-brand-300">
            表述锚定：{FRAMING_LABEL[policy.framing]}
          </p>
        </div>
      </div>

      {/* 重点关注（强调维度置顶） */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          重点关注（已置顶强调）
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {emphasisDims.map((d) => (
            <div
              key={d.dimension}
              className="rounded-lg border border-brand-200 bg-brand-50/50 p-3"
            >
              <p className="text-sm text-brand-700">{d.dimensionLabel}</p>
              <p className="text-lg font-bold text-brand-900">
                ¥{d.estimatedAmount.toLocaleString()}
              </p>
              <p className="text-xs text-brand-500">占比 {d.ratio}%</p>
            </div>
          ))}
          {emphasisDims.length === 0 && (
            <p className="text-sm text-brand-400">该角色无强调维度。</p>
          )}
        </div>
      </div>

      {/* 信息呈现粒度（规格1：唯一允许的可见性控制） */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">信息呈现粒度</h3>
        <p className="mt-2 text-sm text-brand-700">{GRANULARITY_LABEL[policy.granularity]}</p>
        <p className="mt-2 text-xs text-brand-400">
          说明：粒度仅控制明细折叠程度，<span className="font-semibold text-brand-600">绝不删除或隐藏任何成本维度与金额</span>；
          核心成本基线与物理风险指标对所有角色一致、不可掩盖。
        </p>
      </div>

      {/* 不可侵犯硬指标（规格1：永远渲染） */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          不可侵犯硬指标（所有角色一致渲染）
        </h3>
        {invariants.length === 0 ? (
          <p className="mt-2 text-sm text-brand-400">
            当前无物理风险 / error 级校验，核心成本基线照常完整呈现。
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {invariants.map((inv, i) => (
              <li
                key={i}
                className={`rounded-md px-3 py-2 ${
                  inv.severity === "error"
                    ? "bg-red-50 text-red-800"
                    : "bg-slate-50 text-brand-700"
                }`}
              >
                <span className="font-semibold">{inv.label}：</span>
                {inv.value}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-brand-400">
          物理风险（ECT/BCT）与 error 级校验属不可侵犯清单，任何角色视角均不得隐藏或淡化。
        </p>
      </div>
    </div>
  );
}
