"use client";

// 書類画面の右側: 書類の種類ごとに「状態・最新・操作」を 1 行で出す。
// 状態の決め方は lib/docChecklist.ts (純関数・check:doc-checklist で検証)。

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Plus } from "lucide-react";
import type { ClientDocument } from "@/lib/supabase";
import { jstYmd, type ChecklistKey, type ChecklistRow, type ChecklistStatus } from "@/lib/docChecklist";

const STATUS_STYLE: Record<ChecklistStatus, { label: string; cls: string }> = {
  missing: { label: "未作成", cls: "bg-red-50 text-red-700 border-red-200" },
  outdated: { label: "要更新", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  done: { label: "作成済み", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paper: { label: "移行前 (紙)", cls: "bg-gray-50 text-gray-500 border-gray-200" },
  none: { label: "—", cls: "bg-white text-gray-400 border-gray-200" },
};

const fmt = (ts: string) => {
  const d = jstYmd(ts);
  return `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
};

export default function DocChecklistPanel({
  rows,
  otherDocs,
  onCreate,
  onOpen,
  onDelete,
}: {
  rows: ChecklistRow[];
  /** チェックリストに入らない書類 (発注メール等) */
  otherDocs: ClientDocument[];
  onCreate: (key: ChecklistKey) => void;
  onOpen: (doc: ClientDocument) => void;
  onDelete: (doc: ClientDocument) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((prev) => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const phases = ["契約時", "変更時", "毎月"] as const;

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-[11px] text-gray-500">
          <tr>
            <th className="text-left font-medium px-3 py-2">書類</th>
            <th className="text-left font-medium px-2 py-2 w-28">状態</th>
            <th className="text-left font-medium px-2 py-2">理由・最新</th>
            <th className="px-3 py-2 w-40" />
          </tr>
        </thead>
        <tbody>
          {phases.map((phase) => {
            const list = rows.filter((r) => r.phase === phase);
            if (list.length === 0) return null;
            return [
              <tr key={`h-${phase}`} className="bg-gray-50/60">
                <td colSpan={4} className="px-3 py-1 text-[11px] font-semibold text-gray-500 border-t border-gray-100">{phase}</td>
              </tr>,
              ...list.flatMap((r) => {
                const st = STATUS_STYLE[r.status];
                const latest = r.docs[0];
                const isOpen = open.has(r.key);
                const main = (
                  <tr key={r.key} className="border-t border-gray-100">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => r.docs.length > 0 && toggle(r.key)}
                        className={`inline-flex items-center gap-1 font-medium text-gray-800 ${r.docs.length ? "hover:text-blue-700" : "cursor-default"}`}
                        title={r.docs.length ? "作成した書類の一覧" : undefined}
                      >
                        {r.docs.length ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="w-[14px]" />}
                        {r.label}
                        {r.docs.length > 1 && <span className="text-[10px] text-gray-400 font-normal">({r.docs.length})</span>}
                      </button>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-2 py-2 text-xs text-gray-600">
                      {r.reason && <span className={r.status === "missing" || r.status === "outdated" ? "text-gray-800" : ""}>{r.reason}</span>}
                      {latest && <span className="text-gray-400">{r.reason ? "　" : ""}最新 {fmt(latest.created_at)}</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {latest && (
                        <button onClick={() => onOpen(latest)} className="text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50 mr-1">
                          開く
                        </button>
                      )}
                      <button
                        onClick={() => onCreate(r.key)}
                        className={`text-xs px-2.5 py-1 rounded-lg inline-flex items-center gap-0.5 ${
                          r.status === "missing" || r.status === "outdated"
                            ? "bg-blue-600 text-white hover:bg-blue-700"
                            : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        <Plus size={12} />作成
                      </button>
                    </td>
                  </tr>
                );
                if (!isOpen) return [main];
                return [
                  main,
                  ...r.docs.map((d) => (
                    <tr key={d.id} className="bg-gray-50/40">
                      <td className="pl-9 pr-3 py-1.5 text-xs text-gray-700 truncate max-w-[260px]" colSpan={2} title={d.title}>
                        <FileText size={12} className="inline -mt-0.5 mr-1 text-gray-400" />{d.title}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-gray-400">{fmt(d.created_at)}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <button onClick={() => onOpen(d)} className="text-[11px] text-blue-600 hover:underline mr-2">開く</button>
                        <button onClick={() => onDelete(d)} className="text-[11px] text-red-400 hover:underline">削除</button>
                      </td>
                    </tr>
                  )),
                ];
              }),
            ];
          })}
          {otherDocs.length > 0 && (
            <>
              <tr className="bg-gray-50/60">
                <td colSpan={4} className="px-3 py-1 text-[11px] font-semibold text-gray-500 border-t border-gray-100">その他 (発注メール等)</td>
              </tr>
              {otherDocs.map((d) => (
                <tr key={d.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 text-xs text-gray-700 truncate max-w-[260px]" colSpan={2} title={d.title}>
                    <FileText size={12} className="inline -mt-0.5 mr-1 text-gray-400" />{d.title}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-400">{fmt(d.created_at)}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button onClick={() => onOpen(d)} className="text-[11px] text-blue-600 hover:underline mr-2">開く</button>
                    <button onClick={() => onDelete(d)} className="text-[11px] text-red-400 hover:underline">削除</button>
                  </td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
