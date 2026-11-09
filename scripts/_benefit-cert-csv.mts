/**
 * ほのぼの「負担割合証等」CSV を読む (取込 script と突合 script の共用。DB は触らない)。
 *
 *   列 (ヘッダー名で引く。出力設定で列位置が変わるため):
 *     利用者名 / 被保険者番号 / 保険者 (★ 名前。番号ではない) / 保険有効開始日 / 保険有効終了日 /
 *     適用 (○ = 適用) / 給付種類 (介護保険負担割合証 / 給付制限 / 特例措置) / 給付率 / 有効開始日 / 有効終了日 /
 *     制限内容 / 備考
 *   ★ 保険者が名前なので、同じ回に出した「介護保険」CSV で 番号に変える:
 *     1. (被保険者番号, 保険者名) が介護保険 CSV にあれば その行の保険者番号
 *     2. 無ければ 保険者名 → 番号 が介護保険 CSV 全体で 1 通りに決まるときだけ
 *     3. それも無ければ 未解決 (取り込まない・件数を出す)
 *   ★ 同じ証が 保険有効期間の違う行で重複して出る (内澤 鉄治 等) → (給付種類, 給付率, 有効期間) で 1 つにまとめる。
 *   cp932 (Shift_JIS)。
 */
import { readFileSync } from "node:fs";

export type BenefitCsvEntry = {
  insurer: string;        // 正規化した保険者番号 (6 桁。00 始まり 8 桁は 6 桁に)
  insured: string;        // 正規化した被保険者番号
  name: string;
  kind: string;           // 介護保険負担割合証 / 給付制限 / 特例措置
  rate: number | null;
  from: string;           // YYYY-MM-DD
  to: string | null;
  restriction: string | null;
  note: string | null;
  line: number;           // CSV の行番号 (1 = ヘッダー)
};

export type BenefitCsvResult = {
  entries: BenefitCsvEntry[];
  stats: {
    rows: number;            // データ行
    blankKind: number;       // 給付種類が空 (証の無い人の行)
    notApplied: number;      // 適用 が ○ でない
    noFrom: number;          // 有効開始日が読めない
    badPeriod: number;       // 終了 < 開始
    badRate: number;         // 給付率が 0〜100 の数でない
    insurerUnresolved: number; // 保険者名 → 番号が決まらない
    insurerViaPerson: number;
    insurerViaName: number;
    dupMerged: number;       // 同じ証の重複行をまとめた
    unresolvedNames: Map<string, number>; // 保険者名 → 件数
  };
};

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
export function readCp932Csv(path: string): string[][] {
  const text = new TextDecoder("shift-jis").decode(readFileSync(path));
  return text.split(/\r\n|\n/).filter((l) => l.trim().length > 0).map((l) => parseCsvLine(l).map((s) => s.trim()));
}
const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim();
export const nInsurer = (s: string | null | undefined) => {
  const d = nfkc(s).replace(/\D/g, "");
  return d.length === 8 && d.startsWith("00") ? d.slice(2) : d;
};
export const nInsured = (s: string | null | undefined) => nfkc(s).toUpperCase();
export const nInsurerName = (s: string | null | undefined) => nfkc(s).replace(/[\s　]+/g, "");
export const isoDate = (s: string | null | undefined): string | null => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(nfkc(s));
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
function col(header: string[], name: string, path: string): number {
  const i = header.findIndex((h) => h === name);
  if (i < 0) throw new Error(`★ ${path} にヘッダー「${name}」が無い (帳票が違う): ${header.join(",")}`);
  return i;
}

/** @param futanPath 負担割合証等 CSV / @param kaigoInsPaths 同じ回の介護保険 CSV (保険者名→番号の変換用。複数可) */
export function readBenefitCsv(futanPath: string, kaigoInsPaths: string[]): BenefitCsvResult {
  // 保険者名 → 番号
  const byPerson = new Map<string, string>(); // 被保番|保険者名 → 番号
  const byName = new Map<string, Set<string>>();
  for (const p of kaigoInsPaths) {
    const rows = readCp932Csv(p);
    const h = rows[0];
    const cInsured = col(h, "被保険者番号", p), cName = col(h, "保険者", p), cNo = col(h, "保険者番号", p);
    for (const r of rows.slice(1)) {
      const no = nInsurer(r[cNo]);
      const nm = nInsurerName(r[cName]);
      if (!no || !nm) continue;
      byPerson.set(`${nInsured(r[cInsured])}|${nm}`, no);
      if (!byName.has(nm)) byName.set(nm, new Set());
      byName.get(nm)!.add(no);
    }
  }
  const rows = readCp932Csv(futanPath);
  const h = rows[0];
  const c = {
    name: col(h, "利用者名", futanPath), insured: col(h, "被保険者番号", futanPath), insurer: col(h, "保険者", futanPath),
    applied: col(h, "適用", futanPath), kind: col(h, "給付種類", futanPath), rate: col(h, "給付率", futanPath),
    from: col(h, "有効開始日", futanPath), to: col(h, "有効終了日", futanPath),
    restriction: col(h, "制限内容", futanPath), note: col(h, "備考", futanPath),
  };
  const stats: BenefitCsvResult["stats"] = {
    rows: rows.length - 1, blankKind: 0, notApplied: 0, noFrom: 0, badPeriod: 0, badRate: 0,
    insurerUnresolved: 0, insurerViaPerson: 0, insurerViaName: 0, dupMerged: 0, unresolvedNames: new Map(),
  };
  const seen = new Set<string>();
  const entries: BenefitCsvEntry[] = [];
  rows.slice(1).forEach((r, i) => {
    const kind = nfkc(r[c.kind]);
    if (!kind) { stats.blankKind++; return; }
    if (nfkc(r[c.applied]) !== "○") { stats.notApplied++; return; }
    const from = isoDate(r[c.from]);
    if (!from) { stats.noFrom++; return; }
    const to = isoDate(r[c.to]);
    if (to && to < from) { stats.badPeriod++; return; }
    const rateS = nfkc(r[c.rate]);
    const rate = rateS === "" ? null : Number(rateS);
    if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) { stats.badRate++; return; }
    const insured = nInsured(r[c.insured]);
    const nm = nInsurerName(r[c.insurer]);
    let insurer = byPerson.get(`${insured}|${nm}`) ?? null;
    if (insurer) stats.insurerViaPerson++;
    else {
      const s = byName.get(nm);
      if (s && s.size === 1) { insurer = [...s][0]; stats.insurerViaName++; }
    }
    if (!insurer) {
      stats.insurerUnresolved++;
      stats.unresolvedNames.set(nm || "(空)", (stats.unresolvedNames.get(nm || "(空)") ?? 0) + 1);
      return;
    }
    const key = `${insurer}|${insured}|${kind}|${rate}|${from}|${to ?? ""}`;
    if (seen.has(key)) { stats.dupMerged++; return; }
    seen.add(key);
    entries.push({
      insurer, insured, name: nfkc(r[c.name]), kind, rate: rate == null ? null : Math.round(rate), from, to,
      restriction: nfkc(r[c.restriction]) || null, note: nfkc(r[c.note]) || null, line: i + 2,
    });
  });
  return { entries, stats };
}
