// 福祉用具 軽度者 例外給付 — 期限・市町村ルールの判定 (2026-11-09 user 合意)
//
// ★ 純関数だけを置く (supabase を import しない)。検査 = scripts/fukuyogu-exception-rules-test.mts
//   DB の読み書きは lib/fukuyoguExceptions.ts。
//
// 判定 (利用者 × 品目区分 × 基準日):
//   missing                記録なし (基準日に有効な記録が無く、過去にも無い)            → danger (赤)
//   expired                切れている (過去の記録はあるが基準日には切れている)          → danger (赤)
//   expiring               有効だが 30 日以内に切れる (更新の記録が続いていない)          → warn (橙)
//   period_required_no_end 有効だが終了日が空。市町村ルールで期間が要る               → warn (橙)
//   ok                     有効 (期限なし・期間不要 / 31 日以上先まで有効)
//
// ⚠ 「記録なし」は「例外給付を取っていない」ではない (記録が追いついていないだけの可能性)。
//   画面の文言でも断定しない。
// ⚠ 日付は "YYYY-MM-DD" 文字列で扱い、計算は UTC で行う (toISOString の JST ずれを避ける)。

export const EXCEPTION_EXPIRY_WARN_DAYS = 30;

export type ExceptionInsurerRule = {
  id: string;
  tenant_id: string;
  insurer_number: string;
  insurer_name: string | null;
  requires_period: boolean;
  period_months: number | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

/** 判定に要る最小限の形 (FukuyoguExceptionGrant の部分集合) */
export type GrantLike = {
  client_id: string;
  restriction_group: string;
  valid_from: string;
  valid_end: string | null;
};

export type ExceptionStatusKind = "ok" | "expiring" | "period_required_no_end" | "expired" | "missing";
export type ExceptionAlertLevel = "ok" | "warn" | "danger";

export type ExceptionJudgement = {
  group: string;
  kind: ExceptionStatusKind;
  level: ExceptionAlertLevel;
  /** 有効な間の終わり (更新の記録が続いていればその先まで)。null = 期限なし。missing/expired では undefined */
  coverageEnd?: string | null;
  /** coverageEnd までの日数 (基準日 = 0)。期限なしなら undefined */
  daysLeft?: number;
  /** expired のとき、最後に切れた日 */
  lastEnded?: string;
};

const LEVEL_OF: Record<ExceptionStatusKind, ExceptionAlertLevel> = {
  ok: "ok", expiring: "warn", period_required_no_end: "warn", expired: "danger", missing: "danger",
};

function parseYmd(s: string): number {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function fmt(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function addDaysYmd(ymd: string, n: number): string {
  return fmt(parseYmd(ymd) + n * 86400000);
}
/** b - a の日数 */
export function diffDaysYmd(a: string, b: string): number {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

/**
 * 開始日 + N か月 の有効期間の終了日 (民法 143 条の数え方)。
 *   起算日の応当日の前日。応当日が無い月 (1/31 の 1 か月後) はその月の末日。
 *   2026-04-01 + 12 → 2027-03-31 / 2026-01-15 + 1 → 2026-02-14 / 2026-01-31 + 1 → 2026-02-28
 */
export function proposeValidEnd(validFrom: string, months: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(validFrom) || !Number.isInteger(months) || months < 1) return null;
  const [y, m, d] = validFrom.slice(0, 10).split("-").map(Number);
  const targetMonthIdx = m - 1 + months; // 0 起点
  const ty = y + Math.floor(targetMonthIdx / 12);
  const tm = targetMonthIdx % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  if (d > lastDay) return fmt(Date.UTC(ty, tm, lastDay)); // 応当日なし → 末日
  return fmt(Date.UTC(ty, tm, d) - 86400000); // 応当日の前日
}

export function normalizeInsurerNumber(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").replace(/\s/g, "");
}

export function findInsurerRule(rules: ExceptionInsurerRule[], insurerNumber: string | null | undefined): ExceptionInsurerRule | null {
  const n = normalizeInsurerNumber(insurerNumber);
  if (!n) return null;
  return rules.find((r) => normalizeInsurerNumber(r.insurer_number) === n) ?? null;
}

/**
 * 基準日に有効な記録から始めて、更新の記録 (前の終了日の翌日までに始まるもの) を繋いだ有効期間の終わり。
 *   戻り値 undefined = 基準日に有効な記録が無い / null = 期限なし
 */
export function coverageEndOf(grants: GrantLike[], onDate: string): string | null | undefined {
  const active = grants.filter((g) => g.valid_from <= onDate && (g.valid_end == null || g.valid_end >= onDate));
  if (active.length === 0) return undefined;
  if (active.some((g) => g.valid_end == null)) return null;
  let end = active.map((g) => g.valid_end as string).sort().at(-1)!;
  // 更新の記録を繋ぐ (無限ループしないよう、伸びたときだけ続ける)
  for (;;) {
    const next = addDaysYmd(end, 1);
    const cont = grants.filter((g) => g.valid_from <= next && (g.valid_end == null || g.valid_end > end));
    if (cont.length === 0) return end;
    if (cont.some((g) => g.valid_end == null)) return null;
    end = cont.map((g) => g.valid_end as string).sort().at(-1)!;
  }
}

/**
 * 利用者 × 品目区分 × 基準日 の判定。
 * @param rule その利用者の保険者のルール。null = 未設定 (期間要否の警告は出さない)
 */
export function judgeExceptionGrant(
  grants: GrantLike[],
  clientId: string,
  group: string,
  onDate: string,
  rule: Pick<ExceptionInsurerRule, "requires_period"> | null,
  warnDays: number = EXCEPTION_EXPIRY_WARN_DAYS,
): ExceptionJudgement {
  const mine = grants.filter((g) => g.client_id === clientId && g.restriction_group === group);
  const cov = coverageEndOf(mine, onDate);
  if (cov === undefined) {
    const ended = mine.filter((g) => g.valid_end != null && g.valid_end < onDate).map((g) => g.valid_end as string).sort();
    if (ended.length > 0) return { group, kind: "expired", level: "danger", lastEnded: ended.at(-1) };
    return { group, kind: "missing", level: "danger" };
  }
  if (cov === null) {
    // 期限なし。期間が要る市町村なら警告 (有効な記録のどれかが終了日空 = 期間を区切っていない)
    const kind: ExceptionStatusKind = rule?.requires_period ? "period_required_no_end" : "ok";
    return { group, kind, level: LEVEL_OF[kind], coverageEnd: null };
  }
  const daysLeft = diffDaysYmd(onDate, cov);
  const kind: ExceptionStatusKind = daysLeft <= warnDays ? "expiring" : "ok";
  return { group, kind, level: LEVEL_OF[kind], coverageEnd: cov, daysLeft };
}

const RANK: Record<ExceptionAlertLevel, number> = { ok: 0, warn: 1, danger: 2 };
export function worstLevel(levels: ExceptionAlertLevel[]): ExceptionAlertLevel {
  return levels.reduce<ExceptionAlertLevel>((w, l) => (RANK[l] > RANK[w] ? l : w), "ok");
}

/** 利用者の要確認の品目区分をまとめて判定 (groups は重複可。呼出側で軽度者 × 原則対象外の区分を渡す) */
export function judgeClientExceptions(
  grants: GrantLike[],
  clientId: string,
  groups: string[],
  onDate: string,
  rule: Pick<ExceptionInsurerRule, "requires_period"> | null,
  warnDays: number = EXCEPTION_EXPIRY_WARN_DAYS,
): { level: ExceptionAlertLevel; items: ExceptionJudgement[] } {
  const items = [...new Set(groups)].sort().map((g) => judgeExceptionGrant(grants, clientId, g, onDate, rule, warnDays));
  return { level: worstLevel(items.map((i) => i.level)), items };
}

/** 画面用の短い文言 */
export function describeJudgement(j: ExceptionJudgement): string {
  switch (j.kind) {
    case "missing": return `${j.group}: 例外給付の記録なし`;
    case "expired": return `${j.group}: 例外給付の期限切れ (${j.lastEnded} まで)`;
    case "expiring": return `${j.group}: ${j.coverageEnd} で期限 (あと ${j.daysLeft} 日)`;
    case "period_required_no_end": return `${j.group}: 市町村ルールで有効期間が要りますが終了日が空です`;
    case "ok": return j.coverageEnd ? `${j.group}: ${j.coverageEnd} まで有効` : `${j.group}: 有効 (期限なし)`;
  }
}
