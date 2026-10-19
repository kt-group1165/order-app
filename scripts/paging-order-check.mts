/**
 * 1000 行ずつ読む (.range) のに並び順 (.order) を付けていない箇所を数える (DB 不使用)
 *
 *   npm run check:paging-order
 *
 * PostgREST は order 無しだと毎回の並びが保証されず、ページの境目で行が抜けたり重なったりする
 * (memory feedback_postgrest_paging_needs_order)。2026-10-19 に 6 箇所を是正して 0 件 (fd12892)。0 を保つ検査。
 * 金額に効く集計も通るが「件数が揺れる」形で出るので check:all には入れず手で回す診断にしている。
 * 負のコントロール: SELF_TEST を必ず拾える / order 付きを拾わないことを毎回確かめてから本番のファイルを見る。
 */
import fs from "node:fs";
import path from "node:path";

function scan(text: string): { line: number; code: string }[] {
  const L = text.split(/\r?\n/);
  const out: { line: number; code: string }[] = [];
  for (let i = 0; i < L.length; i++) {
    if (!/\.range\(/.test(L[i])) continue;
    // 同じ文の .from( まで遡り、その間と直後 2 行に .order( があるか見る
    let j = i;
    while (j > 0 && !/\.from\(/.test(L[j]) && i - j < 15) j--;
    const stmt = L.slice(j, i + 3).join(" ");
    if (!/\.order\(/.test(stmt)) out.push({ line: i + 1, code: L[i].trim().slice(0, 110) });
  }
  return out;
}

const bad = `const { data } = await supabase\n  .from("x")\n  .select("*")\n  .range(from, from + 999);`;
const good = `const { data } = await supabase\n  .from("x")\n  .select("*")\n  .order("id")\n  .range(from, from + 999);`;
if (scan(bad).length !== 1 || scan(good).length !== 0) {
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
console.log(`check:paging-order  対象 ${files.length} ファイル / order 無しのページング ${hits.length} 件`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.code}`);
process.exit(hits.length > 0 ? 1 : 0);
