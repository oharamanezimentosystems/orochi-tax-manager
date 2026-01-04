import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export', // ★この行を追加
  trailingSlash: true, // ★この行も追加（URLの末尾に/をつける設定）
  /* config options here */
};

export default nextConfig;