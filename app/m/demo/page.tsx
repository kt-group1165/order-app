"use client";

// スマホ用: デモ機管理 (特定福祉用具のデモ貸出状況)。
// URL: /m/demo?key=<MEETING_FORM_KEY>&office=<slug> (事業所別 URL で運用)
// 一覧・持出・返却は /api/demo 経由で demo_units / demo_loans を読み書きする。
// 台帳の追加・編集は本体アプリの「デモ機管理」タブのみ。

import { Fragment, useCallback, useEffect, useState } from "react";
import { todayYmd } from "@/lib/date-jst";

const todayStr = () => todayYmd();

// 事業所 slug → 表示名 (id の解決・検証はサーバー側 /api/demo が行う)
const OFFICE_LABELS: Record<string, string> = {
  "caresupo": "ケア・サポート千葉",
  "hana-mutsumi": "Ｈａｎａムツミ福祉用具",
  "takashina": "千葉ムツミ福祉用具高品",
  "hanamigawa": "Ｈａｎａ福祉用具花見川",
  "links": "リンクス福祉用具",
};

const RETURN_LOCATIONS = ["事務所", "消毒庫", "社用車", "その他"];

type DemoUnitRow = {
  id: string;
  office_id: string | null;
  unit_no: string;
  category: string;
  product_name: string;
  color: string | null;
  storage_location: string | null;
  cleaned: boolean;
  memo: string | null;
};

type DemoLoanRow = {
  id: string;
  unit_id: string;
  client_name: string;
  taken_date: string | null;
  taken_by: string | null;
  due_date: string | null;
  memo: string | null;
};

type StatusFilter = "all" | "out" | "stock" | "overdue";

