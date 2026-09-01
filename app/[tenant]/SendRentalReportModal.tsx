"use client";

// 貸与報告書を居宅介護支援事業所に送付する確認モーダル。
// MonitoringTab (モニタリング報告書) と RentalReportModal (福祉用具貸与状況報告) の
// 両方から使われる共有コンポーネントのため独立させている。
import { useState, useEffect } from "react";
import { Loader2, Send } from "lucide-react";
import { supabase, Client } from "@/lib/supabase";
import { todayYmd } from "@/lib/date-jst";

export type CareOfficeChoice = {
  id: string;
  name: string;
  is_assigned: boolean;  // 当該 client の assignment にあるか
};

export default function SendRentalReportModal({
  tenantId, client, sourceOfficeId, monitoringRecordId, visitDate, reportDate,
  getHtmlSnapshot, onClose, onSuccess, onError,
}: {
  tenantId: string;
  client: Client;
  sourceOfficeId: string;
  monitoringRecordId: string | null;
  visitDate: string;
  reportDate: string;
  getHtmlSnapshot: () => string;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<CareOfficeChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);  // assigned 居宅 が無い時に全 居宅 表示に切替

  // 候補 office 取得
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1. 当該利用者の assignment 一覧
        const { data: asgn, error: asgnErr } = await supabase
          .from("client_office_assignments")
          .select("office_id")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id);
        if (asgnErr) throw asgnErr;
        const assignedIds = new Set((asgn ?? []).map(a => a.office_id as string));

        // 2. tenant 内の 居宅介護支援 事業所一覧
        const { data: careOffices, error: careErr } = await supabase
          .from("offices")
          .select("id, name, service_type")
          .eq("tenant_id", tenantId)
          .eq("service_type", "居宅介護支援")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });
        if (careErr) throw careErr;

        // 3. 送信元 office 名
        const { data: srcOffice } = await supabase
          .from("offices")
          .select("name")
          .eq("id", sourceOfficeId)
          .maybeSingle();
        if (cancelled) return;
        if (srcOffice?.name) setSourceOfficeName(srcOffice.name as string);

        const all = (careOffices ?? []).map(o => ({
          id: o.id as string,
          name: o.name as string,
          is_assigned: assignedIds.has(o.id as string),
        }));
        const assigned = all.filter(c => c.is_assigned);
        setChoices(all);
        // assigned 居宅 が 1+ あれば assigned のみを既定で見せる
        if (assigned.length > 0) {
          setShowAll(false);
          setSelectedId(assigned[0].id);
        } else {
          setShowAll(true);
          setSelectedId(all[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, client.id, sourceOfficeId]);

  const visibleChoices = showAll ? choices : choices.filter(c => c.is_assigned);
  const assignedCount = choices.filter(c => c.is_assigned).length;

  const handleSend = async () => {
    if (!selectedId) return;
    setSending(true);
    setErrorMsg(null);
    try {
      // current user 取得
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) throw new Error("ユーザー情報が取得できません");
      const userId = userData.user.id;

      // HTML スナップショット
      const html = getHtmlSnapshot();
      if (!html) throw new Error("プレビュー DOM が見つかりません");

      // タイトル
      const dateForTitle = visitDate || reportDate || todayYmd();
      const title = `貸与報告書 ${dateForTitle} ${client.name} 様`;

      // shared_documents INSERT
      const { data: sd, error: sdErr } = await supabase
        .from("shared_documents")
        .insert({
          tenant_id: tenantId,
          client_id: client.id,
          source_office_id: sourceOfficeId,
          target_office_id: selectedId,
          document_type: "rental_report",
          title,
          html_content: html,
          payload: { monitoring_record_id: monitoringRecordId, visit_date: visitDate, report_date: reportDate, client_id: client.id, client_name: client.name },
          sent_by: userId,
        })
        .select("id")
        .single();
      if (sdErr || !sd) throw sdErr ?? new Error("shared_documents 作成失敗");

      // notifications INSERT (受信 office 全 staff 宛)
      const { error: ntErr } = await supabase
        .from("notifications")
        .insert({
          tenant_id: tenantId,
          office_id: selectedId,
          user_id: null,
          type: "document_received",
          ref_table: "shared_documents",
          ref_id: sd.id,
          title: `貸与報告書を受信: ${client.name} 様`,
          body: `${sourceOfficeName || "送信元事業所"} から`,
        });
      if (ntErr) throw ntErr;

      onSuccess();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] bg-black/60 flex items-center justify-center p-4 print:hidden" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">居宅介護支援事業所に送付</h3>
          <p className="text-xs text-gray-500 mt-1">{client.name} 様の貸与報告書を送付します</p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
          ) : choices.length === 0 ? (
            <p className="text-sm text-red-500">tenant 内に居宅介護支援事業所が登録されていません</p>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1.5">送付先</label>
                {assignedCount === 0 && (
                  <p className="text-xs text-amber-600 mb-2">
                    この利用者に紐付く居宅介護支援事業所がありません。全候補から手動選択してください。
                  </p>
                )}
                {assignedCount > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}
                      className="w-3.5 h-3.5 accent-emerald-500" />
                    <span>全 居宅介護支援事業所 から選ぶ</span>
                  </label>
                )}
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {visibleChoices.map(c => (
                    <label key={c.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${selectedId === c.id ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"}`}>
                      <input type="radio" name="target_office" value={c.id}
                        checked={selectedId === c.id}
                        onChange={() => setSelectedId(c.id)}
                        className="accent-emerald-500" />
                      <span className="text-sm text-gray-800 flex-1 truncate">{c.name}</span>
                      {c.is_assigned && <span className="text-[10px] text-emerald-600 shrink-0 px-1.5 py-0.5 bg-emerald-100 rounded">担当</span>}
                    </label>
                  ))}
                </div>
              </div>

              {errorMsg && (
                <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {errorMsg}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} disabled={sending}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            キャンセル
          </button>
          <button onClick={handleSend}
            disabled={loading || sending || !selectedId}
            className="text-sm text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            送付確定
          </button>
        </div>
      </div>
    </div>
  );
}
