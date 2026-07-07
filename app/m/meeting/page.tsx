"use client";

// スマホ用: サービス担当者会議の要点 (第4表) 入力フォーム。
// URL: /m/meeting?key=<MEETING_FORM_KEY>
// 送信すると /api/meeting-submit 経由で service_meeting_notes に保存され、
// 本体アプリの「担当者会議録」一覧に表示される。

import { useEffect, useState } from "react";
import { MeetingNoteSheet, printMeetingNoteSheet } from "@/components/MeetingNoteSheet";

const DEFAULTS = {
  discussed_items: "居宅サービス計画書原案について\n①全体の援助方針について\n②サービス内容について",
  discussion_content: "総合的援助の方針、援助目標についての確認",
  conclusion: "居宅サービス計画の原案通りに進める",
  // 「残された課題（次回の開催時期）」は標準様式どおり1枠
  remaining_issues: "モニタリングの上、計画変更がある場合に開催する。",
};

const todayStr = () => new Date().toISOString().slice(0, 10);

// 事業所 slug → 表示名 (id の解決・検証はサーバー側 /api/meeting-submit が行う)
const OFFICE_LABELS: Record<string, string> = {
  "caresupo": "ケア・サポート千葉",
  "hana-mutsumi": "Ｈａｎａムツミ福祉用具",
  "takashina": "千葉ムツミ福祉用具高品",
  "hanamigawa": "Ｈａｎａ福祉用具花見川",
  "links": "リンクス福祉用具",
};

type SavedNote = {
  id: string;
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
  created_at: string;
};

