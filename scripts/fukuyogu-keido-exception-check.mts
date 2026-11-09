/**
 * 福祉用具貸与 — 軽度者(要支援1・2/要介護1)への原則対象外品目 の請求規模を測る
 * (READ ONLY・DB書換なし・断定しない・H割当・B-6d)
 *
 *   npx tsx scripts/fukuyogu-keido-exception-check.mts
 *   MONTH=2026-06 npx tsx scripts/fukuyogu-keido-exception-check.mts
 *   npx tsx scripts/fukuyogu-keido-exception-check.mts -- --update   基準値の更新
 *
 * ⚠⚠⚠ 告示の条件は未確認 (2026-09-05 時点) ⚠⚠⚠
 *   下記の対象6区分・除外ロジックは、G が一般的な福祉用具貸与の軽度者原則対象外
 *   ルールから整理したもので、★ 告示・通知の条文原文までは確認していない。
 *   user が確認したら、この注記と migrations/fukuyogu_exception_grants.sql /
 *   app/[tenant]/order-item-helpers.ts の同趣旨コメントを消すこと。
 *
 * ── 背景 ─────────────────────────────────────────────────────────────────
 *   fukuyogu-coverage-check.mts の調査で判明: order-app の請求計算 (BillingTab.tsx
 *   / kokuho-densou/build.ts) は client.care_level を 7131 の印字にしか使っておらず、
 *   ★ 「軽度者は原則対象外」の品目制限を一切判定していない (grep 0件)。
 *
 *   制度上、要支援1・2/要介護1 は以下 6 品目が原則給付対象外
 *   (例外給付は医師の意見書 or サービス担当者会議等での確認が要る):
 *     車いす・車椅子付属品 / 特殊寝台・特殊寝台付属品 / 床ずれ防止用具 /
 *     体位変換器 / 認知症老人徘徊感知機器(徘徊感知機器) / 移動用リフト
 *
 *   ⚠ 自動排泄処理装置は上記6区分と別ロジック (要介護4・5のみ対象、かつ
 *     「尿のみ吸引」型は要介護度不問という更なる例外がある)。区別する列が
 *     equipment_master に無いため、★ この検査は自動排泄処理装置の判定を保留する
 *     (対象に含めない)。詳細は order-item-helpers.ts の同趣旨コメント参照。
 *
 * ⚠ この検査は「対象外なのに請求している」と断定しない。例外給付が正当に
 *   認められているケースは実際に多い。出すのは「区別できていない件数と金額」。
 * ⚠ 直さない。測るだけ。実装は user 判断のあと。
 *
 * ── 要介護度は「その月の認定」から取る (2026-11-09 変更) ──────────────────
 *   以前は clients.care_level で判定していたが、clients.care_level は「今の」値であり
 *   検査月 (MONTH) の値ではない。2026-11-09 のほのぼの福祉用具反映で clients.care_level が
 *   9/30 時点の値に置き換わり、MONTH=2026-06 の判定が 誤検出 22 行・取りこぼし 5 行 ずれた。
 *   → MONTH に有効な認定 (client_insurance_records) のうち effective_date 最新の 1 件の
 *     care_level を使う (benefit-rate-check.mts の certOf と同じ選び方)。
 *   その月に有効な認定が無い利用者は「軽度者」に数えない (= 保険で請求できない人。
 *   そちらは check:benefit-rate の certExpired が見ている)。件数だけ参考に出す。
 *   ★ 負のコントロール: 実行のたびに メモリ上で認定の要介護度を 1 名ぶん書き換え、
 *     件数が動くことを確かめる (DB は触らない)。動かなければ exit 1。
 *
 * ── 基準値方式 (2026-09-05 導入) ────────────────────────────────────────
 *   fukuyogu_exception_grants (migrations/fukuyogu_exception_grants.sql) に
 *   記録があれば「区別できた」件数から除外する。user の入力が進むほど
 *   「未記録」件数は減っていく想定。★ 0 を目指す検査にはしない (H指示) —
 *   減っても増えなければ何も言わず、増えたら (=新しい未記録の請求が発生したら)
 *   落ちる形にする。テーブル未適用の間は基準値比較をスキップする。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const UPDATE = process.argv.includes("--update");

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTH = process.env.MONTH ?? "2026-06";
const [y, m] = MONTH.split("-").map(Number);
const monthStart = new Date(y, m - 1, 1);
const monthEnd = new Date(y, m, 0, 23, 59, 59);
const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

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

type OrderItemRow = {
  id: string; order_id: string; product_code: string; status: string;
  rental_start_date: string | null; rental_end_date: string | null;
  payment_type: string | null; quantity: number;
};
type OrderRow = { id: string; client_id: string; payment_type: string | null };
type EquipRow = { product_code: string; category: string | null; rental_price: number | null; selection_reason: string | null; proposal_reason: string | null };
type ClientRow = { id: string; name: string; care_level: string | null; benefit_rate: string | null };
type CertRow = {
  client_id: string; care_level: string | null; effective_date: string | null;
  certification_start_date: string | null; certification_end_date: string | null;
};

console.log(`══ 福祉用具貸与 — 軽度者 原則対象外品目の請求規模測定 (${MONTH}・READ ONLY) ══\n`);

const [orderItemsAll, ordersAll, equipAll, clientsAll, certsAll] = await Promise.all([
  pageAll<OrderItemRow>("order_items", "id, order_id, product_code, status, rental_start_date, rental_end_date, payment_type, quantity"),
  pageAll<OrderRow>("orders", "id, client_id, payment_type"),
  pageAll<EquipRow>("equipment_master", "product_code, category, rental_price, selection_reason, proposal_reason"),
  pageAll<ClientRow>("clients", "id, name, care_level, benefit_rate"),
  pageAll<CertRow>("client_insurance_records", "client_id, care_level, effective_date, certification_start_date, certification_end_date"),
]);

const orderById = new Map(ordersAll.map((o) => [o.id, o]));
const equipByCode = new Map(equipAll.map((e) => [e.product_code, e]));
const clientById = new Map(clientsAll.map((c) => [c.id, c]));

// ── 対象月に有効な認定のうち effective_date 最新の 1 件 (benefit-rate-check.mts の certOf と同じ) ──
const MS = `${MONTH}-01`;
const ME = `${MONTH}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
const certOf = new Map<string, CertRow>();
for (const r of certsAll) {
  const s = r.certification_start_date ?? r.effective_date;
  const e = r.certification_end_date;
  if (s != null && s > ME) continue;
  if (e != null && e < MS) continue;
  const cur = certOf.get(r.client_id);
  if (!cur || (r.effective_date ?? "") > (cur.effective_date ?? "")) certOf.set(r.client_id, r);
}
/** その月の要介護度 (NFKC)。有効な認定が無ければ null */
const levelOf = (cid: string): string | null => {
  const c = certOf.get(cid);
  return c ? (c.care_level ?? "").normalize("NFKC") : null;
};

