/**
 * 1000 行ずつ読む (.range) のに、行を一意に並べていない箇所を数える (DB 不使用)
 *
 *   npm run check:paging-order
 *
 * PostgREST は並び順が一意でないと毎回の並びが保証されず、ページの境目で行が抜けたり重なったりする
 * (memory feedback_postgrest_paging_needs_order)。次の 2 つを拾う:
 *   [order 無し]          .order() が無い              … 2026-10-19 に 6 箇所是正 (fd12892)
 *   [id で並べていない]   .order() はあるが id を含まない … 2026-10-21 に追加。
 *       利用者別の認定 19,010 行を order("effective_date") だけで読んでいて、
 *       ページの境目で 1,198 行が抜け・別の 1,198 行が重複していた (件数は合うので気づけない)。
 *   id 以外の一意な列で並べている箇所は、その文に `// paging-order: unique` と書けば対象外にできる。
 * 0 を保つ検査。check:all には入れず手で回す診断にしている。
 * 負のコントロール: 3 つの見本を毎回判定してから本番のファイルを見る。
 */
import fs from "node:fs";
import path from "node:path";

function scan(text: string): { line: number; code: string }[] {
  const L = text.split(/\r?\n/);
  const out: { line: number; code: string }[] = [];
  for (let i = 0; i < L.length; i++) {
    if (!/\.range\(/.test(L[i])) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(L[i])) continue; // コメント行
    // 同じ文の .from( まで遡り、その間と直後 2 行を 1 つの文として見る
    let j = i;
    while (j > 0 && !/\.from\(/.test(L[j]) && i - j < 15) j--;
    const stmt = L.slice(j, i + 3).join(" ");
    if (/paging-order: unique/.test(stmt)) continue;
    if (!/\.order\(/.test(stmt)) out.push({ line: i + 1, code: "[order 無し] " + L[i].trim().slice(0, 100) });
    else if (!/\.order\(\s*["']id["']/.test(stmt)) out.push({ line: i + 1, code: "[id で並べていない] " + L[i].trim().slice(0, 90) });
  }
  return out;
}

const noOrder = `const { data } = await supabase\n  .from("x")\n  .select("*")\n  .range(from, from + 999);`;
const dateOnly = `const { data } = await supabase\n  .from("x")\n  .select("*")\n  .order("effective_date", { ascending: false })\n  .range(from, from + 999);`;
const good = `const { data } = await supabase\n  .from("x")\n  .select("*")\n  .order("effective_date", { ascending: false })\n  .order("id")\n  .range(from, from + 999);`;
if (scan(noOrder).length !== 1 || scan(dateOnly).length !== 1 || scan(good).length !== 0) {
  console.error("check:paging-order  負のコントロールが効いていません");
  process.exit(2);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(f)) out.push(p);
  }
  return out;
}

const files = ["app", "lib", "components"].flatMap((d) => walk(d));
const hits = files.flatMap((f) => scan(fs.readFileSync(f, "utf8")).map((h) => ({ file: f, ...h })));
console.log(`check:paging-order  対象 ${files.length} ファイル / 一意に並べていないページング ${hits.length} 件`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.code}`);
process.exit(hits.length > 0 ? 1 : 0);
