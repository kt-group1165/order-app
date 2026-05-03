import type { NextConfig } from "next";

// Phase 2-X monorepo 化（B-2 段階）。@kt/shared は TypeScript ソースを
// 直接 import しているため Next の transpile 対象に含める。
// node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.md
const nextConfig: NextConfig = {
  transpilePackages: ["@kt/shared"],
};

export default nextConfig;
