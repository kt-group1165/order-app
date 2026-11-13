// 福祉用具貸与: 貸与価格が **国が公表した上限価格**を超えていないかの判定。
//
// ─── なぜ要るか (2026-09-03 追加) ─────────────────────────────────────────
// 上限価格マスタ (equipment_price_ceilings) は 15,010 行あるのに、
// **どこからも照合されていなかった** (取り込んで CeilingPriceTab に出すだけ)。
// 貸与価格が上限を超えると**保険給付の対象外**になるので、金額に直結する。
//
// 2026-09-03 に全 4,669 行を手で照合したところ超過は 0 件だったが、
// **今後入っても気づけない**状態だったため、入力時に警告を出すためのガードを足す。
//
// ─── 設計 ────────────────────────────────────────────────────────────────
//   ★ ブロックしない。**警告だけ**。
//     上限マスタに TAIS が無い行が 60 行、貸与開始日時点で有効な世代が無い行が
//     7 行ある。判定できないものを「超過」に倒すと入力できなくなる。
//     判定できないときは "unknown" を返し、呼出側は何も出さないか
//     「確認できません」と出す。
//   ★ 金額は変えない。請求額の計算には一切触れない。
//
// ─── 適用世代の選び方 ────────────────────────────────────────────────────
//   上限価格は「3 年ごとの全面見直し + 四半期ごとの新規追加」で世代管理される。
//   **基準日以前で最も新しい世代**を使う。基準日より後の世代しか無い TAIS は
//   「まだ公表されていない」ので judgement 不能 (= "unknown")。
//   ⚠ 無い場合に最古世代へ fallback してはいけない。**未来の上限と比べることになり、
//     誤検出する** (2026-09-03 に実際にこれで 1 件を誤って「超過」と報告した)。

/** 判定に使う上限価格マスタの 1 行 */
export type CeilingRow = {
  tais_code: string;
  effective_from: string; // "YYYY-MM-DD"
  ceiling_price: number;
};

export type CeilingJudgement =
  | { kind: "ok"; ceiling: number; effectiveFrom: string }
  | { kind: "over"; ceiling: number; effectiveFrom: string; excess: number }
  /** 判定できない。reason は UI の出し分け用 */
  | { kind: "unknown"; reason: "no_tais" | "no_master" | "no_generation" | "no_price" };

/** TAIS コードの正しい形 (企業 5 桁 - 商品 6 桁。商品の先頭は Z のこともある) */
export const TAIS_FORMAT = /^\d{5}-[0-9A-Z]{6}$/;

/**
 * TAIS コードをそろえる (2026-11-13)。NFKC (全角英数・全角ハイフン) → 大文字 → 5 桁の後の 1 文字が
 * 「?」やダッシュ系なら「-」に (用具マスタに「00167?000197」のような化けがあった)。
 * ★ 既知の化け方しか直せない。直らないものは countUnjudgeable の bad_format で数えて警告する。
 */
export function normalizeTais(s: string | null | undefined): string {
  const t = String(s ?? "").normalize("NFKC").trim().toUpperCase();
  const m = t.match(/^(\d{5})[?\-‐―ー–—](.{6})$/);
  return m ? `${m[1]}-${m[2]}` : t;
}

/** TAIS ごとに effective_from 昇順で束ねる (呼出側で 1 回だけ作る)。キーは normalizeTais でそろえる */
export function indexCeilings(rows: CeilingRow[]): Map<string, CeilingRow[]> {
  const m = new Map<string, CeilingRow[]>();
  for (const r of rows) {
    const k = normalizeTais(r.tais_code);
    if (!k) continue;
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  }
  for (const v of m.values()) v.sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  return m;
}

/**
 * 貸与価格が上限を超えているか判定する。
 *
 * @param taisCode  用具の TAIS コード (equipment_master.tais_code)
 * @param price     貸与価格 (円/月)
 * @param onDate    基準日 "YYYY-MM-DD" — **貸与開始日**。未定なら当日を渡す
 * @param index     indexCeilings() の結果
 */
export function judgeCeiling(
  taisCode: string | null | undefined,
  price: number | null | undefined,
  onDate: string,
  index: Map<string, CeilingRow[]>,
): CeilingJudgement {
  const t = normalizeTais(taisCode);
  if (!t) return { kind: "unknown", reason: "no_tais" };
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return { kind: "unknown", reason: "no_price" };
  }
  const rows = index.get(t);
  if (!rows || rows.length === 0) return { kind: "unknown", reason: "no_master" };
  const d = String(onDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { kind: "unknown", reason: "no_generation" };
  // 基準日以前で最も新しい世代。無ければ判定不能 (最古への fallback はしない)
  let applicable: CeilingRow | null = null;
  for (const r of rows) {
    if (String(r.effective_from).slice(0, 10) <= d) applicable = r;
    else break; // 昇順なのでここから先は全部未来
  }
  if (!applicable) return { kind: "unknown", reason: "no_generation" };
  const ceiling = Number(applicable.ceiling_price);
  if (!Number.isFinite(ceiling)) return { kind: "unknown", reason: "no_master" };
  const effectiveFrom = String(applicable.effective_from).slice(0, 10);
  return price > ceiling
    ? { kind: "over", ceiling, effectiveFrom, excess: price - ceiling }
    : { kind: "ok", ceiling, effectiveFrom };
}

