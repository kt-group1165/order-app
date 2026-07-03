"use client";

// サービス担当者会議の要点 (第4表) の帳票コンポーネント。
// スマホページ (/m/meeting) のプレビュー・印刷用。
// レイアウトは本体 MeetingNotesTab のプレビューと同一 (page.tsx 側と将来統合予定)。

import { Fragment } from "react";

export type MeetingSheetData = {
  client_name: string;
  creator_name: string | null;
  created_date: string | null;
  meeting_date: string | null;
  meeting_time: string | null;
  meeting_place: string | null;
  attendees: { affiliation: string; name: string }[];
  discussed_items: string | null;
  discussion_content: string | null;
  conclusion: string | null;
  remaining_issues: string | null;
  next_meeting: string | null;
};

const toEra = (s: string | null): string => {
  if (!s) return "";
  const date = new Date(s + "T00:00:00");
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `令和${y - 2018}年${m}月${d}日`;
  if (y > 1989) return `平成${y - 1988}年${m}月${d}日`;
  return `${y}年${m}月${d}日`;
};

export function printMeetingNoteSheet(printId = "meeting-sheet-print-content") {
  const el = document.getElementById(printId);
  if (!el) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>サービス担当者会議の要点</title><style>
    body{font-family:'Meiryo','MS PGothic',sans-serif;margin:0;padding:0}
    @page{size:A4 landscape;margin:10mm 12mm}
    table{border-collapse:collapse;width:100%}
  </style></head><body>${el.innerHTML}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
}

export function MeetingNoteSheet({ data, printId = "meeting-sheet-print-content" }: { data: MeetingSheetData; printId?: string }) {
  const cellBase: React.CSSProperties = { border: "1px solid #333", padding: "4px 6px", fontSize: "11px", verticalAlign: "top" };
  const attendeeHeadCell: React.CSSProperties = { ...cellBase, background: "#f3f4f6", fontWeight: 600, textAlign: "center", verticalAlign: "middle", whiteSpace: "nowrap", width: "20%" };
  const attendeeNameHeadCell: React.CSSProperties = { ...attendeeHeadCell, width: "13.3%" };
  // A4 横 (縦方向 約190mm ≈ 715px) に収まる行高配分
  const bodyRows: { label: string; text: string; minHeight: number }[] = [
    { label: "検討した項目", text: data.discussed_items ?? "", minHeight: 80 },
    { label: "検討内容", text: data.discussion_content ?? "", minHeight: 120 },
    { label: "結論", text: data.conclusion ?? "", minHeight: 80 },
    // 標準様式どおり1枠。旧データ (next_meeting 別枠時代) は結合して表示
    { label: "残された課題（次回の開催時期）", text: [data.remaining_issues, data.next_meeting].filter(Boolean).join("\n"), minHeight: 90 },
  ];
  const attendees = data.attendees ?? [];

  return (
    <div id={printId} style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", color: "#111" }}>
      {/* 1行目: 第4表 / タイトル / 作成年月日 */}
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "14px" }}>
        <div style={{ border: "1px solid #333", padding: "2px 10px", fontSize: "11px", whiteSpace: "nowrap" }}>第4表</div>
        <div style={{ flex: 1, textAlign: "center", fontSize: "18px", fontWeight: "bold", letterSpacing: "0.1em" }}>サービス担当者会議の要点</div>
        <div style={{ fontSize: "11px", whiteSpace: "nowrap", paddingTop: "4px" }}>作成年月日　{toEra(data.created_date)}</div>
      </div>
      {/* 2行目: 利用者名 / 作成者氏名 */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "8px", flexWrap: "wrap", gap: "4px" }}>
        <div>利用者名　<span style={{ borderBottom: "1px solid #333", padding: "0 16px", display: "inline-block", minWidth: "120px", textAlign: "center" }}>{data.client_name}</span>　様</div>
        <div>居宅サービス計画作成者氏名(担当者)氏名　<span style={{ borderBottom: "1px solid #333", padding: "0 12px", display: "inline-block", minWidth: "100px", textAlign: "center" }}>{data.creator_name ?? ""}</span></div>
      </div>
      {/* 3行目: 開催日 / 時間 / 開催場所 */}
      <div style={{ fontSize: "12px", marginBottom: "10px" }}>
        開催日　{toEra(data.meeting_date)}　　時間　{data.meeting_time ?? ""}　　開催場所　{data.meeting_place ?? ""}
      </div>
      {/* 会議出席者表: 3ペア × 2行 = 6名 */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "10px" }}>
        <thead>
          <tr>
            {[0, 1, 2].map((i) => (
              <Fragment key={i}>
                <th style={attendeeHeadCell}>所属(職種)</th>
                <th style={attendeeNameHeadCell}>氏名</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1].map((row) => (
            <tr key={row}>
              {[0, 1, 2].map((col) => {
                const a = attendees[row * 3 + col] ?? { affiliation: "", name: "" };
                return (
                  <Fragment key={col}>
                    <td style={{ ...cellBase, height: "28px" }}>{a.affiliation}</td>
                    <td style={{ ...cellBase, height: "28px" }}>{a.name}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 本文表 */}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {bodyRows.map(({ label, text, minHeight }) => (
            <tr key={label}>
              <td style={{ ...cellBase, width: "110px", background: "#f3f4f6", fontWeight: 600, textAlign: "center", verticalAlign: "middle" }}>{label}</td>
              <td style={cellBase}>
                <div style={{ whiteSpace: "pre-wrap", minHeight: `${minHeight}px`, lineHeight: 1.7 }}>{text}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
