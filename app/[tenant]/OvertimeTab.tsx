"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Plus, Loader2, Check, X, AlertTriangle } from "lucide-react";
import { supabase, OvertimeRequest, Member } from "@/lib/supabase";
import {
  getOvertimeRequests,
  createOvertimeRequest,
  cancelOvertimeRequest,
  approveOvertimeRequest,
  rejectOvertimeRequest,
  recordOvertimeActual,
} from "@/lib/overtimeRequests";

// 36協定の一般的な月間残業上限の目安 (45時間)。法定強制ではなく警告表示のみ。
const MONTHLY_WARN_MINUTES = 45 * 60;

const STATUS_LABEL: Record<string, string> = {
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消",
};
const STATUS_COLOR: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-gray-200 text-gray-500",
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function calcPlannedMinutes(start: string, end: string): number {
  if (!start || !end) return 0;
  let diff = toMinutes(end) - toMinutes(start);
  if (diff <= 0) diff += 24 * 60; // 日跨ぎ
  return diff;
}

function minutesLabel(min: number | null): string {
  if (min === null || min === undefined) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

type SubTab = "requests" | "approval" | "summary";

export default function OvertimeTab({
  tenantId,
  currentOfficeId,
  officeViewAll,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  officeViewAll: boolean;
}) {
  const [subTab, setSubTab] = useState<SubTab>("requests");
  const [rows, setRows] = useState<OvertimeRequest[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const officeFilter = officeViewAll ? null : currentOfficeId;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOvertimeRequests(tenantId, officeFilter);
      setRows(data);
    } catch (e) {
      console.error("残業申請の取得に失敗:", e);
    } finally {
      setLoading(false);
    }
  }, [tenantId, officeFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の async fetch
    load();
  }, [load]);

  // 現在の事業所に紐づく在籍メンバー (申請フォームの「誰の残業か」選択用)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentOfficeId) {
        setMembers([]);
        return;
      }
      const { data: linkRows, error: linkErr } = await supabase
        .from("member_offices")
        .select("member_id")
        .eq("office_id", currentOfficeId);
      if (linkErr) {
        console.warn("member_offices fetch failed:", linkErr.message);
        return;
      }
      const memberIds = Array.from(new Set((linkRows ?? []).map((r) => (r as { member_id: string }).member_id)));
      if (memberIds.length === 0) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { data, error } = await supabase
        .from("members")
        .select("*")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("status", "active")
        .in("id", memberIds)
        .order("name");
      if (error) {
        console.warn("members fetch failed:", error.message);
        return;
      }
      if (!cancelled) setMembers((data ?? []) as Member[]);
    })();
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId]);

  // 事業所管理者かどうか (承認タブの表示可否)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentOfficeId) {
        setIsAdmin(false);
        return;
      }
      const { data, error } = await supabase.rpc("auth_admin_office_ids");
      if (error) return;
      type Row = { auth_admin_office_ids?: string } | string;
      const ids = ((data ?? []) as Row[]).map((r) => (typeof r === "string" ? r : r.auth_admin_office_ids ?? ""));
      if (!cancelled) setIsAdmin(ids.includes(currentOfficeId));
    })();
    return () => { cancelled = true; };
  }, [currentOfficeId]);

  const pending = useMemo(() => rows.filter((r) => r.status === "pending"), [rows]);

  const subTabBar = (
    <div className="bg-white border-b border-gray-200 px-3 pt-2 flex gap-1 shrink-0">
      {(
        [
          ["requests", "申請一覧"],
          ["approval", `承認待ち${pending.length > 0 ? ` (${pending.length})` : ""}`],
          ["summary", "残業時間管理表"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setSubTab(id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
            subTab === id ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <Clock size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">残業管理</h2>
        {subTab === "requests" && (
          <div className="ml-auto">
            <button
              onClick={() => setShowForm(true)}
              disabled={!currentOfficeId}
              className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
              title={currentOfficeId ? undefined : "事業所を選択してください"}
            >
              <Plus size={14} />
              残業許可申請
            </button>
          </div>
        )}
      </div>
      {subTabBar}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      ) : subTab === "requests" ? (
        <RequestListView rows={rows} onReload={load} />
      ) : subTab === "approval" ? (
        <ApprovalView rows={pending} isAdmin={isAdmin} onReload={load} />
      ) : (
        <SummaryView rows={rows} onReload={load} />
      )}

      {showForm && currentOfficeId && (
        <NewRequestModal
          tenantId={tenantId}
          officeId={currentOfficeId}
          members={members}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── 申請一覧 ──────────────────────────────────────────────────────────
function RequestListView({ rows, onReload }: { rows: OvertimeRequest[]; onReload: () => void }) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = async (id: string) => {
    if (!window.confirm("この申請を取り消しますか？")) return;
    setCancellingId(id);
    try {
      await cancelOvertimeRequest(id);
      onReload();
    } catch (e) {
      alert("取消に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCancellingId(null);
    }
  };

  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">申請はありません</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <table className="w-full text-sm bg-white">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="text-left px-3 py-2">対象日</th>
            <th className="text-left px-3 py-2">氏名</th>
            <th className="text-left px-3 py-2">残業時間 (予定)</th>
            <th className="text-left px-3 py-2">実績</th>
            <th className="text-left px-3 py-2">理由</th>
            <th className="text-left px-3 py-2 w-24">状態</th>
            <th className="text-left px-3 py-2 w-16" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 whitespace-nowrap">{r.target_date}</td>
              <td className="px-3 py-2 whitespace-nowrap">{r.member_name}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {r.overtime_start_time.slice(0, 5)}〜{r.overtime_end_time.slice(0, 5)} ({minutesLabel(r.planned_minutes)})
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{minutesLabel(r.actual_minutes)}</td>
              <td className="px-3 py-2 text-gray-600 max-w-xs truncate" title={r.reason}>{r.reason}</td>
              <td className="px-3 py-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </td>
              <td className="px-3 py-2">
                {r.status === "pending" && (
                  <button
                    onClick={() => handleCancel(r.id)}
                    disabled={cancellingId === r.id}
                    className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
                  >
                    取消
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 承認待ち ──────────────────────────────────────────────────────────
function ApprovalView({ rows, isAdmin, onReload }: { rows: OvertimeRequest[]; isAdmin: boolean; onReload: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const handleApprove = async (id: string) => {
    setBusyId(id);
    try {
      await approveOvertimeRequest(id);
      onReload();
    } catch (e) {
      alert("承認に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!rejectReason.trim()) {
      alert("却下理由を入力してください");
      return;
    }
    setBusyId(id);
    try {
      await rejectOvertimeRequest(id, rejectReason.trim());
      setRejectingId(null);
      setRejectReason("");
      onReload();
    } catch (e) {
      alert("却下処理に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm px-6 text-center">
        承認操作は事業所管理者のみ行えます。閲覧のみ可能です。
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">承認待ちの申請はありません</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2">
      {rows.map((r) => (
        <div key={r.id} className="bg-white border border-gray-200 rounded-lg p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-gray-800">{r.member_name} — {r.target_date}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {r.overtime_start_time.slice(0, 5)}〜{r.overtime_end_time.slice(0, 5)} ({minutesLabel(r.planned_minutes)})
              </div>
              {r.work_content && <div className="text-xs text-gray-600 mt-1">業務内容: {r.work_content}</div>}
              <div className="text-xs text-gray-600 mt-1">理由: {r.reason}</div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => handleApprove(r.id)}
                disabled={busyId === r.id}
                className="text-xs px-2.5 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
              >
                <Check size={13} />承認
              </button>
              <button
                onClick={() => setRejectingId(rejectingId === r.id ? null : r.id)}
                disabled={busyId === r.id}
                className="text-xs px-2.5 py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50 inline-flex items-center gap-1 disabled:opacity-40"
              >
                <X size={13} />却下
              </button>
            </div>
          </div>
          {rejectingId === r.id && (
            <div className="mt-2 flex gap-2">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="却下理由 (必須)"
                className="flex-1 text-xs border border-gray-300 rounded px-2 py-1"
              />
              <button
                onClick={() => handleReject(r.id)}
                disabled={busyId === r.id}
                className="text-xs px-3 py-1 bg-red-500 hover:bg-red-600 text-white rounded disabled:opacity-40"
              >
                却下を確定
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── 残業時間管理表 (月次 × メンバー集計) ──────────────────────────────
function SummaryView({ rows, onReload }: { rows: OvertimeRequest[]; onReload: () => void }) {
  const months = useMemo(() => {
    const s = new Set(rows.map((r) => r.target_date.slice(0, 7)));
    return Array.from(s).sort().reverse();
  }, [rows]);
  const [month, setMonth] = useState<string | null>(null);
  const effMonth = month ?? months[0] ?? null;

  const [savingId, setSavingId] = useState<string | null>(null);
  const [actualDraft, setActualDraft] = useState<Record<string, string>>({});

  type Agg = {
    memberId: string;
    memberName: string;
    plannedMinutes: number;
    actualMinutes: number;
    pendingCount: number;
    approvedRows: OvertimeRequest[];
  };

  const agg = useMemo(() => {
    if (!effMonth) return [] as Agg[];
    const map = new Map<string, Agg>();
    for (const r of rows) {
      if (r.target_date.slice(0, 7) !== effMonth) continue;
      if (r.status === "cancelled" || r.status === "rejected") continue;
      let a = map.get(r.member_id);
      if (!a) {
        a = { memberId: r.member_id, memberName: r.member_name, plannedMinutes: 0, actualMinutes: 0, pendingCount: 0, approvedRows: [] };
        map.set(r.member_id, a);
      }
      if (r.status === "approved") {
        a.plannedMinutes += r.planned_minutes;
        a.actualMinutes += r.actual_minutes ?? 0;
        a.approvedRows.push(r);
      } else if (r.status === "pending") {
        a.pendingCount += 1;
      }
    }
    return Array.from(map.values()).sort((x, y) => x.memberName.localeCompare(y.memberName, "ja"));
  }, [rows, effMonth]);

  const handleSaveActual = async (r: OvertimeRequest) => {
    const raw = actualDraft[r.id];
    const val = Number(raw);
    if (!raw || Number.isNaN(val) || val < 0) {
      alert("実績時間 (分) は0以上の数値で入力してください");
      return;
    }
    setSavingId(r.id);
    try {
      await recordOvertimeActual(r.id, val);
      setActualDraft((d) => { const n = { ...d }; delete n[r.id]; return n; });
      onReload();
    } catch (e) {
      alert("実績記録に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingId(null);
    }
  };

  if (months.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">データがありません</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <label className="text-xs text-gray-600">対象月</label>
        <select
          value={effMonth ?? ""}
          onChange={(e) => setMonth(e.target.value)}
          className="text-sm border border-gray-300 rounded px-2 py-1"
        >
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="text-[11px] text-gray-400 inline-flex items-center gap-1 ml-2">
          <AlertTriangle size={12} className="text-amber-500" />
          月{Math.floor(MONTHLY_WARN_MINUTES / 60)}時間超で警告表示 (36協定目安、法的判定ではありません)
        </span>
      </div>

      <table className="w-full text-sm bg-white">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="text-left px-3 py-2">氏名</th>
            <th className="text-left px-3 py-2">承認済み予定計</th>
            <th className="text-left px-3 py-2">実績計</th>
            <th className="text-left px-3 py-2">承認待ち</th>
          </tr>
        </thead>
        <tbody>
          {agg.map((a) => (
            <tr key={a.memberId} className="border-b border-gray-100 align-top">
              <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-800">{a.memberName}</td>
              <td className={`px-3 py-2 whitespace-nowrap ${a.plannedMinutes > MONTHLY_WARN_MINUTES ? "text-red-600 font-semibold" : ""}`}>
                {minutesLabel(a.plannedMinutes)}
              </td>
              <td className={`px-3 py-2 whitespace-nowrap ${a.actualMinutes > MONTHLY_WARN_MINUTES ? "text-red-600 font-semibold" : ""}`}>
                {minutesLabel(a.actualMinutes)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-gray-500">{a.pendingCount > 0 ? `${a.pendingCount} 件` : "—"}</td>
            </tr>
          ))}
          {agg.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">対象月のデータはありません</td></tr>
          )}
        </tbody>
      </table>

      {/* 実績未記録の承認済み申請 → 実績時間入力 */}
      {agg.some((a) => a.approvedRows.some((r) => r.actual_minutes === null)) && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-gray-600 mb-2">実績時間 未記録 (承認済み)</h3>
          <div className="space-y-1.5">
            {agg.flatMap((a) => a.approvedRows.filter((r) => r.actual_minutes === null)).map((r) => (
              <div key={r.id} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-3 py-1.5">
                <span className="text-xs text-gray-700 w-40 shrink-0">{r.member_name} ({r.target_date})</span>
                <span className="text-xs text-gray-400">予定 {minutesLabel(r.planned_minutes)}</span>
                <input
                  type="number"
                  min={0}
                  placeholder="実績(分)"
                  value={actualDraft[r.id] ?? ""}
                  onChange={(e) => setActualDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                  className="w-24 text-xs border border-gray-300 rounded px-2 py-1"
                />
                <button
                  onClick={() => handleSaveActual(r)}
                  disabled={savingId === r.id}
                  className="text-[11px] px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded disabled:opacity-40"
                >
                  記録
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 新規申請モーダル ──────────────────────────────────────────────────
function NewRequestModal({
  tenantId,
  officeId,
  members,
  onClose,
  onSaved,
}: {
  tenantId: string;
  officeId: string;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [memberId, setMemberId] = useState("");
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [workContent, setWorkContent] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plannedMinutes = calcPlannedMinutes(start, end);

  const handleSubmit = async () => {
    setError(null);
    const member = members.find((m) => m.id === memberId);
    if (!member) { setError("対象者を選択してください"); return; }
    if (!targetDate) { setError("対象日を入力してください"); return; }
    if (!start || !end) { setError("残業開始/終了予定時刻を入力してください"); return; }
    if (plannedMinutes <= 0) { setError("残業予定時間が0分です。時刻を確認してください"); return; }
    if (!reason.trim()) { setError("残業理由を入力してください"); return; }

    setSaving(true);
    try {
      await createOvertimeRequest({
        tenantId,
        officeId,
        memberId: member.id,
        memberName: member.name,
        targetDate,
        scheduledEndTime: scheduledEnd || null,
        overtimeStartTime: start,
        overtimeEndTime: end,
        plannedMinutes,
        workContent: workContent.trim() || null,
        reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
        <h3 className="text-base font-semibold mb-3">残業許可申請書</h3>
        <div className="space-y-3 text-sm">
          <div>
            <label className="text-xs text-gray-600">対象者 (必須)</label>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1">
              <option value="">選択してください</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">対象日 (必須)</label>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-xs text-gray-600">所定終業時刻</label>
              <input type="time" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">残業開始予定 (必須)</label>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-xs text-gray-600">残業終了予定 (必須)</label>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1" />
            </div>
          </div>
          {plannedMinutes > 0 && (
            <div className="text-xs text-gray-500">残業予定時間: {minutesLabel(plannedMinutes)}</div>
          )}
          <div>
            <label className="text-xs text-gray-600">業務内容</label>
            <input value={workContent} onChange={(e) => setWorkContent(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1" />
          </div>
          <div>
            <label className="text-xs text-gray-600">残業理由 (必須)</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="w-full border border-gray-300 rounded px-2 py-1" />
          </div>
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-4 py-1.5 border border-gray-300 rounded hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSubmit} disabled={saving} className="text-sm px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded disabled:opacity-50">
            {saving ? "申請中..." : "申請する"}
          </button>
        </div>
      </div>
    </div>
  );
}
