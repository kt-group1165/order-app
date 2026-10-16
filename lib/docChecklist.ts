// 書類画面の「書類チェックリスト」: 利用者ごとに、どの書類が作成済み / 未作成 / 要更新かを決める (pure)。
//
// 書類タスク (doc_tasks) は 2026-10-17 時点で pending 4,224 件のうち 4,222 件が 2026-05-20 の一括 backfill
// (既存利用者ぶん・紙で作成済み。user 判断で「残す」) で、運用で発生したものは 2 件しかない。
// client_documents も 2 件しかない (旧システム・紙の書類は DB に無い)。
// そのため状態は「貸与の出来事 (開始・終了) と認定の切替」から導き、★ 運用開始日 (CUTOFF) より前の出来事は
// 紙で対応済みとみなして見ない。見ないと貸与中 1,057 名が全員「未作成」になり、一覧の印が意味を失う。
//
// 検証: npm run check:doc-checklist

import type { ClientDocument } from "./supabase";
import { docTypesSatisfying } from "./docTaskMatch";

/** この日以降の出来事だけを書類の要否判定に使う (order-app の書類運用の開始 = 一括 backfill の翌日) */
export const DOC_CHECK_CUTOFF = "2026-05-21";

/** 出来事より少し前に作った書類も「その出来事向け」とみなす日数 (選定提案書は貸与開始の前に作るため) */
const LEAD_DAYS = 30;

export type ChecklistKey = "contract" | "proposal" | "care_plan" | "change_contract" | "rental_report";

export type ChecklistStatus =
  | "done"      // 必要で、作成済み
  | "missing"   // 必要なのに無い (運用開始後の出来事に対して)
  | "outdated"  // 作成済みだが、その後の出来事で作り直しが要る
  | "paper"     // 運用開始前の出来事だけ (紙で対応済みとみなす)
  | "none";     // 今は要らない (貸与が無い 等)

export type ChecklistRow = {
  key: ChecklistKey;
  label: string;
  /** いつ出す書類か (画面のまとまり) */
  phase: "契約時" | "変更時" | "毎月";
  status: ChecklistStatus;
  /** 状態の理由 (「6/1 の貸与開始」「認定の切替 4/1」など) */
  reason: string;
  /** この種類の書類 (新しい順) */
  docs: ClientDocument[];
};

export type RentalEvent = { date: string; kind: "start" | "end"; label: string };

export type ChecklistInput = {
  /** 介護保険の貸与明細 (自費は書類の要否から外す) */
  rentals: { rental_start_date: string | null; rental_end_date: string | null; status: string; name?: string | null }[];
  /** 認定の開始日 (要介護度の切替・更新)。無ければ null */
  certificationStart: string | null;
  docs: ClientDocument[];
  /** 判定の基準日 (今日)。毎月の貸与報告書の「今月分」に使う */
  today: string;
};

const ROW_DEFS: { key: ChecklistKey; label: string; phase: ChecklistRow["phase"]; types: string[] }[] = [
  { key: "contract", label: "重要事項説明書・契約書", phase: "契約時", types: docTypesSatisfying("rental_contract") },
  { key: "proposal", label: "選定提案書", phase: "契約時", types: ["proposal"] },
  { key: "care_plan", label: "個別援助計画書", phase: "契約時", types: ["care_plan"] },
  { key: "change_contract", label: "変更契約書", phase: "変更時", types: ["change_contract"] },
  { key: "rental_report", label: "貸与報告書", phase: "毎月", types: ["rental_report"] },
];

