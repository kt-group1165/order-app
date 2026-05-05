import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 補助スクリプト (lint 対象外):
    "import-rentals.mjs",
    "import-insurance.mjs",
    // 単独 Supabase 時代の旧 SQL migration 参考ファイル群 (リポジトリ root に
    // 散らかってるが lint には不要):
    "supabase_migration_*.sql",
    // contract_extracted/ などはバイナリ・xlsx 解凍の置き場、lint 対象外
    "contract_extracted/**",
  ]),
]);

export default eslintConfig;
