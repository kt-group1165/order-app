"use client";

/**
 * 利用者の引落口座 (client_bank_accounts) — 事業所ごとに持つ (2026-11-11 user 決定)。
 *   ・この画面の事業所 (currentOfficeId) の行だけを登録・編集・削除できる
 *   ・他事業所の口座は参考表示。[複写] でこの事業所の行として作れる (元が後で変わっても自動では変わらない)
 *   ・事業所を選んでいない (全事業所表示) ときは表示だけ
 * 表: migrations/applied_archive/client_bank_accounts.sql
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { copyRowForOffice } from "@/lib/insurance/office-scope-rules";

export type ClientBankAccount = {
  id: string;
  tenant_id: string;
  client_id: string;
  office_id: string | null;
  bank_name: string | null;
  bank_code: string | null;
  branch_name: string | null;
  branch_code: string | null;
  account_type: string | null;
  account_number: string | null;
  account_holder: string | null;
  account_holder_kana: string | null;
  payer_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  notes: string | null;
  copied_from_id: string | null;
  office_source: string | null;
  created_at: string;
  updated_at: string;
};

type Form = Pick<ClientBankAccount, "bank_name" | "bank_code" | "branch_name" | "branch_code" | "account_type" | "account_number"
  | "account_holder" | "account_holder_kana" | "payer_name" | "valid_from" | "valid_to" | "notes">;

const EMPTY: Form = {
  bank_name: null, bank_code: null, branch_name: null, branch_code: null, account_type: "普通", account_number: null,
  account_holder: null, account_holder_kana: null, payer_name: null, valid_from: null, valid_to: null, notes: null,
};

/** 入力の検査 (DB の CHECK と同じ規則。保存前に画面で止める) */
function validate(f: Form): string[] {
  const e: string[] = [];
  if (f.bank_code && !/^\d{4}$/.test(f.bank_code)) e.push("金融機関コードは 4 桁の数字です");
  if (f.branch_code && !/^\d{3}$/.test(f.branch_code)) e.push("支店コードは 3 桁の数字です");
  if (f.account_number && !/^\d{1,8}$/.test(f.account_number)) e.push("口座番号は数字 (8 桁まで) です");
  if (f.valid_from && f.valid_to && f.valid_to < f.valid_from) e.push("終了日が開始日より前です");
  if (!f.bank_name && !f.bank_code) e.push("金融機関名か金融機関コードを入れてください");
  if (!f.account_number) e.push("口座番号を入れてください");
  return e;
}