// ── ①-2026-06 の請求対象 (fukuyogu-coverage-check.mts の activeRentals と同じ定義) ──
const activeRentals = orderItemsAll.filter((item) => {
  const pt = item.payment_type ?? orderById.get(item.order_id)?.payment_type ?? "介護";
  if (pt !== "介護") return false;
  if (!item.rental_start_date) return false;
  const start = parseLocalDate(item.rental_start_date);
  if (start > monthEnd) return false;
  if (item.status === "terminated" && item.rental_end_date) {
    const end = parseLocalDate(item.rental_end_date);
    if (end < monthStart) return false;
  }
  if (item.status !== "rental_started" && item.status !== "terminated") return false;
  return true;
});

// clientごとに集約 (①の分母 = 請求対象クライアント)
const clientIdsInMonth = new Set(activeRentals.map((it) => orderById.get(it.order_id)?.client_id).filter(Boolean) as string[]);
console.log(`【分母①】${MONTH} に福祉用具貸与を請求する候補クライアント: ${clientIdsInMonth.size} 名 (activeRentals ${activeRentals.length} 行)`);

const careLevelDist = new Map<string, number>();
for (const cid of clientIdsInMonth) {
  const cl = levelOf(cid) ?? "(当月有効な認定なし)";
  careLevelDist.set(cl || "(認定に要介護度なし)", (careLevelDist.get(cl || "(認定に要介護度なし)") ?? 0) + 1);
}
console.log(`要介護度の分布 (${MONTH} に有効な認定の care_level):`);
for (const [k, v] of [...careLevelDist.entries()].sort()) console.log(`  ${k.padEnd(8)} ${v} 名`);

