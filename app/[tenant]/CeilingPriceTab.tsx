"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, Loader2, CheckCircle2, Trash2, X, Search } from "lucide-react";
import {
  getCeilingPrices,
  upsertCeilingPrices,
  deleteCeilingMonth,
  type EquipmentPriceCeiling,
  type CeilingImportRow,
} from "@/lib/ceilingPrices";

// 適用月ラベル: "YYYY-MM-DD" → "令和8年7月 (2026-07)"
function monthLabel(eff: string): string {
  const [y, mo] = eff.split("-").map(Number);
  return `令和${y - 2018}年${mo}月`;
}
function ymOf(eff: string): string {
  return eff.slice(0, 7);
}

export default function CeilingPriceTab({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<EquipmentPriceCeiling[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await getCeilingPrices(tenantId));
    } catch (e) {
      console.error("上限価格の取得に失敗:", e);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の async fetch (既存 EquipmentTab と同パターン)
    load();
  }, [load]);

  // 適用月ごとの件数 (降順)
  const months = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.effective_from, (m.get(r.effective_from) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  const filtered = useMemo(() => {
    let rs = rows;
    if (selectedMonth) rs = rs.filter((r) => r.effective_from === selectedMonth);
    const q = search.trim().toLowerCase();
    if (q) {
      rs = rs.filter((r) =>
        [r.tais_code, r.product_name, r.corp_name, r.model_number]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }
    return rs;
  }, [rows, selectedMonth, search]);

  const handleDeleteMonth = async (eff: string) => {
    const cnt = months.find(([mm]) => mm === eff)?.[1] ?? 0;
    if (!window.confirm(`${monthLabel(eff)} 適用分 ${cnt}件を削除します。よろしいですか？`)) return;
    try {
      await deleteCeilingMonth(tenantId, eff);
      if (selectedMonth === eff) setSelectedMonth(null);
      load();
    } catch (e) {
      alert("削除に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: 適用月サマリ */}
      <div className="w-52 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col">
        <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">適用月</span>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 bg-emerald-500 text-white text-[11px] font-medium px-2 py-1 rounded-lg hover:bg-emerald-600"
          >
            <Upload size={12} />
            Excel取込
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={() => setSelectedMonth(null)}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              selectedMonth === null ? "bg-emerald-100 text-emerald-800 font-semibold" : "hover:bg-gray-100 text-gray-600"
            }`}
          >
            すべて <span className="text-gray-400">({rows.length})</span>
          </button>
          {months.map(([eff, cnt]) => (
            <div
              key={eff}
              className={`group flex items-center gap-1 rounded-lg ${
                selectedMonth === eff ? "bg-emerald-100" : "hover:bg-gray-100"
              }`}
            >
              <button
                onClick={() => setSelectedMonth(eff)}
                className={`flex-1 text-left px-2.5 py-1.5 text-xs min-w-0 ${
                  selectedMonth === eff ? "text-emerald-800 font-semibold" : "text-gray-600"
                }`}
              >
                <span className="block truncate">{monthLabel(eff)}</span>
                <span className="text-[10px] text-gray-400">
                  {ymOf(eff)}・{cnt}件
                </span>
              </button>
              <button
                onClick={() => handleDeleteMonth(eff)}
                title="この適用月の取込分を削除"
                className="shrink-0 p-1.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {months.length === 0 && !loading && (
            <p className="text-[11px] text-gray-400 px-2 py-4 text-center leading-relaxed">
              データがありません。
              <br />
              「Excel取込」から
              <br />
              公表データを取り込んでください。
            </p>
          )}
        </div>
      </div>

      {/* 右: 一覧 */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 shrink-0">
          <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="TAIS・商品名・法人名・型番で検索"
              className="flex-1 bg-transparent text-sm outline-none"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X size={14} className="text-gray-400" />
              </button>
            )}
          </div>
          <span className="text-xs text-gray-400 shrink-0">{filtered.length}件</span>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={22} className="animate-spin text-emerald-400" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-gray-400 text-center py-16 text-sm">該当データがありません</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-100 text-gray-600 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">商品コード(TAIS)</th>
                  <th className="px-3 py-2 text-left font-semibold">法人名</th>
                  <th className="px-3 py-2 text-left font-semibold">商品名</th>
                  <th className="px-3 py-2 text-left font-semibold">型番</th>
                  <th className="px-3 py-2 text-right font-semibold">平均価格</th>
                  <th className="px-3 py-2 text-right font-semibold">上限価格</th>
                  <th className="px-3 py-2 text-left font-semibold">適用月</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 font-mono text-gray-700">{r.tais_code}</td>
                    <td className="px-3 py-1.5 text-gray-600 max-w-[10rem] truncate" title={r.corp_name ?? ""}>
                      {r.corp_name ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-gray-800 max-w-[16rem] truncate" title={r.product_name ?? ""}>
                      {r.product_name ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500 max-w-[10rem] truncate" title={r.model_number ?? ""}>
                      {r.model_number ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-600 tabular-nums">
                      {r.average_price != null ? `¥${r.average_price.toLocaleString()}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold text-gray-800 tabular-nums">
                      ¥{r.ceiling_price.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{ymOf(r.effective_from)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showImport && (
        <CeilingPriceImportModal
          tenantId={tenantId}
          existingMonths={new Set(months.map(([m]) => m))}
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ── 取込モーダル: ファイル選択 → パース → プレビュー → 確定 ──────────────
type ParsedResult = {
  effectiveFrom: string | null;
  monthLabel: string;
  publicationLabel: string | null;
  sheetName: string;
  count: number;
  rows: CeilingImportRow[];
};

function CeilingPriceImportModal({
  tenantId,
  existingMonths,
  onClose,
  onDone,
}: {
  tenantId: string;
  existingMonths: Set<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"input" | "preview" | "done">("input");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [ym, setYm] = useState(""); // 適用月 "YYYY-MM" (編集可)
  const [doneCount, setDoneCount] = useState(0);

  const handleFile = async (file: File) => {
    setParsing(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/ceiling-price-parse", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "取込に失敗しました");
        return;
      }
      const p = data as ParsedResult;
      setParsed(p);
      setYm(p.effectiveFrom ? p.effectiveFrom.slice(0, 7) : "");
      setStep("preview");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    if (!parsed) return;
    if (!ym) {
      setError("適用開始月を指定してください");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const eff = `${ym}-01`;
      const n = await upsertCeilingPrices(tenantId, eff, parsed.publicationLabel, parsed.rows);
      setDoneCount(n);
      setStep("done");
    } catch (e) {
      setError("保存に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const willOverwrite = ym ? existingMonths.has(`${ym}-01`) : false;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">上限・平均価格 Excel取込</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === "input" && (
            <>
              <div className="bg-emerald-50 rounded-xl p-3 text-xs text-emerald-800 leading-relaxed">
                厚労省「福祉用具の全国平均貸与価格及び貸与価格の上限一覧」の Excel を選択してください。
                <br />
                A1/A2 に書かれた適用月（例: 令和8年7月）を自動読取します（次画面で確認・変更できます）。
              </div>
              <label className="block">
                <span className="text-xs font-medium text-gray-500 block mb-1">Excelファイル (.xlsx)</span>
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={parsing}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                  className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-emerald-500 file:text-white file:text-xs file:font-medium hover:file:bg-emerald-600"
                />
              </label>
              {parsing && (
                <p className="text-xs text-gray-500 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  読み込み中…
                </p>
              )}
              {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{error}</p>}
            </>
          )}

          {step === "preview" && parsed && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[10px] text-gray-400 mb-0.5">公表</p>
                  <p className="text-sm font-semibold text-gray-700 truncate" title={parsed.publicationLabel ?? ""}>
                    {parsed.publicationLabel ?? "—"}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[10px] text-gray-400 mb-0.5">読取件数</p>
                  <p className="text-sm font-semibold text-emerald-600">{parsed.count}件</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 mb-0.5">適用開始月 *</p>
                  <input
                    type="month"
                    value={ym}
                    onChange={(e) => setYm(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
                  />
                </div>
              </div>
              {!parsed.effectiveFrom && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-2.5">
                  Excelから適用月を自動読取できませんでした。適用開始月を手動で指定してください。
                </p>
              )}
              {willOverwrite && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-2.5">
                  同じ適用月（{ym}）の既存データがあります。取込むと上書きされます。
                </p>
              )}
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left">TAIS</th>
                      <th className="px-2 py-1.5 text-left">商品名</th>
                      <th className="px-2 py-1.5 text-right">平均</th>
                      <th className="px-2 py-1.5 text-right">上限</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {parsed.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 font-mono text-gray-600">{r.tais_code}</td>
                        <td className="px-2 py-1 text-gray-700 max-w-[16rem] truncate" title={r.product_name ?? ""}>
                          {r.product_name ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-500 tabular-nums">
                          {r.average_price != null ? r.average_price.toLocaleString() : "—"}
                        </td>
                        <td className="px-2 py-1 text-right font-semibold text-gray-700 tabular-nums">
                          {r.ceiling_price.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.rows.length > 8 && (
                  <p className="text-[10px] text-gray-400 px-2 py-1.5 bg-gray-50">ほか {parsed.rows.length - 8}件</p>
                )}
              </div>
              {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{error}</p>}
            </>
          )}

          {step === "done" && (
            <div className="bg-emerald-50 rounded-xl p-6 text-center space-y-1">
              <CheckCircle2 size={30} className="text-emerald-500 mx-auto" />
              <p className="text-sm font-semibold text-emerald-700">
                {doneCount}件を {ym} 適用分として取り込みました
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 shrink-0">
          {step === "preview" && (
            <>
              <button
                onClick={() => {
                  setStep("input");
                  setParsed(null);
                  setError("");
                }}
                className="px-4 py-2 border border-gray-200 text-gray-600 text-sm rounded-xl hover:bg-gray-50"
              >
                ← 戻る
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !ym}
                className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                この内容で取込
              </button>
            </>
          )}
          {step === "done" && (
            <button onClick={onDone} className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600">
              完了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