export default function ClientBankAccountsPanel({ tenantId, clientId, currentOfficeId, officeNameById }: {
  tenantId: string;
  clientId: string;
  currentOfficeId: string | null;
  officeNameById: Map<string, string>;
}) {
  const [rows, setRows] = useState<ClientBankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 読み込み (状態は呼び出し側で反映。effect の中で同期的に setState しないため) */
  const fetchRows = useCallback(async (): Promise<{ rows: ClientBankAccount[]; error: string | null }> => {
    const { data, error } = await supabase.from("client_bank_accounts").select("*")
      .eq("tenant_id", tenantId).eq("client_id", clientId).order("valid_from", { ascending: false, nullsFirst: true });
    if (error) {
      console.error("口座情報の取得失敗:", error.message);
      return { rows: [], error: error.code === "42P01" || error.code === "PGRST205"
        ? "口座の表 (client_bank_accounts) が未作成です"
        : `口座情報を読めませんでした: ${error.message}` };
    }
    return { rows: (data ?? []) as ClientBankAccount[], error: null };
  }, [tenantId, clientId]);
  const apply = (r: { rows: ClientBankAccount[]; error: string | null }) => {
    setLoadError(r.error);
    if (!r.error) setRows(r.rows);
    setLoading(false);
  };
  const load = async () => apply(await fetchRows());
  useEffect(() => {
    let cancelled = false;
    fetchRows().then((r) => { if (!cancelled) apply(r); });
    return () => { cancelled = true; };
  }, [fetchRows]);

  const own = useMemo(() => rows.filter((r) => currentOfficeId && r.office_id === currentOfficeId), [rows, currentOfficeId]);
  const others = useMemo(() => rows.filter((r) => !currentOfficeId || r.office_id !== currentOfficeId), [rows, currentOfficeId]);

  const save = async () => {
    if (!form || !currentOfficeId) return;
    const errs = validate(form);
    if (errs.length) { alert(errs.join("\n")); return; }
    setSaving(true);
    const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? null : v]));
    const res = editingId
      ? await supabase.from("client_bank_accounts").update(payload).eq("id", editingId).eq("office_id", currentOfficeId)
      : await supabase.from("client_bank_accounts").insert({ ...payload, tenant_id: tenantId, client_id: clientId, office_id: currentOfficeId, office_source: "manual" });
    setSaving(false);
    if (res.error) { console.error("口座情報の保存失敗:", res.error.message); alert(`保存に失敗しました: ${res.error.message}`); return; }
    setForm(null); setEditingId(null);
    await load();
  };

  const remove = async (r: ClientBankAccount) => {
    if (r.office_id !== currentOfficeId) return;
    if (!confirm("この口座情報を削除しますか？")) return;
    const { error } = await supabase.from("client_bank_accounts").delete().eq("id", r.id).eq("office_id", currentOfficeId);
    if (error) { alert(`削除に失敗しました: ${error.message}`); return; }
    await load();
  };

  const copy = async (r: ClientBankAccount) => {
    if (!currentOfficeId) return;
    if (!confirm("この口座を この事業所の口座として複写しますか？\n複写後は別の行になり、元の口座が変わっても自動では変わりません。")) return;
    const { error } = await supabase.from("client_bank_accounts").insert(copyRowForOffice(r, currentOfficeId));
    if (error) { console.error("口座の複写失敗:", error.message); alert(`複写に失敗しました: ${error.message}`); return; }
    await load();
  };

  const field = (key: keyof Form, label: string, opt: { ph?: string; type?: string; mono?: boolean; w?: string } = {}) => (
    <div className={opt.w ?? ""}>
      <label className="text-sm font-medium text-gray-600 block mb-1">{label}</label>
      <input type={opt.type ?? "text"} value={form?.[key] ?? ""} placeholder={opt.ph}
        onChange={(e) => setForm((f) => f ? { ...f, [key]: e.target.value } : f)}
        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${opt.mono ? "tabular-nums" : ""}`} />
    </div>
  );

  const card = (r: ClientBankAccount, mine: boolean) => (
    <div key={r.id} className={`rounded-lg border px-4 py-3 ${mine ? "border-blue-200 bg-white" : "border-gray-200 bg-gray-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-gray-800">
            {r.bank_name ?? "—"}{r.bank_code ? <span className="ml-1 text-sm font-normal text-gray-500">({r.bank_code})</span> : null}
            <span className="mx-2 text-gray-300">/</span>
            {r.branch_name ?? "—"}{r.branch_code ? <span className="ml-1 text-sm font-normal text-gray-500">({r.branch_code})</span> : null}
          </div>
          <div className="mt-0.5 text-sm text-gray-700">
            {r.account_type ?? ""} <span className="tabular-nums font-medium">{r.account_number ?? ""}</span>
            <span className="ml-3">名義 {r.account_holder ?? "—"}{r.account_holder_kana ? `（${r.account_holder_kana}）` : ""}</span>
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {(r.valid_from || r.valid_to) ? `期間 ${r.valid_from ?? ""}〜${r.valid_to ?? ""}　` : ""}
            {r.payer_name ? `支払者 ${r.payer_name}　` : ""}
            {r.notes ?? ""}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {mine ? (
            <>
              <button onClick={() => { setEditingId(r.id); setForm({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, r[k as keyof ClientBankAccount]])) } as Form); }}
                className="text-sm text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50">編集</button>
              <button onClick={() => remove(r)} className="text-sm text-red-500 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50">削除</button>
            </>
          ) : (
            <>
              <span className="text-xs text-gray-500">{r.office_id ? (officeNameById.get(r.office_id) ?? "他事業所") : "事業所未定"}</span>
              {currentOfficeId && (
                <button onClick={() => copy(r)} className="text-sm text-emerald-700 border border-emerald-300 bg-white px-2.5 py-1 rounded-lg hover:bg-emerald-50">複写</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        {loadError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{loadError}</p>}
        <section className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-bold text-gray-800">この事業所の引落口座</h3>
            {currentOfficeId && !form && (
              <button onClick={() => { setEditingId(null); setForm({ ...EMPTY }); }}
                className="text-sm text-white bg-blue-500 px-3 py-1.5 rounded-lg hover:bg-blue-600">＋ 口座を登録</button>
            )}
          </div>
          {!currentOfficeId && <p className="text-sm text-gray-500">口座は事業所ごとに持ちます。事業所を選ぶと登録・編集できます。</p>}
          {loading ? <p className="text-sm text-gray-400">読み込み中…</p>
            : own.length === 0 && !form ? <p className="text-sm text-gray-400">{currentOfficeId ? "この事業所の口座はまだ登録されていません" : ""}</p>
            : own.map((r) => card(r, true))}

          {form && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {field("bank_name", "金融機関名", { ph: "千葉銀行", w: "col-span-2 md:col-span-3" })}
                {field("bank_code", "金融機関コード", { ph: "0134", mono: true })}
                {field("branch_name", "支店名", { ph: "市原支店", w: "col-span-2 md:col-span-3" })}
                {field("branch_code", "支店コード", { ph: "123", mono: true })}
                <div>
                  <label className="text-sm font-medium text-gray-600 block mb-1">種別</label>
                  <select value={form.account_type ?? ""} onChange={(e) => setForm((f) => f ? { ...f, account_type: e.target.value || null } : f)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base bg-white outline-none focus:border-blue-500">
                    <option value="普通">普通</option><option value="当座">当座</option><option value="貯蓄">貯蓄</option>
                  </select>
                </div>
                {field("account_number", "口座番号", { ph: "1234567", mono: true })}
                {field("account_holder", "口座名義", { w: "col-span-2" })}
                {field("account_holder_kana", "口座名義 (カナ)", { ph: "ﾔﾏﾀﾞ ﾀﾛｳ", w: "col-span-2" })}
                {field("payer_name", "支払者 (本人以外のとき)", { w: "col-span-2" })}
                {field("valid_from", "引落開始", { type: "date" })}
                {field("valid_to", "引落終了", { type: "date" })}
                {field("notes", "メモ", { w: "col-span-2 md:col-span-4" })}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => { setForm(null); setEditingId(null); }} className="text-sm text-gray-600 border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50">キャンセル</button>
                <button onClick={save} disabled={saving} className="text-sm text-white bg-blue-500 px-5 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50">{saving ? "保存中…" : "保存"}</button>
              </div>
            </div>
          )}
        </section>

        {others.length > 0 && (
          <section className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
            <h3 className="text-base font-bold text-gray-800">他の事業所の口座 <span className="text-sm font-normal text-gray-500">(参考・この事業所の引落には使いません)</span></h3>
            {others.map((r) => card(r, false))}
          </section>
        )}
      </div>
    </div>
  );
}