const KEIDO_LEVELS = new Set(["要支援1", "要支援2", "要介護1"]);
const keidoClientIds = new Set([...clientIdsInMonth].filter((cid) => KEIDO_LEVELS.has(levelOf(cid) ?? "")));
{
  // 参考: clients.care_level (=今の値) で判定した場合との差。月を過去にすると差が出るのが正常
  const byClients = new Set([...clientIdsInMonth].filter((cid) => KEIDO_LEVELS.has((clientById.get(cid)?.care_level ?? "").normalize("NFKC"))));
  const onlyCert = [...keidoClientIds].filter((c) => !byClients.has(c)).length;
  const onlyClients = [...byClients].filter((c) => !keidoClientIds.has(c)).length;
  const noCertKeido = [...byClients].filter((c) => !certOf.has(c)).length;
  console.log(`(参考) clients.care_level (=今の値) で判定すると軽度者 ${byClients.size} 名。認定だけ軽度 ${onlyCert} 名 / clients だけ軽度 ${onlyClients} 名 (うち当月有効な認定なし ${noCertKeido} 名)`);
}
console.log(`\n【分母②】うち軽度者(要支援1・2/要介護1): ${keidoClientIds.size} 名`);

// ── ② 原則対象外6品目に該当する行を、軽度者クライアントに絞って集計 ──
const RESTRICTED_CATEGORIES = new Set([
  "車いす", "車椅子", "車いす付属品", "車椅子付属品",
  "特殊寝台", "特殊寝台付属品",
  "床ずれ防止用具",
  "体位変換器",
  "徘徊感知機器", "認知症老人徘徊感知機器",
  "移動用リフト",
]);

// カテゴリ → 例外給付の単位となる区分 (order-item-helpers.ts の RESTRICTION_GROUP_OF_CATEGORY と揃える)
const RESTRICTION_GROUP_OF_CATEGORY: Record<string, string> = {
  "車いす": "車いす系", "車椅子": "車いす系", "車いす付属品": "車いす系", "車椅子付属品": "車いす系",
  "特殊寝台": "特殊寝台系", "特殊寝台付属品": "特殊寝台系",
  "床ずれ防止用具": "床ずれ防止用具",
  "体位変換器": "体位変換器",
  "徘徊感知機器": "徘徊感知機器", "認知症老人徘徊感知機器": "徘徊感知機器",
  "移動用リフト": "移動用リフト",
};

type GrantRow = { client_id: string; restriction_group: string; valid_from: string; valid_end: string | null };
let grants: GrantRow[] = [];
let grantsTableAvailable = true;
try {
  grants = await pageAll<GrantRow>("fukuyogu_exception_grants", "client_id, restriction_group, valid_from, valid_end");
} catch (e) {
  const code = (e as { code?: string })?.code;
  if (code === "42P01" || code === "PGRST205") grantsTableAvailable = false;
  else throw e;
}
const onDate = `${MONTH}-01`;
const hasActiveGrant = (clientId: string, group: string) =>
  grants.some((g) => g.client_id === clientId && g.restriction_group === group && g.valid_from <= onDate && (g.valid_end == null || g.valid_end >= onDate));

type Hit = { clientId: string; clientName: string; careLevel: string; category: string; productCode: string; units: number; amountApprox: number; hasReasonText: boolean; covered: boolean };
function collectHits(lv: (cid: string) => string | null): Hit[] {
const hits: Hit[] = [];
for (const item of activeRentals) {
  const clientId = orderById.get(item.order_id)?.client_id;
  if (!clientId || !KEIDO_LEVELS.has(lv(clientId) ?? "")) continue;
  const eq = equipByCode.get(item.product_code);
  const cat = eq?.category ?? null;
  if (!cat || !RESTRICTED_CATEGORIES.has(cat)) continue;
  const client = clientById.get(clientId)!;
  // ⚠ 半月按分や公費・給付率までは再現せず、規模感を出すための概算 (rental_price × quantity)。
  //   fukuyogu-coverage-check.mts で判明の通り、実データは月途中開始/終了が無いため概算で十分。
  const amountApprox = (eq?.rental_price ?? 0) * item.quantity;
  const hasReasonText = !!((eq?.selection_reason ?? "").trim() || (eq?.proposal_reason ?? "").trim());
  const group = RESTRICTION_GROUP_OF_CATEGORY[cat];
  const covered = grantsTableAvailable && !!group && hasActiveGrant(clientId, group);
  hits.push({
    clientId,
    clientName: client.name,
    careLevel: lv(clientId) ?? "",
    category: cat,
    productCode: item.product_code,
    units: eq?.rental_price ? Math.round(eq.rental_price / 10) * item.quantity : 0,
    amountApprox,
    hasReasonText,
    covered,
  });
}
return hits;
}
const hits = collectHits(levelOf);
const uncovered = hits.filter((h) => !h.covered);