export default function MobileDemoPage() {
  const [key, setKey] = useState<string | null>(null);
  const [office, setOffice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [units, setUnits] = useState<DemoUnitRow[] | null>(null);
  const [loans, setLoans] = useState<DemoLoanRow[]>([]);
  const [listError, setListError] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");

  // 持出フォーム (対象 unit)
  const [checkoutTarget, setCheckoutTarget] = useState<DemoUnitRow | null>(null);
  const [coClientName, setCoClientName] = useState("");
  const [coTakenDate, setCoTakenDate] = useState(todayStr());
  const [coTakenBy, setCoTakenBy] = useState("");
  const [coDueDate, setCoDueDate] = useState("");
  const [coMemo, setCoMemo] = useState("");

  // 返却フォーム (対象 unit + loan)
  const [returnTarget, setReturnTarget] = useState<{ unit: DemoUnitRow; loan: DemoLoanRow } | null>(null);
  const [rtDate, setRtDate] = useState(todayStr());
  const [rtBy, setRtBy] = useState("");
  const [rtLocation, setRtLocation] = useState("事務所");
  const [rtCleaned, setRtCleaned] = useState(false);

  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time init: URL クエリ読み取り)
    setKey(params.get("key"));
    setOffice(params.get("office"));
    setReady(true);
  }, []);

  const load = useCallback(async (k: string, o: string | null) => {
    setListError("");
    setUnits(null);
    try {
      const res = await fetch(`/api/demo?key=${encodeURIComponent(k)}${o ? `&office=${encodeURIComponent(o)}` : ""}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListError(data.error ?? "取得に失敗しました");
        setUnits([]);
        return;
      }
      setUnits(data.units ?? []);
      setLoans(data.loans ?? []);
    } catch {
      setListError("通信エラーが発生しました");
      setUnits([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    if (ready && key) load(key, office);
  }, [ready, key, office, load]);

  const today = todayStr();
  const loanByUnit = new Map<string, DemoLoanRow>();
  for (const l of loans) if (!loanByUnit.has(l.unit_id)) loanByUnit.set(l.unit_id, l);
  const isOverdue = (loan: DemoLoanRow) => !!loan.due_date && loan.due_date < today;

  const allUnits = units ?? [];
  const categories: string[] = [];
  for (const u of allUnits) {
    const c = u.category || "未分類";
    if (!categories.includes(c)) categories.push(c);
  }
  let outCount = 0, stockCount = 0, overdueCount = 0;
  for (const u of allUnits) {
    const loan = loanByUnit.get(u.id);
    if (loan) { outCount++; if (isOverdue(loan)) overdueCount++; }
    else stockCount++;
  }
  const filtered = allUnits.filter((u) => {
    if (categoryFilter && (u.category || "未分類") !== categoryFilter) return false;
    const loan = loanByUnit.get(u.id);
    if (statusFilter === "out") return !!loan;
    if (statusFilter === "stock") return !loan;
    if (statusFilter === "overdue") return !!loan && isOverdue(loan);
    return true;
  });

  const openCheckout = (u: DemoUnitRow) => {
    setCoClientName("");
    setCoTakenDate(todayStr());
    setCoTakenBy("");
    setCoDueDate("");
    setCoMemo("");
    setFormError("");
    setReturnTarget(null);
    setCheckoutTarget(u);
  };

  const openReturn = (u: DemoUnitRow, loan: DemoLoanRow) => {
    setRtDate(todayStr());
    setRtBy("");
    setRtLocation("事務所");
    setRtCleaned(false);
    setFormError("");
    setCheckoutTarget(null);
    setReturnTarget({ unit: u, loan });
  };

  const submitCheckout = async () => {
    if (!checkoutTarget) return;
    if (!coClientName.trim()) { setFormError("利用者名を入力してください"); return; }
    setSending(true);
    setFormError("");
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          office,
          action: "checkout",
          unitId: checkoutTarget.id,
          clientName: coClientName,
          takenDate: coTakenDate,
          takenBy: coTakenBy,
          dueDate: coDueDate,
          memo: coMemo,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error ?? "送信に失敗しました");
        return;
      }
      setCheckoutTarget(null);
      if (key) await load(key, office);
    } catch {
      setFormError("通信エラーが発生しました。電波状況を確認して再送信してください。");
    } finally {
      setSending(false);
    }
  };

  const submitReturn = async () => {
    if (!returnTarget) return;
    setSending(true);
    setFormError("");
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          office,
          action: "return",
          loanId: returnTarget.loan.id,
          unitId: returnTarget.unit.id,
          returnedDate: rtDate,
          returnedBy: rtBy,
          storageLocation: rtLocation,
          cleaned: rtCleaned,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error ?? "送信に失敗しました");
        return;
      }
      setReturnTarget(null);
      if (key) await load(key, office);
    } catch {
      setFormError("通信エラーが発生しました。電波状況を確認して再送信してください。");
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

  const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base outline-none focus:border-emerald-400 bg-white";
  const labelCls = "text-xs font-medium text-gray-500 block mb-1";
  const chipCls = (active: boolean) =>
    `px-2.5 py-1.5 rounded-full text-xs whitespace-nowrap border ${
      active ? "bg-emerald-500 text-white border-emerald-500" : "bg-white text-gray-600 border-gray-200"
    }`;

  const statusChips: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "すべて" },
    { id: "out", label: `貸出中 ${outCount}` },
    { id: "stock", label: `在庫 ${stockCount}` },
    { id: "overdue", label: `期限超過 ${overdueCount}` },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-emerald-600 text-white px-4 py-3 sticky top-0 z-10">
        <h1 className="text-sm font-semibold">デモ機管理</h1>
        {office && OFFICE_LABELS[office] && (
          <p className="text-[11px] text-emerald-100 truncate">{OFFICE_LABELS[office]}</p>
        )}
      </header>

      {/* フィルタ */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 space-y-2 sticky top-[52px] z-10">
        <div className="flex gap-1.5 overflow-x-auto">
          {statusChips.map((c) => (
            <button key={c.id} onClick={() => setStatusFilter(c.id)} className={chipCls(statusFilter === c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        {categories.length > 0 && (
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white">
            <option value="">全カテゴリ</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      <div className="p-4 max-w-6xl mx-auto space-y-4 pb-16">
        {units === null ? (
          <p className="text-sm text-gray-400 text-center py-12">読み込み中...</p>
        ) : (
          <>
            {listError && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{listError}</p>}
            {filtered.length === 0 && !listError && (
              <p className="text-sm text-gray-400 text-center py-12">
                {allUnits.length === 0 ? "デモ機がありません" : "条件に合うデモ機がありません"}
              </p>
            )}
            {(() => {
              // カテゴリごとにグループ化して見出し + グリッド表示 (縦一列の間延び防止)
              const groups: [string, typeof filtered][] = [];
              const gIdx = new Map<string, number>();
              for (const u of filtered) {
                const c = u.category || "未分類";
                if (!gIdx.has(c)) { gIdx.set(c, groups.length); groups.push([c, []]); }
                groups[gIdx.get(c)!][1].push(u);
              }
              return groups.map(([cat, us]) => (
                <div key={cat}>
                  <h3 className="text-xs font-semibold text-gray-500 mb-2">
                    {cat}<span className="text-gray-300 ml-1">({us.length})</span>
                  </h3>
                  <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
                    <table className="w-full text-sm min-w-[680px]">
                      <tbody className="divide-y divide-gray-100">
            {us.map((u) => {
              const loan = loanByUnit.get(u.id) ?? null;
              const overdue = loan ? isOverdue(loan) : false;
              const isCheckoutOpen = checkoutTarget?.id === u.id;
              const isReturnOpen = returnTarget?.unit.id === u.id;
              return (
                <Fragment key={u.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="pl-3 pr-1 py-2 font-mono text-xs text-gray-400 whitespace-nowrap w-12">{u.unit_no || "―"}</td>
                    <td className="px-2 py-2">
                      <span className="font-medium text-gray-800">{u.product_name}</span>
                      {u.color && <span className="text-xs text-gray-400 ml-1">{u.color}</span>}
                    </td>
                    <td className="px-2 py-2 text-xs whitespace-nowrap">
                      {loan ? (
                        <span className={overdue ? "text-red-600" : "text-amber-700"}>
                          貸出中: {loan.client_name.replace(/[\s　]*様$/, "")} 様
                          {loan.taken_date && ` / 持出 ${loan.taken_date}`}
                          {loan.due_date && ` / 返却予定 ${loan.due_date}${overdue ? " (超過)" : ""}`}
                        </span>
                      ) : (
                        <span className="text-emerald-700">
                          在庫: {u.storage_location || "―"} / {u.cleaned ? "清掃済 ✓" : "未清掃"}
                        </span>
                      )}
                      {loan?.memo && <span className="text-gray-400 ml-2">{loan.memo}</span>}
                    </td>
                    <td className="px-3 py-1.5 w-16 text-right whitespace-nowrap">
                      {loan ? (
                        <button onClick={() => (isReturnOpen ? setReturnTarget(null) : openReturn(u, loan))}
                          className="px-3 py-1.5 bg-emerald-500 text-white text-xs font-medium rounded-lg">
                          返却
                        </button>
                      ) : (
                        <button onClick={() => (isCheckoutOpen ? setCheckoutTarget(null) : openCheckout(u))}
                          className="px-3 py-1.5 border border-emerald-300 text-emerald-700 bg-emerald-50 text-xs font-medium rounded-lg">
                          持出
                        </button>
                      )}
                    </td>
                  </tr>
                  {(isCheckoutOpen || isReturnOpen) && (
                  <tr>
                    <td colSpan={4} className="bg-gray-50 px-4 py-3">
                      <div className="max-w-md">

                  {/* 持出フォーム (カード内展開) */}
                  {isCheckoutOpen && (
                    <div className="space-y-3">
                      <div>
                        <label className={labelCls}>利用者名 *</label>
                        <input value={coClientName} onChange={(e) => setCoClientName(e.target.value)} placeholder="例：山田 太郎" className={inputCls} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>持出日</label>
                          <input type="date" value={coTakenDate} onChange={(e) => setCoTakenDate(e.target.value)} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>持出者</label>
                          <input value={coTakenBy} onChange={(e) => setCoTakenBy(e.target.value)} className={inputCls} />
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>返却予定日</label>
                        <input type="date" value={coDueDate} onChange={(e) => setCoDueDate(e.target.value)} className={inputCls} />
                      </div>
                      <div>
                        <label className={labelCls}>メモ (認定待ち 等)</label>
                        <input value={coMemo} onChange={(e) => setCoMemo(e.target.value)} className={inputCls} />
                      </div>
                      {formError && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{formError}</p>}
                      <button onClick={submitCheckout} disabled={sending}
                        className="w-full py-3 bg-emerald-500 text-white text-sm font-semibold rounded-xl disabled:opacity-50">
                        {sending ? "送信中..." : "持出を記録"}
                      </button>
                    </div>
                  )}

                  {/* 返却フォーム (カード内展開) */}
                  {isReturnOpen && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>返却日</label>
                          <input type="date" value={rtDate} onChange={(e) => setRtDate(e.target.value)} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>返却者</label>
                          <input value={rtBy} onChange={(e) => setRtBy(e.target.value)} className={inputCls} />
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>保管場所</label>
                        <select value={rtLocation} onChange={(e) => setRtLocation(e.target.value)} className={inputCls}>
                          {RETURN_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={rtCleaned} onChange={(e) => setRtCleaned(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
                        清掃済み
                      </label>
                      {formError && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{formError}</p>}
                      <button onClick={submitReturn} disabled={sending}
                        className="w-full py-3 bg-emerald-500 text-white text-sm font-semibold rounded-xl disabled:opacity-50">
                        {sending ? "送信中..." : "返却を記録"}
                      </button>
                    </div>
                  )}
                      </div>
                    </td>
                  </tr>
                  )}
                </Fragment>
              );
            })}
                      </tbody>
                    </table>
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
