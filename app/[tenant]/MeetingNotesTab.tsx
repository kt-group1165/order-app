"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { Search, X, Plus, Loader2, Pencil, Trash2, ArrowLeft, Printer } from "lucide-react";
import { todayYmd, toJapaneseEra } from "@/lib/date-jst";
import { listMeetingNotes, saveMeetingNote, deleteMeetingNote, type ServiceMeetingNote, type MeetingAttendee } from "@/lib/meetingNotes";

// ─── サービス担当者会議の要点 (第4表) ─────────────────────────

const MEETING_NOTE_DEFAULTS = {
  discussedItems: "居宅サービス計画書原案について\n①全体の援助方針について\n②サービス内容について",
  discussionContent: "総合的援助の方針、援助目標についての確認",
  conclusion: "居宅サービス計画の原案通りに進める",
  // 「残された課題（次回の開催時期）」は標準様式どおり1枠
  remainingIssues: "モニタリングの上、計画変更がある場合に開催する。",
};

function emptyMeetingAttendees(): MeetingAttendee[] {
  return Array.from({ length: 6 }, () => ({ affiliation: "", name: "" }));
}

export default function MeetingNotesTab({ tenantId, currentOfficeId, currentOfficeName, officeViewAll }: { tenantId: string; currentOfficeId: string | null; currentOfficeName: string | null; officeViewAll: boolean }) {
  const [view, setView] = useState<"list" | "edit" | "preview">("list");
  const [notes, setNotes] = useState<ServiceMeetingNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // 一覧検索: 利用者名・事業所・日付・出席者・検討内容 等を横断部分一致
  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => {
      const hay = [
        n.client_name, n.office_label, n.creator_name, n.meeting_date, n.created_date,
        n.meeting_place, n.discussed_items, n.discussion_content, n.conclusion, n.remaining_issues,
        ...(Array.isArray(n.attendees) ? n.attendees.flatMap((a) => [a.affiliation, a.name]) : []),
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [notes, search]);

  // ── 編集フォーム state ──
  const todayStr = todayYmd();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [createdDate, setCreatedDate] = useState(todayStr);
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingPlace, setMeetingPlace] = useState("自宅");
  const [attendees, setAttendees] = useState<MeetingAttendee[]>(emptyMeetingAttendees());
  const [discussedItems, setDiscussedItems] = useState(MEETING_NOTE_DEFAULTS.discussedItems);
  const [discussionContent, setDiscussionContent] = useState(MEETING_NOTE_DEFAULTS.discussionContent);
  const [conclusion, setConclusion] = useState(MEETING_NOTE_DEFAULTS.conclusion);
  const [remainingIssues, setRemainingIssues] = useState(MEETING_NOTE_DEFAULTS.remainingIssues);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      // 他タブと同様: 自事業所のみ (officeViewAll=false) は currentOfficeId で絞り込む
      const officeFilter = officeViewAll ? null : currentOfficeId;
      setNotes(await listMeetingNotes(tenantId, officeFilter));
    } catch (e) {
      console.error("meeting notes load failed:", e);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tenantId, currentOfficeId, officeViewAll]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { loadNotes(); }, [loadNotes]);

  const startNew = () => {
    setEditingId(null);
    setClientName("");
    setCreatorName("");
    setCreatedDate(todayStr);
    setMeetingDate("");
    setMeetingTime("");
    setMeetingPlace("自宅");
    setAttendees(emptyMeetingAttendees());
    setDiscussedItems(MEETING_NOTE_DEFAULTS.discussedItems);
    setDiscussionContent(MEETING_NOTE_DEFAULTS.discussionContent);
    setConclusion(MEETING_NOTE_DEFAULTS.conclusion);
    setRemainingIssues(MEETING_NOTE_DEFAULTS.remainingIssues);
    setView("edit");
  };

  const startEdit = (n: ServiceMeetingNote) => {
    setEditingId(n.id ?? null);
    setClientName(n.client_name ?? "");
    setCreatorName(n.creator_name ?? "");
    setCreatedDate(n.created_date ?? "");
    setMeetingDate(n.meeting_date ?? "");
    setMeetingTime(n.meeting_time ?? "");
    setMeetingPlace(n.meeting_place ?? "");
    const rows = Array.isArray(n.attendees) ? n.attendees : [];
    setAttendees(Array.from({ length: 6 }, (_, i) => ({
      affiliation: rows[i]?.affiliation ?? "",
      name: rows[i]?.name ?? "",
    })));
    setDiscussedItems(n.discussed_items ?? "");
    setDiscussionContent(n.discussion_content ?? "");
    setConclusion(n.conclusion ?? "");
    // 旧データ互換: 別枠だった next_meeting は「残された課題（次回の開催時期）」に結合
    setRemainingIssues([n.remaining_issues, n.next_meeting].filter(Boolean).join("\n"));
    setView("edit");
  };

  const updateAttendee = (idx: number, field: keyof MeetingAttendee, value: string) => {
    setAttendees((prev) => prev.map((a, i) => (i === idx ? { ...a, [field]: value } : a)));
  };

  const goPreview = () => {
    if (!clientName.trim()) {
      alert("利用者名を入力してください");
      return;
    }
    setView("preview");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveMeetingNote({
        id: editingId ?? undefined,
        tenant_id: tenantId,
        client_id: null, // 将来の利用者連動用 (現状は手入力運用)
        // 新規時のみ反映 (update 側は office を変更しない)。自事業所を付与
        office_id: currentOfficeId,
        office_label: currentOfficeName,
        client_name: clientName.trim(),
        creator_name: creatorName,
        created_date: createdDate,
        meeting_date: meetingDate,
        meeting_time: meetingTime,
        meeting_place: meetingPlace,
        attendees: attendees.filter((a) => a.affiliation.trim() || a.name.trim()),
        discussed_items: discussedItems,
        discussion_content: discussionContent,
        conclusion,
        remaining_issues: remainingIssues,
        next_meeting: null, // 標準様式どおり「残された課題（次回の開催時期）」1枠に統合
      });
      setView("list");
      await loadNotes();
    } catch (e) {
      console.error("meeting note save failed:", e);
      alert(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (n: ServiceMeetingNote) => {
    if (!n.id) return;
    if (!confirm(`「${n.client_name || "(利用者名なし)"}」の会議録を削除しますか？`)) return;
    setDeletingId(n.id);
    try {
      await deleteMeetingNote(n.id);
      await loadNotes();
    } catch (e) {
      console.error("meeting note delete failed:", e);
      alert(`削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handlePrint = () => {
    const el = document.getElementById("meeting-note-print-content");
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
  };

  // 和暦表示 ("YYYY-MM-DD" → "令和N年N月N日")
  const jaDate = (s: string) => (s ? toJapaneseEra(new Date(s + "T00:00:00")) : "");

  const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400";

  // ── 一覧 ──
  if (view === "list") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-800 shrink-0">サービス担当者会議の要点 (第4表)</h2>
          <div className="relative flex-1 max-w-xs ml-auto">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="利用者名・事業所・日付・内容で検索"
              className="w-full border border-gray-200 rounded-lg pl-8 pr-7 py-1.5 text-xs outline-none focus:border-emerald-400"
            />
            {search && (
              <button onClick={() => setSearch("")} title="クリア"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                <X size={13} />
              </button>
            )}
          </div>
          <button onClick={startNew}
            className="flex items-center gap-1 text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg shrink-0">
            <Plus size={14} /> 新規作成
          </button>
        </div>
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <Loader2 size={28} className="animate-spin text-emerald-400" />
          </div>
        ) : listError ? (
          <div className="p-4">
            <p className="text-sm text-red-500">読み込みに失敗しました: {listError}</p>
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">会議録がありません。「新規作成」から作成してください</p>
        ) : filteredNotes.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">「{search}」に一致する会議録がありません</p>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-4xl mx-auto space-y-1">
              {filteredNotes.map((n) => (
                <div key={n.id}
                  onClick={() => startEdit(n)}
                  title="クリックで編集"
                  className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 flex items-center justify-between cursor-pointer hover:border-emerald-300 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-gray-800 truncate">{n.client_name || "(利用者名なし)"}<span className="font-normal text-gray-400 ml-0.5">様</span></span>
                    {n.office_label && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 shrink-0">{n.office_label}</span>}
                    {n.meeting_date && <span className="text-xs text-gray-500 shrink-0">開催日: {n.meeting_date}</span>}
                    {n.created_date && <span className="text-xs text-gray-400 shrink-0">作成: {n.created_date}</span>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); startEdit(n); }}
                      className="p-1.5 text-gray-300 hover:text-emerald-500 rounded-lg"
                      title="編集">
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(n); }}
                      disabled={deletingId === n.id}
                      className="p-1.5 text-gray-300 hover:text-red-500 rounded-lg disabled:opacity-50"
                      title="削除">
                      {deletingId === n.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 編集フォーム ──
  if (view === "edit") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setView("list")} className="p-1.5 hover:bg-gray-100 rounded-lg" title="一覧へ戻る">
              <ArrowLeft size={16} className="text-gray-500" />
            </button>
            <h2 className="font-semibold text-gray-800">担当者会議録 {editingId ? "編集" : "新規作成"}</h2>
          </div>
          <button onClick={goPreview}
            className="text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg">
            プレビュー →
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">利用者名 <span className="text-red-500">*</span></label>
                <input type="text" value={clientName} onChange={(e) => setClientName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">居宅サービス計画作成者氏名 (担当者)</label>
                <input type="text" value={creatorName} onChange={(e) => setCreatorName(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">作成年月日</label>
                <input type="date" value={createdDate} onChange={(e) => setCreatedDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">開催日</label>
                <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">時間</label>
                <input type="text" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} placeholder="14:00〜15:00" className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">開催場所</label>
                <input type="text" value={meetingPlace} onChange={(e) => setMeetingPlace(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">会議出席者 (最大6名)</label>
              <div className="space-y-2 mt-1">
                {attendees.map((a, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <input type="text" value={a.affiliation}
                      onChange={(e) => updateAttendee(i, "affiliation", e.target.value)}
                      placeholder={i === 0 ? "ケアマネージャー" : i === 1 ? "福祉用具" : "所属(職種)"}
                      className={inputCls} />
                    <input type="text" value={a.name}
                      onChange={(e) => updateAttendee(i, "name", e.target.value)}
                      placeholder="氏名"
                      className={inputCls} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">検討した項目</label>
              <textarea rows={3} value={discussedItems} onChange={(e) => setDiscussedItems(e.target.value)} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className="text-xs text-gray-500">検討内容</label>
              <textarea rows={2} value={discussionContent} onChange={(e) => setDiscussionContent(e.target.value)} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className="text-xs text-gray-500">結論</label>
              <textarea rows={2} value={conclusion} onChange={(e) => setConclusion(e.target.value)} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className="text-xs text-gray-500">残された課題（次回の開催時期）</label>
              <textarea rows={3} value={remainingIssues} onChange={(e) => setRemainingIssues(e.target.value)} className={`${inputCls} resize-none`} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── プレビュー (第4表帳票) ──
  const cellBase: React.CSSProperties = { border: "1px solid #333", padding: "4px 6px", fontSize: "11px", verticalAlign: "top" };
  const attendeeHeadCell: React.CSSProperties = { ...cellBase, background: "#f3f4f6", fontWeight: 600, textAlign: "center", verticalAlign: "middle", whiteSpace: "nowrap", width: "20%" };
  const attendeeNameHeadCell: React.CSSProperties = { ...attendeeHeadCell, width: "13.3%" };
  // A4 横 (縦方向 約190mm ≈ 715px) に収まる行高配分
  const bodyRows: { label: string; text: string; minHeight: number }[] = [
    { label: "検討した項目", text: discussedItems, minHeight: 80 },
    { label: "検討内容", text: discussionContent, minHeight: 120 },
    { label: "結論", text: conclusion, minHeight: 80 },
    { label: "残された課題（次回の開催時期）", text: remainingIssues, minHeight: 90 },
  ];
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => setView("edit")} className="p-1.5 hover:bg-gray-100 rounded-lg" title="編集に戻る">
            <ArrowLeft size={16} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800">プレビュー — サービス担当者会議の要点</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1 text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} 保存
          </button>
          <button onClick={handlePrint}
            className="flex items-center gap-1 text-xs text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg">
            <Printer size={14} /> 印刷
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-6xl mx-auto bg-white rounded-xl border border-gray-200 shadow-sm p-8 overflow-x-auto">
          <div id="meeting-note-print-content" style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", color: "#111", minWidth: "960px" }}>
            {/* 1行目: 第4表 / タイトル / 作成年月日 */}
            <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "14px" }}>
              <div style={{ border: "1px solid #333", padding: "2px 10px", fontSize: "11px", whiteSpace: "nowrap" }}>第4表</div>
              <div style={{ flex: 1, textAlign: "center", fontSize: "18px", fontWeight: "bold", letterSpacing: "0.1em" }}>サービス担当者会議の要点</div>
              <div style={{ fontSize: "11px", whiteSpace: "nowrap", paddingTop: "4px" }}>作成年月日　{jaDate(createdDate)}</div>
            </div>
            {/* 2行目: 利用者名 / 作成者氏名 */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "8px" }}>
              <div>利用者名　<span style={{ borderBottom: "1px solid #333", padding: "0 16px", display: "inline-block", minWidth: "120px", textAlign: "center" }}>{clientName}</span>　様</div>
              <div>居宅サービス計画作成者氏名(担当者)氏名　<span style={{ borderBottom: "1px solid #333", padding: "0 12px", display: "inline-block", minWidth: "100px", textAlign: "center" }}>{creatorName}</span></div>
            </div>
            {/* 3行目: 開催日 / 時間 / 開催場所 */}
            <div style={{ fontSize: "12px", marginBottom: "10px" }}>
              開催日　{jaDate(meetingDate)}　　時間　{meetingTime}　　開催場所　{meetingPlace}
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
        </div>
      </div>
    </div>
  );
}