// ── ★ 負のコントロール (メモリ上だけ。DB は触らない) ──
//   (a) 記録なしの 1 名の認定を 要介護3 に書き換えたら その人の行ぶん減るか
//   (b) 軽度でない人で対象外品目を借りている 1 名を 要介護1 に書き換えたら増えるか
{
  const ucount = (lv: (cid: string) => string | null) => collectHits(lv).filter((h) => !h.covered).length;
  const results: string[] = [];
  let ok = true;
  const a = uncovered[0];
  if (a) {
    const expect = uncovered.length - uncovered.filter((h) => h.clientId === a.clientId).length;
    const got = ucount((cid) => (cid === a.clientId ? "要介護3" : levelOf(cid)));
    results.push(`(a) ${a.clientName} の認定を 要介護3 に → ${uncovered.length} → ${got} 件 (期待 ${expect})`);
    if (got !== expect) ok = false;
  }
  const allHeavy = collectHits(() => "要介護1").filter((h) => !h.covered && !KEIDO_LEVELS.has(levelOf(h.clientId) ?? ""));
  const b = allHeavy.find((h) => certOf.has(h.clientId));
  if (b) {
    const expect = uncovered.length + allHeavy.filter((h) => h.clientId === b.clientId).length;
    const got = ucount((cid) => (cid === b.clientId ? "要介護1" : levelOf(cid)));
    results.push(`(b) ${b.clientName} (認定 ${levelOf(b.clientId)}) を 要介護1 に → ${uncovered.length} → ${got} 件 (期待 ${expect})`);
    if (got !== expect) ok = false;
  }
  console.log(`
【負のコントロール (メモリ上で認定の要介護度を書き換え)】`);
  for (const r of results) console.log(`  ${r}`);
  if (!a || !b) { console.log(`  ⚠ 書き換える対象が見つからず 一部実施できなかった`); ok = false; }
  if (!ok) { console.log(`  ❌ 判定が認定の要介護度に反応していない`); process.exitCode = 1; }
  else console.log(`  ✅ 認定の要介護度を変えると件数が期待どおり動く`);
}

