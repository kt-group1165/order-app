// 福祉用具貸与の伝送: どの明細を どの事業所番号で出すかを決める (2026-11-13 追加・純関数)。
//
// ─── なぜ要るか ───────────────────────────────────────────────────────────
//   請求の事業所番号は「実際に貸した事業所」(orders.office_id) の番号 (2026-11-13 決着。
//   居宅の給付管理票 KY 8222 は 実際に貸した事業所で出ているので、番号が違うと突合不一致で返戻)。
//   ところが BillingTab の伝送作成は 画面で選んでいる事業所 (currentOfficeId) の番号を使い、
//     ・事業所を選んでいない (「全事業所」= 既定) と テナントの番号 (kt-group は空) で 全事業所の明細を 1 本にまとめて出す
//     ・orders.office_id が NULL の注文は どの事業所の伝送にも入る
//   という穴があった。画面の中にあって検証できなかったので、ここに出して 伝送作成と検査 (check:densou-office) の両方から使う。
//
// ★ 金額は変えない。どの明細を入れるか・どの番号で出すか・止めるか だけを決める。

export type DensouOfficeRow = { id: string; business_number: string | null; name?: string | null };

export type DensouOfficePlan = {
  /** 伝送に使う事業所番号 (10 桁)。止めるときは null */
  officeNumber: string | null;
  /** 伝送に入れる明細の id */
  included: string[];
  /** 伝送から外した明細と理由 */
  excluded: { itemId: string; reason: "office_null" | "other_office" }[];
  /** 伝送を止める理由 (1 つでもあれば 伝送を作らない) */
  blockers: string[];
  /** 伝送は作るが 知らせること */
  warnings: string[];
};

/**
 * @param lines            伝送の候補の明細 (その明細の注文の office_id)
 * @param selectedOfficeId 画面で選んでいる事業所 (null = 全事業所)
 * @param offices          事業所マスタ (business_number を引く)
 */
export function planDensouOffice(
  lines: readonly { itemId: string; orderOfficeId: string | null | undefined }[],
  selectedOfficeId: string | null | undefined,
  offices: readonly DensouOfficeRow[],
): DensouOfficePlan {
  const plan: DensouOfficePlan = { officeNumber: null, included: [], excluded: [], blockers: [], warnings: [] };
  if (!selectedOfficeId) {
    plan.blockers.push("事業所を選んでいません (全事業所)。伝送は 実際に貸した事業所ごとに その事業所番号で作ります — 画面上の事業所を選んでから作ってください");
    return plan;
  }
  const office = offices.find((o) => o.id === selectedOfficeId);
  const num = String(office?.business_number ?? "").replace(/[-\s]/g, "");
  if (!/^\d{10}$/.test(num)) {
    plan.blockers.push(`事業所「${office?.name ?? selectedOfficeId}」の事業所番号が 10 桁の数字ではありません ("${num}") — 設定タブで登録してください`);
    return plan;
  }
  plan.officeNumber = num;
  for (const l of lines) {
    if (!l.orderOfficeId) plan.excluded.push({ itemId: l.itemId, reason: "office_null" });
    else if (l.orderOfficeId !== selectedOfficeId) plan.excluded.push({ itemId: l.itemId, reason: "other_office" });
    else plan.included.push(l.itemId);
  }
  const nNull = plan.excluded.filter((e) => e.reason === "office_null").length;
  if (nNull) plan.warnings.push(`注文の事業所が空の明細 ${nNull} 本は 伝送から外しました (どの事業所番号で出すか決まらないため) — 注文の事業所を入れてください`);
  return plan;
}