/** timestamptz → JST の暦日 */
export function jstYmd(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/** 出来事 date に対応する書類があるか (date − LEAD_DAYS 以降に作成) */
function coveredBy(docs: ClientDocument[], date: string): boolean {
  const from = addDays(date, -LEAD_DAYS);
  return docs.some((d) => jstYmd(d.created_at) >= from);
}

export function buildChecklist(input: ChecklistInput): ChecklistRow[] {
  const starts = input.rentals.filter((r) => r.rental_start_date).map((r) => r.rental_start_date as string).sort();
  const ends = input.rentals.filter((r) => r.rental_end_date).map((r) => r.rental_end_date as string).sort();
  const hasRental = starts.length > 0;
  const firstStart = starts[0] ?? null;
  const newStarts = starts.filter((d) => d >= DOC_CHECK_CUTOFF);
  const newEnds = ends.filter((d) => d >= DOC_CHECK_CUTOFF);
  const certChange = input.certificationStart && input.certificationStart >= DOC_CHECK_CUTOFF ? input.certificationStart : null;
  const activeNow = input.rentals.some((r) => r.status === "rental_started" && (!r.rental_end_date || r.rental_end_date >= input.today));

  return ROW_DEFS.map((def) => {
    const docs = input.docs
      .filter((d) => def.types.includes(d.type))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const base = { key: def.key, label: def.label, phase: def.phase, docs };
    if (!hasRental) return { ...base, status: docs.length ? "done" : "none", reason: docs.length ? "" : "貸与なし" } as ChecklistRow;

    switch (def.key) {
      case "contract": {
        // 最初の貸与開始に対して 1 回
        if (docs.length) return { ...base, status: "done", reason: "" };
        if (firstStart && firstStart >= DOC_CHECK_CUTOFF) return { ...base, status: "missing", reason: `${md(firstStart)} の貸与開始` };
        return { ...base, status: "paper", reason: "運用開始前からの貸与" };
      }
      case "proposal": {
        // 貸与開始のたびに (品目を選ぶたびに) 要る
        const latest = newStarts[newStarts.length - 1];
        if (!latest) return { ...base, status: docs.length ? "done" : "paper", reason: docs.length ? "" : "運用開始前からの貸与" };
        if (coveredBy(docs, latest)) return { ...base, status: "done", reason: "" };
        return { ...base, status: docs.length ? "outdated" : "missing", reason: `${md(latest)} の貸与開始` };
      }
      case "care_plan": {
        // 貸与の開始・終了、認定の切替のたびに見直す
        const events = [
          ...newStarts.map((d) => ({ d, why: `${md(d)} の貸与開始` })),
          ...newEnds.map((d) => ({ d, why: `${md(d)} の貸与終了` })),
          ...(certChange ? [{ d: certChange, why: `${md(certChange)} の認定切替` }] : []),
        ].sort((a, b) => (a.d < b.d ? -1 : 1));
        const latest = events[events.length - 1];
        if (!latest) return { ...base, status: docs.length ? "done" : "paper", reason: docs.length ? "" : "運用開始前からの貸与" };
        if (coveredBy(docs, latest.d)) return { ...base, status: "done", reason: "" };
        return { ...base, status: docs.length ? "outdated" : "missing", reason: latest.why };
      }
      case "change_contract": {
        // 最初の契約の後に品目を足したとき (2 回目以降の貸与開始)
        const additional = newStarts.filter((d) => firstStart !== null && d > firstStart);
        const latest = additional[additional.length - 1];
        if (!latest) return { ...base, status: docs.length ? "done" : "none", reason: docs.length ? "" : "追加の貸与なし" };
        if (coveredBy(docs, latest)) return { ...base, status: "done", reason: "" };
        return { ...base, status: docs.length ? "outdated" : "missing", reason: `${md(latest)} の品目追加` };
      }
      case "rental_report": {
        // 毎月出す。今月分が無くても「未作成」にはしない (月末にまとめて作るため。一覧の印も増やさない)
        const thisMonth = input.today.slice(0, 7);
        const has = docs.some((d) => jstYmd(d.created_at).slice(0, 7) === thisMonth);
        if (!activeNow) return { ...base, status: docs.length ? "done" : "none", reason: docs.length ? "" : "貸与中の品目なし" };
        return { ...base, status: has ? "done" : "none", reason: has ? "" : `${Number(thisMonth.slice(5))}月分は未作成` };
      }
    }
  });
}

/** 一覧の赤い印に数える件数 (未作成・要更新) */
export function countActionNeeded(rows: ChecklistRow[]): number {
  return rows.filter((r) => r.status === "missing" || r.status === "outdated").length;
}
