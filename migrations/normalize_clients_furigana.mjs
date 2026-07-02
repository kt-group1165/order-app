/**
 * clients.furigana の 半角カナ → 全角カナ 一括正規化
 *   - 対象: clients (tenant_id='kt-group') で furigana に半角カナ [ｦ-ﾟ] を含む行
 *   - 変換: 半角カナ→全角カナ (ﾞﾟ 合成含む: ｶﾞ→ガ, ﾊﾟ→パ) + NFC 正規化
 *   - 触らない: 英数記号 / 全角スペース / 既存の全角ひらがな・カタカナ
 *     (NFKC は英数記号も変えてしまうので使わない。カナのみ自前マップで変換)
 *   - equipment_master.furigana は対象外 (音声マッチング用の別仕様)
 *
 * --execute 時:
 *   1. 変更前の (id, furigana) を migrations/_backup_clients_furigana_20260702.json に書き出し
 *   2. id ごとに UPDATE (error は必ず check、失敗で即 exit 1)
 *   3. 検証: 半角カナ残存件数を数える (期待: 0)
 *
 * Usage:
 *   node migrations/normalize_clients_furigana.mjs            # DRY RUN
 *   node migrations/normalize_clients_furigana.mjs --execute  # 本番
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません");
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TENANT_ID = "kt-group";
const BACKUP_PATH = join(__dirname, "_backup_clients_furigana_20260702.json");
const EXECUTE = process.argv.includes("--execute");

// ---- 半角カナ → 全角カナ 変換 (自前マップ。NFKC は使わない) ----

// 濁点合成 (ｶﾞ→ガ 等)
const DAKUTEN_MAP = {
  "ｶ": "ガ", "ｷ": "ギ", "ｸ": "グ", "ｹ": "ゲ", "ｺ": "ゴ",
  "ｻ": "ザ", "ｼ": "ジ", "ｽ": "ズ", "ｾ": "ゼ", "ｿ": "ゾ",
  "ﾀ": "ダ", "ﾁ": "ヂ", "ﾂ": "ヅ", "ﾃ": "デ", "ﾄ": "ド",
  "ﾊ": "バ", "ﾋ": "ビ", "ﾌ": "ブ", "ﾍ": "ベ", "ﾎ": "ボ",
  "ｳ": "ヴ", "ﾜ": "ヷ", "ｦ": "ヺ",
};
// 半濁点合成 (ﾊﾟ→パ 等)
const HANDAKUTEN_MAP = {
  "ﾊ": "パ", "ﾋ": "ピ", "ﾌ": "プ", "ﾍ": "ペ", "ﾎ": "ポ",
};
// 単独カナ
const KANA_MAP = {
  "ｦ": "ヲ", "ｧ": "ァ", "ｨ": "ィ", "ｩ": "ゥ", "ｪ": "ェ", "ｫ": "ォ",
  "ｬ": "ャ", "ｭ": "ュ", "ｮ": "ョ", "ｯ": "ッ", "ｰ": "ー",
  "ｱ": "ア", "ｲ": "イ", "ｳ": "ウ", "ｴ": "エ", "ｵ": "オ",
  "ｶ": "カ", "ｷ": "キ", "ｸ": "ク", "ｹ": "ケ", "ｺ": "コ",
  "ｻ": "サ", "ｼ": "シ", "ｽ": "ス", "ｾ": "セ", "ｿ": "ソ",
  "ﾀ": "タ", "ﾁ": "チ", "ﾂ": "ツ", "ﾃ": "テ", "ﾄ": "ト",
  "ﾅ": "ナ", "ﾆ": "ニ", "ﾇ": "ヌ", "ﾈ": "ネ", "ﾉ": "ノ",
  "ﾊ": "ハ", "ﾋ": "ヒ", "ﾌ": "フ", "ﾍ": "ヘ", "ﾎ": "ホ",
  "ﾏ": "マ", "ﾐ": "ミ", "ﾑ": "ム", "ﾒ": "メ", "ﾓ": "モ",
  "ﾔ": "ヤ", "ﾕ": "ユ", "ﾖ": "ヨ",
  "ﾗ": "ラ", "ﾘ": "リ", "ﾙ": "ル", "ﾚ": "レ", "ﾛ": "ロ",
  "ﾜ": "ワ", "ﾝ": "ン",
  "ﾞ": "゛", "ﾟ": "゜", // 合成できない孤立濁点は全角記号に
};

const HALF_KANA_RE = /[ｦ-ﾟ]/; // U+FF66 - U+FF9F

function normalizeFurigana(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (next === "ﾞ" && DAKUTEN_MAP[ch]) {
      out += DAKUTEN_MAP[ch];
      i++;
      continue;
    }
    if (next === "ﾟ" && HANDAKUTEN_MAP[ch]) {
      out += HANDAKUTEN_MAP[ch];
      i++;
      continue;
    }
    out += KANA_MAP[ch] ?? ch; // マップ外 (全角カナ / ひらがな / 英数 / 全角スペース等) はそのまま
  }
  return out.normalize("NFC");
}

async function fetchAll(table, columns, filterFn) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  console.log(`\n=== clients.furigana 半角カナ→全角カナ 正規化 (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);

  const clients = await fetchAll(
    "clients",
    "id, name, furigana",
    (q) => q.eq("tenant_id", TENANT_ID).not("furigana", "is", null).order("id"),
  );
  console.log(`clients(kt-group, furigana あり): ${clients.length} 件`);

  const targets = [];
  for (const c of clients) {
    if (!HALF_KANA_RE.test(c.furigana)) continue;
    const after = normalizeFurigana(c.furigana);
    if (after === c.furigana) continue; // 念のため (半角カナを含むのに不変は想定外)
    targets.push({ id: c.id, name: c.name, before: c.furigana, after });
  }
  console.log(`半角カナ [ｦ-ﾟ] を含む変更対象: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log("✅ 変更対象なし。終了します。");
    return;
  }

  console.log("\n変更例 (先頭10件):");
  for (const t of targets.slice(0, 10)) {
    console.log(`  ${t.name}: 「${t.before}」 → 「${t.after}」`);
  }

  // 変換後に半角カナが残るケースの検出 (マップ漏れ = 想定外)
  const residualInPlan = targets.filter((t) => HALF_KANA_RE.test(t.after));
  if (residualInPlan.length > 0) {
    console.error(`\n❌ 変換後も半角カナが残る行が ${residualInPlan.length} 件あります (マップ漏れ):`);
    for (const t of residualInPlan.slice(0, 10)) {
      console.error(`  ${t.name}: 「${t.before}」 → 「${t.after}」`);
    }
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log("\n(DRY RUN) --execute で本番実行 (backup JSON 書き出し → UPDATE → 残存検証)。");
    return;
  }

  // ---- 本番: backup → UPDATE → 検証 ----

  // 1. 変更前 snapshot を JSON に書き出し
  const backup = targets.map((t) => ({ id: t.id, furigana: t.before }));
  writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n📦 backup 書き出し: ${BACKUP_PATH} (${backup.length} 件)`);

  // 2. id ごとに UPDATE
  let done = 0;
  for (const t of targets) {
    const { error } = await sb
      .from("clients")
      .update({ furigana: t.after })
      .eq("id", t.id)
      .eq("tenant_id", TENANT_ID);
    if (error) {
      console.error(`❌ UPDATE 失敗 (id=${t.id}, ${t.name}):`, error.message);
      console.error(`   ここまで ${done} 件更新済。backup: ${BACKUP_PATH}`);
      process.exit(1);
    }
    done++;
    if (done % 100 === 0 || done === targets.length) {
      console.log(`  UPDATE ${done}/${targets.length}`);
    }
  }

  // 3. 検証: 半角カナ残存件数 (期待: 0)
  const after = await fetchAll(
    "clients",
    "id, furigana",
    (q) => q.eq("tenant_id", TENANT_ID).not("furigana", "is", null),
  );
  const residual = after.filter((c) => HALF_KANA_RE.test(c.furigana));
  console.log(`\n検証: 半角カナ [ｦ-ﾟ] を含む furigana 残存 = ${residual.length} 件 (期待: 0)`);
  if (residual.length > 0) {
    for (const c of residual.slice(0, 10)) {
      console.error(`  残存 id=${c.id}: 「${c.furigana}」`);
    }
    process.exit(1);
  }
  console.log(`✅ 完了。${done} 件を正規化しました。`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