// ─── 貸与中の明細を上限と突き合わせる (2026-10-15 追加・B-2i) ────────────────
//
// なぜ要るか:
//   check:ceiling (ceiling-baseline-check.mts) は **用具マスタ** 全 2,159 件を見ている。
//   2026-10-15 に実測すると超過 269 件のうち 268 件は旧コード (EQ-xxxxxx, 1,520 件) で、
//   **order_items から 1 件も参照されていない** (= 請求に乗らない)。
//   実際に請求に乗る超過は 1 口だけで、マスタ件数を見ているだけでは埋もれて見えない。
//   ここでは「その月に介護保険で請求される貸与の明細」を、その月に効く上限と比べる。
//
// ★ 価格は呼出側が渡す。請求画面 (BillingTab の getUnits) と同じく
//   「その月に有効な価格改定履歴 → 無ければ用具マスタの現在価格」を渡すこと。
//   (order_items.rental_price は請求の単位数計算には使われていない)
// ★ 金額は変えない。判定だけ。

/** 判定対象の 1 明細 */
export type CeilingRentalLine = {
  id: string;
  taisCode: string | null | undefined;
  /** その月の請求に使う月額 (円) */
  price: number | null | undefined;
  quantity?: number | null;
};

export type CeilingOverrun = {
  id: string;
  ceiling: number;
  effectiveFrom: string;
  /** 1 個あたりの超過額 (円/月) */
  excess: number;
  price: number;
  quantity: number;
};

/**
 * その月に介護保険で請求される貸与か (キャンセル・期間外・未開始を除く)。
 * 判定は日付文字列 "YYYY-MM-DD" の比較だけで行う (タイムゾーンに依存しない)。
 *
 * @param ym "YYYY-MM"
 */
export function isCareRentalInMonth(
  item: {
    status: string | null;
    cancelled_at: string | null;
    rental_start_date: string | null;
    rental_end_date: string | null;
  },
  paymentType: string | null | undefined,
  ym: string,
): boolean {
  if (paymentType !== "介護") return false;
  if (item.cancelled_at || item.status === "cancelled") return false;
  if (!(item.status === "rental_started" || item.status === "terminated")) return false;
  if (!/^\d{4}-\d{2}$/.test(ym)) return false;
  const monthStart = `${ym}-01`;
  const [y, m] = ym.split("-").map(Number);
  const monthEnd = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const start = String(item.rental_start_date ?? "").slice(0, 10);
  if (!start || start > monthEnd) return false;
  const end = String(item.rental_end_date ?? "").slice(0, 10);
  if (end && end < monthStart) return false;
  return true;
}

/** 明細のうち onDate 時点の上限を超えるものを返す (判定できないものは返さない) */
export function findRentalOverruns(
  lines: CeilingRentalLine[],
  onDate: string,
  index: Map<string, CeilingRow[]>,
): CeilingOverrun[] {
  const out: CeilingOverrun[] = [];
  for (const l of lines) {
    const j = judgeCeiling(l.taisCode, l.price, onDate, index);
    if (j.kind !== "over") continue;
    out.push({
      id: l.id,
      ceiling: j.ceiling,
      effectiveFrom: j.effectiveFrom,
      excess: j.excess,
      price: Number(l.price),
      quantity: Number(l.quantity ?? 1) || 1,
    });
  }
  return out;
}

/**
 * ★ 上限を判定できなかった明細を 理由ごとに数える (2026-11-13 追加)。
 *
 * なぜ要るか: findRentalOverruns は "over" だけを返し、判定できない (unknown) 明細を捨てる。
 *   TAIS が空・化けた (「00167?000197」等) 介護の明細は、上限を超えていても **黙って素通り**していた
 *   (負のコントロールで確認: 上限 9,000 円に 12,000 円の明細 → TAIS 空・? 化け・全角ハイフン のどれも超過 0 件)。
 *   TAIS の正規化 (normalizeTais) は 既知の化け方しか直せないので、**判定できない口を数えて見せる**のが本筋。
 * ★ 渡すのは 介護保険で請求する明細だけにすること (自費は上限の対象外。混ぜると 常に点灯して読まれなくなる)。
 * 返す区分:
 *   no_tais    TAIS が空                                     → ★ 警告する (上限を超えても検出できない)
 *   bad_format TAIS が「5桁-6桁」の形でない (化け・全角 等) → ★ 警告する (上限マスタに当たらず素通りする)
 *   not_listed 形は正しいが 上限マスタに無い                → 警告しない。上限は月平均 100 件以上貸与される商品にしか
 *                                                            設定されないので、正しい TAIS でも載っていない商品は普通にある (数えるだけ)
 *   no_generation その TAIS の上限が まだ施行前              → 警告しない (数えるだけ)
 * 価格 0 / 無し (no_price) は 上限と比べる意味が無いので数えない。
 */
export function countUnjudgeable(
  lines: CeilingRentalLine[],
  onDate: string,
  index: Map<string, CeilingRow[]>,
): { no_tais: string[]; bad_format: string[]; not_listed: string[]; no_generation: string[] } {
  const out = { no_tais: [] as string[], bad_format: [] as string[], not_listed: [] as string[], no_generation: [] as string[] };
  for (const l of lines) {
    if (l.price == null || !Number.isFinite(l.price) || l.price <= 0) continue; // 価格 0 / 無し は 上限と比べる意味が無い
    const j = judgeCeiling(l.taisCode, l.price, onDate, index);
    if (j.kind !== "unknown" || j.reason === "no_price") continue;
    if (j.reason === "no_master") {
      (TAIS_FORMAT.test(normalizeTais(l.taisCode)) ? out.not_listed : out.bad_format).push(l.id);
    } else out[j.reason].push(l.id);
  }
  return out;
}

/** afterDate より後に施行される世代の施行日 (昇順・重複なし)。改定前の「超過見込み」用 */
export function futureEffectiveDates(index: Map<string, CeilingRow[]>, afterDate: string): string[] {
  const s = new Set<string>();
  for (const rows of index.values()) {
    for (const r of rows) {
      const d = String(r.effective_from).slice(0, 10);
      if (d > afterDate) s.add(d);
    }
  }
  return Array.from(s).sort();
}
