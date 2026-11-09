"use client";

// 設定 → 軽度者例外給付 市町村ルール (2026-11-09 user 合意)
//   保険者番号ごとに「例外給付に有効期間が要るか」「標準の期間 (月数)」を手入力する。
//   使う所: 利用者タブの例外給付タブ (終了日の提案・終了日空の警告) / 利用者一覧の印 / 請求画面の印。
//   表 (migrations/fukuyogu_exception_insurer_rules.sql) が未適用なら その旨を出して入力欄を出さない。

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  getExceptionInsurerRules, createExceptionInsurerRule, updateExceptionInsurerRule,
  deleteExceptionInsurerRule, lookupInsurerName, type InsurerRuleInput,
} from "@/lib/fukuyoguExceptions";
import { normalizeInsurerNumber, type ExceptionInsurerRule } from "@/lib/fukuyoguExceptionRules";

type Form = { insurer_number: string; insurer_name: string; requires_period: boolean; period_months: string; notes: string };
const EMPTY: Form = { insurer_number: "", insurer_name: "", requires_period: true, period_months: "", notes: "" };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
}

export default function ExceptionInsurerRulesSection({ tenantId }: { tenantId: string }) {
  const [rules, setRules] = useState<ExceptionInsurerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await getExceptionInsurerRules(tenantId);
    setRules(r.rules);
    setAvailable(r.available);
    setMessage(r.message);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回とテナント切替時に読み込む
    void load();
  }, [load]);

  const startNew = () => { setEditingId("new"); setForm(EMPTY); };
  const startEdit = (r: ExceptionInsurerRule) => {
    setEditingId(r.id);
    setForm({
      insurer_number: r.insurer_number, insurer_name: r.insurer_name ?? "", requires_period: r.requires_period,
      period_months: r.period_months != null ? String(r.period_months) : "", notes: r.notes ?? "",
    });
  };

  const fillName = async () => {
    const n = normalizeInsurerNumber(form.insurer_number);
    if (!/^\d{6}$/.test(n) || form.insurer_name.trim()) return;
    const name = await lookupInsurerName(tenantId, n);
    if (name) setForm((f) => (f.insurer_name.trim() ? f : { ...f, insurer_name: name }));
  };

  const save = async () => {
    const n = normalizeInsurerNumber(form.insurer_number);
    if (!/^\d{6}$/.test(n)) { alert("保険者番号は 6 桁の数字で入力してください"); return; }
    let months: number | null = null;
    if (form.period_months.trim()) {
      months = Number(form.period_months.normalize("NFKC").trim());
      if (!Number.isInteger(months) || months < 1 || months > 120) { alert("標準の期間は 1〜120 (か月) の整数で入力してください"); return; }
    }
    if (editingId === "new" && rules.some((r) => normalizeInsurerNumber(r.insurer_number) === n)) {
      alert(`保険者番号 ${n} は既に登録されています。一覧から編集してください`);
      return;
    }
    const input: InsurerRuleInput = {
      insurer_number: n,
      insurer_name: form.insurer_name.trim() || null,
      requires_period: form.requires_period,
      period_months: months,
      notes: form.notes.trim() || null,
    };
    setSaving(true);
    try {
      if (editingId === "new") await createExceptionInsurerRule(tenantId, input);
      else if (editingId) await updateExceptionInsurerRule(editingId, input);
      setEditingId(null);
      await load();
    } catch (e) {
      console.error("市町村ルールの保存失敗:", e);
      alert(`保存に失敗しました: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: ExceptionInsurerRule) => {
    if (!confirm(`${r.insurer_name ?? ""} (${r.insurer_number}) のルールを削除しますか？\n削除するとこの市町村は「ルール未設定」(期間要否の警告なし) になります。`)) return;
    try {
      await deleteExceptionInsurerRule(r.id);
      await load();
    } catch (e) {
      console.error("市町村ルールの削除失敗:", e);
      alert(`削除に失敗しました: ${errMsg(e)}`);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-10"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 leading-relaxed">
        軽度者 (要支援1・2/要介護1) の原則対象外品目の例外給付について、市町村 (保険者) ごとの扱いを登録します。<br />
        「有効期間が要る」にした市町村では、例外給付記録の終了日が空だと警告します。標準の期間 (月数) を入れると、
        例外給付の入力時に 開始日 + 期間 を終了日の初期値として出します。<br />
        登録の無い市町村は「ルール未設定」として扱い、期間要否の警告は出しません (期限の警告は出ます)。
      </div>
      {message && (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{message}</div>
      )}
      {available && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-700">市町村ルール ({rules.length} 件)</span>
            <button onClick={startNew} className="text-xs text-white bg-emerald-500 px-3 py-1 rounded-lg hover:bg-emerald-600">＋ 追加</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {["保険者番号", "市町村名", "有効期間", "標準の期間", "備考", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {editingId === "new" && <FormRow form={form} setForm={setForm} onSave={save} onCancel={() => setEditingId(null)} onNumberBlur={fillName} saving={saving} />}
                {rules.length === 0 && editingId !== "new" && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">登録がありません (全市町村「ルール未設定」)</td></tr>
                )}
                {rules.map((r) => editingId === r.id ? (
                  <FormRow key={r.id} form={form} setForm={setForm} onSave={save} onCancel={() => setEditingId(null)} onNumberBlur={fillName} saving={saving} />
                ) : (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-800">{r.insurer_number}</td>
                    <td className="px-3 py-2 text-gray-800">{r.insurer_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      {r.requires_period
                        ? <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium">要る</span>
                        : <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">不要</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{r.period_months != null ? `${r.period_months} か月` : "—"}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate" title={r.notes ?? ""}>{r.notes ?? ""}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <button onClick={() => startEdit(r)} disabled={editingId !== null}
                        className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-50 disabled:opacity-40">編集</button>
                      <button onClick={() => remove(r)} disabled={editingId !== null}
                        className="ml-1.5 text-xs text-red-400 border border-red-200 px-2 py-0.5 rounded hover:bg-red-50 disabled:opacity-40">削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FormRow({ form, setForm, onSave, onCancel, onNumberBlur, saving }: {
  form: Form;
  setForm: React.Dispatch<React.SetStateAction<Form>>;
  onSave: () => void;
  onCancel: () => void;
  onNumberBlur: () => void;
  saving: boolean;
}) {
  const input = "w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400 bg-white";
  return (
    <tr className="bg-blue-50/50">
      <td className="px-2 py-1.5">
        <input value={form.insurer_number} onChange={(e) => setForm((f) => ({ ...f, insurer_number: e.target.value }))}
          onBlur={onNumberBlur} placeholder="122069" inputMode="numeric" className={`${input} font-mono w-24`} />
      </td>
      <td className="px-2 py-1.5">
        <input value={form.insurer_name} onChange={(e) => setForm((f) => ({ ...f, insurer_name: e.target.value }))}
          placeholder="木更津市" className={input} />
      </td>
      <td className="px-2 py-1.5">
        <select value={form.requires_period ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, requires_period: e.target.value === "1" }))} className={input}>
          <option value="1">要る</option>
          <option value="0">不要</option>
        </select>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <input value={form.period_months} onChange={(e) => setForm((f) => ({ ...f, period_months: e.target.value }))}
            placeholder="12" inputMode="numeric" className={`${input} w-14 text-right`} />
          <span className="text-gray-500 whitespace-nowrap">か月</span>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className={input} />
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap text-right">
        <button onClick={onCancel} className="text-xs text-gray-500 border border-gray-200 px-2 py-0.5 rounded bg-white">取消</button>
        <button onClick={onSave} disabled={saving} className="ml-1.5 text-xs text-white bg-blue-500 px-2 py-0.5 rounded disabled:opacity-50">
          {saving ? "保存中…" : "保存"}
        </button>
      </td>
    </tr>
  );
}
