import { createServerClient } from "@supabase/ssr";

// service_role を使う admin クライアント。RLS をバイパスするため、
// 呼び出し側で必ず別の認証要素（パスワード認証 / unguessable token 等）を
// 検証してから使うこと。Phase 11c trust check (login 時 trusted_devices 操作)
// 用に新規追加。
//
// 型は order-app の lib/supabase/server.ts と同様に <any> 明示で
// pre-Phase 3-6 の supabase-js v2 デフォルト any 推論互換を維持する。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
export function createAdminClient(): ReturnType<typeof createServerClient<any>> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
  return createServerClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
    {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    }
  );
}
