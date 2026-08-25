"use client";

import { useState } from "react";
import {
  buildRolePolicy,
  DEPT_LABELS,
  LEVEL_LABELS,
  type RoleDept,
  type RoleLevel,
} from "@/lib/vave/role-policy";
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

export function RolePanel({ report }: { report: AnalysisReport }) {
  const [dept, setDept] = useState<RoleDept>("procurement");
  const [level, setLevel] = useState<RoleLevel>("manager");
  const policy = buildRolePolicy(dept, level);

  const emphasisDims = report.dimensions
    .filter((d) => policy.emphasisDimensions.includes(d.dimension))
    .sort((a, b) => b.ratio - a.ratio);
  const softened = policy.suppressRules.filter((r) => r.action === "soften");
  const hiddenDims = policy.suppressRules
    .filter((r) => r.action === "hide" && r.dimension)
    .map((r) => r.dimension as string);

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">
          角色决策策略（展示层裁剪）
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

      {/* 弱化 / 屏蔽处理 */}
      <div className="card p-5">
        <h3 className="text-base font-bold text-brand-900">弱化 / 屏蔽处理</h3>
        <ul className="mt-3 space-y-2 text-sm">
          {policy.suppressRules.length === 0 && (
            <li className="text-brand-400">该角色无屏蔽 / 改写规则。</li>
          )}
          {softened.map((r, i) => (
            <li
              key={i}
              className="rounded-md bg-amber-50 px-3 py-2 text-amber-800"
            >
              「{r.keyword ?? r.dimension}」改写为：{r.reframe}
            </li>
          ))}
          {hiddenDims.map((dim, i) => (
            <li
              key={i}
              className="rounded-md bg-slate-50 px-3 py-2 text-brand-500"
            >
              维度「{dim}」对该角色不展示（hide）
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-brand-400">
          说明：屏蔽 / 改写仅作用于展示层，客观成本数据不被修改；多 Agent
          协作时由全局合成 agent 统一执行该策略。
        </p>
      </div>
    </div>
  );
}
