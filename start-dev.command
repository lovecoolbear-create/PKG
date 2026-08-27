#!/bin/bash
# ============================================================
#  成本分析 · 一键启动开发服务器
#  双击本文件即可在终端启动 Next.js dev server
#  访问地址：http://localhost:3000
#
#  使用说明：
#   - 保持终端窗口打开  =  服务运行中，可看编译日志
#   - 关闭终端窗口      =  停止服务（Ctrl+C 亦可）
#   - 若端口被占用，先关闭其它 3000 端口进程再双击
# ============================================================

# 切到项目目录（含中文路径，务必用引号）
cd "/Users/blair/成本分析" || { echo "❌ 找不到项目目录 /Users/blair/成本分析"; exit 1; }

# 清理上一次构建产物，规避旧缓存导致的怪异报错（移走而非删除，留备份可追溯）
if [ -d .next ]; then
  mv -f .next ".next.bak-$(date +%s)" 2>/dev/null && echo "🧹 已移走旧 .next 构建"
fi

# 清理可能占用 3000/3001 端口的旧 dev server，避免双实例抢端口（旧实例会返回 404）
for p in 3000 3001 3002; do
  pid=$(lsof -ti :$p 2>/dev/null)
  if [ -n "$pid" ]; then
    kill -9 $pid 2>/dev/null && echo "🔌 已释放端口 $p (PID $pid)"
    sleep 1
  fi
done

# 使用托管 Node 22，避免系统 Node 版本不兼容
export PATH="/Users/blair/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH"

echo "▶ 启动开发服务器 (http://localhost:3000) ..."
echo "▶ 首次编译稍慢（按需编译页面），请稍候；Ctrl+C 或关闭窗口可停止。"
echo "------------------------------------------------------------"
npm run dev
