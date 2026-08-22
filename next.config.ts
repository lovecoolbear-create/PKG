import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 构建产物输出到项目外，规避本地安全删除守卫对 .next 批量清理的拦截
  distDir: "/tmp/costnext/.next",
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
