import { createBrowserClient } from "@supabase/ssr";

// 型は pre-Phase 3-6 の `@supabase/supabase-js` の createClient (no generic) と
// 同じ「any 駆動」挙動を維持するため <any> を明示。order-app の lib/* は
// supabase-js v2 のデフォルト any 推論前提で書かれており (reduce/map で
// row の型を強くは見ていない)、Database 型を未定義のまま createBrowserClient
// すると row が `unknown` になり `select(...)` 結果の reduce が型エラー。
// 必要になったら types/database.ts を生成して <Database> に差替え。
let client: ReturnType<typeof createBrowserClient<any>> | null = null;

export function createClient() {
  if (!client) {
    client = createBrowserClient<any>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return client;
}
