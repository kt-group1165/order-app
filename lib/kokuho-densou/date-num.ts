/**
 * 伝送の日付項目 (数字8 = YYYYMMDD) への変換。build.ts (01 項13・17・18・21・22) と densou-exclude.ts (読めない日付で外す) が
 * ★ 同じこの関数を使う (2026-11-14: 判定を 2 か所に書くと 片方だけ直したときに乖離するため 1 か所に)。
 *
 * ★ 2026-11-09: clients.certification_start/end_date に "2026/2/19" 形式 (ほのぼの由来) が混ざっていた
 *   (2026-09 の請求対象で 認定開始 61 名・終了 58 名)。"-" を消すだけだと "2026/2/19" のまま出て
 *   数字8 の項目に "/" が入る。YYYY-MM-DD / YYYY/M/D のどちらも YYYYMMDD に直す。
 * 読めない値 (和暦 "S15.3.3" / "R8/8/1" 等) は "" (空欄) を返す。空欄で伝送すると返戻になるので、
 *   値はあるのに読めない人は densouExcludeReasons で外す (isUnreadableDate)。
 */
export function dateNum(s: string | null | undefined): string {
  const t = (s ?? "").normalize("NFKC").trim();
  if (!t) return "";
  const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : "";
}

/** 値は入っているのに dateNum で読めない (= 伝送では空欄になる)。空・null は false (「空」は別の理由で扱う) */
export function isUnreadableDate(s: string | null | undefined): boolean {
  return (s ?? "").normalize("NFKC").trim() !== "" && dateNum(s) === "";
}
