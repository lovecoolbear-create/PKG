# 包装降本分析工作台

B2B 专业包装成本估算与VAVE降本 Web 应用，采用配置化架构，覆盖纸/塑/木缓冲等多品类，便于扩展到其他产品类型。

## 技术栈

- **框架**: Next.js 15 (App Router) + TypeScript
- **样式**: Tailwind CSS
- **数据库**: Prisma + SQLite
- **图表**: Recharts
- **PDF**: jsPDF + jspdf-autotable

## 快速开始

```bash
# 安装依赖
npm install

# 初始化数据库
npm run db:push

# 启动开发服务器
npm run dev
```

访问 http://localhost:3000

## 项目目录结构

```
src/
├── app/                          # Next.js App Router 页面
│   ├── page.tsx                  # 首页
│   ├── analyze/page.tsx          # 分析流程页（左中右三栏）
│   ├── share/[token]/page.tsx    # 分享报告页
│   └── api/                      # API 路由
│       ├── sessions/             # 分析会话 CRUD + 触发分析
│       ├── upload/               # 文件上传
│       └── share/                # 分享链接访问
├── components/
│   ├── layout/                   # 三栏布局组件
│   │   ├── ThreeColumnLayout.tsx
│   │   ├── StepNav.tsx           # 左侧步骤导航
│   │   └── SidebarPanel.tsx      # 右侧提示面板
│   └── analyze/                  # 分析步骤组件
│       ├── UploadStep.tsx
│       ├── InfoFormStep.tsx
│       └── ReportStep.tsx
├── config/
│   └── products/                 # 产品类型配置（核心扩展点）
│       ├── color-print-box.ts    # 彩印纸盒配置
│       └── index.ts                # 产品注册表
├── lib/
│   ├── agents/                   # 多 Agent 架构
│   │   ├── specialists.ts        # 6 个专业 Agent
│   │   └── orchestrator.ts       # 主控 Agent + 校验
│   ├── cost-rules/               # 规则公式（非 AI 自由发挥）
│   ├── completeness.ts           # 信息完整度计算
│   ├── pdf/export.ts             # PDF 导出
│   ├── db.ts                     # Prisma 客户端
│   └── seed.ts                   # 数据库种子
├── types/index.ts                # 全局类型定义
prisma/
└── schema.prisma                 # 数据模型
```

## 产品类型配置化设计

新增产品类型只需 3 步：

1. 在 `src/config/products/` 创建配置文件，定义：
   - `fields[]`: 动态表单字段（类型、必填、权重、选项）
   - `dimensions[]`: 成本维度（分组、占比区间、Agent 映射）
   - `steps[]`: 分析步骤

2. 在 `src/config/products/index.ts` 注册

3. 在 `src/lib/agents/specialists.ts` 添加对应 Agent 函数

4. 运行 seed 写入数据库

## 多 Agent 架构

```
Orchestrator (主控)
  ├── materialAgent      → 材料成本
  ├── processAgent       → 工艺加工成本
  ├── laborAgent         → 人工成本
  ├── equipmentAgent     → 设备与能耗成本
  ├── designAgent        → 设计与制版成本
  └── financeAgent       → 财务与其他成本
```

每个 Agent 输出统一结构：`AgentResult`（金额、占比、依据、假设、置信度、风险）

主控 Agent 校验：
- 占比区间检查
- 信息完整度 → 置信度惩罚
- 低置信度 Agent 警告
- 最多 2 次重试

## 知识库

- `AnalysisSession`: 每次分析的输入与结果
- `KnowledgeEntry`: 结构化知识条目（材料价格、工艺费率等）
- `CostRule`: 成本计算公式规则库
- `SharedReport`: 分享链接与访问统计

## 环境变量

```
DATABASE_URL="file:./dev.db"
NEXT_PUBLIC_BASE_URL="http://localhost:3000"
```
