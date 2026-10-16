/**
 * 書類チェックリスト (lib/docChecklist.ts) の検証 (DB 不使用・純関数)
 *
 *   npm run check:doc-checklist
 *
 * 期待値は規則から手で出している:
 *   運用開始日 (2026-05-21) より前の出来事は「紙で対応済み」(paper)。一覧の赤い印に数えない
 *   契約書          最初の貸与開始に 1 回
 *   選定提案書      貸与開始のたび (開始の 30 日前以降に作った書類で満たす)
 *   個別援助計画書  貸与の開始・終了・認定切替のたび
 *   変更契約書      2 回目以降の貸与開始のたび
 *   貸与報告書      毎月。今月分が無くても赤い印にしない
 *
 * 負のコントロール: CUTOFF 判定を外すと ① が、LEAD_DAYS を 0 にすると ③ が落ちることを 2026-10-17 に確認。
 */
import { buildChecklist, countActionNeeded, type ChecklistInput } from "../lib/docChecklist";
import type { ClientDocument } from "../lib/supabase";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const doc = (type: string, ymd: string): ClientDocument =>
  ({ id: `${type}-${ymd}`, tenant_id: "t", client_id: "c", type, title: type, params: {}, created_at: `${ymd}T01:00:00Z` } as unknown as ClientDocument);
const rental = (start: string | null, end: string | null = null, status = "rental_started") => ({ rental_start_date: start, rental_end_date: end, status });
const status = (input: ChecklistInput) => Object.fromEntries(buildChecklist(input).map((r) => [r.key, r.status]));
const TODAY = "2026-10-17";

// ① 運用開始前からの貸与・書類なし → 全部 paper / 印 0 (1,057 名がこの形)
const s1 = status({ rentals: [rental("2025-04-01")], certificationStart: "2025-10-01", docs: [], today: TODAY });
eq("① 移行前", [s1.contract, s1.proposal, s1.care_plan, s1.change_contract], ["paper", "paper", "paper", "none"]);
eq("① 印 0", countActionNeeded(buildChecklist({ rentals: [rental("2025-04-01")], certificationStart: null, docs: [], today: TODAY })), 0);

// ② 運用開始後の新規貸与・書類なし → 契約書・提案書・計画書が missing
const s2 = status({ rentals: [rental("2026-09-01")], certificationStart: null, docs: [], today: TODAY });
eq("② 新規", [s2.contract, s2.proposal, s2.care_plan, s2.change_contract], ["missing", "missing", "missing", "none"]);

// ③ 開始の 20 日前に作った提案書・計画書でも満たす (30 日以内)
const s3 = status({ rentals: [rental("2026-09-01")], certificationStart: null, docs: [doc("contract", "2026-08-12"), doc("proposal", "2026-08-12"), doc("care_plan", "2026-08-12")], today: TODAY });
eq("③ 事前作成", [s3.contract, s3.proposal, s3.care_plan], ["done", "done", "done"]);

// ④ 開始の 40 日前の提案書は古い → outdated
const s4 = status({ rentals: [rental("2026-09-01")], certificationStart: null, docs: [doc("proposal", "2026-07-20")], today: TODAY });
eq("④ 古い提案書", s4.proposal, "outdated");

// ⑤ 認定切替 (運用開始後) の後に計画書が無い → care_plan outdated (他は移行前なので paper)
const s5 = status({ rentals: [rental("2025-04-01")], certificationStart: "2026-08-01", docs: [doc("care_plan", "2026-01-10")], today: TODAY });
eq("⑤ 認定切替", [s5.care_plan, s5.proposal], ["outdated", "paper"]);

// ⑥ 品目追加 (2 回目の開始が運用開始後) → 変更契約書 missing、契約書は移行前なので paper
const s6 = status({ rentals: [rental("2025-04-01"), rental("2026-09-15")], certificationStart: null, docs: [], today: TODAY });
eq("⑥ 品目追加", [s6.change_contract, s6.contract, s6.proposal], ["missing", "paper", "missing"]);

// ⑦ 貸与終了 (運用開始後) → 計画書の見直し
const s7 = status({ rentals: [rental("2025-04-01", "2026-09-30", "terminated")], certificationStart: null, docs: [], today: TODAY });
eq("⑦ 終了", s7.care_plan, "missing");

// ⑧ 貸与報告書: 今月分が無くても赤くしない / あれば done
const s8a = status({ rentals: [rental("2025-04-01")], certificationStart: null, docs: [], today: TODAY });
const s8b = status({ rentals: [rental("2025-04-01")], certificationStart: null, docs: [doc("rental_report", "2026-10-05")], today: TODAY });
eq("⑧ 貸与報告書", [s8a.rental_report, s8b.rental_report], ["none", "done"]);

// ⑨ 貸与なし → none (書類があれば done)
const s9 = status({ rentals: [], certificationStart: null, docs: [doc("contract", "2026-07-02")], today: TODAY });
eq("⑨ 貸与なし", [s9.contract, s9.proposal], ["done", "none"]);

// ⑩ 旧 type (rental_contract / important_matters) も契約書として数える
const s10 = status({ rentals: [rental("2026-09-01")], certificationStart: null, docs: [doc("important_matters", "2026-08-30")], today: TODAY });
eq("⑩ 旧 type", s10.contract, "done");

// ⑪ JST 日付: 2026-08-02T15:30Z = JST 8/3 → 開始 9/2 の 30 日前 (8/3) 以降なので満たす
const s11 = status({ rentals: [rental("2026-09-02")], certificationStart: null, docs: [{ ...doc("proposal", "x"), created_at: "2026-08-02T15:30:00Z" } as ClientDocument], today: TODAY });
eq("⑪ JST", s11.proposal, "done");

// ⑫ 印の数 = missing + outdated
eq("⑫ 印", countActionNeeded(buildChecklist({ rentals: [rental("2026-09-01")], certificationStart: null, docs: [], today: TODAY })), 3);

console.log(`check:doc-checklist  ${pass} 件 合格 / ${fails.length} 件 不合格`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
