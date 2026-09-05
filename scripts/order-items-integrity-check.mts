/**
 * order_items の「壊れたデータ」を常設監視する (案C・H割当・READ ONLY)
 *
 *   npx tsx scripts/order-items-integrity-check.mts
 *   npx tsx scripts/order-items-integrity-check.mts -- --update   基準値更新
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 *   fukuyogu-coverage-sample-verify.mts (2026-09-05) で判明: 貸与期間が
 *   「開始日が翌月」型に壊れていると、国保連請求(0単位)と利用者請求書
 *   (calcMonthUnits・満額)で別の値が計算される (DECISIONS_PENDING B-6g)。
 *   案A(入力時に弾く)はUI変更が要りuser判断待ち。★ 先に「出たら気づける」
 *   案C(常設監視)をここで作る。
 *
 * ── 見ているもの (5種。すべて実データでは現在0件) ─────────────────────────
 *   ① rental_start_date > rental_end_date (貸与期間の逆転)
 *   ② status='rental_started'/'terminated' なのに rental_start_date が null
 *      (★ status='ordered'/'delivered'等は納品前でnullが正常なので対象外)
 *   ③ rental_start_date が1年以上先 (入力ミスの疑い)
 *   ④ rental_price が0またはnull (単位数が必ず0になり請求から欠落する)
 *   ⑤ quantity が0以下
 *
 * ── 基準値方式 (0を目指す検査) ────────────────────────────────────────────
 *   この5種は「本来ゼロであるべき」データなので、他の網羅率系チェックと違い
 *   ★ 0件を基準値にして増えたら即FAILにする。減る余地は無い(既に0)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes("--update");
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function pageAll<T>(table: string, select: string, orderCol = "id"): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

type Row = {
  id: string; status: string; rental_start_date: string | null; rental_end_date: string | null;
  rental_price: number | null; quantity: number | null;
};

export function checkIntegrity(rows: Row[], todayIso: string) {
  const oneYearOut = `${Number(todayIso.slice(0, 4)) + 1}${todayIso.slice(4)}`;
  const reversed = rows.filter((r) => r.rental_start_date && r.rental_end_date && r.rental_end_date < r.rental_start_date);
  const nullStartWhenStarted = rows.filter((r) => (r.status === "rental_started" || r.status === "terminated") && !r.rental_start_date);
  const farFutureStart = rows.filter((r) => r.rental_start_date && r.rental_start_date > oneYearOut);
  const zeroOrNullPrice = rows.filter((r) => r.rental_price == null || r.rental_price === 0);
  const zeroOrNegativeQty = rows.filter((r) => r.quantity == null || r.quantity <= 0);
  return { reversed, nullStartWhenStarted, farFutureStart, zeroOrNullPrice, zeroOrNegativeQty };
}

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
console.log(`══ order_items データ整合性 常設監視 (基準日 ${TODAY}・READ ONLY) ══\n`);

const allItems = await pageAll<Row>("order_items", "id,status,rental_start_date,rental_end_date,rental_price,quantity");
console.log(`【分母】order_items 全件: ${allItems.length} 行\n`);

const result = checkIntegrity(allItems, TODAY);
console.log("見ているもの (5種):");
console.log(`  ① 貸与期間の逆転 (start > end)                          : ${result.reversed.length} 件`);
console.log(`  ② rental_started/terminated なのに開始日が null          : ${result.nullStartWhenStarted.length} 件`);
console.log(`  ③ 開始日が1年以上先 (${TODAY}起算)                        : ${result.farFutureStart.length} 件`);
console.log(`  ④ rental_price が0またはnull                            : ${result.zeroOrNullPrice.length} 件`);
console.log(`  ⑤ quantity が0以下またはnull                             : ${result.zeroOrNegativeQty.length} 件`);

const counts = {
  reversed: result.reversed.length,
  nullStartWhenStarted: result.nullStartWhenStarted.length,
  farFutureStart: result.farFutureStart.length,
  zeroOrNullPrice: result.zeroOrNullPrice.length,
  zeroOrNegativeQty: result.zeroOrNegativeQty.length,
};

type Baseline = { _readme?: string[] } & typeof counts;
const baselinePath = join(__dirname, "order-items-integrity-baseline.json");
if (UPDATE) {
  const prevReadme = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline)._readme : undefined;
  const baseline: Baseline = {
    _readme: prevReadme ?? [
      "npm run check:order-items-integrity の基準値。",
      "",
      "■ なぜ0件が基準値か",
      "  この5種はいずれも「業務として起こり得ない」壊れたデータ (2026-09-05 実測で",
      "  全項目0件、②は元々1件あったが status='ordered'(納品前) の正常な null なので",
      "  対象から除外している)。B-6g (国保連請求と利用者請求書で別の値になる) の",
      "  温床になるため、増えたら即座に気づけるようにする。",
      "",
      "■ 他のfukuyogu-*系チェックとの違い",
      "  fukuyogu-coverage-check/fukuyogu-keido-exception-checkは「0を目指さない」",
      "  (現実のデータが自然にそうなっているものを測るだけ)。★ このチェックは逆に",
      "  0を維持するのが目的の検査。1件でも増えたらFAIL。",
      "",
      "■ 更新のしかた",
      "  npx tsx scripts/order-items-integrity-check.mts -- --update",
      "  ★ 0件以外の値で--updateする前に、本当に正常な状態か確認すること",
      "  (焼き付けると以後同じ件数までの悪化に気づけなくなる)。",
    ],
    ...counts,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\n★ 基準値を更新しました: ${baselinePath}`);
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  console.log(`\n══ 基準値比較 ══`);
  let fail = false;
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    const b = baseline[key] ?? 0;
    const a = counts[key];
    const mark = a > b ? "❌" : "✅";
    console.log(`  ${mark} ${key.padEnd(24)} 基準値 ${b} → 実測 ${a}`);
    if (a > b) fail = true;
  }
  if (fail) {
    console.log(`\n❌ FAIL — 壊れたデータが基準値より増えました。`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ PASS — 壊れたデータは増えていません。`);
  }
} else {
  console.log(`\n⚠ 基準値ファイルが無い。初回は -- --update で作成してください。`);
}
