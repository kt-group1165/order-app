"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, Trash2, X, Search, FileSpreadsheet, AlertCircle, Download } from "lucide-react";
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
  // 商品別 価格推移ビュー
  const [view, setView] = useState<"list" | "pivot">("list");
  const [metric, setMetric] = useState<"ceiling" | "average">("ceiling"); // 既定=上限価格
  const [carryForward, setCarryForward] = useState(false); // 既定=公表値のみ (true=実効値/据え置き補完)
  const [onlyMulti, setOnlyMulti] = useState(true); // 推移あり(2回以上公表)のみ

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

  // ── 商品別 価格推移: TAIS で集約し 公表月を列に ──────────────────────
  const allMonthsAsc = useMemo(() => {
    const s = new Set(rows.map((r) => r.effective_from));
    return Array.from(s).sort();
  }, [rows]);

  type PivotRow = {
    tais: string;
    name: string | null;
    corp: string | null;
    model: string | null;
    count: number;
    ceil: Map<string, number>;
    avg: Map<string, number | null>;
  };

  const pivotRows = useMemo(() => {
    const map = new Map<string, PivotRow>();
    // 名称類は最新月の値を採用するため effective_from 昇順で上書き
    const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    for (const r of sorted) {
      let p = map.get(r.tais_code);
      if (!p) {
        p = { tais: r.tais_code, name: null, corp: null, model: null, count: 0, ceil: new Map(), avg: new Map() };
        map.set(r.tais_code, p);
      }
      p.ceil.set(r.effective_from, r.ceiling_price);
      p.avg.set(r.effective_from, r.average_price);
      p.count++;
      if (r.product_name) p.name = r.product_name;
      if (r.corp_name) p.corp = r.corp_name;
      if (r.model_number) p.model = r.model_number;
    }
    return Array.from(map.values()).sort((a, b) => a.tais.localeCompare(b.tais));
  }, [rows]);

  const pivotFiltered = useMemo(() => {
    let ps = pivotRows;
    if (onlyMulti) ps = ps.filter((p) => p.count >= 2);
    const q = search.trim().toLowerCase();
    if (q) ps = ps.filter((p) => [p.tais, p.name, p.corp, p.model].filter(Boolean).join(" ").toLowerCase().includes(q));
    return ps;
  }, [pivotRows, onlyMulti, search]);

  // 1商品の各月セル (shown=表示値, dir=前回比)
  const computeCells = useCallback(
    (p: PivotRow) => {
      let last: number | null = null;
      return allMonthsAsc.map((m) => {
        const published = p.ceil.has(m);
        const raw = published ? (metric === "ceiling" ? p.ceil.get(m)! : p.avg.get(m) ?? null) : null;
        let shown: number | null;
        let dir: "up" | "down" | null = null;
        if (raw != null) {
          if (last != null && raw !== last) dir = raw > last ? "up" : "down";
          last = raw;
          shown = raw;
        } else {
          shown = carryForward ? last : null;
        }
        return { m, shown, dir };
      });
    },
    [allMonthsAsc, metric, carryForward]
  );

  const exportPivotCSV = () => {
    const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["商品コード", "法人名", "商品名", "型番", ...allMonthsAsc.map(ymOf)];
    const lines = [header.map(esc).join(",")];
    for (const p of pivotFiltered) {
      const cells = computeCells(p);
      const row = [p.tais, p.corp ?? "", p.name ?? "", p.model ?? "", ...cells.map((c) => (c.shown != null ? String(c.shown) : ""))];
      lines.push(row.map((v) => esc(String(v))).join(","));
    }
    const csv = "﻿" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `上限価格推移_${metric === "ceiling" ? "上限" : "平均"}_${carryForward ? "実効値" : "公表値"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const PIVOT_ROW_CAP = 300;

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

      {/* 右: 取込一覧 / 商品別推移 */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 shrink-0 flex-wrap">
          {/* ビュー切替 */}
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 shrink-0">
            {([["list", "取込一覧"], ["pivot", "商品別推移"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  view === v ? "bg-white text-emerald-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 検索 */}
          <div className="flex-1 min-w-[8rem] flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
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
          {view === "pivot" && (
            <>
              {/* 上限 / 平均 */}
              <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 shrink-0">
                {([["ceiling", "上限"], ["average", "平均"]] as const).map(([mv, label]) => (
                  <button
                    key={mv}
                    onClick={() => setMetric(mv)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                      metric === mv ? "bg-white text-emerald-700 shadow-sm" : "text-gray-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* 公表値 / 実効値 */}
              <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 shrink-0">
                {([[false, "公表値"], [true, "実効値"]] as const).map(([cv, label]) => (
                  <button
                    key={String(cv)}
                    onClick={() => setCarryForward(cv)}
                    title={cv ? "据え置き月も前回価格で補完して表示" : "公表された月のみ表示"}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                      carryForward === cv ? "bg-white text-emerald-700 shadow-sm" : "text-gray-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setOnlyMulti((v) => !v)}
                title="2回以上公表された(推移のある)商品だけ表示"
                className={`px-2.5 py-1 text-xs font-medium rounded-lg border shrink-0 ${
                  onlyMulti ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-gray-200 text-gray-500"
                }`}
              >
                推移ありのみ
              </button>
              <button
                onClick={exportPivotCSV}
                className="flex items-center gap-1 bg-gray-600 text-white text-xs font-medium px-2.5 py-1 rounded-lg hover:bg-gray-700 shrink-0"
              >
                <Download size={13} />
                CSV
              </button>
            </>
          )}
          <span className="text-xs text-gray-400 shrink-0 ml-auto">
            {view === "list" ? filtered.length : pivotFiltered.length}件
          </span>
        </div>

        {loading ? (
          <div className="flex-1 flex justify-center py-16">
            <Loader2 size={22} className="animate-spin text-emerald-400" />
          </div>
        ) : view === "list" ? (
          <div className="flex-1 overflow-auto">
            {filtered.length === 0 ? (
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
        ) : (
          /* ── 商品別 価格推移 (TAIS×公表月ピボット) ── */
          <div className="flex-1 overflow-auto">
            {pivotFiltered.length === 0 ? (
              <p className="text-gray-400 text-center py-16 text-sm">該当商品がありません</p>
            ) : (
              <table className="text-xs border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th
                      className="sticky top-0 left-0 z-30 bg-gray-100 text-gray-600 font-semibold text-left px-3 py-2 border-b border-r border-gray-200"
                      style={{ minWidth: 120 }}
                    >
                      商品コード
                    </th>
                    <th
                      className="sticky top-0 z-20 bg-gray-100 text-gray-600 font-semibold text-left px-3 py-2 border-b border-r border-gray-200"
                      style={{ left: 120, minWidth: 200 }}
                    >
                      商品名
                    </th>
                    {allMonthsAsc.map((m) => (
                      <th
                        key={m}
                        className="sticky top-0 z-20 bg-gray-100 text-gray-500 font-semibold text-right px-2 py-2 border-b border-gray-200 whitespace-nowrap"
                        style={{ minWidth: 72 }}
                      >
                        {ymOf(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pivotFiltered.slice(0, PIVOT_ROW_CAP).map((p) => {
                    const cells = computeCells(p);
                    return (
                      <tr key={p.tais} className="group">
                        <td
                          className="sticky left-0 z-10 bg-white group-hover:bg-gray-50 font-mono text-gray-700 px-3 py-1.5 border-b border-r border-gray-100"
                          style={{ minWidth: 120 }}
                        >
                          {p.tais}
                        </td>
                        <td
                          className="sticky z-10 bg-white group-hover:bg-gray-50 text-gray-800 px-3 py-1.5 border-b border-r border-gray-100 max-w-[200px] truncate"
                          style={{ left: 120, minWidth: 200 }}
                          title={[p.name, p.corp, p.model].filter(Boolean).join(" / ")}
                        >
                          {p.name ?? "—"}
                        </td>
                        {cells.map((c) => (
                          <td
                            key={c.m}
                            className="text-right px-2 py-1.5 border-b border-gray-100 tabular-nums whitespace-nowrap group-hover:bg-gray-50"
                          >
                            {c.shown != null ? (
                              <span className={c.dir === "up" ? "text-red-600" : c.dir === "down" ? "text-blue-600" : "text-gray-700"}>
                                {c.dir === "up" ? "▲" : c.dir === "down" ? "▼" : ""}
                                {c.shown.toLocaleString()}
                              </span>
                            ) : (
                              <span className="text-gray-200">·</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {pivotFiltered.length > PIVOT_ROW_CAP && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-2 sticky bottom-0">
                {pivotFiltered.length}件中 先頭 {PIVOT_ROW_CAP}件 を表示中。検索で絞り込むか、CSV出力で全件確認してください。
              </p>
            )}
          </div>
        )}
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
