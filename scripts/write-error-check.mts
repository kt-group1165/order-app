/**
 * 書き込み (insert / update / upsert / delete) の失敗を握りつぶしている箇所を数える (DB 不使用)
 *
 *   npm run check:write-errors
 *
 * 次の 2 つの書き方を拾う。どちらも CHECK 制約違反・RLS 拒否が画面に出ない (CLAUDE.md §5)。
 *   ① 戻り値を捨てる          await supabase.from("x").update(...)...;
 *   ② data だけ受けて error を見ない  const { data } = await supabase.from("x").insert(...)...;
 *
 * 2026-10-19 に 11 箇所を是正して 0 件 (order-app 3e4fc17)。0 を保つ検査。
 * 金額・返戻には直接効かないので check:all には入れていない (手で回す診断)。
 * 負のコントロール: 下の SELF_TEST の 2 例を必ず拾えることを毎回確かめてから本番のファイルを見る。
 */
import fs from "node:fs";
import path from "node:path";

const CLIENT = String.raw`(supabase|sb|admin|client)`;
const BARE = new RegExp(String.raw`^\s*await\s+${CLIENT}\s*(\.|$)`);
const DATA_ONLY = new RegExp(String.raw`const\s*\{\s*data(\s*:\s*\w+)?\s*\}\s*=\s*await\s+${CLIENT}\b`);
const WRITE = /\.(insert|update|upsert|delete)\(/;

function scan(text: string): { line: number; kind: "①" | "②"; stmt: string }[] {
  const L = text.split(/\r?\n/);
  const out: { line: number; kind: "①" | "②"; stmt: string }[] = [];
  for (let i = 0; i < L.length; i++) {
    const bare = BARE.test(L[i]);
    const dataOnly = DATA_ONLY.test(L[i]);
    if (!bare && !dataOnly) continue;
    let stmt = L[i];
    for (let j = i + 1; !/;\s*$/.test(stmt) && j < i + 15; j++) stmt += " " + (L[j] ?? "").trim();
    if (WRITE.test(stmt)) out.push({ line: i + 1, kind: bare ? "①" : "②", stmt: stmt.trim().slice(0, 110) });
  }
  return out;
}

// 負のコントロール
const SELF_TEST = [
  `  await supabase\n    .from("x")\n    .update({ a: 1 })\n    .eq("id", id);`,
  `  const { data } = await sb.from("y").insert(row).select();`,
];
const missed = SELF_TEST.filter((t) => scan(t).length !== 1);
const okSample = scan(`  const { error } = await supabase.from("x").update({ a: 1 }).eq("id", id);`);
if (missed.length > 0 || okSample.length > 0) {
  console.error(`check:write-errors  負のコントロールが効いていません (拾えない ${missed.length} / 誤検出 ${okSample.length})`);
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
console.log(`check:write-errors  対象 ${files.length} ファイル / 握りつぶし ${hits.length} 件`);
for (const h of hits) console.log(`  ${h.kind} ${h.file}:${h.line}  ${h.stmt}`);
process.exit(hits.length > 0 ? 1 : 0);
