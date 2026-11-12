// ほのぼのの「認定状況」の読み方 (2026-11-13)
//
// ほのぼのの利用者マスタ (介護保険 CSV) の「認定状況 = 申請中」は、その認定が未確定という意味ではなく、
// 期間の終わりが近い人の「更新 (次の認定) を申請中」という印として付いていることがある。
// 実測: 板谷・玉井・小泉・小池・齊藤 の 5 名は、申請中の認定の期間中も ほのぼのは毎月請求していた (KDS 処理R8-04〜09)。
// 当方で「申請中」にすると BillingTab の月遅れ自動判定 (認定の状態 = 申請中) で 当方だけ請求を止めてしまう。
//
// 規則:
//   ① 新しく入れる行: 申請中 でも 要介護度 (要支援・要介護) があれば 認定済み として入れる
//      (要介護度が無い 申請中 = 本当に結果待ち は 申請中 のまま)
//   ② 既存の行を書き換えるとき: 認定済み → 申請中 には下げない
// 同じ規則: migrations/sync_fukuyogu_from_honobono.mjs / build_caresapo_rows_from_master.mjs / fix_honobono_sync_7_cases_202609.mjs

const hasCareLevel = (careLevel: string | null | undefined) => {
  const v = (careLevel ?? "").normalize("NFKC").trim();
  return v !== "" && !/申請|非該当|なし/.test(v);
};

/** ① ほのぼのの認定状況を 当方に入れる値にする */
export function certStatusFromHonobono(status: string | null | undefined, careLevel: string | null | undefined): string | null {
  const s = (status ?? "").trim() || null;
  if (s === "申請中" && hasCareLevel(careLevel)) return "認定済み";
  return s;
}

/** ② 既存の行の認定状況を書き換えてよいか (認定済み → 申請中 は false) */
export function mayOverwriteCertStatus(current: string | null | undefined, next: string | null | undefined): boolean {
  return !(current === "認定済み" && next === "申請中");
}
