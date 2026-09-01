"use client";

import { useState, useEffect, useRef } from "react";
import { Bell, Loader2, ArrowLeft, Printer, FileText, ChevronRight, Check } from "lucide-react";
import {
  getNotifications,
  getSharedDocument,
  markRead,
  markSharedDocumentRead,
  type NotificationRow,
  type SharedDocumentRow,
} from "@/lib/notifications";

// 受信通知一覧 + 受信書類 view (iframe sandbox + 印刷)。
export default function NotificationsTab({ currentOfficeId }: { currentOfficeId: string | null }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<SharedDocumentRow | null>(null);
  const markedRef = useRef<Set<string>>(new Set());

  const reload = async () => {
    if (!currentOfficeId) { setRows([]); setLoading(false); return; }
    const data = await getNotifications(currentOfficeId);
    setRows(data);
    setLoading(false);
  };
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!currentOfficeId) {
        if (!cancelled) { setRows([]); setLoading(false); }
        return;
      }
      const data = await getNotifications(currentOfficeId);
      if (!cancelled) { setRows(data); setLoading(false); }
    };
    void run();
    return () => { cancelled = true; };
  }, [currentOfficeId]);

  const handleMarkRead = async (id: string) => {
    setMarking(id);
    await markRead(id);
    setRows(prev => prev.map(r => r.id === id ? { ...r, read_at: new Date().toISOString() } : r));
    setMarking(null);
  };

  const openDocFromRow = async (row: NotificationRow) => {
    if (!row.ref_id) return;
    const doc = await getSharedDocument(row.ref_id);
    if (doc) {
      setOpenDoc(doc);
      // 関連 notification + shared_document の read_at を 1 度だけ update
      if (!markedRef.current.has(doc.id)) {
        markedRef.current.add(doc.id);
        if (!doc.read_at) await markSharedDocumentRead(doc.id);
        if (!row.read_at) await markRead(row.id);
        await reload();
      }
    }
  };

  const unread = rows.filter(r => !r.read_at);
  const read = rows.filter(r => r.read_at);

  if (!currentOfficeId) {
    return <div className="flex items-center justify-center py-20 text-gray-500 text-sm">事業所を選択してください</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <Bell size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">通知</h2>
        {loading && <Loader2 size={14} className="animate-spin text-gray-400" />}
        <span className="ml-auto text-xs text-gray-500">未読 {unread.length} / 既読 {read.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 max-w-4xl mx-auto w-full">
        <section>
          <h3 className="text-sm font-semibold text-red-700 mb-2">未読 ({unread.length})</h3>
          {unread.length === 0 ? (
            <div className="rounded border bg-gray-50 px-4 py-6 text-center text-xs text-gray-500">未読の通知はありません</div>
          ) : (
            <ul className="divide-y rounded border bg-white">
              {unread.map(row => (
                <NotificationRowItem key={row.id} row={row} marking={marking === row.id} onOpen={() => openDocFromRow(row)} onMarkRead={() => handleMarkRead(row.id)} />
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="text-sm font-semibold text-gray-600 mb-2">既読 ({read.length})</h3>
          {read.length === 0 ? (
            <div className="rounded border bg-gray-50 px-4 py-6 text-center text-xs text-gray-500">既読の通知はありません</div>
          ) : (
            <ul className="divide-y rounded border bg-white">
              {read.map(row => (
                <NotificationRowItem key={row.id} row={row} marking={false} onOpen={() => openDocFromRow(row)} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 受信書類 view modal */}
      {openDoc && (
        <div className="fixed inset-0 bg-black/60 z-[80] flex flex-col">
          <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 shrink-0">
            <button onClick={() => setOpenDoc(null)} className="text-gray-500 hover:text-gray-700"><ArrowLeft size={18} /></button>
            <span className="font-semibold text-sm text-gray-800 flex-1 truncate">{openDoc.title}</span>
            <span className="text-[11px] text-gray-500">{openDoc.sent_at?.slice(0, 16).replace("T", " ")}</span>
            <button
              onClick={() => {
                const iframe = document.getElementById("shared-doc-iframe") as HTMLIFrameElement | null;
                if (iframe?.contentWindow) iframe.contentWindow.print();
                else window.print();
              }}
              className="text-xs bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1 rounded flex items-center gap-1"
            >
              <Printer size={12} /> 印刷
            </button>
          </div>
          <iframe
            id="shared-doc-iframe"
            srcDoc={openDoc.html_content}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="flex-1 border-0 bg-white"
            title={openDoc.title}
          />
        </div>
      )}
    </div>
  );
}

function NotificationRowItem({ row, marking, onOpen, onMarkRead }: { row: NotificationRow; marking: boolean; onOpen: () => void; onMarkRead?: () => void }) {
  const isDoc = row.type === "document_received" && row.ref_table === "shared_documents" && !!row.ref_id;
  return (
    <li className={`flex items-start gap-3 px-4 py-3 ${isDoc ? "cursor-pointer hover:bg-blue-50" : ""}`} onClick={isDoc ? onOpen : undefined}>
      <div className="mt-0.5 text-gray-400">{isDoc ? <FileText size={18} /> : <Bell size={18} />}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{row.title}</div>
        {row.body && <div className="mt-0.5 text-xs text-gray-600 line-clamp-2">{row.body}</div>}
        <div className="mt-1 text-[11px] text-gray-400">
          {row.created_at?.slice(0, 16).replace("T", " ")}
          {row.read_at && <span className="ml-2 text-gray-400">既読 {row.read_at.slice(0, 16).replace("T", " ")}</span>}
        </div>
      </div>
      {isDoc && (
        <button onClick={(e) => { e.stopPropagation(); onOpen(); }} className="flex shrink-0 items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">
          内容を見る
          <ChevronRight size={12} />
        </button>
      )}
      {!row.read_at && onMarkRead && (
        <button disabled={marking} onClick={(e) => { e.stopPropagation(); onMarkRead(); }} className="flex shrink-0 items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {marking ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          既読
        </button>
      )}
    </li>
  );
}
