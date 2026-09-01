"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Upload, Download, Plus, X, ChevronLeft, ChevronRight, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase, Equipment, EquipmentPrice, Supplier } from "@/lib/supabase";
import {
  getEquipment, importEquipment, parseEquipmentCSV, updateEquipment, createEquipmentItem,
  updateEquipmentSortOrders, addPriceHistory, getActiveEquipmentPrices, revisePurchasePrice,
  getAllActivePurchasePrices, bulkUpsertPurchasePrices, getActiveSuppliers, getEquipmentSetItems,
  saveEquipmentSetItems, findPriceCorrectionTargets, applyPriceCorrection,
  type ImportResult, type PriceCorrectionTarget,
} from "@/lib/equipment";
import {
  getOffices, getOfficePrices, upsertOfficePrice, deleteOfficePrice, bulkUpsertOfficePrices,
  type Office, type EquipmentOfficePrice,
} from "@/lib/offices";
import { invalidateCache } from "@/lib/cache";
import { matchEquipment, normalizeSearch } from "./search-utils";
import CeilingPriceTab from "./CeilingPriceTab";

export default function EquipmentTab({ tenantId }: { tenantId: string }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  type SortMode = "default" | "name" | "category" | "price_asc" | "price_desc";
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [dragId, setDragId] = useState<string | null>(null);
  const [localEquipment, setLocalEquipment] = useState<Equipment[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Equipment | null>(null);
  const [showNewItem, setShowNewItem] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<"idle" | "confirm1" | "confirm2">("idle");
  const [deleting, setDeleting] = useState(false);
  const [offices, setOffices] = useState<Office[]>([]);
  const [officePrices, setOfficePrices] = useState<EquipmentOfficePrice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierPrices, setSupplierPrices] = useState<EquipmentPrice[]>([]);
  const [showSupplierPriceUpdate, setShowSupplierPriceUpdate] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<"master" | "ceiling">("master");

  const handleDeleteAll = async () => {
    if (deleteConfirm === "idle") { setDeleteConfirm("confirm1"); return; }
    if (deleteConfirm === "confirm1") { setDeleteConfirm("confirm2"); return; }
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("equipment_master")
        .delete()
        .eq("tenant_id", tenantId);
      if (error) throw error;
      setDeleteConfirm("idle");
      await load();
    } catch {
      alert("削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  };

  // フリガナが未登録の用具を AI で一括生成
  const [bulkFuriganaState, setBulkFuriganaState] = useState<"idle" | "running" | "done">("idle");
  const [bulkFuriganaProgress, setBulkFuriganaProgress] = useState({ done: 0, total: 0 });
  const handleBulkGenerateFurigana = async () => {
    const targets = equipment.filter((e) => !e.furigana || !e.furigana.trim());
    if (targets.length === 0) {
      alert("フリガナ未登録の用具はありません。");
      return;
    }
    if (!confirm(`フリガナ未登録の用具 ${targets.length} 件のフリガナを AI で一括生成します。よろしいですか？`)) {
      return;
    }
    setBulkFuriganaState("running");
    setBulkFuriganaProgress({ done: 0, total: targets.length });
    try {
      // 50件ずつバッチでAPIに投げる
      const BATCH = 50;
      for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        const res = await fetch("/api/kana-convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: batch.map((e) => e.name), tenantId, purpose: "bulk_furigana" }),
        });
        const data = await res.json();
        const kanaArr: string[] = Array.isArray(data.kana) ? data.kana : [];
        // 各レコードを更新
        for (let j = 0; j < batch.length; j++) {
          const kana = (kanaArr[j] ?? "").trim();
          if (kana) {
            await supabase
              .from("equipment_master")
              .update({ furigana: kana, updated_at: new Date().toISOString() })
              .eq("id", batch[j].id);
          }
        }
        setBulkFuriganaProgress({ done: Math.min(i + BATCH, targets.length), total: targets.length });
      }
      // ブラウザ内のメモリキャッシュを無効化（音声発注のマッチング側が古い equipment を見ないように）
      invalidateCache("equipment:");
      setBulkFuriganaState("done");
      await load();
      setTimeout(() => setBulkFuriganaState("idle"), 2500);
    } catch (e) {
      console.error(e);
      alert("フリガナ生成に失敗しました");
      setBulkFuriganaState("idle");
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eq, ofs, ops, sups, spp] = await Promise.all([
        getEquipment(tenantId),
        getOffices(tenantId).catch(() => [] as Office[]),
        getOfficePrices(tenantId).catch(() => [] as EquipmentOfficePrice[]),
        getActiveSuppliers().catch(() => [] as Supplier[]),
        getAllActivePurchasePrices(tenantId).catch(() => [] as EquipmentPrice[]),
      ]);
      setEquipment(eq);
      setOffices(ofs);
      setOfficePrices(ops);
      setSuppliers(sups);
      setSupplierPrices(spp);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  // equipmentが変わったらlocalEquipmentも更新（デフォルト順）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setLocalEquipment(equipment);
    setOrderChanged(false);
  }, [equipment]);

  const handleExportCSV = () => {
    // 基本情報 + 事業所別レンタル価格(事業所:名) + 卸別仕入価格(仕入:名) を1つに統合
    const baseHeaders = ["用具名", "フリガナ", "TAISコード", "カテゴリ", "レンタル価格", "全国平均価格", "限度額", "商品コード", "選定理由", "提案理由"];
    const headers = [
      ...baseHeaders,
      ...offices.map((o) => `事業所:${o.name}`),
      ...suppliers.map((s) => `仕入:${s.name}`),
    ];
    const rows = localEquipment.map((e) => {
      const base = [
        e.name,
        e.furigana ?? "",
        e.tais_code ?? "",
        e.category ?? "",
        e.rental_price?.toString() ?? "",
        e.national_avg_price?.toString() ?? "",
        e.price_limit?.toString() ?? "",
        e.product_code,
        e.selection_reason ?? "",
        e.proposal_reason ?? "",
      ];
      const officeCells = offices.map((o) => {
        const op = officePrices.find((p) => p.product_code === e.product_code && p.office_id === o.id);
        return op ? String(op.rental_price) : "";
      });
      const supplierCells = suppliers.map((s) => {
        const pp = supplierPrices.find((p) => p.product_code === e.product_code && p.supplier_id === s.id);
        return pp ? String(pp.purchase_price) : "";
      });
      return [...base, ...officeCells, ...supplierCells];
    });
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "用具マスタ.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortedEquipment = (() => {
    if (sortMode === "default") return localEquipment;
    const arr = [...localEquipment];
    if (sortMode === "name") arr.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    else if (sortMode === "category") arr.sort((a, b) => {
      const ca = a.category ?? "zzz", cb = b.category ?? "zzz";
      if (ca !== cb) return ca.localeCompare(cb, "ja");
      return a.name.localeCompare(b.name, "ja");
    });
    else if (sortMode === "price_asc") arr.sort((a, b) => (a.rental_price ?? 0) - (b.rental_price ?? 0));
    else if (sortMode === "price_desc") arr.sort((a, b) => (b.rental_price ?? 0) - (a.rental_price ?? 0));
    return arr;
  })();
  const filtered = sortedEquipment.filter((e) => matchEquipment(e, search));

  const handleDragStart = (id: string) => {
    if (sortMode !== "default") return;
    setDragId(id);
  };
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId || sortMode !== "default") return;
    setLocalEquipment((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((x) => x.id === dragId);
      const toIdx   = arr.findIndex((x) => x.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
    setOrderChanged(true);
  };
  const handleDragEnd = () => setDragId(null);

  const saveOrder = async () => {
    setSavingOrder(true);
    try {
      const updates = localEquipment.map((e, i) => ({ id: e.id, sort_order: (i + 1) * 10 }));
      await updateEquipmentSortOrders(updates);
      setOrderChanged(false);
      await load();
    } catch {
      alert("並び順の保存に失敗しました");
    } finally {
      setSavingOrder(false);
    }
  };

  const CATEGORY_COLOR: Record<string, string> = {
    車いす: "bg-blue-100 text-blue-700",
    歩行器: "bg-purple-100 text-purple-700",
    ベッド: "bg-amber-100 text-amber-700",
    手すり: "bg-green-100 text-green-700",
    スロープ: "bg-orange-100 text-orange-700",
  };
  const catColor = (cat: string | null) =>
    cat ? (CATEGORY_COLOR[cat] ?? "bg-gray-100 text-gray-600") : "";

  // 用具コード → 卸別仕入の最安/最高 (一覧の仕入・粗利率列用)
  const purchaseByProduct = (() => {
    const m = new Map<string, { min: number; max: number }>();
    for (const p of supplierPrices) {
      const cur = m.get(p.product_code);
      if (!cur) m.set(p.product_code, { min: p.purchase_price, max: p.purchase_price });
      else { cur.min = Math.min(cur.min, p.purchase_price); cur.max = Math.max(cur.max, p.purchase_price); }
    }
    return m;
  })();

  if (selectedItem) {
    return (
      <EquipmentDetail
        item={selectedItem}
        tenantId={tenantId}
        onBack={() => setSelectedItem(null)}
        onSave={(saved) => { setSelectedItem(saved); load(); }}
        offices={offices}
        officePrices={officePrices}
        onReloadOfficePrices={load}
      />
    );
  }

  if (showNewItem) {
    return (
      <EquipmentDetail
        item={null}
        tenantId={tenantId}
        onBack={() => setShowNewItem(false)}
        onSave={(saved) => { setShowNewItem(false); setSelectedItem(saved); load(); }}
        offices={offices}
        officePrices={officePrices}
        onReloadOfficePrices={load}
      />
    );
  }

  const subTabBar = (
    <div className="bg-white border-b border-gray-200 px-3 pt-2 flex gap-1 shrink-0">
      {([["master", "用具マスタ"], ["ceiling", "上限・平均価格管理"]] as const).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setActiveSubTab(id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
            activeSubTab === id ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (activeSubTab === "ceiling") {
    return (
      <div className="flex flex-col h-full">
        {subTabBar}
        <CeilingPriceTab tenantId={tenantId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {subTabBar}
      {/* Search + Import */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 shrink-0">
        <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
          <Search size={14} className="text-gray-400 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="用具名・コードで検索"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")}>
              <X size={14} className="text-gray-400" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowNewItem(true)}
          className="shrink-0 flex items-center gap-1 bg-emerald-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Plus size={14} />
          新規
        </button>
        <button
          onClick={() => setShowImport(true)}
          className="shrink-0 flex items-center gap-1 bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Upload size={14} />
          取込
        </button>
        <button
          onClick={handleExportCSV}
          className="shrink-0 flex items-center gap-1 bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
          title="基本情報 + 事業所別レンタル価格 + 卸別仕入価格 を1つのCSVで出力"
        >
          <Download size={14} />
          CSV出力
        </button>
        <button
          onClick={() => setShowSupplierPriceUpdate(true)}
          className="shrink-0 flex items-center gap-1 bg-teal-600 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
          title="卸から届いた価格改定リストを貼り付けて差分確認のうえ反映"
        >
          <Upload size={14} />
          卸価格取込
        </button>
        {/* フリガナ未登録件数があれば一括生成ボタンを表示 */}
        {(() => {
          const missing = equipment.filter((e) => !e.furigana || !e.furigana.trim()).length;
          if (missing === 0 && bulkFuriganaState === "idle") return null;
          return (
            <button
              onClick={handleBulkGenerateFurigana}
              disabled={bulkFuriganaState === "running"}
              className={`shrink-0 flex items-center gap-1 text-white text-xs font-medium px-3 py-1.5 rounded-xl ${
                bulkFuriganaState === "running" ? "bg-amber-400" : bulkFuriganaState === "done" ? "bg-emerald-500" : "bg-amber-500"
              }`}
              title="フリガナ未登録の用具に対してAIでカタカナ読みを一括生成"
            >
              {bulkFuriganaState === "running"
                ? `生成中 ${bulkFuriganaProgress.done}/${bulkFuriganaProgress.total}`
                : bulkFuriganaState === "done"
                ? "完了"
                : `フリガナ生成 (${missing})`}
            </button>
          );
        })()}
        <button
          onClick={handleDeleteAll}
          disabled={deleting}
          className={`shrink-0 flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-xl transition-colors ${
            deleteConfirm === "idle"
              ? "bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500"
              : deleteConfirm === "confirm1"
              ? "bg-red-100 text-red-500"
              : "bg-red-500 text-white"
          }`}
        >
          {deleting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <X size={14} />
          )}
          {deleteConfirm === "idle" && "全削除"}
          {deleteConfirm === "confirm1" && "本当に？"}
          {deleteConfirm === "confirm2" && "実行する"}
        </button>
        {deleteConfirm !== "idle" && (
          <button
            onClick={() => setDeleteConfirm("idle")}
            className="shrink-0 text-xs text-gray-400 underline"
          >
            戻す
          </button>
        )}
      </div>

      <div className="px-3 py-2 bg-white border-b border-gray-100 shrink-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-gray-400 mr-1">{filtered.length}件</p>
          {/* 並び替えボタン */}
          {(["default","name","category","price_asc","price_desc"] as const).map((mode) => {
            const labels: Record<string, string> = {
              default: "CSV順", name: "名前順", category: "カテゴリ順",
              price_asc: "価格↑", price_desc: "価格↓"
            };
            return (
              <button key={mode} onClick={() => setSortMode(mode)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  sortMode === mode
                    ? "bg-emerald-500 text-white border-emerald-500"
                    : "bg-white text-gray-500 border-gray-200 hover:border-emerald-300"
                }`}>
                {labels[mode]}
              </button>
            );
          })}
          {/* 並び順保存ボタン（CSV順かつ変更あり時） */}
          {sortMode === "default" && orderChanged && (
            <button onClick={saveOrder} disabled={savingOrder}
              className="ml-auto flex items-center gap-1 text-xs bg-amber-500 text-white px-3 py-1 rounded-xl disabled:opacity-60">
              {savingOrder ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              順番を保存
            </button>
          )}
        </div>
        {sortMode === "default" && (
          <p className="text-[10px] text-gray-400 mt-0.5">CSV順のとき行をドラッグして並び替え可能</p>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">
              {equipment.length === 0 ? "用具データがありません。CSVからインポートしてください。" : "該当なし"}
            </p>
          ) : (
            <table className="min-w-[860px] w-full table-fixed bg-white text-left">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="pl-3 py-2 text-xs font-semibold text-gray-500 w-[5.5rem]">種目</th>
                  <th className="py-2 text-xs font-semibold text-gray-500">用具名</th>
                  <th className="py-2 px-3 text-xs font-semibold text-gray-500 w-[6.5rem]">コード</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[10rem]">TAISコード</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-gray-500 w-[5.5rem] text-right">レンタル価格</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[7.5rem] text-right">仕入</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[4rem] text-right">粗利率</th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dashed divide-gray-200">
                {filtered.map((item) => (
                  <tr key={item.id}
                    draggable={sortMode === "default"}
                    onDragStart={() => handleDragStart(item.id)}
                    onDragOver={(e) => handleDragOver(e, item.id)}
                    onDragEnd={handleDragEnd}
                    className={`hover:bg-gray-50 transition-colors cursor-pointer ${dragId === item.id ? "opacity-40" : ""}`}
                    onClick={() => setSelectedItem(item)}>
                    {/* 種目マーク */}
                    <td className="pl-3 py-2.5 w-[5.5rem] overflow-hidden">
                      {item.category && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium block truncate ${catColor(item.category)}`}>
                          {item.category}
                        </span>
                      )}
                    </td>
                    {/* 用具名 */}
                    <td className="py-2.5 text-sm font-medium text-gray-800 max-w-0">
                      <span className="block truncate">{item.name}</span>
                    </td>
                    {/* コード */}
                    <td className="py-2.5 px-3 text-xs text-gray-400 whitespace-nowrap w-[6.5rem]">
                      {item.product_code}
                    </td>
                    {/* TAISコード */}
                    <td className="py-2.5 pr-3 text-xs text-gray-400 whitespace-nowrap w-[10rem]">
                      {item.tais_code ? `TAIS: ${item.tais_code}` : ""}
                    </td>
                    {/* レンタル価格 */}
                    <td className="py-2.5 pr-2 text-sm font-semibold text-emerald-600 whitespace-nowrap w-[5.5rem] text-right">
                      {item.rental_price ? `¥${item.rental_price.toLocaleString()}` : ""}
                      <span className="text-xs font-normal text-gray-400">{item.rental_price ? "/月" : ""}</span>
                    </td>
                    {/* 仕入 (最安〜最高) */}
                    <td className="py-2.5 pr-3 text-xs text-gray-500 whitespace-nowrap w-[7.5rem] text-right">
                      {(() => {
                        const pp = purchaseByProduct.get(item.product_code);
                        if (!pp) return "";
                        return pp.min === pp.max ? `¥${pp.min.toLocaleString()}` : `¥${pp.min.toLocaleString()}〜¥${pp.max.toLocaleString()}`;
                      })()}
                    </td>
                    {/* 粗利率 (最安仕入基準) */}
                    <td className="py-2.5 pr-3 text-xs whitespace-nowrap w-[4rem] text-right">
                      {(() => {
                        const pp = purchaseByProduct.get(item.product_code);
                        if (!pp || !item.rental_price) return "";
                        const rate = Math.round(((item.rental_price - pp.min) / item.rental_price) * 100);
                        return <span className={rate >= 0 ? "text-emerald-600" : "text-red-500"}>{rate}%</span>;
                      })()}
                    </td>
                    {/* 矢印 */}
                    <td className="py-2.5 pr-3 w-6">
                      <ChevronRight size={16} className="text-gray-300" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showImport && (
        <ImportModal
          tenantId={tenantId}
          offices={offices}
          suppliers={suppliers}
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            load();
          }}
        />
      )}

      {showSupplierPriceUpdate && (
        <SupplierPriceUpdateModal
          tenantId={tenantId}
          suppliers={suppliers}
          equipment={equipment}
          onClose={() => setShowSupplierPriceUpdate(false)}
          onDone={() => {
            setShowSupplierPriceUpdate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Equipment Detail ────────────────────────────────────────────────────────

// 用具詳細の表示用: 左=項目 / 右=値 の1行 (divide-y カード内の定義リスト)
function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between items-baseline gap-6 px-5 py-3">
      <span className="text-xs text-gray-400 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 text-right break-words whitespace-pre-wrap">{value}</span>
    </div>
  );
}

function EquipmentDetail({
  item,
  tenantId,
  onBack,
  onSave,
  offices,
  officePrices,
  onReloadOfficePrices,
}: {
  item: Equipment | null;
  tenantId: string;
  onBack: () => void;
  onSave: (saved: Equipment) => void;
  offices: Office[];
  officePrices: EquipmentOfficePrice[];
  onReloadOfficePrices: () => void;
}) {
  const isNew = item === null;
  const [isEditing, setIsEditing] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 事業所別価格（この用具分）
  const myOfficePrices = item
    ? officePrices.filter((p) => p.product_code === item.product_code)
    : [];
  const [officePriceMap, setOfficePriceMap] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    myOfficePrices.forEach((p) => { m[p.office_id] = String(p.rental_price); });
    return m;
  });
  // 編集開始時に同期
  useEffect(() => {
    const m: Record<string, string> = {};
    const prices = item ? officePrices.filter((p) => p.product_code === item.product_code) : [];
    prices.forEach((p) => { m[p.office_id] = String(p.rental_price); });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setOfficePriceMap(m);
  }, [isEditing, officePrices, item]);

  // フォーム state
  const [name, setName] = useState(item?.name ?? "");
  const [furigana, setFurigana] = useState(item?.furigana ?? "");
  const [generatingFurigana, setGeneratingFurigana] = useState(false);
  const [taisCode, setTaisCode] = useState(item?.tais_code ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [rentalPrice, setRentalPrice] = useState(item?.rental_price ? String(item.rental_price) : "");
  const [nationalAvg, setNationalAvg] = useState(item?.national_avg_price ? String(item.national_avg_price) : "");
  const [priceLimit, setPriceLimit] = useState(item?.price_limit ? String(item.price_limit) : "");
  const [selectionReason, setSelectionReason] = useState(item?.selection_reason ?? "");
  const [proposalReason, setProposalReason] = useState(item?.proposal_reason ?? "");
  const todayYM = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const [priceEffectiveMonth, setPriceEffectiveMonth] = useState(todayYM);

  // 卸別仕入価格（月次改定）
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  // この用具の「現行」有効仕入価格（卸ごと1件）
  const [purchasePrices, setPurchasePrices] = useState<EquipmentPrice[]>([]);
  const [purchasePriceMap, setPurchasePriceMap] = useState<Record<string, string>>({});
  const [ppEffectiveMonth, setPpEffectiveMonth] = useState(todayYM);
  // 卸マスタを読み込む
  useEffect(() => {
    let active = true;
    getActiveSuppliers().then((s) => { if (active) setSuppliers(s); }).catch(() => {});
    return () => { active = false; };
  }, []);
  // この用具の現行仕入価格を読み込む
  useEffect(() => {
    if (!item) return; // 新規は現行仕入価格なし（初期値 [] のまま）
    let active = true;
    getActiveEquipmentPrices(tenantId, item.product_code)
      .then((ps) => { if (active) setPurchasePrices(ps); })
      .catch(() => {});
    return () => { active = false; };
  }, [tenantId, item]);
  // 編集開始 or 価格更新時に入力欄へ同期
  useEffect(() => {
    const m: Record<string, string> = {};
    purchasePrices.forEach((p) => { m[p.supplier_id] = String(p.purchase_price); });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount init / 現行値の同期)
    setPurchasePriceMap(m);
  }, [isEditing, purchasePrices]);

  // セット構成 (BOM)
  const [kind, setKind] = useState<"single" | "set">(item?.kind ?? "single");
  const [setComponents, setSetComponents] = useState<{ component_product_code: string; quantity: number }[]>([]);
  const [allEquip, setAllEquip] = useState<Equipment[]>([]);
  useEffect(() => {
    let active = true;
    getEquipment(tenantId).then((eq) => { if (active) setAllEquip(eq); }).catch(() => {});
    return () => { active = false; };
  }, [tenantId]);
  useEffect(() => {
    if (!item || item.kind !== "set") return;
    let active = true;
    getEquipmentSetItems(tenantId, item.product_code)
      .then((rows) => { if (active) setSetComponents(rows.map((r) => ({ component_product_code: r.component_product_code, quantity: r.quantity }))); })
      .catch(() => {});
    return () => { active = false; };
  }, [tenantId, item]);

  // 仕入価格の一括訂正 (過去の発注実績 restate + 監査ログ)
  const [correction, setCorrection] = useState<{ supplierId: string; month: string; newPrice: string; reason: string; targets: PriceCorrectionTarget[] | null; running: boolean; done: number | null } | null>(null);

  // 用具名から AI でフリガナ自動生成
  const handleGenerateFurigana = async () => {
    if (!name.trim()) return;
    setGeneratingFurigana(true);
    try {
      const res = await fetch("/api/kana-convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: [name.trim()], tenantId, purpose: "manual_kana" }),
      });
      const data = await res.json();
      if (Array.isArray(data.kana) && data.kana[0]) {
        setFurigana(data.kana[0]);
      }
    } catch {
      // 失敗時は無音
    } finally {
      setGeneratingFurigana(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("用具名は必須です"); return; }
    setSaving(true);
    setError("");
    try {
      const newRentalPrice = rentalPrice ? parseFloat(rentalPrice) : null;
      const payload = {
        name: name.trim(),
        furigana: furigana.trim() || null,
        tais_code: taisCode.trim() || null,
        category: category.trim() || null,
        rental_price: newRentalPrice,
        national_avg_price: nationalAvg ? parseFloat(nationalAvg) : null,
        price_limit: priceLimit ? parseFloat(priceLimit) : null,
        selection_reason: selectionReason.trim() || null,
        proposal_reason: proposalReason.trim() || null,
        kind,
      };
      const saved = isNew
        ? await createEquipmentItem(tenantId, payload)
        : await updateEquipment(item!.id, payload);
      // セット構成 (BOM) を保存 (kind=set の時のみ。single に戻したら構成を空に)
      await saveEquipmentSetItems(
        tenantId,
        saved.product_code,
        kind === "set" ? setComponents.filter((c) => c.component_product_code && c.quantity > 0) : []
      );
      // 価格が変更された場合（または新規）、履歴を記録（月初日で登録）
      if (newRentalPrice && priceEffectiveMonth) {
        const oldPrice = item?.rental_price ?? null;
        if (isNew || newRentalPrice !== oldPrice) {
          await addPriceHistory(tenantId, saved.product_code, newRentalPrice, `${priceEffectiveMonth}-01`);
        }
      }
      // 事業所別価格を保存
      await Promise.all(
        offices.map(async (office) => {
          const priceStr = officePriceMap[office.id] ?? "";
          const price = priceStr.trim() ? parseInt(priceStr.trim()) : 0;
          if (price > 0) {
            await upsertOfficePrice(tenantId, saved.product_code, office.id, price);
          } else {
            await deleteOfficePrice(tenantId, saved.product_code, office.id).catch((err) => {
              console.warn("deleteOfficePrice failed:", err);
            });
          }
        })
      );
      // 卸別仕入価格を保存（変更があった卸だけ、ppEffectiveMonth から有効な履歴行を追加）
      await Promise.all(
        suppliers.map(async (sup) => {
          const raw = purchasePriceMap[sup.id] ?? "";
          if (!raw.trim()) return; // 空欄 = 変更なし扱い（取扱終了トグルは別途）
          const val = parseInt(raw.trim());
          if (!Number.isFinite(val) || val <= 0) return;
          const current = purchasePrices.find((p) => p.supplier_id === sup.id)?.purchase_price ?? null;
          if (current === val) return; // 変更なしはスキップ（履歴を汚さない）
          await revisePurchasePrice({
            tenantId,
            productCode: saved.product_code,
            supplierId: sup.id,
            purchasePrice: val,
            effectiveMonth: ppEffectiveMonth,
          });
        })
      );
      // 現行仕入価格を再取得
      getActiveEquipmentPrices(tenantId, saved.product_code).then(setPurchasePrices).catch(() => {});
      onReloadOfficePrices();
      onSave(saved);
      setIsEditing(false);
    } catch {
      setError("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isNew) { onBack(); return; }
    // 元に戻す
    setName(item!.name);
    setFurigana(item!.furigana ?? "");
    setTaisCode(item!.tais_code ?? "");
    setCategory(item!.category ?? "");
    setRentalPrice(item!.rental_price ? String(item!.rental_price) : "");
    setNationalAvg(item!.national_avg_price ? String(item!.national_avg_price) : "");
    setPriceLimit(item!.price_limit ? String(item!.price_limit) : "");
    setSelectionReason(item!.selection_reason ?? "");
    setProposalReason(item!.proposal_reason ?? "");
    setPriceEffectiveMonth(new Date().toISOString().slice(0, 7));
    setKind(item!.kind ?? "single");
    // 卸別仕入価格の入力を現行値に戻す
    const pm: Record<string, string> = {};
    purchasePrices.forEach((p) => { pm[p.supplier_id] = String(p.purchase_price); });
    setPurchasePriceMap(pm);
    setPpEffectiveMonth(new Date().toISOString().slice(0, 7));
    setIsEditing(false);
    setError("");
  };

  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={isEditing && !isNew ? handleCancel : onBack}>
          <ChevronLeft size={20} className="text-gray-500" />
        </button>
        <h2 className="font-semibold text-gray-800 flex-1 truncate">
          {isNew ? "用具 新規登録" : (isEditing ? "用具を編集" : (item?.name ?? ""))}
        </h2>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl"
          >
            編集
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isEditing ? (
          /* 編集フォーム */
          <>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">用具名 *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：電動ベッド"
                type="text"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                フリガナ <span className="text-[10px] text-gray-400 font-normal">（音声発注のマッチング用）</span>
              </label>
              <div className="flex gap-2">
                <input
                  value={furigana}
                  onChange={(e) => setFurigana(e.target.value)}
                  placeholder="例：デンドウベッド"
                  type="text"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
                <button
                  type="button"
                  onClick={handleGenerateFurigana}
                  disabled={!name.trim() || generatingFurigana}
                  className="px-3 text-xs font-medium text-emerald-700 bg-emerald-50 disabled:opacity-40 rounded-xl whitespace-nowrap hover:bg-emerald-100"
                >
                  {generatingFurigana ? "生成中..." : "AI自動生成"}
                </button>
              </div>
            </div>
            {[
              { label: "TAISコード", value: taisCode, setter: setTaisCode, placeholder: "例：07-0001-01", type: "text" },
              { label: "カテゴリ", value: category, setter: setCategory, placeholder: "例：ベッド", type: "text" },
            ].map(({ label, value, setter, placeholder, type }) => (
              <div key={label}>
                <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
                <input
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={placeholder}
                  type={type}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            {/* レンタル価格 + 改定日 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">レンタル価格（円/月）</label>
              <input
                value={rentalPrice}
                onChange={(e) => setRentalPrice(e.target.value)}
                placeholder="例：15000"
                type="number"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">価格の適用開始月</label>
              <input
                type="month"
                value={priceEffectiveMonth}
                onChange={(e) => setPriceEffectiveMonth(e.target.value)}
                className="w-44 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <p className="text-[11px] text-gray-400 mt-1">価格を変更した場合のみ履歴に記録されます</p>
            </div>
            {[
              { label: "全国平均価格（円）", value: nationalAvg, setter: setNationalAvg, placeholder: "例：12000", type: "number" },
              { label: "限度額（円）", value: priceLimit, setter: setPriceLimit, placeholder: "例：18000", type: "number" },
            ].map(({ label, value, setter, placeholder, type }) => (
              <div key={label}>
                <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
                <input
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={placeholder}
                  type={type}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            {[
              { label: "選定理由", value: selectionReason, setter: setSelectionReason },
              { label: "提案理由", value: proposalReason, setter: setProposalReason },
            ].map(({ label, value, setter }) => (
              <div key={label}>
                <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
                <textarea
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  rows={3}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 resize-none"
                />
              </div>
            ))}
            {/* 事業所別レンタル価格 */}
            {offices.length > 0 && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-2">事業所別レンタル価格（円/月）</label>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {offices.map((office, idx) => (
                    <div key={office.id} className={`flex items-center gap-2 px-3 py-2 ${idx > 0 ? "border-t border-gray-100" : ""}`}>
                      <span className="text-sm text-gray-700 flex-1 truncate">{office.name}</span>
                      <input
                        type="number"
                        value={officePriceMap[office.id] ?? ""}
                        onChange={(e) => setOfficePriceMap((prev) => ({ ...prev, [office.id]: e.target.value }))}
                        placeholder="例：15000"
                        className="w-28 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right outline-none focus:border-emerald-400"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 商品種別 + セット構成 (BOM) */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">商品種別</label>
              <div className="flex gap-2">
                {(["single", "set"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                      kind === k ? "bg-emerald-500 text-white border-emerald-500" : "bg-white text-gray-500 border-gray-200"
                    }`}
                  >
                    {k === "single" ? "単品" : "セット（複数商品の組み合わせ）"}
                  </button>
                ))}
              </div>
              {kind === "set" && (
                <div className="mt-2 border border-gray-200 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-gray-400">構成品（この用具 = 以下の商品の組み合わせ）</p>
                  {setComponents.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={c.component_product_code}
                        onChange={(e) => setSetComponents((prev) => prev.map((x, j) => j === i ? { ...x, component_product_code: e.target.value } : x))}
                        className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white min-w-0"
                      >
                        <option value="">選択してください</option>
                        {allEquip
                          .filter((e) => e.kind !== "set" && e.product_code !== item?.product_code)
                          .map((e) => (
                            <option key={e.product_code} value={e.product_code}>{e.name}（{e.product_code}）</option>
                          ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        value={c.quantity}
                        onChange={(e) => setSetComponents((prev) => prev.map((x, j) => j === i ? { ...x, quantity: parseInt(e.target.value) || 1 } : x))}
                        className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right outline-none focus:border-emerald-400"
                      />
                      <button
                        type="button"
                        onClick={() => setSetComponents((prev) => prev.filter((_, j) => j !== i))}
                        className="shrink-0 text-gray-300 hover:text-red-400"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSetComponents((prev) => [...prev, { component_product_code: "", quantity: 1 }])}
                    className="text-xs font-medium text-emerald-600 flex items-center gap-1"
                  >
                    <Plus size={14} /> 構成品を追加
                  </button>
                </div>
              )}
            </div>
            {/* 卸別仕入価格（月次改定） */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-2">卸別仕入価格（円）</label>
              {suppliers.length === 0 ? (
                <p className="text-[11px] text-gray-400 border border-dashed border-gray-200 rounded-xl px-3 py-2">卸（仕入先）が未登録です。発注時に使う卸を登録すると、ここで卸ごとの仕入価格を月次で管理できます。</p>
              ) : (
                <>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {suppliers.map((sup, idx) => {
                    const cur = purchasePrices.find((p) => p.supplier_id === sup.id)?.purchase_price ?? null;
                    const rp = rentalPrice ? parseFloat(rentalPrice) : null;
                    const inputVal = purchasePriceMap[sup.id] ?? "";
                    const pv = inputVal.trim() ? parseInt(inputVal.trim()) : null;
                    const margin = rp != null && pv != null ? rp - pv : null;
                    return (
                      <div key={sup.id} className={`flex items-center gap-2 px-3 py-2 ${idx > 0 ? "border-t border-gray-100" : ""}`}>
                        <span className="text-sm text-gray-700 flex-1 truncate">{sup.name}</span>
                        {margin != null && (
                          <span className={`text-[11px] ${margin >= 0 ? "text-emerald-600" : "text-red-500"}`}>粗利 ¥{margin.toLocaleString()}</span>
                        )}
                        <input
                          type="number"
                          value={inputVal}
                          onChange={(e) => setPurchasePriceMap((prev) => ({ ...prev, [sup.id]: e.target.value }))}
                          placeholder={cur != null ? String(cur) : "例：9000"}
                          className="w-28 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right outline-none focus:border-emerald-400"
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2">
                  <label className="text-xs font-medium text-gray-600 block mb-1">仕入価格の適用開始月</label>
                  <input
                    type="month"
                    value={ppEffectiveMonth}
                    onChange={(e) => setPpEffectiveMonth(e.target.value)}
                    className="w-44 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">変更した卸のみ、この月から有効な価格として履歴に追加されます（過去の発注には影響しません）</p>
                </div>
                </>
              )}
            </div>
            {error && (
              <div className="flex items-center gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                <AlertCircle size={14} />
                {error}
              </div>
            )}
          </>
        ) : (
          /* 表示モード */
          <>
            <div className="max-w-2xl mx-auto w-full">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">
                <DetailRow label="商品コード" value={item?.product_code} />
                <DetailRow label="TAISコード" value={item?.tais_code} />
                <DetailRow label="フリガナ" value={item?.furigana} />
                <DetailRow label="カテゴリ" value={item?.category} />
                <DetailRow label="レンタル価格" value={item?.rental_price != null ? `¥${item.rental_price.toLocaleString()}/月` : null} />
                <DetailRow label="全国平均価格" value={item?.national_avg_price != null ? `¥${item.national_avg_price.toLocaleString()}` : null} />
                <DetailRow label="限度額" value={item?.price_limit != null ? `¥${item.price_limit.toLocaleString()}` : null} />
                <DetailRow label="選定理由" value={item?.selection_reason} />
                <DetailRow label="提案理由" value={item?.proposal_reason} />
                {/* 事業所別レンタル価格 */}
                {offices.length > 0 && myOfficePrices.length > 0 && (
                  <div className="px-5 py-3">
                    <p className="text-xs text-gray-400 mb-1.5">事業所別レンタル価格</p>
                    <div className="space-y-1.5">
                      {offices.map((office) => {
                        const op = myOfficePrices.find((p) => p.office_id === office.id);
                        if (!op) return null;
                        return (
                          <div key={office.id} className="flex justify-between items-baseline gap-6">
                            <span className="text-sm text-gray-500">{office.name}</span>
                            <span className="text-sm font-medium text-emerald-700">¥{op.rental_price.toLocaleString()}/月</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* セット構成 (BOM) */}
                {item?.kind === "set" && setComponents.length > 0 && (
                  <div className="px-5 py-3">
                    <p className="text-xs text-gray-400 mb-1.5">セット構成</p>
                    <div className="space-y-1.5">
                      {setComponents.map((c, i) => {
                        const eq = allEquip.find((e) => e.product_code === c.component_product_code);
                        return (
                          <div key={i} className="flex justify-between items-baseline gap-6">
                            <span className="text-sm text-gray-600">{eq?.name ?? c.component_product_code}</span>
                            <span className="text-sm text-gray-500">×{c.quantity}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* 卸別仕入価格（現行） */}
                {purchasePrices.length > 0 && (
                  <div className="px-5 py-3">
                    <p className="text-xs text-gray-400 mb-1.5">卸別仕入価格（現行）</p>
                    <div className="space-y-1.5">
                      {purchasePrices.map((p) => {
                        const sup = suppliers.find((s) => s.id === p.supplier_id);
                        const margin = item?.rental_price != null ? item.rental_price - p.purchase_price : null;
                        return (
                          <div key={p.id} className="flex justify-between items-baseline gap-6">
                            <span className="text-sm text-gray-500">{sup?.name ?? "（不明な卸）"}</span>
                            <span className="flex items-baseline gap-2">
                              <span className="text-sm font-medium text-gray-800">¥{p.purchase_price.toLocaleString()}</span>
                              {margin != null && (
                                <span className={`text-[11px] ${margin >= 0 ? "text-emerald-600" : "text-red-500"}`}>粗利 ¥{margin.toLocaleString()}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {/* 過去の発注実績の一括訂正 (誤入力の restate + 監査ログ) */}
                    {item && !correction && (
                      <button
                        onClick={() => setCorrection({ supplierId: suppliers[0]?.id ?? "", month: todayYM, newPrice: "", reason: "", targets: null, running: false, done: null })}
                        className="mt-2 text-[11px] font-medium text-gray-400 hover:text-gray-700 underline"
                      >
                        過去の発注実績の仕入価格を訂正…
                      </button>
                    )}
                    {item && correction && (
                      <div className="mt-3 border border-amber-200 bg-amber-50 rounded-xl p-3 space-y-2">
                        <p className="text-xs font-semibold text-amber-700">仕入価格の一括訂正（該当月の発注実績を直接修正・監査ログに記録）</p>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <select
                            value={correction.supplierId}
                            onChange={(e) => setCorrection({ ...correction, supplierId: e.target.value, targets: null, done: null })}
                            className="border border-gray-200 rounded-lg px-2 py-1.5 bg-white outline-none"
                          >
                            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                          <input
                            type="month"
                            value={correction.month}
                            onChange={(e) => setCorrection({ ...correction, month: e.target.value, targets: null, done: null })}
                            className="border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none"
                          />
                          <button
                            onClick={async () => {
                              if (!correction.supplierId || !correction.month) return;
                              setCorrection({ ...correction, running: true });
                              try {
                                const targets = await findPriceCorrectionTargets(tenantId, item.product_code, correction.supplierId, correction.month);
                                setCorrection((c) => c ? { ...c, targets, running: false } : c);
                              } catch {
                                setCorrection((c) => c ? { ...c, running: false } : c);
                                alert("対象の検索に失敗しました");
                              }
                            }}
                            disabled={correction.running}
                            className="px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-700 font-medium disabled:opacity-40"
                          >
                            対象を検索
                          </button>
                          {correction.targets != null && (
                            <span className="text-amber-700">該当 {correction.targets.length} 件</span>
                          )}
                        </div>
                        {correction.targets != null && correction.targets.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <input
                              type="number"
                              placeholder="正しい仕入価格"
                              value={correction.newPrice}
                              onChange={(e) => setCorrection({ ...correction, newPrice: e.target.value })}
                              className="w-32 border border-gray-200 rounded-lg px-2 py-1.5 text-right bg-white outline-none"
                            />
                            <input
                              type="text"
                              placeholder="訂正理由（任意）"
                              value={correction.reason}
                              onChange={(e) => setCorrection({ ...correction, reason: e.target.value })}
                              className="flex-1 min-w-40 border border-gray-200 rounded-lg px-2 py-1.5 bg-white outline-none"
                            />
                            <button
                              onClick={async () => {
                                const np = parseInt(correction.newPrice);
                                if (!Number.isFinite(np) || np <= 0 || !correction.targets) return;
                                if (!confirm(`${correction.targets.length} 件の発注実績の仕入価格を ¥${np.toLocaleString()} に訂正します。よろしいですか？`)) return;
                                setCorrection({ ...correction, running: true });
                                try {
                                  const { data: userData } = await supabase.auth.getUser();
                                  const n = await applyPriceCorrection({
                                    tenantId,
                                    targets: correction.targets.map((t) => ({ order_item_id: t.order_item_id, old_price: t.old_price })),
                                    newPrice: np,
                                    effectiveMonth: correction.month,
                                    reason: correction.reason || undefined,
                                    changedBy: userData.user?.email ?? undefined,
                                  });
                                  setCorrection((c) => c ? { ...c, running: false, done: n } : c);
                                } catch {
                                  setCorrection((c) => c ? { ...c, running: false } : c);
                                  alert("訂正の適用に失敗しました");
                                }
                              }}
                              disabled={correction.running || !correction.newPrice.trim()}
                              className="px-3 py-1.5 rounded-lg bg-amber-500 text-white font-medium disabled:opacity-40"
                            >
                              {correction.running ? "適用中…" : "訂正を適用"}
                            </button>
                          </div>
                        )}
                        {correction.done != null && (
                          <p className="text-xs font-medium text-emerald-700">✓ {correction.done} 件を訂正しました（監査ログに記録済み）</p>
                        )}
                        <button onClick={() => setCorrection(null)} className="text-[11px] text-gray-400 hover:text-gray-600 underline">閉じる</button>
                      </div>
                    )}
                  </div>
                )}
                <DetailRow label="更新日" value={item ? new Date(item.updated_at).toLocaleDateString("ja-JP") : null} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* 編集時フッター */}
      {isEditing && (
        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 flex gap-2">
          <button
            onClick={handleCancel}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            保存
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportModal({
  tenantId,
  offices,
  suppliers,
  onClose,
  onDone,
}: {
  tenantId: string;
  offices: Office[];
  suppliers: Supplier[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [priceResult, setPriceResult] = useState<{ officeCount: number; supplierCount: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [effectiveMonth, setEffectiveMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const handleImport = async () => {
    if (!csvText.trim()) {
      setError("CSVテキストを入力してください");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const text = csvText.replace(/^﻿/, "");
      // RFC4180 準拠の CSV パース (引用符内のカンマ・改行・"" エスケープ対応)。
      // 出力側 (handleExportCSV) が全セルを引用して書き出すため、
      // 出力したファイルは選定理由等にカンマ/改行を含んでいても必ず取り込める。
      const parseCsvTable = (src: string): string[][] => {
        const records: string[][] = [];
        let row: string[] = [];
        let cur = "";
        let q = false;
        for (let i = 0; i < src.length; i++) {
          const ch = src[i];
          if (q) {
            if (ch === '"') {
              if (src[i + 1] === '"') { cur += '"'; i++; } else q = false;
            } else cur += ch;
          } else if (ch === '"') q = true;
          else if (ch === ",") { row.push(cur.trim()); cur = ""; }
          else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && src[i + 1] === "\n") i++;
            row.push(cur.trim()); cur = "";
            if (row.some((c) => c !== "")) records.push(row);
            row = [];
          } else cur += ch;
        }
        row.push(cur.trim());
        if (row.some((c) => c !== "")) records.push(row);
        return records;
      };
      const records = parseCsvTable(text);
      if (records.length === 0) {
        setError("有効なデータが見つかりませんでした。CSVの形式を確認してください。");
        return;
      }
      const headers = records[0];
      const officeMap = new Map(offices.map((o) => [o.name, o.id]));
      const supplierMap = new Map(suppliers.map((s) => [s.name, s.id]));
      const officeCols: { idx: number; officeId: string }[] = [];
      const supplierCols: { idx: number; supplierId: string }[] = [];
      const baseColIdx: number[] = [];
      headers.forEach((h, i) => {
        if (h.startsWith("事業所:")) {
          const id = officeMap.get(h.slice(4));
          if (id) officeCols.push({ idx: i, officeId: id });
        } else if (h.startsWith("仕入:")) {
          const id = supplierMap.get(h.slice(3));
          if (id) supplierCols.push({ idx: i, supplierId: id });
        } else {
          baseColIdx.push(i);
        }
      });
      const codeIdx = headers.findIndex((h) => {
        const l = h.toLowerCase();
        return l.includes("商品コード") || l.includes("product_code");
      });

      // 基本情報: 事業所/仕入列を除いた CSV を再構成して既存パーサへ渡す
      const baseCsv = records
        .map((cols) => baseColIdx.map((i) => `"${String(cols[i] ?? "").replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const rows = parseEquipmentCSV(baseCsv);
      if (rows.length === 0) {
        setError("有効なデータが見つかりませんでした。CSVの形式を確認してください。");
        return;
      }
      const res = await importEquipment(tenantId, rows);

      // 事業所別レンタル価格 / 卸別仕入価格 も同時取込
      let officeCount = 0;
      let supplierCount = 0;
      if (codeIdx >= 0 && (officeCols.length > 0 || supplierCols.length > 0)) {
        const officeRows: { tenant_id: string; product_code: string; office_id: string; rental_price: number }[] = [];
        const supplierRows: { tenant_id: string; product_code: string; supplier_id: string; purchase_price: number; valid_from: string }[] = [];
        const validFrom = `${effectiveMonth}-01`;
        for (let i = 1; i < records.length; i++) {
          const cols = records[i];
          const productCode = cols[codeIdx]?.trim();
          if (!productCode) continue;
          for (const oc of officeCols) {
            const v = cols[oc.idx]?.trim();
            if (!v) continue;
            const price = parseInt(v.replace(/,/g, ""));
            if (isNaN(price) || price <= 0) continue;
            officeRows.push({ tenant_id: tenantId, product_code: productCode, office_id: oc.officeId, rental_price: price });
          }
          for (const sc of supplierCols) {
            const v = cols[sc.idx]?.trim();
            if (!v) continue;
            const price = parseInt(v.replace(/,/g, ""));
            if (isNaN(price) || price <= 0) continue;
            supplierRows.push({ tenant_id: tenantId, product_code: productCode, supplier_id: sc.supplierId, purchase_price: price, valid_from: validFrom });
          }
        }
        if (officeRows.length > 0) { await bulkUpsertOfficePrices(officeRows); officeCount = officeRows.length; }
        if (supplierRows.length > 0) { await bulkUpsertPurchasePrices(supplierRows); supplierCount = supplierRows.length; }
      }
      setPriceResult({ officeCount, supplierCount });
      setResult(res);
    } catch {
      setError("インポート中にエラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    // UTF-8で試してダメならShift-JIS
    let text = new TextDecoder("utf-8").decode(buffer);
    if (text.includes("\uFFFD")) {
      try {
        text = new TextDecoder("shift-jis").decode(buffer);
      } catch {}
    }
    setCsvText(text);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">用具CSVインポート</h3>
          <button onClick={onClose}>
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!result ? (
            <>
              <div className="bg-emerald-50 rounded-xl p-3 text-xs text-emerald-700 space-y-1">
                <p className="font-semibold">CSVの列（1行目がヘッダー）</p>
                <p>用具名（必須）、TAISコード、カテゴリ、レンタル価格、全国平均価格、限度額、商品コード</p>
                <p>「事業所:〇〇」列=事業所別レンタル価格 / 「仕入:〇〇」列=卸別仕入価格 も同時取込</p>
                <p>既存のTAISコード・用具名・商品コードが一致する場合は上書き更新されます</p>
                <p className="text-emerald-500">※「CSV出力」で全列入りテンプレートを取得できます</p>
              </div>

              {suppliers.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">仕入価格の適用開始月（「仕入:」列がある場合）</label>
                  <input
                    type="month"
                    value={effectiveMonth}
                    onChange={(e) => setEffectiveMonth(e.target.value)}
                    className="w-44 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                  />
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  ファイルを選択
                </label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFile}
                  className="text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-emerald-100 file:text-emerald-700 file:text-xs file:font-medium"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  またはCSVをここに貼り付け
                </label>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={"用具名,TAISコード,カテゴリ,レンタル価格\n電動ベッド,17-0671-00,ベッド,15000"}
                  className="w-full h-32 text-xs font-mono border border-gray-200 rounded-xl p-2 outline-none focus:border-emerald-400 resize-none"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                onClick={handleImport}
                disabled={loading}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Upload size={16} />
                )}
                インポート実行
              </button>
            </>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600">{result.inserted}</p>
                  <p className="text-xs text-emerald-600">新規追加</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-blue-600">{result.updated}</p>
                  <p className="text-xs text-blue-600">更新</p>
                </div>
              </div>

              {priceResult && (priceResult.officeCount > 0 || priceResult.supplierCount > 0) && (
                <div className="bg-teal-50 rounded-xl p-3 text-xs text-teal-700">
                  事業所別レンタル価格 {priceResult.officeCount}件 / 卸別仕入価格 {priceResult.supplierCount}件 を更新しました
                </div>
              )}

              {result.changes.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">変更内容</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {result.changes.map((c, i) => (
                      <div key={i} className="text-xs bg-amber-50 rounded-lg p-2">
                        <span className="font-medium">{c.name}</span>の{c.field}:{" "}
                        <span className="line-through text-gray-400">{c.old || "（空）"}</span>
                        {" → "}
                        <span className="text-amber-700">{c.new}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.errors.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-500 mb-2">
                    エラー ({result.errors.length}件)
                  </p>
                  <div className="space-y-1">
                    {result.errors.map((e, i) => (
                      <p key={i} className="text-xs text-red-500 bg-red-50 rounded-lg p-2">
                        {e}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={onDone}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={16} />
                完了
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 卸別価格取込 (差分プレビュー付き) ────────────────────────────────────────
// 卸から届く「変更となる用具と価格」の2列リスト (識別子, 新価格) を貼り付け →
// 差分プレビューで確認 → bulkUpsertPurchasePrices で valid_from 付き反映。

type SupplierPriceDiffRow = {
  /** 貼り付け元の行テキスト (エラー表示用) */
  line: string;
  status: "change" | "new" | "same" | "error";
  /** error のときの理由 (形式エラー / 該当なし / 複数候補 / 重複行) */
  reason?: string;
  equipmentName?: string;
  productCode?: string;
  currentPrice?: number;
  newPrice?: number;
};

function SupplierPriceUpdateModal({
  tenantId,
  suppliers,
  equipment,
  onClose,
  onDone,
}: {
  tenantId: string;
  suppliers: Supplier[];
  equipment: Equipment[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"input" | "preview" | "done">("input");
  const [supplierId, setSupplierId] = useState("");
  const [effectiveMonth, setEffectiveMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [listText, setListText] = useState("");
  const [currentPrices, setCurrentPrices] = useState<EquipmentPrice[] | null>(null);
  const [diffRows, setDiffRows] = useState<SupplierPriceDiffRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [doneCount, setDoneCount] = useState(0);

  // 現行有効価格 (卸別) を mount 時に fetch
  useEffect(() => {
    let active = true;
    getAllActivePurchasePrices(tenantId)
      .then((rows) => { if (active) setCurrentPrices(rows); })
      .catch((e) => {
        console.error("getAllActivePurchasePrices failed:", e);
        if (active) setError(`現行価格の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => { active = false; };
  }, [tenantId]);

  /** 識別子 → 用具の照合: ①product_code 完全一致 ②tais_code 完全一致 ③正規化名 完全一致 → 部分一致(一意のみ) */
  const matchIdentifier = (ident: string): { eq?: Equipment; reason?: string } => {
    const raw = ident.trim();
    if (!raw) return { reason: "形式エラー (識別子が空)" };
    const byCode = equipment.find((e) => e.product_code === raw);
    if (byCode) return { eq: byCode };
    const byTais = equipment.find((e) => (e.tais_code ?? "") !== "" && e.tais_code === raw);
    if (byTais) return { eq: byTais };
    const nq = normalizeSearch(raw);
    if (!nq) return { reason: "形式エラー (識別子が空)" };
    const exact = equipment.filter((e) => normalizeSearch(e.name) === nq);
    if (exact.length === 1) return { eq: exact[0] };
    if (exact.length > 1) return { reason: `複数候補 (${exact.length}件)` };
    const partial = equipment.filter((e) => normalizeSearch(e.name).includes(nq));
    if (partial.length === 1) return { eq: partial[0] };
    if (partial.length > 1) return { reason: `複数候補 (${partial.length}件)` };
    return { reason: "該当なし" };
  };

  /** 「差分を確認 →」: 貼り付けテキストをパースして差分行を組み立てる */
  const handlePreview = () => {
    setError("");
    if (!supplierId) { setError("卸を選択してください"); return; }
    if (!/^\d{4}-\d{2}$/.test(effectiveMonth)) { setError("適用開始月を指定してください"); return; }
    if (!listText.trim()) { setError("リストを貼り付けてください"); return; }
    if (currentPrices === null) { setError("現行価格を読み込み中です。少し待ってから再度お試しください"); return; }

    // 現行価格 lookup (選択卸のみ)
    const currentByProduct = new Map<string, number>();
    for (const p of currentPrices) {
      if (p.supplier_id === supplierId) currentByProduct.set(p.product_code, p.purchase_price);
    }

    const rows: SupplierPriceDiffRow[] = [];
    const seenProducts = new Set<string>();
    const lines = listText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    for (const line of lines) {
      // 末尾の価格 (¥・カンマ・全角数字許容) と、その手前の区切り (カンマ/タブ/読点) で分割
      const m = line.match(/^(.+?)[\t,，、]\s*([¥￥]?\s*[0-9０-９][0-9０-９,，.\s]*)\s*円?\s*$/);
      if (!m) {
        rows.push({ line, status: "error", reason: "形式エラー (識別子, 価格 の2列で入力)" });
        continue;
      }
      const priceStr = m[2]
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[¥￥,，.\s]/g, "");
      const price = parseInt(priceStr, 10);
      if (isNaN(price) || price <= 0) {
        rows.push({ line, status: "error", reason: "形式エラー (価格を数値化できない)" });
        continue;
      }
      const { eq, reason } = matchIdentifier(m[1]);
      if (!eq) {
        rows.push({ line, status: "error", reason });
        continue;
      }
      if (seenProducts.has(eq.product_code)) {
        rows.push({ line, status: "error", reason: `重複行 (${eq.name} は既に上の行にあります)`, equipmentName: eq.name, productCode: eq.product_code });
        continue;
      }
      seenProducts.add(eq.product_code);
      const cur = currentByProduct.get(eq.product_code);
      rows.push({
        line,
        status: cur === undefined ? "new" : cur === price ? "same" : "change",
        equipmentName: eq.name,
        productCode: eq.product_code,
        currentPrice: cur,
        newPrice: price,
      });
    }
    if (rows.length === 0) { setError("有効な行が見つかりませんでした"); return; }
    setDiffRows(rows);
    setStep("preview");
  };

  const applyTargets = diffRows.flatMap((r) =>
    (r.status === "change" || r.status === "new") && r.productCode && r.newPrice != null
      ? [{ tenant_id: tenantId, product_code: r.productCode, supplier_id: supplierId, purchase_price: r.newPrice, valid_from: `${effectiveMonth}-01` }]
      : []
  );

  const handleExecute = async () => {
    if (applyTargets.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await bulkUpsertPurchasePrices(applyTargets);
      setDoneCount(applyTargets.length);
      setStep("done");
    } catch (e) {
      console.error("bulkUpsertPurchasePrices failed:", e);
      setError(`取込に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const counts = {
    change: diffRows.filter((r) => r.status === "change").length,
    new: diffRows.filter((r) => r.status === "new").length,
    same: diffRows.filter((r) => r.status === "same").length,
    error: diffRows.filter((r) => r.status === "error").length,
  };
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? "";
  const monthLabel = /^\d{4}-\d{2}$/.test(effectiveMonth)
    ? `${parseInt(effectiveMonth.slice(0, 4), 10)}年${parseInt(effectiveMonth.slice(5, 7), 10)}月`
    : effectiveMonth;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">卸別価格取込</h3>
          <button onClick={onClose}>
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {step === "input" && (
            <>
              <div className="bg-teal-50 rounded-xl p-3 text-xs text-teal-700 space-y-1">
                <p className="font-semibold">卸から届いた価格改定リストをそのまま貼り付け</p>
                <p>1行 = 識別子（商品コード / TAISコード / 商品名）と新価格。カンマ or タブ区切り</p>
                <p>反映前に差分（現行 → 新価格）をプレビューで確認できます</p>
              </div>

              <div className="flex gap-3 flex-wrap">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">卸（必須）</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-52 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-teal-400 bg-white"
                  >
                    <option value="">選択してください</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">適用開始月</label>
                  <input
                    type="month"
                    value={effectiveMonth}
                    onChange={(e) => setEffectiveMonth(e.target.value)}
                    className="w-44 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-teal-400"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  卸から届いたリストを貼り付け（1行 = 識別子, 新価格）
                </label>
                <textarea
                  value={listText}
                  onChange={(e) => setListText(e.target.value)}
                  placeholder={"00170-000513, 9400\n安寿 楽らく開閉シャワーベンチ\t9400"}
                  className="w-full h-40 text-xs font-mono border border-gray-200 rounded-xl p-2 outline-none focus:border-teal-400 resize-none"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                onClick={handlePreview}
                className="w-full bg-teal-600 text-white py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2"
              >
                差分を確認
                <ChevronRight size={16} />
              </button>
            </>
          )}

          {step === "preview" && (
            <>
              <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
                <span>{supplierName} / {monthLabel}から適用</span>
                <span className="font-semibold">
                  <span className="text-red-500">変更 {counts.change}</span>
                  {" / "}
                  <span className="text-emerald-600">新規 {counts.new}</span>
                  {" / "}
                  <span className="text-gray-400">変更なし {counts.same}</span>
                  {" / "}
                  <span className={counts.error > 0 ? "text-red-500" : "text-gray-400"}>照合不可 {counts.error}</span>
                </span>
              </div>

              <div className="space-y-1 max-h-[45vh] overflow-y-auto">
                {diffRows.map((r, i) => {
                  if (r.status === "error") {
                    return (
                      <div key={i} className="text-xs bg-red-50 rounded-lg p-2 flex items-start gap-2">
                        <AlertCircle size={14} className="shrink-0 mt-0.5 text-red-500" />
                        <div className="min-w-0">
                          <p className="text-red-600 font-medium">{r.reason}（反映されません）</p>
                          <p className="text-red-400 truncate">{r.line}</p>
                        </div>
                      </div>
                    );
                  }
                  if (r.status === "same") {
                    return (
                      <div key={i} className="text-xs bg-gray-50 rounded-lg p-2 flex items-center justify-between gap-2 text-gray-400">
                        <span className="truncate">{r.equipmentName}</span>
                        <span className="shrink-0 whitespace-nowrap">¥{r.newPrice?.toLocaleString()} 変更なし（スキップ）</span>
                      </div>
                    );
                  }
                  if (r.status === "new") {
                    return (
                      <div key={i} className="text-xs bg-emerald-50 rounded-lg p-2 flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-gray-700">{r.equipmentName}</span>
                        <span className="shrink-0 whitespace-nowrap text-emerald-600 font-semibold">
                          (現行なし) → ¥{r.newPrice?.toLocaleString()} 新規設定
                        </span>
                      </div>
                    );
                  }
                  // change
                  const cur = r.currentPrice ?? 0;
                  const nw = r.newPrice ?? 0;
                  const diff = nw - cur;
                  const rate = cur > 0 ? Math.round((diff / cur) * 100) : 0;
                  const up = diff > 0;
                  return (
                    <div key={i} className="text-xs bg-white border border-gray-200 rounded-lg p-2 flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-gray-700">{r.equipmentName}</span>
                      <span className={`shrink-0 whitespace-nowrap font-semibold ${up ? "text-red-500" : "text-blue-500"}`}>
                        ¥{cur.toLocaleString()} → ¥{nw.toLocaleString()}
                        <span className="font-normal">
                          {" "}({up ? "+" : ""}{diff.toLocaleString()} / {up ? "+" : ""}{rate}%)
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => { setError(""); setStep("input"); }}
                  disabled={saving}
                  className="shrink-0 bg-gray-100 text-gray-600 px-4 py-3 rounded-xl font-medium text-sm disabled:opacity-50"
                >
                  ← 戻る
                </button>
                <button
                  onClick={handleExecute}
                  disabled={saving || applyTargets.length === 0}
                  className="flex-1 bg-teal-600 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                  この内容で取込（{applyTargets.length}件）
                </button>
              </div>
            </>
          )}

          {step === "done" && (
            <div className="space-y-4">
              <div className="bg-emerald-50 rounded-xl p-4 text-center space-y-1">
                <CheckCircle2 size={28} className="text-emerald-500 mx-auto" />
                <p className="text-sm font-semibold text-emerald-700">
                  {doneCount}件を{monthLabel}から有効な価格として登録しました
                </p>
                <p className="text-xs text-emerald-600">{supplierName} / 過去の発注価格には影響しません</p>
              </div>
              <button
                onClick={onDone}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={16} />
                完了
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