console.log(`\n【分母③】軽度者 × 原則対象外6品目 に該当する行: ${hits.length} 件`);
if (grantsTableAvailable) {
  console.log(`  うち fukuyogu_exception_grants に有効な記録あり(=区別できた): ${hits.length - uncovered.length} 件`);
  console.log(`  ★ 記録なし(=区別できていない): ${uncovered.length} 件`);
} else {
  console.log(`  ⚠ fukuyogu_exception_grants は未作成 (migrations/fukuyogu_exception_grants.sql 未適用)。`);
  console.log(`    全件を「記録なし」扱いとする。`);
}
const targetSet = grantsTableAvailable ? uncovered : hits;
const totalAmount = targetSet.reduce((s, h) => s + h.amountApprox, 0);
const totalUnits = targetSet.reduce((s, h) => s + h.units, 0);
const byCat = new Map<string, { count: number; amount: number }>();
for (const h of targetSet) {
  const e = byCat.get(h.category) ?? { count: 0, amount: 0 };
  e.count++; e.amount += h.amountApprox;
  byCat.set(h.category, e);
}
console.log(`\n品目別内訳 (${grantsTableAvailable ? "記録なしのみ" : "全件"}):`);
for (const [cat, v] of [...byCat.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
  console.log(`  ${cat.padEnd(14)} ${String(v.count).padStart(3)} 件   概算費用合計 ¥${v.amount.toLocaleString()}`);
}

// ── ③ 例外給付の記録の有無 (selection_reason/proposal_reason にテキストがあるか) ──
const withReason = hits.filter((h) => h.hasReasonText).length;
console.log(`\n【③ 例外給付の裏付け材料】selection_reason/proposal_reason に何らかの記載がある行: ${withReason}/${hits.length}`);
console.log(`  ⚠★ 検証したところ、この記載は client (利用者) にも order_item (レンタル) にも紐付いていない。`);
console.log(`    equipment_master (商品カタログ) 側の列で、同じ product_code なら誰が借りても同じ文言。`);
console.log(`    実測: equipment_master 全2,159件中2,088件(97%)に何らかの selection_reason が入っている`);
console.log(`    (例: "自力での起き上がりが困難なため、背上げ機能を活用し..." — 商品説明の定型文)。`);
console.log(`    → ${withReason}/${hits.length} が「あり」なのは、その利用者の医師意見書等の証跡ではなく、`);
console.log(`      商品カタログにほぼ常に何か書いてあることの反映に過ぎない。★ 証拠にならない。`);
console.log(`  → 利用者ごと・レンタルごとに例外給付の可否を記録する専用のフラグ・別テーブルは`);
console.log(`    grep でも schema (OpenAPI) 検索でも見つからなかった。`);
console.log(`    ★ 結論: 例外給付か原則対象外への誤請求かを、システム上のデータからは区別できない。`);

console.log(`\n══ ④ 金額規模 (概算・自己負担/給付率按分前の費用総額ベース・${grantsTableAvailable ? "記録なし分のみ" : "全件"}) ══`);
console.log(`軽度者${keidoClientIds.size}名のうち、原則対象外6品目を借りていて記録が無い行 ${targetSet.length} 件`);
console.log(`概算単位数合計: ${totalUnits.toLocaleString()} 単位 / 概算費用合計 (10割ベース): ¥${totalAmount.toLocaleString()}/月`);
console.log(`→ 保険給付分(概ね7-9割)としては 月 ¥${Math.round(totalAmount * 0.9).toLocaleString()}〜¥${Math.round(totalAmount * 0.7).toLocaleString()} の範囲`);
console.log(`\n★ 繰り返し: 「区別できていない」金額であり、「誤請求が確定した」金額ではない。`);
console.log(`  例外給付が正当なケースがどれだけ含まれるかは、記録が無い限りこのデータからは判定不能。`);

if (targetSet.length > 0) {
  console.log(`\n── 記録なしの明細 (先頭20件) ──`);
  for (const h of targetSet.slice(0, 20)) {
    console.log(`  ${h.clientName.padEnd(10)} ${h.careLevel.padEnd(6)} ${h.category.padEnd(10)} ${h.productCode}  ¥${h.amountApprox.toLocaleString()}`);
  }
  if (targetSet.length > 20) console.log(`  …他 ${targetSet.length - 20} 件`);
}

// ── 基準値方式 (0を目指さない。増えたら落ちる/減っても何も言わない) ──
type Baseline = { _readme?: string[]; month?: string; uncoveredCount: number; totalAmountApprox: number };
const baselinePath = join(__dirname, "fukuyogu-keido-exception-baseline.json");
if (!grantsTableAvailable) {
  console.log(`\n⚠ 基準値比較はスキップ (fukuyogu_exception_grants 未作成)。`);
} else if (UPDATE && process.exitCode === 1) {
  console.log(`\n❌ 負のコントロールが失敗しているので基準値は更新しない。`);
} else if (UPDATE) {
  const prevReadme = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline)._readme
    : undefined;
  const baseline: Baseline = {
    _readme: prevReadme ?? [
      "npm run check:keido-exception の基準値。詳細は初回作成時のcommitメッセージ・DECISIONS_PENDING B-6dを参照。",
      "0を目指さない: 増えたらFAIL、減っても何も言わない (user の入力が進むほど減る想定)。",
    ],
    month: MONTH,
    uncoveredCount: uncovered.length,
    totalAmountApprox: totalAmount,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\n★ 基準値を更新しました: ${baselinePath}`);
  console.log(`  ⚠ _readme は前の基準値のものを引き継いだ。件数が変わったなら「なぜこの数か」を書き直すこと。`);
} else if (existsSync(baselinePath) && ((JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline).month ?? "2026-06") !== MONTH) {
  const bm = (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline).month ?? "2026-06";
  console.log(`\n⚠ 基準値は ${bm} のもの。MONTH=${MONTH} とは比較しない (★ 合格ではない)。`);
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  console.log(`\n══ 基準値比較 ══`);
  console.log(`記録なし件数: 基準値 ${baseline.uncoveredCount} → 実測 ${uncovered.length}`);
  if (uncovered.length > baseline.uncoveredCount) {
    console.log(`❌ FAIL — 記録なし件数が基準値より増えました (+${uncovered.length - baseline.uncoveredCount})。`);
    console.log(`   新しく軽度者×原則対象外品目の請求が発生したのに記録が無い可能性があります。`);
    process.exitCode = 1;
  } else if (uncovered.length < baseline.uncoveredCount) {
    console.log(`✅ 記録なし件数が減りました (${baseline.uncoveredCount} → ${uncovered.length})。基準値の更新は任意 (-- --update)。`);
  } else {
    console.log(`✅ 変化なし。`);
  }
} else {
  console.log(`\n⚠ 基準値ファイルが無いので、初回として保存します: node --run ... -- --update`);
}
