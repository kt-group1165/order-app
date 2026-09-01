"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Loader2, Pencil, History, X } from "lucide-react";
import { todayYmd } from "@/lib/date-jst";
import { getOffices, type Office } from "@/lib/offices";
import { listDemoUnits, listOpenLoans, listLoansForUnit, createDemoUnit, updateDemoUnit, checkoutUnit, returnUnit, type DemoUnit, type DemoLoan } from "@/lib/demoUnits";

// 特定福祉用具販売の対象商品 (シャワーチェア等) のデモ貸出管理 (Excel 運用の置換)。
// 台帳 = demo_units、貸出履歴 = demo_loans (returned_date IS NULL = 貸出中)。
// スマホ入力 (/m/demo → /api/demo) と同じデータを本体では lib 直 (authenticated + RLS) で読み書きする。

const DEMO_RETURN_LOCATIONS = ["事務所", "消毒庫", "社用車", "その他"];

type DemoStatusFilter = "all" | "out" | "stock" | "overdue";

export default function DemoUnitsTab({ tenantId, currentOfficeId }: { tenantId: string; currentOfficeId: string | null }) {
  const todayStr = todayYmd();

  const [offices, setOffices] = useState<Office[]>([]);
  // ログイン中の事業所がある場合はそこに固定 (他事業所のデモ機は見せない)。無い場合のみ全事業所+セレクト
  const [officeFilter, setOfficeFilter] = useState<string>(currentOfficeId ?? "");
  const [subTab, setSubTab] = useState<"status" | "master">("status"); // 貸出状況 / 台帳管理
  const [units, setUnits] = useState<DemoUnit[]>([]); // 廃棄済み含む全件 (表示側でフィルタ)
  const [openLoans, setOpenLoans] = useState<DemoLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DemoStatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>(""); // "" = 全カテゴリ
  const [showInactive, setShowInactive] = useState(false); // 台帳管理: 廃棄済みを表示
  const [saving, setSaving] = useState(false);

  // ── 持出モーダル ──
  const [checkoutTarget, setCheckoutTarget] = useState<DemoUnit | null>(null);
  const [coClientName, setCoClientName] = useState("");
  const [coTakenDate, setCoTakenDate] = useState(todayStr);
  const [coTakenBy, setCoTakenBy] = useState("");
  const [coDueDate, setCoDueDate] = useState("");
  const [coMemo, setCoMemo] = useState("");

  // ── 返却モーダル ──
  const [returnTarget, setReturnTarget] = useState<{ unit: DemoUnit; loan: DemoLoan } | null>(null);
  const [rtDate, setRtDate] = useState(todayStr);
  const [rtBy, setRtBy] = useState("");
  const [rtLocation, setRtLocation] = useState("事務所");
  const [rtCleaned, setRtCleaned] = useState(false);

  // ── 台帳 追加/編集モーダル ("new" = 新規) ──
  const [editTarget, setEditTarget] = useState<DemoUnit | "new" | null>(null);
  const [euNo, setEuNo] = useState("");
  const [euCategory, setEuCategory] = useState("");
  const [euName, setEuName] = useState("");
  const [euColor, setEuColor] = useState("");
  const [euOfficeId, setEuOfficeId] = useState("");
  const [euMemo, setEuMemo] = useState("");

  // ── 貸出履歴モーダル ──
  const [historyTarget, setHistoryTarget] = useState<DemoUnit | null>(null);
  const [historyLoans, setHistoryLoans] = useState<DemoLoan[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const [u, l] = await Promise.all([
        listDemoUnits(tenantId, officeFilter || undefined, true),
        listOpenLoans(tenantId),
      ]);
      setUnits(u);
      setOpenLoans(l);
    } catch (e) {
      console.error("demo units load failed:", e);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tenantId, officeFilter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getOffices(tenantId).then(setOffices).catch((e) => console.error("offices load failed:", e));
  }, [tenantId]);

  const officeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of offices) m.set(o.id, o.name);
    return m;
  }, [offices]);

  // 貸出中 loan: unit_id → loan (open は 1 台 1 件想定。複数あれば最新)
  const loanByUnit = useMemo(() => {
    const m = new Map<string, DemoLoan>();
    for (const l of openLoans) if (!m.has(l.unit_id)) m.set(l.unit_id, l);
    return m;
  }, [openLoans]);

  const isOverdue = useCallback(
    (loan: DemoLoan) => !!loan.due_date && loan.due_date < todayStr,
    [todayStr]
  );

  // 貸出状況ビューは稼働中 (is_active=true) のみ対象
  const activeUnits = useMemo(() => units.filter((u) => u.is_active), [units]);

  const counts = useMemo(() => {
    let out = 0, stock = 0, overdue = 0;
    for (const u of activeUnits) {
      const loan = loanByUnit.get(u.id);
      if (loan) { out++; if (isOverdue(loan)) overdue++; }
      else stock++;
    }
    return { out, stock, overdue };
  }, [activeUnits, loanByUnit, isOverdue]);

  const categories = useMemo(() => {
    const list: string[] = [];
    for (const u of activeUnits) {
      const c = u.category || "未分類";
      if (!list.includes(c)) list.push(c);
    }
    return list;
  }, [activeUnits]);

  const filteredUnits = useMemo(() => activeUnits.filter((u) => {
    if (categoryFilter && (u.category || "未分類") !== categoryFilter) return false;
    const loan = loanByUnit.get(u.id);
    if (statusFilter === "out") return !!loan;
    if (statusFilter === "stock") return !loan;
    if (statusFilter === "overdue") return !!loan && isOverdue(loan);
    return true;
  }), [activeUnits, loanByUnit, statusFilter, categoryFilter, isOverdue]);

  // カテゴリごとにグループ表示 (出現順)
  const grouped = useMemo(() => {
    const m = new Map<string, DemoUnit[]>();
    for (const u of filteredUnits) {
      const key = u.category || "未分類";
      const arr = m.get(key);
      if (arr) arr.push(u);
      else m.set(key, [u]);
    }
    return Array.from(m.entries());
  }, [filteredUnits]);

  // 台帳管理ビュー: 「廃棄済みを表示」ON なら is_active=false も含める
  const masterUnits = useMemo(
    () => (showInactive ? units : activeUnits),
    [units, activeUnits, showInactive]
  );
  const masterGrouped = useMemo(() => {
    const m = new Map<string, DemoUnit[]>();
    for (const u of masterUnits) {
      const key = u.category || "未分類";
      const arr = m.get(key);
      if (arr) arr.push(u);
      else m.set(key, [u]);
    }
    return Array.from(m.entries());
  }, [masterUnits]);

  // ── モーダルを開く ──
  const openCheckout = (u: DemoUnit) => {
    setCoClientName("");
    setCoTakenDate(todayStr);
    setCoTakenBy("");
    setCoDueDate("");
    setCoMemo("");
    setCheckoutTarget(u);
  };

  const openReturn = (u: DemoUnit, loan: DemoLoan) => {
    setRtDate(todayStr);
    setRtBy("");
    setRtLocation("事務所");
    setRtCleaned(false);
    setReturnTarget({ unit: u, loan });
  };

  const openEdit = (u: DemoUnit | "new") => {
    if (u === "new") {
      setEuNo("");
      setEuCategory("");
      setEuName("");
      setEuColor("");
      setEuOfficeId(officeFilter);
      setEuMemo("");
    } else {
      setEuNo(u.unit_no);
      setEuCategory(u.category);
      setEuName(u.product_name);
      setEuColor(u.color ?? "");
      setEuOfficeId(u.office_id ?? "");
      setEuMemo(u.memo ?? "");
    }
    setEditTarget(u);
  };

  const openHistory = async (u: DemoUnit) => {
    setHistoryTarget(u);
    setHistoryLoans(null);
    setHistoryError(null);
    try {
      setHistoryLoans(await listLoansForUnit(tenantId, u.id));
    } catch (e) {
      console.error("demo loan history load failed:", e);
      setHistoryError(e instanceof Error ? e.message : String(e));
      setHistoryLoans([]);
    }
  };

  // ── 保存系ハンドラ ──
  const handleCheckout = async () => {
    if (!checkoutTarget) return;
    if (!coClientName.trim()) { alert("利用者名を入力してください"); return; }
    setSaving(true);
    try {
      await checkoutUnit({
        tenantId,
        unitId: checkoutTarget.id,
        clientName: coClientName.trim(),
        takenDate: coTakenDate || todayStr,
        takenBy: coTakenBy,
        dueDate: coDueDate,
        memo: coMemo,
      });
      setCheckoutTarget(null);
      await load();
    } catch (e) {
      console.error("demo checkout failed:", e);
      alert(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReturn = async () => {
    if (!returnTarget) return;
    setSaving(true);
    try {
      await returnUnit({
        tenantId,
        loanId: returnTarget.loan.id,
        unitId: returnTarget.unit.id,
        returnedDate: rtDate || todayStr,
        returnedBy: rtBy,
        storageLocation: rtLocation,
        cleaned: rtCleaned,
      });
      setReturnTarget(null);
      await load();
    } catch (e) {
      console.error("demo return failed:", e);
      alert(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveUnit = async () => {
    if (editTarget === null) return;
    if (!euName.trim()) { alert("商品名を入力してください"); return; }
    setSaving(true);
    try {
      if (editTarget === "new") {
        await createDemoUnit({
          tenant_id: tenantId,
          office_id: euOfficeId || null,
          unit_no: euNo.trim(),
          category: euCategory.trim(),
          product_name: euName.trim(),
          color: euColor.trim() || null,
          storage_location: "事務所",
          cleaned: true,
          memo: euMemo.trim() || null,
          is_active: true,
          sort_order: null,
        });
      } else {
        await updateDemoUnit(editTarget.id, {
          office_id: euOfficeId || null,
          unit_no: euNo.trim(),
          category: euCategory.trim(),
          product_name: euName.trim(),
          color: euColor.trim() || null,
          memo: euMemo.trim() || null,
        });
      }
      setEditTarget(null);
      await load();
    } catch (e) {
      console.error("demo unit save failed:", e);
      alert(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // 廃棄 (論理削除)。貸出中はブロック
  const handleDiscard = async (u: DemoUnit) => {
    if (loanByUnit.get(u.id)) {
      alert("貸出中のため廃棄できません。先に返却してください");
      return;
    }
    if (!confirm(`「${u.unit_no} ${u.product_name}」を廃棄 (非表示) にします。貸出履歴は残ります。`)) return;
    setSaving(true);
    try {
      await updateDemoUnit(u.id, { is_active: false });
      await load();
    } catch (e) {
      console.error("demo unit discard failed:", e);
      alert(`更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (u: DemoUnit) => {
    setSaving(true);
    try {
      await updateDemoUnit(u.id, { is_active: true });
      await load();
    } catch (e) {
      console.error("demo unit restore failed:", e);
      alert(`更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400";
  const chipCls = (active: boolean) =>
    `px-2.5 py-1 rounded-full text-xs whitespace-nowrap border transition-colors ${
      active ? "bg-emerald-500 text-white border-emerald-500" : "bg-white text-gray-600 border-gray-200 hover:border-emerald-300"
    }`;

  const statusChips: { id: DemoStatusFilter; label: string }[] = [
    { id: "all", label: "すべて" },
    { id: "out", label: `貸出中 ${counts.out}` },
    { id: "stock", label: `在庫 ${counts.stock}` },
    { id: "overdue", label: `返却期限超過 ${counts.overdue}` },
  ];

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
        <h2 className="font-semibold text-gray-800">デモ機管理</h2>
      </div>

      {/* サブタブ + フィルタ: 事業所 / (貸出状況: ステータス・カテゴリ) / (台帳管理: 追加・廃棄済み表示) */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 shrink-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {([["status", "貸出状況"], ["master", "台帳管理"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setSubTab(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  subTab === id ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}>
                {label}
              </button>
            ))}
          </div>
          <span className="w-px h-4 bg-gray-200" />
          {currentOfficeId ? (
            <span className="text-xs font-medium text-gray-600 px-1">
              {offices.find((o) => o.id === currentOfficeId)?.name ?? ""}
            </span>
          ) : (
            <select value={officeFilter} onChange={(e) => setOfficeFilter(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 bg-white">
              <option value="">全事業所</option>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {subTab === "status" ? (
            statusChips.map((c) => (
              <button key={c.id} onClick={() => setStatusFilter(c.id)}
                className={chipCls(statusFilter === c.id)}>{c.label}</button>
            ))
          ) : (
            <>
              <button onClick={() => openEdit("new")}
                className="flex items-center gap-1 text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg">
                <Plus size={14} /> デモ機を追加
              </button>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-emerald-500" />
                廃棄済みを表示
              </label>
            </>
          )}
        </div>
        {subTab === "status" && categories.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => setCategoryFilter("")} className={chipCls(categoryFilter === "")}>全カテゴリ</button>
            {categories.map((c) => (
              <button key={c} onClick={() => setCategoryFilter(c)} className={chipCls(categoryFilter === c)}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {/* 一覧 (カテゴリごとにグループ表示) */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : listError ? (
        <div className="p-4">
          <p className="text-sm text-red-500">読み込みに失敗しました: {listError}</p>
        </div>
      ) : subTab === "master" ? (
        /* ── 台帳管理ビュー ── */
        masterUnits.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            デモ機がありません。「デモ機を追加」から台帳に登録してください
          </p>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-4xl mx-auto space-y-4">
              {masterGrouped.map(([category, list]) => (
                <div key={category}>
                  <h3 className="text-xs font-semibold text-gray-500 mb-1.5">{category} <span className="font-normal text-gray-400">({list.length})</span></h3>
                  <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] text-gray-400 border-b border-gray-100">
                          <th className="text-left font-normal px-3 py-1.5 w-20">番号</th>
                          <th className="text-left font-normal px-3 py-1.5">商品名</th>
                          <th className="text-left font-normal px-3 py-1.5 w-24">カラー</th>
                          <th className="text-left font-normal px-3 py-1.5 w-32">状態</th>
                          <th className="text-right font-normal px-3 py-1.5 w-44">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((u) => {
                          const loan = loanByUnit.get(u.id) ?? null;
                          return (
                            <tr key={u.id} className={`border-b border-gray-50 last:border-b-0 ${u.is_active ? "" : "opacity-60"}`}>
                              <td className="px-3 py-2 text-xs font-mono text-gray-500">{u.unit_no || "―"}</td>
                              <td className="px-3 py-2 text-gray-800">
                                {u.product_name}
                                {!u.is_active && (
                                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 align-middle">廃棄済み</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-500">{u.color || "―"}</td>
                              <td className="px-3 py-2 text-xs">
                                {loan ? (
                                  <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">貸出中</span>
                                ) : (
                                  <span className="text-gray-500">{u.storage_location || "―"}</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-end gap-1.5">
                                  <button onClick={() => openEdit(u)}
                                    className="flex items-center gap-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-lg">
                                    <Pencil size={12} /> 編集
                                  </button>
                                  {u.is_active ? (
                                    <button onClick={() => handleDiscard(u)} disabled={saving}
                                      className="text-xs text-red-500 bg-red-50 hover:bg-red-100 border border-red-100 px-2.5 py-1 rounded-lg disabled:opacity-50">
                                      廃棄
                                    </button>
                                  ) : (
                                    <button onClick={() => handleRestore(u)} disabled={saving}
                                      className="text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-lg disabled:opacity-50">
                                      復活
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : filteredUnits.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-16">
          {activeUnits.length === 0 ? "デモ機がありません。「台帳管理」タブから登録してください" : "条件に合うデモ機がありません"}
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-4xl mx-auto space-y-4">
            {grouped.map(([category, list]) => (
              <div key={category}>
                <h3 className="text-xs font-semibold text-gray-500 mb-1.5">{category} <span className="font-normal text-gray-400">({list.length})</span></h3>
                <div className="space-y-1">
                  {list.map((u) => {
                    const loan = loanByUnit.get(u.id) ?? null;
                    const overdue = loan ? isOverdue(loan) : false;
                    return (
                      <div key={u.id}
                        onClick={() => openHistory(u)}
                        className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-emerald-300 transition-colors">
                        <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                          <span className="text-xs font-mono text-gray-500 shrink-0">{u.unit_no || "―"}</span>
                          <span className="text-sm font-medium text-gray-800 truncate">{u.product_name}</span>
                          {u.color && <span className="text-xs text-gray-400 shrink-0">{u.color}</span>}
                          {!officeFilter && u.office_id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">{officeNameById.get(u.office_id) ?? "事業所不明"}</span>
                          )}
                          {loan ? (
                            <span className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${overdue ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>
                              貸出中: {loan.client_name.replace(/[\s　]*様$/, "")} 様
                              {loan.taken_date && ` / 持出 ${loan.taken_date}`}
                              {loan.taken_by && ` (${loan.taken_by})`}
                              {loan.due_date && ` / 返却予定 ${loan.due_date}${overdue ? " 超過" : ""}`}
                            </span>
                          ) : (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 shrink-0">
                              在庫: {u.storage_location || "―"} / {u.cleaned ? "清掃済 ✓" : "未清掃"}
                            </span>
                          )}
                          {loan?.memo && <span className="text-[11px] text-gray-400 shrink-0">{loan.memo}</span>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {loan ? (
                            <button onClick={(e) => { e.stopPropagation(); openReturn(u, loan); }}
                              className="text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg">
                              返却
                            </button>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); openCheckout(u); }}
                              className="text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1.5 rounded-lg">
                              持出
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); openHistory(u); }}
                            className="p-1.5 text-gray-300 hover:text-emerald-600 rounded-lg" title="貸出履歴">
                            <History size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 持出モーダル ── */}
      {checkoutTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !saving && setCheckoutTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">持出 — {checkoutTarget.unit_no} {checkoutTarget.product_name}</h3>
              <button onClick={() => setCheckoutTarget(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg"><X size={18} /></button>
            </div>
            <div>
              <label className="text-xs text-gray-500">利用者名 <span className="text-red-500">*</span></label>
              <input type="text" value={coClientName} onChange={(e) => setCoClientName(e.target.value)} placeholder="例：山田 太郎" className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">持出日</label>
                <input type="date" value={coTakenDate} onChange={(e) => setCoTakenDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">持出者</label>
                <input type="text" value={coTakenBy} onChange={(e) => setCoTakenBy(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">返却予定日</label>
              <input type="date" value={coDueDate} onChange={(e) => setCoDueDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-gray-500">メモ (認定待ち 等)</label>
              <input type="text" value={coMemo} onChange={(e) => setCoMemo(e.target.value)} className={inputCls} />
            </div>
            <button onClick={handleCheckout} disabled={saving}
              className="w-full flex items-center justify-center gap-1 text-sm text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-2.5 rounded-xl disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />} 持出を記録
            </button>
          </div>
        </div>
      )}

      {/* ── 返却モーダル ── */}
      {returnTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !saving && setReturnTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">返却 — {returnTarget.unit.unit_no} {returnTarget.unit.product_name}</h3>
              <button onClick={() => setReturnTarget(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg"><X size={18} /></button>
            </div>
            <p className="text-xs text-gray-500">貸出先: {returnTarget.loan.client_name.replace(/[\s　]*様$/, "")} 様{returnTarget.loan.taken_date && ` (持出 ${returnTarget.loan.taken_date})`}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">返却日</label>
                <input type="date" value={rtDate} onChange={(e) => setRtDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">返却者</label>
                <input type="text" value={rtBy} onChange={(e) => setRtBy(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">保管場所</label>
              <select value={rtLocation} onChange={(e) => setRtLocation(e.target.value)} className={inputCls}>
                {DEMO_RETURN_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={rtCleaned} onChange={(e) => setRtCleaned(e.target.checked)} className="accent-emerald-500" />
              清掃済み
            </label>
            <button onClick={handleReturn} disabled={saving}
              className="w-full flex items-center justify-center gap-1 text-sm text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-2.5 rounded-xl disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />} 返却を記録
            </button>
          </div>
        </div>
      )}

      {/* ── 台帳 追加/編集モーダル ── */}
      {editTarget !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !saving && setEditTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">{editTarget === "new" ? "デモ機を追加" : "デモ機を編集"}</h3>
              <button onClick={() => setEditTarget(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">管理番号</label>
                <input type="text" value={euNo} onChange={(e) => setEuNo(e.target.value)} placeholder="例：1-1" className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">カテゴリ</label>
                <input type="text" value={euCategory} onChange={(e) => setEuCategory(e.target.value)} placeholder="例：シャワーチェア" className={inputCls} list="demo-category-list" />
                <datalist id="demo-category-list">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">商品名 <span className="text-red-500">*</span></label>
              <input type="text" value={euName} onChange={(e) => setEuName(e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">カラー</label>
                <input type="text" value={euColor} onChange={(e) => setEuColor(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-gray-500">事業所</label>
                <select value={euOfficeId} onChange={(e) => setEuOfficeId(e.target.value)} className={inputCls}>
                  <option value="">（未設定）</option>
                  {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">メモ</label>
              <input type="text" value={euMemo} onChange={(e) => setEuMemo(e.target.value)} className={inputCls} />
            </div>
            <button onClick={handleSaveUnit} disabled={saving}
              className="w-full flex items-center justify-center gap-1 text-sm text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-2.5 rounded-xl disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />} 保存
            </button>
          </div>
        </div>
      )}

      {/* ── 貸出履歴モーダル ── */}
      {historyTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setHistoryTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-lg p-5 space-y-3 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between shrink-0">
              <h3 className="font-semibold text-gray-800">貸出履歴 — {historyTarget.unit_no} {historyTarget.product_name}</h3>
              <button onClick={() => setHistoryTarget(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1.5">
              {historyLoans === null ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={22} className="animate-spin text-emerald-400" />
                </div>
              ) : historyError ? (
                <p className="text-sm text-red-500">読み込みに失敗しました: {historyError}</p>
              ) : historyLoans.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-10">貸出履歴がありません</p>
              ) : (
                historyLoans.map((l) => (
                  <div key={l.id} className="border border-gray-100 rounded-xl px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{l.client_name.replace(/[\s　]*様$/, "")} 様</span>
                      {l.returned_date ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">返却済</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">貸出中</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {l.taken_date ?? "―"} 〜 {l.returned_date ?? "―"}
                      {l.taken_by && ` / 持出: ${l.taken_by}`}
                      {l.returned_by && ` / 返却: ${l.returned_by}`}
                    </p>
                    {l.memo && <p className="text-xs text-gray-400 mt-0.5">{l.memo}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
