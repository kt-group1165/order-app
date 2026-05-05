import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// 型は pre-Phase 3-6 の `@supabase/supabase-js` の createClient (no generic) と
// 同じ「any 駆動」挙動を維持するため <any> を明示 (client.ts と同様の理由)。
export async function createClient() {
  const cookieStore = await cookies();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
  return createServerClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component では set できないので skip
          }
        },
      },
    }
  );
}
