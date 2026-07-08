"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, Trash2, X, Search, FileSpreadsheet, AlertCircle } from "lucide-react";
import {
  getCeilingPrices,
  upsertCeilingPrices,
  deleteCeilingMonth,
  type EquipmentPriceCeiling,
  type CeilingImportRow,
} from "@/lib/ceilingPrices";

// 適用月ラベル: "YYYY-MM-DD" → "令和8年7月"
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

// ── 取込モーダル: 複数ファイル + ドラッグ&ドロップ対応 ─────────────────────
// 各ファイルを個別にパース (A1 から適用月を自動読取)、適用月はファイルごとに編集可。
// まとめて 取込 で全ファイルを upsert する。
type FileEntry = {
  key: number;
  fileName: string;
  status: "parsing" | "ok" | "error";
  error?: string;
  effectiveFrom: string | null;
  publicationLabel: string | null;
  count: number;
  rows: CeilingImportRow[];
  ym: string; // "YYYY-MM" (編集可)
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
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ total: number; months: number } | null>(null);
  const keyRef = useRef(0);

  const parseOne = useCallback(async (file: File) => {
    const key = keyRef.current++;
    setEntries((prev) => [
      ...prev,
      { key, fileName: file.name, status: "parsing", effectiveFrom: null, publicationLabel: null, count: 0, rows: [], ym: "" },
    ]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/ceiling-price-parse", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, status: "error", error: data.error ?? "取込に失敗しました" } : e)));
        return;
      }
      setEntries((prev) =>
        prev.map((e) =>
          e.key === key
            ? {
                ...e,
                status: "ok",
                effectiveFrom: data.effectiveFrom ?? null,
                publicationLabel: data.publicationLabel ?? null,
                count: data.count ?? 0,
                rows: (data.rows ?? []) as CeilingImportRow[],
                ym: data.effectiveFrom ? String(data.effectiveFrom).slice(0, 7) : "",
              }
            : e
        )
      );
    } catch {
      setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, status: "error", error: "通信エラーが発生しました" } : e)));
    }
  }, []);

  const handleFiles = useCallback(
    (fl: FileList | null) => {
      if (!fl || fl.length === 0) return;
      setError("");
      setDone(null);
      const files = Array.from(fl).filter((f) => f.name.toLowerCase().endsWith(".xlsx"));
      const skipped = fl.length - files.length;
      if (skipped > 0) setError(`.xlsx 以外の ${skipped}件 は除外しました`);
      files.forEach((f) => parseOne(f));
    },
    [parseOne]
  );

  const setYm = (key: number, ym: string) => setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ym } : e)));
  const removeEntry = (key: number) => setEntries((prev) => prev.filter((e) => e.key !== key));

  const okEntries = entries.filter((e) => e.status === "ok");
  const parsing = entries.some((e) => e.status === "parsing");
  const totalCount = okEntries.reduce((s, e) => s + e.count, 0);
  const distinctMonths = new Set(okEntries.filter((e) => e.ym).map((e) => e.ym)).size;
  const canSave = okEntries.length > 0 && okEntries.every((e) => e.ym) && !parsing && !saving;

  const handleSave = async () => {
    if (okEntries.length === 0) return;
    if (okEntries.some((e) => !e.ym)) {
      setError("適用開始月が未設定のファイルがあります");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let total = 0;
      const monthsSet = new Set<string>();
      for (const e of okEntries) {
        const eff = `${e.ym}-01`;
        const n = await upsertCeilingPrices(tenantId, eff, e.publicationLabel, e.rows);
        total += n;
        monthsSet.add(eff);
      }
      setDone({ total, months: monthsSet.size });
    } catch (err) {
      setError("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">上限・平均価格 Excel取込（複数可）</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {done ? (
            <div className="bg-emerald-50 rounded-xl p-6 text-center space-y-1">
              <CheckCircle2 size={30} className="text-emerald-500 mx-auto" />
              <p className="text-sm font-semibold text-emerald-700">
                {done.total}件（{done.months}適用月）を取り込みました
              </p>
            </div>
          ) : (
            <>
              {/* ドロップゾーン */}
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFiles(e.dataTransfer.files);
                }}
                className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 cursor-pointer transition-colors ${
                  dragging ? "border-emerald-500 bg-emerald-50" : "border-gray-200 hover:border-emerald-300 hover:bg-gray-50"
                }`}
              >
                <Upload size={24} className={dragging ? "text-emerald-500" : "text-gray-400"} />
                <p className="text-sm text-gray-600 font-medium">
                  Excelファイル(.xlsx)をドラッグ&ドロップ
                </p>
                <p className="text-xs text-gray-400">またはクリックして選択（複数選択可）</p>
                <input
                  type="file"
                  multiple
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    handleFiles(e.target.files);
                    e.target.value = ""; // 同じファイルの再選択を許可
                  }}
                  className="hidden"
                />
              </label>

              <p className="text-[11px] text-gray-400 leading-relaxed">
                各ファイルの A1/A2 から適用月（例: 令和8年7月）を自動読取します。ファイルごとに下で確認・変更できます。
              </p>

              {/* ファイル一覧 */}
              {entries.length > 0 && (
                <div className="space-y-2">
                  {entries.map((e) => {
                    const willOverwrite = e.ym ? existingMonths.has(`${e.ym}-01`) : false;
                    return (
                      <div
                        key={e.key}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                          e.status === "error" ? "border-red-200 bg-red-50" : "border-gray-100 bg-white"
                        }`}
                      >
                        <FileSpreadsheet
                          size={18}
                          className={e.status === "error" ? "text-red-400 shrink-0" : "text-emerald-500 shrink-0"}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-700 truncate" title={e.fileName}>
                            {e.fileName}
                          </p>
                          {e.status === "parsing" && (
                            <p className="text-[11px] text-gray-400 flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" />
                              読み込み中…
                            </p>
                          )}
                          {e.status === "error" && (
                            <p className="text-[11px] text-red-500 flex items-center gap-1">
                              <AlertCircle size={11} />
                              {e.error}
                            </p>
                          )}
                          {e.status === "ok" && (
                            <p className="text-[11px] text-gray-400 truncate">
                              {e.count}件{e.publicationLabel ? `・${e.publicationLabel}` : ""}
                              {willOverwrite && <span className="text-amber-600"> ・既存を上書き</span>}
                            </p>
                          )}
                        </div>
                        {e.status === "ok" && (
                          <input
                            type="month"
                            value={e.ym}
                            onChange={(ev) => setYm(e.key, ev.target.value)}
                            title="適用開始月"
                            className={`shrink-0 border rounded-lg px-2 py-1 text-xs outline-none focus:border-emerald-400 ${
                              e.ym ? "border-gray-200 text-gray-700" : "border-amber-300 text-amber-600"
                            }`}
                          />
                        )}
                        <button
                          onClick={() => removeEntry(e.key)}
                          className="shrink-0 p-1 text-gray-300 hover:text-red-500"
                          title="除外"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl p-3">{error}</p>}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 shrink-0">
          {done ? (
            <button onClick={onDone} className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600">
              完了
            </button>
          ) : (
            <>
              <button onClick={onClose} className="px-4 py-2 border border-gray-200 text-gray-600 text-sm rounded-xl hover:bg-gray-50">
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {okEntries.length > 0
                  ? `取込 (${totalCount}件 / ${distinctMonths}適用月)`
                  : "取込"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
