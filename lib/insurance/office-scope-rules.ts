/**
 * 事業所別保険の 規則 (純関数・依存なし)。lib/insurance/office-scope.ts から re-export。
 * 検査 scripts/insurance-office-check.mts から直接呼ぶため supabase を import しない。
 */
export const isPerOffice = (officeId: string | null | undefined, perOfficeIds: readonly string[]): boolean =>
  !!officeId && perOfficeIds.includes(officeId);

/**
 * その事業所が請求・画面で使ってよい行に絞る (純関数)。
 *   per_office の事業所 → office_id = 自事業所 の行だけ
 *   それ以外 (shared・事業所未選択) → per_office の事業所の行を外す (0 件なら素通し)
 */
export function rowsForOffice<T extends { office_id?: string | null }>(
  rows: T[],
  officeId: string | null | undefined,
  perOfficeIds: readonly string[],
): T[] {
  if (!perOfficeIds.length) return rows;
  if (isPerOffice(officeId, perOfficeIds)) return rows.filter((r) => r.office_id === officeId);
  const s = new Set(perOfficeIds);
  return rows.filter((r) => !r.office_id || !s.has(r.office_id));
}

/**
 * 行の持ち主の表示用ラベル。per_office の事業所の画面で「自事業所の行か」を見せるのに使う。
 *   own … 自事業所の行 / other … 他事業所の行 / none … 事業所未定 (NULL)
 */
export function ownerKind(rowOfficeId: string | null | undefined, officeId: string | null | undefined): "own" | "other" | "none" {
  if (!rowOfficeId) return "none";
  return rowOfficeId === officeId ? "own" : "other";
}

/** [複写] の行: 元の行から id・時刻を除き、持ち主を自事業所にする (DESIGN_INSURANCE_PER_OFFICE.md §4.1) */
export function copyRowForOffice<T extends { id: string }>(row: T, officeId: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  delete rest.id;
  delete rest.created_at;
  delete rest.updated_at;
  return { ...rest, office_id: officeId, copied_from_id: row.id, office_source: "copy_button" };
}
