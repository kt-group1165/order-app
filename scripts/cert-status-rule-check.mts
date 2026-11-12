/**
 * 認定状況の規則 (lib/insurance/certStatus.ts) の境界値テスト + 逐語コピーの検知 (DB を読まない・純関数)
 *
 *   npm run check:cert-status
 *
 * 規則 (2026-11-13): ほのぼのの「認定状況=申請中」は 更新申請中の印で、その期間も ほのぼのは請求している。
 *   ① 新しく入れる行: 申請中 でも 要介護度 (要支援・要介護) があれば 認定済み (certStatusFromHonobono)
 *   ② 既存の行: 認定済み → 申請中 には下げない (mayOverwriteCertStatus)
 *   これを破ると BillingTab の月遅れ自動判定 (認定の状態 = 申請中) で 当方だけ請求を止める。
 *
 * 見るもの:
 *   A. ① ② の入力表 (境界値: 全角・空白・要介護度なし・「申請中」「非該当」が要介護度欄に入っている 等)
 *   B. 負のコントロール: 規則をわざと逆にした関数で同じ表を回し、必ず食い違いが出ること (出なければ この検査は効いていない)
 *   C. 逐語コピーの検知: migrations の 3 本 (sync_fukuyogu_from_honobono / fix_honobono_sync_7_cases_202609 /
 *      build_caresapo_rows_from_master) が lib/insurance/certStatus.ts を import して使い、
 *      規則を自前で書いた形 (`=== "認定済み" && v === "申請中"` 等) が残っていないこと
 */
import { readFileSync } from "node:fs";
import { certStatusFromHonobono, mayOverwriteCertStatus } from "../lib/insurance/certStatus";

let n = 0, ng = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  n++;
  const ok = got === want;
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label}${ok ? "" : `   実際=${JSON.stringify(got)} 期待=${JSON.stringify(want)}`}`);
};

type FromCase = [string | null, string | null, string | null, string];
const FROM: FromCase[] = [
  ["申請中", "要介護2", "認定済み", "申請中 + 要介護度 → 認定済み (更新申請中の印)"],
  ["申請中", "要支援1", "認定済み", "申請中 + 要支援 → 認定済み"],
  ["申請中", "要介護３", "認定済み", "全角数字の要介護度"],
  [" 申請中 ", " 要介護1 ", "認定済み", "前後の空白"],
  ["申請中", "", "申請中", "要介護度が空 → 申請中のまま (本当の結果待ち)"],
  ["申請中", null, "申請中", "要介護度 null → 申請中のまま"],
  ["申請中", "申請中", "申請中", "要介護度欄に「申請中」→ 申請中のまま"],
  ["申請中", "非該当", "申請中", "非該当 → 申請中のまま (認定済みにしない)"],
  ["認定済み", "要介護1", "認定済み", "認定済みはそのまま"],
  ["認定済み", null, "認定済み", "認定済み + 要介護度なし → そのまま"],
  [null, "要介護1", null, "状態が空 → null のまま (勝手に埋めない)"],
  ["", "要介護1", null, "状態が空文字 → null"],
];
type OverCase = [string | null, string | null, boolean, string];
const OVER: OverCase[] = [
  ["認定済み", "申請中", false, "★ 認定済み → 申請中 は書かない"],
  ["申請中", "認定済み", true, "申請中 → 認定済み は書く"],
  ["認定済み", "認定済み", true, "同じ値"],
  ["申請中", "申請中", true, "同じ値 (申請中)"],
  [null, "申請中", true, "空 → 申請中 は書く"],
  ["認定済み", null, true, "次が空 (呼出側は空を書かない)"],
];

console.log("══ A. ① certStatusFromHonobono ══");
for (const [s, lv, want, label] of FROM) eq(`${label} (${JSON.stringify(s)}, ${JSON.stringify(lv)})`, certStatusFromHonobono(s, lv), want);
console.log("\n══ A. ② mayOverwriteCertStatus ══");
for (const [cur, next, want, label] of OVER) eq(`${label} (${JSON.stringify(cur)} → ${JSON.stringify(next)})`, mayOverwriteCertStatus(cur, next), want);

console.log("\n══ B. 負のコントロール (規則をわざと逆にする) ══");
{
  // ① を逆: 要介護度があっても 申請中 のまま写す (2026-11-11 の段階 1 が実際にやっていた形)
  const brokenFrom = (s: string | null) => (s ?? "").trim() || null;
  // ② を逆: 何でも上書きする
  const brokenOver = () => true;
  const missFrom = FROM.filter(([s, , want]) => brokenFrom(s) !== want).length;
  const missOver = OVER.filter(([, , want]) => brokenOver() !== want).length;
  n += 2;
  if (missFrom === 0) { ng++; console.log("  NG  ① を逆にしても食い違いが出ない (この入力表では ① を検査できていない)"); }
  else console.log(`  OK  ① を逆にすると ${missFrom} 件食い違う (検査は効いている)`);
  if (missOver === 0) { ng++; console.log("  NG  ② を逆にしても食い違いが出ない (この入力表では ② を検査できていない)"); }
  else console.log(`  OK  ② を逆にすると ${missOver} 件食い違う (検査は効いている)`);
}

console.log("\n══ C. migrations の逐語コピー ══");
const FILES: { path: string; uses: string[] }[] = [
  { path: "migrations/sync_fukuyogu_from_honobono.mjs", uses: ["mayOverwriteCertStatus"] },
  { path: "migrations/fix_honobono_sync_7_cases_202609.mjs", uses: ["mayOverwriteCertStatus"] },
  { path: "migrations/build_caresapo_rows_from_master.mjs", uses: ["certStatusFromHonobono", "mayOverwriteCertStatus"] },
];
// 規則を自前で書いた形 (2026-11-13 時点で各ファイルにあった書き方)
const INLINE = [/certification_status\s*===\s*"認定済み"\s*&&\s*v\s*===\s*"申請中"/, /g\.status\s*===\s*"申請中"\s*&&\s*\(g\.level\s*\|\|/];
// 負のコントロール: 2026-11-13 まで実際にあった書き方を この検知が拾えること
eq("逐語コピーの検知が 旧 sync/fix_7 の書き方を拾う", INLINE.some((re) => re.test('if (col === "certification_status" && ex.certification_status === "認定済み" && v === "申請中") {')), true);
eq("逐語コピーの検知が 旧 build_caresapo の書き方を拾う", INLINE.some((re) => re.test('const masterApplying = g.status === "申請中" && (g.level || src.certification_status === "認定済み");')), true);
for (const f of FILES) {
  let src = "";
  try { src = readFileSync(f.path, "utf8"); } catch { eq(`${f.path} が読める`, false, true); continue; }
  eq(`${f.path}: lib/insurance/certStatus.ts を import`, /import\("\.\.\/lib\/insurance\/certStatus(\.ts)?"\)/.test(src), true);
  for (const u of f.uses) eq(`${f.path}: ${u}( を呼んでいる`, new RegExp(`${u}\\(`).test(src), true);
  eq(`${f.path}: 規則の逐語コピーが無い`, INLINE.some((re) => re.test(src)), false);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log(ng ? "✗ check:cert-status FAIL" : "✓ check:cert-status PASS");
process.exit(ng ? 1 : 0);