export default function MobileMeetingPage() {
  const [key, setKey] = useState<string | null>(null);
  const [office, setOffice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"form" | "list">("form");
  const [notes, setNotes] = useState<SavedNote[] | null>(null);
  const [listError, setListError] = useState("");
  const [detail, setDetail] = useState<SavedNote | null>(null);

  const [clientName, setClientName] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [createdDate, setCreatedDate] = useState(todayStr());
  const [meetingDate, setMeetingDate] = useState(todayStr());
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingPlace, setMeetingPlace] = useState("自宅");
  const [attendees, setAttendees] = useState<{ affiliation: string; name: string }[]>(
    Array.from({ length: 6 }, () => ({ affiliation: "", name: "" }))
  );
  const [discussedItems, setDiscussedItems] = useState(DEFAULTS.discussed_items);
  const [discussionContent, setDiscussionContent] = useState(DEFAULTS.discussion_content);
  const [conclusion, setConclusion] = useState(DEFAULTS.conclusion);
  const [remainingIssues, setRemainingIssues] = useState(DEFAULTS.remaining_issues);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // 編集中の会議録 id (null=新規)
  const [listSearch, setListSearch] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time init: URL クエリ読み取り)
    setKey(params.get("key"));
    setOffice(params.get("office"));
    setReady(true);
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setClientName("");
    setCreatorName("");
    setCreatedDate(todayStr());
    setMeetingDate(todayStr());
    setMeetingTime("");
    setMeetingPlace("自宅");
    setAttendees(Array.from({ length: 6 }, () => ({ affiliation: "", name: "" })));
    setDiscussedItems(DEFAULTS.discussed_items);
    setDiscussionContent(DEFAULTS.discussion_content);
    setConclusion(DEFAULTS.conclusion);
    setRemainingIssues(DEFAULTS.remaining_issues);
    setDone(false);
    setError("");
  };

  // 既存の会議録を編集フォームに読み込む
  const startEdit = (n: SavedNote) => {
    setEditingId(n.id);
    setClientName(n.client_name ?? "");
    setCreatorName(n.creator_name ?? "");
    setCreatedDate(n.created_date ?? todayStr());
    setMeetingDate(n.meeting_date ?? "");
    setMeetingTime(n.meeting_time ?? "");
    setMeetingPlace(n.meeting_place ?? "自宅");
    const rows = Array.isArray(n.attendees) ? n.attendees : [];
    setAttendees(Array.from({ length: 6 }, (_, i) => ({
      affiliation: rows[i]?.affiliation ?? "",
      name: rows[i]?.name ?? "",
    })));
    setDiscussedItems(n.discussed_items ?? "");
    setDiscussionContent(n.discussion_content ?? "");
    setConclusion(n.conclusion ?? "");
    setRemainingIssues([n.remaining_issues, n.next_meeting].filter(Boolean).join("\n"));
    setError("");
    setDone(false);
    setDetail(null);
    setView("form");
  };

  const loadNotes = async (k: string) => {
    setListError("");
    setNotes(null);
    try {
      const res = await fetch(`/api/meeting-submit?key=${encodeURIComponent(k)}${office ? `&office=${encodeURIComponent(office)}` : ""}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListError(data.error ?? "取得に失敗しました");
        setNotes([]);
        return;
      }
      setNotes(data.notes ?? []);
    } catch {
      setListError("通信エラーが発生しました");
      setNotes([]);
    }
  };

  const openList = () => {
    setView("list");
    setDetail(null);
    if (key) loadNotes(key);
  };

  // 会議録の削除 (確認警告付き)。
  const handleDelete = async (n: SavedNote) => {
    if (!key) return;
    if (!window.confirm(`${n.client_name} 様の会議録（開催日 ${n.meeting_date ?? "―"}）を削除します。\nこの操作は取り消せません。よろしいですか？`)) return;
    try {
      const res = await fetch(
        `/api/meeting-submit?key=${encodeURIComponent(key)}&id=${encodeURIComponent(n.id)}${office ? `&office=${encodeURIComponent(office)}` : ""}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListError(data.error ?? "削除に失敗しました");
        return;
      }
      setNotes((prev) => (prev ? prev.filter((x) => x.id !== n.id) : prev));
      if (detail?.id === n.id) setDetail(null);
    } catch {
      setListError("通信エラーが発生しました");
    }
  };

  const handleSubmit = async () => {
    if (!clientName.trim()) { setError("利用者名を入力してください"); return; }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/meeting-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          office,
          id: editingId,
          client_name: clientName,
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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "送信に失敗しました");
        return;
      }
      setDone(true);
    } catch {
      setError("通信エラーが発生しました。電波状況を確認して再送信してください。");
    } finally {
      setSending(false);
    }
  };

  if (!ready) return null;

  if (!key) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <p className="text-sm text-gray-500 text-center">URLが正しくありません。<br />管理者から共有されたリンクを開いてください。</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 gap-4">
        <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center text-2xl">✓</div>
        <p className="text-base font-semibold text-gray-800">{editingId ? "更新しました" : "送信しました"}</p>
        <p className="text-xs text-gray-500">担当者会議録として保存されました。</p>
        <button onClick={resetForm} className="mt-2 px-6 py-3 bg-emerald-500 text-white text-sm font-medium rounded-xl">
          続けて入力する
        </button>
        <button onClick={() => { setDone(false); openList(); }} className="px-6 py-3 border border-gray-300 text-gray-600 text-sm font-medium rounded-xl bg-white">
          一覧を見る
        </button>
      </div>
    );
  }

  // ヘッダー (入力/一覧 切替)
  const header = (
    <header className="bg-emerald-600 text-white px-4 py-3 sticky top-0 z-10 flex items-center justify-between">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold">担当者会議録（第4表）</h1>
        {office && OFFICE_LABELS[office] && (
          <p className="text-[11px] text-emerald-100 truncate">{OFFICE_LABELS[office]}</p>
        )}
      </div>
      <div className="flex gap-1 bg-emerald-700/60 rounded-lg p-0.5">
        <button
          onClick={() => setView("form")}
          className={`px-3 py-1 text-xs font-medium rounded-md ${view === "form" ? "bg-white text-emerald-700" : "text-emerald-50"}`}
        >
          入力
        </button>
        <button
          onClick={openList}
          className={`px-3 py-1 text-xs font-medium rounded-md ${view === "list" ? "bg-white text-emerald-700" : "text-emerald-50"}`}
        >
          一覧
        </button>
      </div>
    </header>
  );

  if (view === "list") {
    return (
      <div className="min-h-screen bg-gray-50">
        {header}
        <div className={detail ? "p-4 max-w-6xl mx-auto" : "p-4 max-w-lg mx-auto space-y-2"}>
          {detail ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <button onClick={() => setDetail(null)} className="text-sm text-emerald-700 font-medium">← 一覧に戻る</button>
                <div className="flex gap-2">
                  <button
                    onClick={() => detail && startEdit(detail)}
                    className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => printMeetingNoteSheet()}
                    className="px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded-xl"
                  >
                    印刷
                  </button>
                </div>
              </div>
              {/* 第4表プレビュー (A4 横想定。狭い画面では横スクロール) */}
              <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6 overflow-x-auto">
                <div className="min-w-[1000px]">
                  <MeetingNoteSheet data={detail} />
                </div>
              </div>
            </div>
          ) : notes === null ? (
            <p className="text-sm text-gray-400 text-center py-12">読み込み中...</p>
          ) : (
            <>
              {listError && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{listError}</p>}
              {notes.length === 0 && !listError && (
                <p className="text-sm text-gray-400 text-center py-12">まだ会議録がありません</p>
              )}
              {notes.length > 0 && (
                <input
                  type="text"
                  value={listSearch}
                  onChange={(e) => setListSearch(e.target.value)}
                  placeholder="利用者名・日付・内容で検索"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base outline-none focus:border-emerald-400 bg-white"
                />
              )}
              {(() => {
                const q = listSearch.trim().toLowerCase();
                const filtered = q
                  ? notes.filter((n) => [
                      n.client_name, n.creator_name, n.meeting_date, n.created_date, n.meeting_place,
                      n.discussed_items, n.discussion_content, n.conclusion, n.remaining_issues,
                      ...(Array.isArray(n.attendees) ? n.attendees.flatMap((a) => [a.affiliation, a.name]) : []),
                    ].filter(Boolean).join(" ").toLowerCase().includes(q))
                  : notes;
                if (notes.length > 0 && filtered.length === 0) {
                  return <p className="text-sm text-gray-400 text-center py-12">「{listSearch}」に一致する会議録がありません</p>;
                }
                return filtered.map((n) => (
                  <div
                    key={n.id}
                    className="flex items-stretch bg-white rounded-2xl border border-gray-200 overflow-hidden"
                  >
                    <button
                      onClick={() => setDetail(n)}
                      className="flex-1 min-w-0 text-left px-4 py-3 active:bg-gray-50"
                    >
                      <p className="text-sm font-semibold text-gray-800 truncate">{n.client_name} 様</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        開催日 {n.meeting_date ?? "―"}　作成 {n.created_date ?? n.created_at.slice(0, 10)}
                      </p>
                    </button>
                    <div className="flex items-center gap-2 shrink-0 pl-1 pr-3">
                      <button
                        onClick={() => startEdit(n)}
                        className="rounded-full border border-emerald-300 bg-emerald-50 px-4 py-1.5 text-xs font-medium text-emerald-700 active:bg-emerald-100"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDelete(n)}
                        className="rounded-full border border-red-300 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 active:bg-red-100"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                ));
              })()}
            </>
          )}
        </div>
      </div>
    );
  }

  const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base outline-none focus:border-emerald-400 bg-white";
  const labelCls = "text-xs font-medium text-gray-500 block mb-1";

  return (
    <div className="min-h-screen bg-gray-50">
      {header}
      <div className="p-4 space-y-4 max-w-lg mx-auto pb-28">
        {editingId && (
          <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            <span className="text-xs text-amber-700 font-medium">既存の会議録を編集中</span>
            <button onClick={resetForm} className="text-xs text-amber-700 underline">新規に切替</button>
          </div>
        )}
        <div>
          <label className={labelCls}>利用者名 *</label>
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="例：山田 太郎" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>居宅サービス計画作成者（担当者）氏名</label>
          <input value={creatorName} onChange={(e) => setCreatorName(e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>作成年月日</label>
            <input type="date" value={createdDate} onChange={(e) => setCreatedDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>開催日</label>
            <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>時間</label>
            <input value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} placeholder="14:00〜15:00" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>開催場所</label>
            <input value={meetingPlace} onChange={(e) => setMeetingPlace(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>会議出席者（所属・氏名）</label>
          <div className="space-y-2">
            {attendees.map((a, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <input
                  value={a.affiliation}
                  onChange={(e) => setAttendees((prev) => prev.map((x, j) => j === i ? { ...x, affiliation: e.target.value } : x))}
                  placeholder={i === 0 ? "ケアマネージャー" : i === 1 ? "福祉用具" : "所属(職種)"}
                  className={inputCls}
                />
                <input
                  value={a.name}
                  onChange={(e) => setAttendees((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  placeholder="氏名"
                  className={inputCls}
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className={labelCls}>検討した項目</label>
          <textarea value={discussedItems} onChange={(e) => setDiscussedItems(e.target.value)} rows={3} className={`${inputCls} resize-none`} />
        </div>
        <div>
          <label className={labelCls}>検討内容</label>
          <textarea value={discussionContent} onChange={(e) => setDiscussionContent(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div>
          <label className={labelCls}>結論</label>
          <textarea value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div>
          <label className={labelCls}>残された課題（次回の開催時期）</label>
          <textarea value={remainingIssues} onChange={(e) => setRemainingIssues(e.target.value)} rows={3} className={`${inputCls} resize-none`} />
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{error}</p>
        )}
      </div>

      {/* 送信バー (固定) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-3">
        <div className="max-w-lg mx-auto">
          <button
            onClick={handleSubmit}
            disabled={sending}
            className="w-full py-3.5 bg-emerald-500 text-white text-base font-semibold rounded-xl disabled:opacity-50"
          >
            {sending ? (editingId ? "更新中..." : "送信中...") : (editingId ? "更新する" : "送信する")}
          </button>
        </div>
      </div>
    </div>
  );
}
