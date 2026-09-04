/**
 * 上限価格超過の回帰チェック (npm run check:ceiling)
 *
 * ■ なぜ要るか
 *   2026-09-04 に equipment_master 全 2,159 件を `lib/ceilingCheck.ts` の
 *   judgeCeiling() で当日時点の上限と照合したところ、超過が **269 件**見つかった。
 *   内訳は性質が全く違う 2 種類:
 *
 *     ① 入力ミス濃厚 (2件)   EQ-000001/002。上限の 11.5倍・115.3倍。
 *        同じ TAIS の正規品が 9,500円 (上限内) で実在するのに、この2品目だけ
 *        桁違い。equipment_price_history を見ると同日・数十秒差で価格改定が
 *        2 件連続挿入されており、テスト/入力ミスの状況証拠が濃い。
 *     ② 上限改定への追従漏れ (267件)  超過 10〜40円・倍率 1.0〜1.1倍程度。
 *        上限価格は定期的に切り下げ改定される (「n回目公表」) ため、価格を
 *        見直していないと少しずつ超過品が増える構造的な問題。
 *
 *   実害 (実際に貸与中で介護保険を使っている件数) は ①=0件・②=1件(月150円)
 *   だった (2026-09-04 実測)。★ だが②は**放っておくと必ず増える**性質のもの
 *   なので、常設チェックにして「増えたら気づける」ようにする。
 *
 * ■ ★ この検査に固有の「回帰」の意味 (3通りある。既存の check:densou-diff とは違う)
 *   上限価格マスタは effective_from を持ち、judgeCeiling() は「今日時点で
 *   最も新しい世代」を選ぶ。つまり **DB の中身が 1 バイトも変わらなくても、
 *   カレンダーが新しい世代の施行日を跨いだだけで超過件数が増えうる**。
 *   これは「壊れた」のではなく、この検査がまさに検出したい現象そのもの。
 *
 *     指紋 一致 + 件数 悪化 → ★ 上限改定の影響 (想定内の型)。
 *                             それでも FAIL にする — 人が見て「価格を直すか」
 *                             「基準値を更新するか」を判断する材料にするため。
 *     指紋 不一致           → equipment_master か 上限価格マスタの中身が
 *                             実際に変わった (品目追加・価格変更・新しい
 *                             公表の取込 等)。中身を読んでから --update する。
 *     指紋 一致 + 件数 改善 → PASS。--update で基準値を下げてよい。
 *
 *   指紋は equipment_master (product_code, tais_code, rental_price) と
 *   equipment_price_ceilings (tais_code, effective_from, ceiling_price) の
 *   ★ 値のハッシュ (行数ではない)。UPDATE で値だけ変わるケースを見逃さない
 *   ため (2026-09-04 に他セッションが「行数だけの指紋は UPDATE を透明にする」
 *   と見つけた教訓をそのまま適用している)。
 *
 * ■ ①②を分けて数える理由
 *   混ぜて「269件」とだけ持つと、①(2件)を直しても 267 という大きい数に
 *   埋もれて動いた実感が出ない。分けて基準値に持つ。
 *   閾値は「上限の 2倍以上」を①、それ未満を②とする (2026-09-04 実測: ①は
 *   11.5倍・115.3倍、②の最大は 1.4倍で、2倍という閾値の前後に実例が無く
 *   きれいに割れる)。
 *
 * ■ ★ 「0件を目指す検査にしない」
 *   ②は制度上すぐには 0 にならない。**増えたら FAIL**という形にし、
 *   現状の件数を基準値として素直に持つ。0 を強制しない。
 *
 * ■ 使い方
 *   npm run check:ceiling
 *   npm run check:ceiling -- --update   基準値を実測で置き直す (中身を読んでから commit)
 *
 * DB は読むだけ (SELECT のみ)。書込は一切しない。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://dummy.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, "ceiling-baseline-expected.json");
const UPDATE = process.argv.includes("--update");

/** ①(入力ミス濃厚) と ②(上限改定への追従漏れ) を分ける閾値。2026-09-04 実測で根拠を _readme に残す。 */
const DATA_ENTRY_ERROR_RATIO = 2.0;

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { indexCeilings, judgeCeiling } = await import("../lib/ceilingCheck");

  const env: Record<string, string> = {};
  for (const p of [join(__dirname, "../../kaigo-app/.env.local"), join(__dirname, "../.env.local")]) {
    let txt = "";
    try { txt = readFileSync(p, "utf8"); } catch { continue; }
    for (const l of txt.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップします。");
    process.exit(0);
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  async function all<T>(table: string, select: string): Promise<T[]> {
    const out: T[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from(table).select(select).order("id").range(f, f + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if ((data ?? []).length < 1000) return out;
    }
  }

  type EM = { product_code: string; tais_code: string | null; name: string; rental_price: number | null };
  type Ceil = { tais_code: string; effective_from: string; ceiling_price: number };
  type Item = { product_code: string; status: string | null; payment_type: string | null };

  const em = await all<EM>("equipment_master", "product_code, tais_code, name, rental_price");
  const ceil = await all<Ceil>("equipment_price_ceilings", "tais_code, effective_from, ceiling_price");
  const items = await all<Item>("order_items", "product_code, status, payment_type");

  // ── 指紋 (値のハッシュ。行数ではない) ──
  const hash = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  const emFingerprint = hash(em.map((e) => [e.product_code, e.tais_code, e.rental_price]).sort());
  const ceilFingerprint = hash(ceil.map((c) => [c.tais_code, c.effective_from, c.ceiling_price]).sort());

  // ── 実際に貸与中 (介護・稼働中/終了) の product_code 集合 ──
  const rentedCodes = new Set(
    items.filter((i) => i.payment_type === "介護" && (i.status === "rental_started" || i.status === "terminated")).map((i) => i.product_code),
  );
  const rentedCountByCode = new Map<string, number>();
  for (const i of items) {
    if (i.payment_type === "介護" && (i.status === "rental_started" || i.status === "terminated")) {
      rentedCountByCode.set(i.product_code, (rentedCountByCode.get(i.product_code) ?? 0) + 1);
    }
  }

  // ── 今日時点で上限を超えている品目を判定 ──
  const idx = indexCeilings(ceil);
  // ⚠ toISOString() は UTC 変換なので JST 深夜 (0-8時台) に前日へずれる
  //   (memory: feedback_toisostring_jst_offset)。ローカル日付から組み立てる。
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dataEntryErrors: { code: string; name: string; price: number; ceiling: number; ratio: number }[] = [];
  const drift: { code: string; name: string; price: number; ceiling: number; ratio: number }[] = [];
  for (const e of em) {
    const j = judgeCeiling(e.tais_code, e.rental_price, todayIso, idx);
    if (j.kind !== "over") continue;
    const ratio = e.rental_price! / j.ceiling;
    const row = { code: e.product_code, name: e.name, price: e.rental_price!, ceiling: j.ceiling, ratio };
    if (ratio >= DATA_ENTRY_ERROR_RATIO) dataEntryErrors.push(row);
    else drift.push(row);
  }

  const summarize = (rows: typeof dataEntryErrors) => {
    const rentedRows = rows.filter((r) => rentedCodes.has(r.code));
    const rentedLines = rentedRows.reduce((s, r) => s + (rentedCountByCode.get(r.code) ?? 0), 0);
    const monthlyExcessYen = rentedRows.reduce((s, r) => s + (r.price - r.ceiling) * (rentedCountByCode.get(r.code) ?? 0), 0);
    return { total: rows.length, rentedItems: rentedRows.length, rentedLines, monthlyExcessYen };
  };
  const current = {
    dataEntryErrors: summarize(dataEntryErrors),
    ceilingDrift: summarize(drift),
  };

  console.log(`【分母】equipment_master ${em.length} 件 / 上限価格マスタ ${ceil.length} 行 / 判定基準日 ${todayIso}\n`);
  console.log(`① 入力ミス濃厚 (上限の${DATA_ENTRY_ERROR_RATIO}倍以上): ${current.dataEntryErrors.total} 件 (うち貸与中 ${current.dataEntryErrors.rentedItems} 品目 / ${current.dataEntryErrors.rentedLines} 口 / 月超過 ¥${current.dataEntryErrors.monthlyExcessYen.toLocaleString()})`);
  console.log(`② 上限改定への追従漏れ: ${current.ceilingDrift.total} 件 (うち貸与中 ${current.ceilingDrift.rentedItems} 品目 / ${current.ceilingDrift.rentedLines} 口 / 月超過 ¥${current.ceilingDrift.monthlyExcessYen.toLocaleString()})`);

  type Baseline = {
    _readme: string[];
    fingerprint: { equipmentMaster: string; ceilings: string };
    asOf: string;
    dataEntryErrors: { total: number; rentedItems: number; rentedLines: number; monthlyExcessYen: number };
    ceilingDrift: { total: number; rentedItems: number; rentedLines: number; monthlyExcessYen: number };
  };

  let baseline: Baseline | null = null;
  if (existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

  if (UPDATE || !baseline) {
    const out: Baseline = {
      _readme: [
        "npm run check:ceiling の基準値。",
        "",
        "■ ①(入力ミス濃厚) と ②(上限改定への追従漏れ) の違い",
        `  閾値: 上限の${DATA_ENTRY_ERROR_RATIO}倍以上を①、それ未満を②とする。`,
        "  2026-09-04 実測: ①は11.5倍・115.3倍の2件、②の最大は1.4倍で、",
        "  2倍という閾値の前後に実例が無くきれいに割れた。",
        "",
        "■ 指紋 (行数ではなく値のハッシュ)",
        "  equipment_master / equipment_price_ceilings の中身が変わっていないのに",
        "  件数が悪化したら、上限価格の新しい世代の施行日をカレンダーが跨いだ",
        "  ことが原因 (=この検査が検出したい現象そのもの)。それでもFAILにして",
        "  人に見せる。指紋が変わっていれば品目追加・価格変更等でデータが",
        "  変わっただけなので、中身を読んでから --update する。",
        "",
        "■ 0件を目指さない",
        "  ②は制度上すぐには0にならない。増えたらFAILにするだけで、",
        "  現状の件数をそのまま基準値にする。",
      ],
      fingerprint: { equipmentMaster: emFingerprint, ceilings: ceilFingerprint },
      asOf: todayIso,
      ...current,
    };
    writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`\n--update: 基準値を書きました (${BASELINE})`);
    return;
  }

  const fingerprintMatch = baseline.fingerprint.equipmentMaster === emFingerprint && baseline.fingerprint.ceilings === ceilFingerprint;
  console.log(`\n指紋: equipment_master ${fingerprintMatch ? "一致" : "★ 不一致"} / ceilings ${fingerprintMatch ? "一致" : "★ 不一致"}`);
  console.log(`基準値 (${baseline.asOf} 時点): ①${baseline.dataEntryErrors.total}件 / ②${baseline.ceilingDrift.total}件`);

  const worse =
    current.dataEntryErrors.total > baseline.dataEntryErrors.total ||
    current.dataEntryErrors.rentedLines > baseline.dataEntryErrors.rentedLines ||
    current.ceilingDrift.total > baseline.ceilingDrift.total ||
    current.ceilingDrift.rentedLines > baseline.ceilingDrift.rentedLines;

  if (!worse) {
    console.log("\n✓ PASS (基準値以下)");
    if (!fingerprintMatch) {
      console.log("  ⚠ 指紋は不一致だがFAIL対象の項目は悪化していない。--update で基準値を更新してよい。");
    }
    return;
  }

  if (fingerprintMatch) {
    console.log("\n★ FAIL — 指紋は一致しているのに件数が悪化した。");
    console.log("  equipment_master / equipment_price_ceilings の中身は変わっていないので、");
    console.log("  ★ 上限価格の新しい世代の施行日をカレンダーが跨いだ可能性が高い");
    console.log("  (=この検査が検出したい現象そのもの。「壊れた」わけではない)。");
    console.log("  価格を見直すか、事情を確認したうえで --update で基準値を上げるか判断すること。");
  } else {
    console.log("\n★ FAIL — データが変わり、かつ件数も悪化した。");
    console.log("  equipment_master か equipment_price_ceilings の中身を確認してから対応すること。");
  }
  process.exitCode = 1;
}

main();
