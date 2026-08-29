import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-to-img（pdfjs-dist + @napi-rs/canvas）在 Next 服务端打包后运行会报
  // "Object.defineProperty called on non-object"，改为原生 require 外部包，
  // 与 standalone node 中的行为一致（已验证可正常渲染 PDF → PNG）。
  serverExternalPackages: ["pdf-to-img", "pdfjs-dist", "@napi-rs/canvas"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  devIndicators: false,
};

export default nextConfig;
