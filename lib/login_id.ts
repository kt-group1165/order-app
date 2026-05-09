// calendar-app の lib/login_id.ts と同じ。order-app login で login_id 受付を
// 可能にするため移植 (4 app で同一 ロジック)。詳細はそちら参照。

const SYNTHETIC_EMAIL_DOMAIN = "kt-staff.invalid";

export const LOGIN_ID_REGEX = /^[a-z][a-z0-9.\-]{3,23}$/;

export function isValidLoginId(loginId: string): boolean {
  return LOGIN_ID_REGEX.test(loginId);
}

export function loginIdToSyntheticEmail(loginId: string): string {
  if (!isValidLoginId(loginId)) {
    throw new Error(`invalid login_id: ${loginId}`);
  }
  return `${loginId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

// Phase 9-5: 招待発行時の login_id 自動派生 / 重複回避ヘルパー (calendar-app と同じロジック)。

// 表示名から login_id 候補を簡易抽出。
//   - ASCII 英小文字 / 数字 / `.` / `-` だけ抜き出して 4-24 字に整形
//   - 漢字・カナ等は変換できないので捨てる (admin が手動入力する想定)
//   - 全く ASCII 英字が無ければ null を返す
export function extractLoginIdHint(displayName: string): string | null {
  if (!displayName) return null;
  const lowered = displayName.toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9.\-\s]/g, "").trim();
  if (!cleaned) return null;
  const first = cleaned.split(/\s+/)[0] ?? "";
  if (!first) return null;
  let candidate = first.replace(/^[^a-z]+/, "");
  if (candidate.length < 4) {
    candidate = (candidate + "user").slice(0, 4);
  }
  candidate = candidate.slice(0, 24);
  return isValidLoginId(candidate) ? candidate : null;
}

// 既に使われている login_id 集合に対して、base が衝突したら base2, base3, …
// と連番を付けて空きを返す。base 自体が valid でなければ null。
export function dedupLoginId(base: string, takenSet: Set<string>): string | null {
  if (!isValidLoginId(base)) return null;
  if (!takenSet.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}${n}`;
    if (cand.length > 24) return null;
    if (!takenSet.has(cand)) return cand;
  }
  return null;
}
