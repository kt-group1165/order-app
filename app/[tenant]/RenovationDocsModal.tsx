"use client";

// 住宅改修の書類を作る画面。左で入力、右で A4 の書類を確認して印刷する。
// 入力は renovation_projects.documents (jsonb) に保存する。利用者の氏名・住所・被保険者番号などは
// 利用者マスタ (clients) から毎回読む (書類側に写さない = マスタを直せば書類も直る)。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Plus, Printer, Save, Trash2, X, AlertTriangle, ImagePlus, Maximize2, Minimize2 } from "lucide-react";
import type { Client } from "@/lib/supabase";
import {
  getClientRenovationHistory, getLatestRenovationIssuer, getRenovationClient, updateRenovationAmounts, getRenovationIssuerDefaults, saveRenovationDocuments, todayYmd,
  type RenovationProjectWithSteps,
} from "@/lib/renovations";
import {
  REASON_ACTIVITIES, REASON_PURPOSES, REASON_TOOLS, REASON_WORK_ITEMS, RENOVATION_KINDS,
  computeEstimate, defaultAddressee, detectEstimateColumns, emptyGroup, emptyLine, estimateCopay, normalizeDocs, rowsToEstimateLines,
  salePriceFromCost, warekiLabel, yenNum, type EstimateColumnMap,
  type EstimateGroup, type EstimateLine, type Issuer, type RenovationDocs, type RenovationKindNo, type ReasonActivityKey,
} from "@/lib/renovationDocs";
import { removeRenovationPhoto, resizeToJpeg, signRenovationPhotos, uploadRenovationPhoto } from "@/lib/renovationPhotos";
import {
  ConsentSheet, CoverLetterSheet, EstimateSheet, PhotoSheet, ReasonP1Sheet, ReasonP2Sheet, ReceiptSheet, type DocSheetProps,
} from "./RenovationDocSheets";
import { ApplicationSheet, cityFormFor, CITY_FORMS } from "./RenovationApplicationSheet";
import { MobaraIninjoSheet, MobaraJuryoTodokeSheet } from "./RenovationMobaraSheets";
import { IchiharaJizenKyogiSheet } from "./RenovationIchiharaSheets";

type DocKey = "estimate" | "reason1" | "reason2" | "consent" | "application" | "mobara_todoke" | "mobara_ininjo" | "ichihara_kyogi" | "photos" | "receipt_tmp" | "receipt" | "cover";
const DOC_LABELS: Record<DocKey, string> = {
  estimate: "見積書",
  reason1: "理由書 P1",
  reason2: "理由書 P2",
  consent: "住宅所有者承諾書",
  application: "支給申請書",
  mobara_todoke: "受領委任届（茂原市）",
  mobara_ininjo: "委任状（茂原市）",
  ichihara_kyogi: "事前協議願（市原市）",
  photos: "写真添付用紙",
  receipt_tmp: "仮領収書",
  receipt: "領収書",
  cover: "領収書送付状",
};
type FormTab = "estimate" | "reason" | "photos" | "application" | "receipt" | "issuer";
const FORM_TABS: [FormTab, string][] = [
  ["estimate", "見積"],
  ["reason", "理由書"],
  ["photos", "写真"],
  ["application", "所有者・申請"],
  ["receipt", "領収書"],
  ["issuer", "発行元"],
];

const PRINT_STYLE_ID = "__renovation_docs_print__";
/** A4 横で出す書類 (それ以外は A4 縦) */
const LANDSCAPE_DOCS = new Set<DocKey>(["estimate", "reason1", "reason2", "photos"]);

export default function RenovationDocsModal({
  tenantId,
  project,
  onClose,
  onSaved,
  onAmountsApplied,
}: {
  tenantId: string;
  project: RenovationProjectWithSteps;
  onClose: () => void;
  onSaved: (documents: RenovationDocs) => void;
  /** 見積の金額を進行表 (仕切り合計・計上金額) に反映したとき */
  onAmountsApplied?: (amounts: { cost_total: number | null; sales_total: number }) => void;
}) {
  const [client, setClient] = useState<Client | null>(null);
  const [docs, setDocs] = useState<RenovationDocs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<FormTab>("estimate");
  const [selected, setSelected] = useState<Set<DocKey>>(new Set<DocKey>(["estimate", "reason1", "reason2", "application"]));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 画面の分け方: 並べる / 入力だけ全画面 / 書類だけ全画面 */
  const [view, setView] = useState<"split" | "form" | "preview">("split");
  const [applyingAmounts, setApplyingAmounts] = useState(false);

  // 読み込み: 利用者 / 既存の書類 / 発行元 (同じ事業所の直前の案件 → 事業所・法人マスタ)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = project.client_id ? await getRenovationClient(project.client_id) : null;
        const address = c?.address ?? project.client_address ?? "";
        let issuer: Partial<Issuer> | undefined;
        if (!project.documents) {
          const latest = await getLatestRenovationIssuer(tenantId, project.office_id);
          if (latest && typeof latest === "object") {
            issuer = latest as Partial<Issuer>;
          } else {
            issuer = await getRenovationIssuerDefaults(project.office_id);
          }
          issuer = { ...issuer, staff_name: project.staff_name ?? (issuer?.staff_name ?? "") };
        }
        const d = normalizeDocs(project.documents, { clientAddress: address, issuer });
        if (!project.documents) {
          // 初回だけ: 理由書の日付・所属を案件から埋める
          const visit = project.steps.find((s) => s.step_key === "visit");
          d.reason.site_visit_date = visit?.actual_date ?? visit?.planned_date ?? null;
          d.reason.creator_office = project.care_office_text ?? "";
          d.reason.creator_name = project.care_manager_text ?? "";
          d.estimate.issue_date = todayYmd();
        }
        if (!cancelled) { setClient(c); setDocs(d); }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("書類データの読み込みに失敗:", msg);
        if (!cancelled) setLoadError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, project]);

  // 印刷: 選んだ書類だけを 1 枚ずつ。見積書・理由書は A4 横、他は A4 縦 (名前付き @page)
  useEffect(() => {
    const style = document.createElement("style");
    style.id = PRINT_STYLE_ID;
    style.textContent = `
      @page rdoc-landscape { size: A4 landscape; margin: 8mm; }
      @page rdoc-portrait { size: A4 portrait; margin: 10mm; }
      @media print {
        body > * { visibility: hidden !important; }
        #renovation-docs-print, #renovation-docs-print * { visibility: visible !important; }
        #renovation-docs-print {
          position: absolute !important; top: 0 !important; left: 0 !important;
          width: auto !important; height: auto !important; overflow: visible !important;
          background: #fff !important; padding: 0 !important;
        }
        #renovation-docs-modal { position: static !important; overflow: visible !important; }
        .no-print { display: none !important; }
        .rdoc-sheet { box-shadow: none !important; margin: 0 !important; break-after: page; }
        .rdoc-sheet:last-child { break-after: auto; }
        .rdoc-fit { zoom: 1 !important; box-shadow: none !important; padding: 0 !important; }
        #renovation-docs-preview-pane { display: flex !important; }
        .rdoc-landscape { page: rdoc-landscape; }
        .rdoc-portrait { page: rdoc-portrait; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById(PRINT_STYLE_ID)?.remove(); };
  }, []);

  const totals = useMemo(() => (docs ? computeEstimate(docs.estimate) : null), [docs]);

  // 右側 (書類の確認欄) の幅。書類を幅いっぱいに拡大縮小するのに使う
  const [previewEl, setPreviewEl] = useState<HTMLDivElement | null>(null);
  const [previewWidth, setPreviewWidth] = useState(0);
  useEffect(() => {
    if (!previewEl) return;
    const ro = new ResizeObserver(([entry]) => setPreviewWidth(entry.contentRect.width));
    ro.observe(previewEl);
    return () => ro.disconnect();
  }, [previewEl]);
  /** 書類の横幅 (px)。Sheet の幅 A4 横 281mm / 縦 190mm を 96dpi で換算 */
  const fitZoom = (k: DocKey): number => {
    if (previewWidth <= 0) return 1;
    // 紙の余白 (印刷時の @page と同じ 横 8mm / 縦 10mm) を付けた幅で合わせ、左右に少し灰色の余白を残す
    const natural = LANDSCAPE_DOCS.has(k) ? 1062 + 2 * 30 : 718 + 2 * 38;
    return Math.min(1.3, Math.max(0.3, (previewWidth * 0.94) / natural));
  };

  // 写真: Storage のパス → 署名付き URL (1 時間)。足りない分だけ取りに行く
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const photoKey = docs
    ? docs.estimate.groups.flatMap((g) => [g.photos.before?.path, g.photos.after?.path]).filter(Boolean).join("|")
    : "";
  useEffect(() => {
    const missing = photoKey ? photoKey.split("|").filter((p) => !photoUrls[p]) : [];
    if (missing.length === 0) return;
    let cancelled = false;
    signRenovationPhotos(missing)
      .then((urls) => { if (!cancelled) setPhotoUrls((prev) => ({ ...prev, ...urls })); })
      .catch((e) => console.error("写真の URL 取得に失敗:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
    // photoUrls は「取得済みか」の判定にだけ使う (入れると取得のたびに再実行される)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoKey]);
  const copay = totals ? estimateCopay(totals.grandTotal, project.copay_rate) : 0;
  const address = client?.address ?? project.client_address ?? "";
  const city = cityFormFor(address);

  if (loadError) {
    return (
      <Shell onClose={onClose} title="書類">
        <div className="p-6 text-sm text-red-700">読み込みに失敗しました: {loadError}</div>
      </Shell>
    );
  }
  if (!docs || !totals) {
    return (
      <Shell onClose={onClose} title="書類">
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      </Shell>
    );
  }

  const update = (fn: (d: RenovationDocs) => void) => {
    setDocs((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveRenovationDocuments(project.id, docs);
      setDirty(false);
      onSaved(docs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("書類データの保存に失敗:", msg);
      alert(
        msg.includes("documents")
          ? `保存に失敗しました: ${msg}\n\n書類用の列 (supabase/migrations/renovation_documents.sql) が DB に未適用の可能性があります。`
          : `保存に失敗しました: ${msg}`,
      );
    } finally {
      setSaving(false);
    }
  };

  /** 写真の追加・削除は Storage と書類データの両方を変えるので、その場で書類データも保存する */
  const persist = async (next: RenovationDocs) => {
    await saveRenovationDocuments(project.id, next);
    setDocs(next);
    setDirty(false);
    onSaved(next);
  };

  const handlePhotoUpload = async (gi: number, side: "before" | "after", file: File) => {
    setPhotoBusy(`${gi}-${side}`);
    let path: string | null = null;
    try {
      const blob = await resizeToJpeg(file);
      path = await uploadRenovationPhoto(project.id, blob);
      const next = structuredClone(docs);
      const old = next.estimate.groups[gi].photos[side];
      next.estimate.groups[gi].photos[side] = {
        path,
        // 撮影日の既定: 工事前 = 理由書の現地確認日 (旧 Excel と同じ) / 工事後 = 完成日
        taken_date: old?.taken_date ?? (side === "before" ? next.reason.site_visit_date : next.application.completed_date),
      };
      await persist(next);
      if (old) {
        await removeRenovationPhoto(old.path).catch((e) => console.warn("差し替え前の写真の削除に失敗 (残っても表示には影響しない):", e));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("写真の追加に失敗:", msg);
      // 書類データの保存に失敗したら、置いた写真は参照されないので消しておく
      if (path) await removeRenovationPhoto(path).catch((err) => console.warn("置いた写真の取り消しに失敗:", err));
      alert(
        /bucket|row-level security/i.test(msg)
          ? `${msg}\n\n写真の置き場 (supabase/migrations/renovation_photos_storage.sql) が DB に未適用の可能性があります。`
          : msg,
      );
    } finally {
      setPhotoBusy(null);
    }
  };

  const handlePhotoRemove = async (gi: number, side: "before" | "after") => {
    const old = docs.estimate.groups[gi].photos[side];
    if (!old || !confirm("この写真を削除しますか？")) return;
    setPhotoBusy(`${gi}-${side}`);
    try {
      const next = structuredClone(docs);
      next.estimate.groups[gi].photos[side] = null;
      await persist(next);
      await removeRenovationPhoto(old.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("写真の削除に失敗:", msg);
      alert(msg);
    } finally {
      setPhotoBusy(null);
    }
  };

  /** 市原市の事前協議願「以前の履歴」: 同じ利用者の過去の住宅改修案件から下書きを作る */
  const fillHistory = async () => {
    if (!project.client_id) return;
    try {
      const rows = await getClientRenovationHistory(tenantId, project.client_id, project.id);
      const text = rows.length === 0
        ? "なし"
        : rows.map((r) => [r.date ? warekiLabel(r.date) : "時期不明", r.work || "住宅改修", r.total !== null ? `${yenNum(r.total)}円` : ""].filter(Boolean).join("　")).join("\n");
      update((d) => { d.application.previous_history = text; });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("過去の住宅改修の取得に失敗:", msg);
      alert(`過去の住宅改修の取得に失敗しました: ${msg}`);
    }
  };

  /** 見積の総合計を計上金額に、仕入計 (税込換算) を仕切り合計に書き込む */
  const handleApplyAmounts = async () => {
    const cost = totals.costSubtotal > 0 ? totals.costTotal : null;
    const msg = `進行表の金額を更新します。\n計上金額: ¥${yenNum(totals.grandTotal)}${cost !== null ? `\n仕切り合計: ¥${yenNum(cost)} (仕入計の税込換算)` : "\n仕切り合計: 変更しません (仕入単価が入っていません)"}`;
    if (!confirm(msg)) return;
    setApplyingAmounts(true);
    try {
      await updateRenovationAmounts(project.id, cost, totals.grandTotal);
      onAmountsApplied?.({ cost_total: cost, sales_total: totals.grandTotal });
    } catch (e) {
      const m = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
      console.error("進行表の金額の更新に失敗:", m);
      alert(`更新に失敗しました: ${m}`);
    } finally {
      setApplyingAmounts(false);
    }
  };

  const handleClose = () => {
    if (dirty && !confirm("保存していない変更があります。閉じてよいですか？")) return;
    onClose();
  };

  const receiptAmount = docs.receipt.amount ?? copay;
  const addressee = docs.application.addressee || defaultAddressee(address);
  const sheetProps: DocSheetProps = { docs, project, client, totals, receiptAmount, addressee, photoUrls };
  // 茂原市の受領委任届・委任状は茂原市の利用者のときだけ選べる
  const order: DocKey[] = (["estimate", "reason1", "reason2", "consent", "application", "mobara_todoke", "mobara_ininjo", "ichihara_kyogi", "photos", "receipt_tmp", "receipt", "cover"] as DocKey[])
    .filter((k) => (!k.startsWith("mobara_") || city.city === "茂原市") && (!k.startsWith("ichihara_") || city.city === "市原市"));

  return (
    <Shell
      onClose={handleClose}
      title={`書類 — ${client?.name ?? project.client_name} 様`}
      actions={
        <>
          {dirty && <span className="text-[11px] text-amber-600">未保存の変更あり</span>}
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存
          </button>
          <button
            onClick={() => window.print()}
            disabled={selected.size === 0}
            className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
          >
            <Printer size={13} />選んだ書類を印刷
          </button>
        </>
      }
    >
      <div className="flex-1 flex min-h-0">
        {/* 入力 (view = "preview" のときは隠す / "form" のときは全幅) */}
        <div className={`no-print flex flex-col min-h-0 bg-white ${view === "preview" ? "hidden" : view === "form" ? "flex-1" : "w-[520px] shrink-0 border-r border-gray-200"}`}>
          <div className="flex items-end gap-1 px-2 pt-2 border-b border-gray-200">
            {FORM_TABS.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t border-b-2 ${tab === id ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-400 hover:text-gray-600"}`}
              >
                {label}
              </button>
            ))}
            <ViewToggle expanded={view === "form"} onClick={() => setView(view === "form" ? "split" : "form")} what="入力" />
          </div>
          <div className={`flex-1 overflow-y-auto p-3 space-y-3 text-xs ${view === "form" ? "w-full max-w-4xl mx-auto" : ""}`}>
            {!client && (
              <Warn>この案件は利用者マスタと紐付いていません。氏名・住所以外 (被保険者番号・生年月日等) は空欄で出ます。案件の編集で利用者を選んでください。</Warn>
            )}
            {tab === "estimate" && (
              <EstimateForm docs={docs} update={update} totals={totals} contractor={project.contractor}
                onApplyAmounts={handleApplyAmounts} applying={applyingAmounts}
                current={{ cost: project.cost_total, sales: project.sales_total }} />
            )}
            {tab === "reason" && <ReasonForm docs={docs} update={update} />}
            {tab === "application" && (
              <ApplicationForm docs={docs} update={update} address={address} cityName={city.city} hasForm={!!city.form} onFillHistory={project.client_id ? fillHistory : null} />
            )}
            {tab === "receipt" && <ReceiptForm docs={docs} update={update} copay={copay} copayRate={project.copay_rate} grandTotal={totals.grandTotal} />}
            {tab === "issuer" && <IssuerForm docs={docs} update={update} />}
            {tab === "photos" && (
              <PhotosForm docs={docs} update={update} photoUrls={photoUrls} busy={photoBusy} onUpload={handlePhotoUpload} onRemove={handlePhotoRemove} />
            )}
          </div>
        </div>

        {/* 書類 (view = "form" のときは画面では隠すが、印刷では出す = #renovation-docs-preview-pane) */}
        <div id="renovation-docs-preview-pane" className={`flex-1 min-w-0 flex-col min-h-0 bg-gray-100 ${view === "form" ? "hidden" : "flex"}`}>
          <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-white border-b border-gray-200 text-xs">
            <span className="text-gray-500">印刷する書類:</span>
            {order.map((k) => (
              <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(k)}
                  onChange={(e) => setSelected((prev) => {
                    const n = new Set(prev);
                    if (e.target.checked) n.add(k); else n.delete(k);
                    return n;
                  })}
                />
                {DOC_LABELS[k]}
              </label>
            ))}
            <ViewToggle expanded={view === "preview"} onClick={() => setView(view === "preview" ? "split" : "preview")} what="書類" />
          </div>
          <div ref={setPreviewEl} id="renovation-docs-print" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-4 flex flex-col items-center gap-4">
            {order.filter((k) => selected.has(k)).map((k) => (
              // 右側の幅に合わせて書類ごとに拡大縮小する (横がはみ出さない)。印刷では等倍に戻す (.rdoc-fit)
              <div key={k} className="shadow-md rdoc-fit bg-white" style={{ zoom: fitZoom(k), padding: LANDSCAPE_DOCS.has(k) ? "8mm" : "10mm" }}>
                {k === "estimate" && <EstimateSheet {...sheetProps} />}
                {k === "reason1" && <ReasonP1Sheet {...sheetProps} />}
                {k === "reason2" && <ReasonP2Sheet {...sheetProps} />}
                {k === "consent" && <ConsentSheet {...sheetProps} />}
                {k === "application" && <ApplicationSheet {...sheetProps} />}
                {k === "mobara_todoke" && <MobaraJuryoTodokeSheet {...sheetProps} />}
                {k === "mobara_ininjo" && <MobaraIninjoSheet {...sheetProps} />}
                {k === "ichihara_kyogi" && <IchiharaJizenKyogiSheet {...sheetProps} />}
                {k === "receipt_tmp" && <ReceiptSheet {...sheetProps} provisional />}
                {k === "receipt" && <ReceiptSheet {...sheetProps} />}
                {k === "cover" && <CoverLetterSheet {...sheetProps} />}
                {k === "photos" && (
                  <div className="flex flex-col gap-4">
                    {docs.estimate.groups.map((g, gi) => <PhotoSheet key={gi} {...sheetProps} group={g} />)}
                  </div>
                )}
              </div>
            ))}
            {selected.size === 0 && <div className="no-print text-gray-400 text-sm py-16">上で書類を選んでください</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ─── 枠 ──────────────────────────────────────────────────────────────────────

function Shell({ title, onClose, actions, children }: { title: string; onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <div id="renovation-docs-modal" className="fixed inset-0 bg-black/60 z-[60] flex">
      <div className="bg-white w-full h-full flex flex-col">
        <div className="no-print flex items-center gap-2 px-4 py-2 border-b border-gray-200 shrink-0">
          <h3 className="font-semibold text-gray-700 text-sm">{title}</h3>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 ml-1" title="閉じる"><X size={18} /></button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1.5 items-start rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800">
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

type Upd = (fn: (d: RenovationDocs) => void) => void;

const inputCls = "w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400";

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-500 mb-0.5">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-gray-400 mt-0.5">{hint}</span>}
    </label>
  );
}

function Text({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function DateIn({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return <input type="date" className={inputCls} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
}

function Area({ value, onChange, rows = 4, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea className={inputCls} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * 数値欄。空 = null。全角数字・カンマも受ける。
 * 打っている途中の文字列 ("0." 等) は手元に持つ。value から毎回描き直すと "0." が 0 になり、
 * 小数点が消えて 0.9 が 9 になる (2026-10-15 本番で実際に起きた)。
 */
function Num({ value, onChange, step }: { value: number | null; onChange: (v: number | null) => void; step?: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const parse = (s: string): number | null | undefined => {
    const raw = s.normalize("NFKC").replace(/,/g, "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  // 外から値が変わったとき (別の操作で書き換わった等) だけ表示を合わせる
  const shown = parse(text) === value ? text : value === null ? "" : String(value);
  return (
    <input
      className={`${inputCls} text-right`}
      inputMode="decimal"
      step={step}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n !== undefined) onChange(n);
      }}
    />
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-1 cursor-pointer mr-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ─── 見積 ────────────────────────────────────────────────────────────────────

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮"];

function EstimateForm({ docs, update, totals, contractor, onApplyAmounts, applying, current }: {
  docs: RenovationDocs; update: Upd; totals: ReturnType<typeof computeEstimate>;
  contractor: string | null; onApplyAmounts: () => void; applying: boolean;
  current: { cost: number | null; sales: number | null };
}) {
  const e = docs.estimate;
  const setLine = (gi: number, li: number, patch: Partial<EstimateLine>) =>
    update((d) => { Object.assign(d.estimate.groups[gi].lines[li], patch); });
  const setGroup = (gi: number, patch: Partial<EstimateGroup>) =>
    update((d) => { Object.assign(d.estimate.groups[gi], patch); });
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="見積日"><DateIn value={e.issue_date} onChange={(v) => update((d) => { d.estimate.issue_date = v; })} /></Field>
        <Field label="工事着工予定日"><DateIn value={e.start_date} onChange={(v) => update((d) => { d.estimate.start_date = v; })} /></Field>
        <Field label="件名"><Text value={e.title} onChange={(v) => update((d) => { d.estimate.title = v; })} /></Field>
        <Field label="工事場所"><Text value={e.site} onChange={(v) => update((d) => { d.estimate.site = v; })} /></Field>
        <Field label="支払条件"><Text value={e.payment_terms} onChange={(v) => update((d) => { d.estimate.payment_terms = v; })} /></Field>
        <Field label="有効期限"><Text value={e.validity} onChange={(v) => update((d) => { d.estimate.validity = v; })} /></Field>
        <Field label="諸経費率 (%)">
          <Num value={Math.round(e.overhead_rate * 1000) / 10} onChange={(v) => update((d) => { d.estimate.overhead_rate = (v ?? 0) / 100; })} />
        </Field>
      </div>

      {/* 利益の乗せ方 (施工会社の見積 = 仕入単価 に対して) */}
      <div className="border border-gray-200 rounded p-2 space-y-1.5">
        <div className="font-semibold text-gray-600">利益の乗せ方</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="inline-flex items-center gap-1"><input type="radio" checked={e.markup_mode === "unit"} onChange={() => update((d) => { d.estimate.markup_mode = "unit"; })} />単価に上乗せ</label>
          <label className="inline-flex items-center gap-1"><input type="radio" checked={e.markup_mode === "overhead"} onChange={() => update((d) => { d.estimate.markup_mode = "overhead"; })} />単価は仕入のまま・諸経費に乗せる</label>
        </div>
        {e.markup_mode === "unit" ? (
          <div className="flex items-end gap-2">
            <Field label="上乗せ率 (%)" hint="仕入単価 × (1 + 上乗せ率) を 10 円単位に切り上げ">
              <Num value={Math.round(e.markup_rate * 1000) / 10} onChange={(v) => update((d) => { d.estimate.markup_rate = (v ?? 0) / 100; })} />
            </Field>
          </div>
        ) : (
          <p className="text-[10px] text-gray-400">単価は仕入単価のまま。利益は上の「諸経費率」で乗せます。</p>
        )}
        <button
          type="button"
          onClick={() => update((d) => {
            for (const g of d.estimate.groups) for (const l of g.lines) {
              if (l.cost_price !== null && l.cost_price !== undefined) l.unit_price = salePriceFromCost(l.cost_price, d.estimate.markup_mode, d.estimate.markup_rate);
            }
          })}
          className="text-emerald-600 hover:underline"
        >
          仕入単価から単価を計算し直す (仕入単価がある行のみ・手で直した単価は上書き)
        </button>
      </div>

      <EstimateImport docs={docs} update={update} contractor={contractor} />

      {e.groups.map((g, gi) => (
        <div key={gi} className="border border-gray-200 rounded p-2 space-y-1.5 bg-gray-50/60">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-gray-600">改修箇所 {gi + 1}</span>
            <button
              onClick={() => update((d) => { d.estimate.groups.splice(gi, 1); })}
              disabled={e.groups.length <= 1}
              className="ml-auto text-gray-400 hover:text-red-500 disabled:opacity-30"
              title="この改修箇所を削除"
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="grid grid-cols-[1fr_60px_1fr_1fr] gap-1.5">
            <Field label="住宅改修の種類">
              <select className={inputCls} value={g.kind} onChange={(ev) => setGroup(gi, { kind: Number(ev.target.value) as RenovationKindNo })}>
                {RENOVATION_KINDS.map((k) => <option key={k.no} value={k.no}>（{k.no}）{k.label}</option>)}
              </select>
            </Field>
            <Field label="写真番号"><Text value={g.photo_no} onChange={(v) => setGroup(gi, { photo_no: v })} /></Field>
            <Field label="改修場所"><Text value={g.place} placeholder="廊下" onChange={(v) => setGroup(gi, { place: v })} /></Field>
            <Field label="改修部分"><Text value={g.part} placeholder="動線" onChange={(v) => setGroup(gi, { part: v })} /></Field>
          </div>
          <table className="w-full">
            <thead className="text-[10px] text-gray-500">
              <tr>
                <th className="text-left font-normal">名称</th>
                <th className="text-left font-normal">商品名・規格</th>
                <th className="text-right font-normal w-12">数量</th>
                <th className="font-normal w-10">単位</th>
                <th className="text-right font-normal w-16" title="施工会社の見積の単価 (見積書には出ません)">仕入</th>
                <th className="text-right font-normal w-16">単価</th>
                <th className="text-right font-normal w-16">金額</th>
                <th className="w-5" />
              </tr>
            </thead>
            <tbody>
              {g.lines.map((l, li) => (
                <tr key={li}>
                  <td className="pr-1"><Text value={l.name} onChange={(v) => setLine(gi, li, { name: v })} /></td>
                  <td className="pr-1"><Text value={l.spec} onChange={(v) => setLine(gi, li, { spec: v })} /></td>
                  <td className="pr-1"><Num value={l.qty} onChange={(v) => setLine(gi, li, { qty: v })} /></td>
                  <td className="pr-1"><Text value={l.unit} onChange={(v) => setLine(gi, li, { unit: v })} /></td>
                  <td className="pr-1"><Num value={l.cost_price ?? null} onChange={(v) => setLine(gi, li, { cost_price: v })} /></td>
                  <td className="pr-1"><Num value={l.unit_price} onChange={(v) => setLine(gi, li, { unit_price: v })} /></td>
                  <td className="text-right text-gray-600 pr-1">{yenNum(totals.lineAmounts[gi][li])}</td>
                  <td>
                    <button
                      onClick={() => update((d) => { d.estimate.groups[gi].lines.splice(li, 1); })}
                      disabled={g.lines.length <= 1}
                      className="text-gray-300 hover:text-red-500 disabled:opacity-30"
                    >
                      <X size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center">
            <button onClick={() => update((d) => { d.estimate.groups[gi].lines.push(emptyLine()); })} className="text-emerald-600 hover:underline inline-flex items-center gap-0.5">
              <Plus size={12} />行を追加
            </button>
            <span className="ml-auto text-gray-600">小計 ¥{yenNum(totals.groupSubtotals[gi])}</span>
          </div>
        </div>
      ))}
      <button
        onClick={() => update((d) => { d.estimate.groups.push(emptyGroup(1, CIRCLED[d.estimate.groups.length] ?? "")); })}
        className="text-emerald-600 hover:underline inline-flex items-center gap-0.5"
      >
        <Plus size={12} />改修箇所を追加
      </button>
      <table className="w-full text-xs border-t border-gray-200 mt-1">
        <tbody>
          {[
            ["工事費用計", totals.workTotal],
            [`諸経費 (${Math.round(e.overhead_rate * 1000) / 10}%)`, totals.overhead],
            ["合計", totals.subtotal],
            ["消費税", totals.tax],
            ["総合計 (税込)", totals.grandTotal],
            ...(totals.costSubtotal > 0
              ? [["仕入計 (税込換算)", totals.costTotal], ["粗利 (総合計 − 仕入)", totals.grandTotal - totals.costTotal]] as [string, number][]
              : []),
          ].map(([k, v]) => (
            <tr key={k as string}>
              <td className="py-0.5 text-gray-500">{k}</td>
              <td className="py-0.5 text-right font-medium">¥{yenNum(v as number)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 pt-1">
        <span className="text-[10px] text-gray-400 flex-1">
          進行表の今の値: 計上 {current.sales === null ? "未入力" : `¥${yenNum(current.sales)}`} / 仕切り {current.cost === null ? "未入力" : `¥${yenNum(current.cost)}`}
        </span>
        <button type="button" onClick={onApplyAmounts} disabled={applying || totals.grandTotal === 0}
          className="text-xs px-2.5 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
          {applying ? "反映中…" : "進行表の金額に反映"}
        </button>
      </div>
    </>
  );
}

// ─── 理由書 ──────────────────────────────────────────────────────────────────

function ReasonForm({ docs, update }: { docs: RenovationDocs; update: Upd }) {
  const r = docs.reason;
  const setAct = (key: ReasonActivityKey, fn: (a: RenovationDocs["reason"]["activities"][ReasonActivityKey]) => void) =>
    update((d) => { fn(d.reason.activities[key]); });
  const toggle = (list: string[], v: string, on: boolean) => (on ? Array.from(new Set([...list, v])) : list.filter((x) => x !== v));
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="現地確認日"><DateIn value={r.site_visit_date} onChange={(v) => update((d) => { d.reason.site_visit_date = v; })} /></Field>
        <Field label="作成日"><DateIn value={r.created_date} onChange={(v) => update((d) => { d.reason.created_date = v; })} /></Field>
        <Field label="作成者 所属事業所"><Text value={r.creator_office} onChange={(v) => update((d) => { d.reason.creator_office = v; })} /></Field>
        <Field label="作成者 氏名"><Text value={r.creator_name} onChange={(v) => update((d) => { d.reason.creator_name = v; })} /></Field>
        <Field label="資格 (介護支援専門員でないとき)"><Text value={r.creator_qualification} onChange={(v) => update((d) => { d.reason.creator_qualification = v; })} /></Field>
        <Field label="作成者 連絡先"><Text value={r.creator_phone} onChange={(v) => update((d) => { d.reason.creator_phone = v; })} /></Field>
      </div>
      <Field label="利用者の身体状況"><Area value={r.body_status} onChange={(v) => update((d) => { d.reason.body_status = v; })} /></Field>
      <Field label="介護状況"><Area value={r.care_status} onChange={(v) => update((d) => { d.reason.care_status = v; })} /></Field>
      <Field label="住宅改修により、利用者等は日常生活をどう変えたいか"><Area value={r.goal} onChange={(v) => update((d) => { d.reason.goal = v; })} /></Field>

      <div>
        <div className="text-[11px] text-gray-500 mb-1">福祉用具の利用状況 (改修前 / 改修後)</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {REASON_TOOLS.map((t) => {
            const v = r.tools[t] ?? { before: false, after: false };
            return (
              <div key={t} className="flex items-center gap-1">
                <span className="flex-1 truncate" title={t}>{t}</span>
                <input type="checkbox" title="改修前" checked={v.before} onChange={(e) => update((d) => { d.reason.tools[t] = { ...v, before: e.target.checked }; })} />
                <input type="checkbox" title="改修後" checked={v.after} onChange={(e) => update((d) => { d.reason.tools[t] = { ...v, after: e.target.checked }; })} />
              </div>
            );
          })}
        </div>
        {r.tools_other.map((t, i) => (
          <div key={i} className="flex items-center gap-1 mt-1">
            <input className={inputCls} placeholder="その他の用具" value={t.name} onChange={(e) => update((d) => { d.reason.tools_other[i].name = e.target.value; })} />
            <input type="checkbox" title="改修前" checked={t.before} onChange={(e) => update((d) => { d.reason.tools_other[i].before = e.target.checked; })} />
            <input type="checkbox" title="改修後" checked={t.after} onChange={(e) => update((d) => { d.reason.tools_other[i].after = e.target.checked; })} />
          </div>
        ))}
      </div>

      {REASON_ACTIVITIES.map((a) => {
        const v = r.activities[a.key];
        return (
          <div key={a.key} className="border border-gray-200 rounded p-2 space-y-1.5">
            <div className="font-semibold text-gray-600">P2 {a.label}</div>
            {a.actions.length > 0 && (
              <div>
                {a.actions.map((x) => (
                  <Check key={x} label={x} checked={v.actions.includes(x)} onChange={(on) => setAct(a.key, (t) => { t.actions = toggle(t.actions, x, on); })} />
                ))}
              </div>
            )}
            <Field label={a.key === "other" ? "改善しようとしている生活動作" : "生活動作 その他"}>
              <Text value={v.action_other} onChange={(s) => setAct(a.key, (t) => { t.action_other = s; })} />
            </Field>
            <Field label="② 具体的な困難な状況"><Area rows={2} value={v.difficulty} onChange={(s) => setAct(a.key, (t) => { t.difficulty = s; })} /></Field>
            <div>
              {REASON_PURPOSES.map((p) => (
                <Check key={p} label={p} checked={v.purposes.includes(p)} onChange={(on) => setAct(a.key, (t) => { t.purposes = toggle(t.purposes, p, on); })} />
              ))}
            </div>
            <Field label="③ 目的 その他"><Text value={v.purpose_other} onChange={(s) => setAct(a.key, (t) => { t.purpose_other = s; })} /></Field>
            <Field label="③ 改修の方針"><Area rows={2} value={v.policy} onChange={(s) => setAct(a.key, (t) => { t.policy = s; })} /></Field>
          </div>
        );
      })}

      <div className="border border-gray-200 rounded p-2 space-y-1.5">
        <div className="flex items-center">
          <span className="font-semibold text-gray-600">P2 ④ 改修項目 (改修箇所を 1 行に 1 つ)</span>
          <button
            className="ml-auto text-emerald-600 hover:underline"
            onClick={() => update((d) => {
              const works: Record<string, string[]> = {};
              for (const g of d.estimate.groups) {
                const place = [g.place, g.part].filter(Boolean).join(" ");
                if (!place) continue;
                (works[String(g.kind)] ??= []).push(place);
              }
              d.reason.works = works;
            })}
            title="見積の改修箇所から埋める (今の入力は上書きされます)"
          >
            見積から埋める
          </button>
        </div>
        {REASON_WORK_ITEMS.map((w) => (
          <Field key={w.kind} label={w.label}>
            <Area
              rows={2}
              value={(r.works[String(w.kind)] ?? []).join("\n")}
              onChange={(s) => update((d) => { d.reason.works[String(w.kind)] = s.split("\n"); })}
            />
          </Field>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label="CM 同意日"><DateIn value={r.cm_consent_date} onChange={(v) => update((d) => { d.reason.cm_consent_date = v; })} /></Field>
        <Field label="CM 事業所名"><Text value={r.cm_consent_office} onChange={(v) => update((d) => { d.reason.cm_consent_office = v; })} /></Field>
        <Field label="CM 氏名"><Text value={r.cm_consent_name} onChange={(v) => update((d) => { d.reason.cm_consent_name = v; })} /></Field>
      </div>
      <p className="text-[10px] text-gray-400">CM 同意欄は、理由書の作成者がケアプランを作る介護支援専門員と違うときだけ書きます。</p>
    </>
  );
}

// ─── 所有者・申請 ────────────────────────────────────────────────────────────

function ApplicationForm({ docs, update, address, cityName, hasForm, onFillHistory }: {
  docs: RenovationDocs; update: Upd; address: string; cityName: string | null; hasForm: boolean; onFillHistory: (() => void) | null;
}) {
  const o = docs.owner;
  const a = docs.application;
  const form = cityName ? CITY_FORMS[cityName] : undefined;
  return (
    <>
      <div className="border border-gray-200 rounded p-2 space-y-1.5">
        <div className="font-semibold text-gray-600">住宅の所有者</div>
        <Check label="所有者は本人 (承諾書は不要)" checked={o.is_self} onChange={(v) => update((d) => { d.owner.is_self = v; })} />
        {!o.is_self && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="所有者 氏名"><Text value={o.name} onChange={(v) => update((d) => { d.owner.name = v; })} /></Field>
            <Field label="本人との関係"><Text value={o.relation} placeholder="長男" onChange={(v) => update((d) => { d.owner.relation = v; })} /></Field>
            <Field label="所有者 住所"><Text value={o.address} onChange={(v) => update((d) => { d.owner.address = v; })} /></Field>
            <Field label="所有者 電話番号"><Text value={o.phone} onChange={(v) => update((d) => { d.owner.phone = v; })} /></Field>
          </div>
        )}
      </div>

      <div className="border border-gray-200 rounded p-2 space-y-1.5">
        <div className="font-semibold text-gray-600">支給申請書</div>
        {!hasForm ? (
          <Warn>
            住所「{address || "未登録"}」の市町村{cityName ? `（${cityName}）` : ""}は様式が未登録です。
            登録済み: {Object.keys(CITY_FORMS).join("・")}
          </Warn>
        ) : (
          <div className="text-gray-600">様式: {cityName}{form?.preOnly ? "（事前申請専用の様式）" : "（事前・事後で同じ用紙）"}</div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-gray-500">申請:</span>
          <label className="inline-flex items-center gap-1"><input type="radio" checked={a.phase === "pre"} onChange={() => update((d) => { d.application.phase = "pre"; })} />事前 (着工前)</label>
          <label className="inline-flex items-center gap-1"><input type="radio" checked={a.phase === "post"} disabled={form?.preOnly} onChange={() => update((d) => { d.application.phase = "post"; })} />事後 (完成後)</label>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-gray-500">支払:</span>
          <label className="inline-flex items-center gap-1"><input type="radio" checked={a.payment === "juryo"} disabled={form && !form.juryo.available} onChange={() => update((d) => { d.application.payment = "juryo"; })} />受領委任払い</label>
          <label className="inline-flex items-center gap-1"><input type="radio" checked={a.payment === "shoukan"} onChange={() => update((d) => { d.application.payment = "shoukan"; })} />償還払い</label>
        </div>
        {form && a.payment === "juryo" && !form.juryo.available && (
          <Warn>{form.juryoNote ?? `${cityName}の様式には受領委任払い用がありません。償還払いの様式で出します。`}</Warn>
        )}
        {form?.juryo.postOnly && a.payment === "juryo" && a.phase === "pre" && (
          <Warn>{cityName}の受領委任払い用の申請書は事後専用です。着工前は「事前協議願（第6号様式）」を出します。右上の「印刷する書類」で選んでください。</Warn>
        )}
        {form && a.phase === "pre" && form.blankOnPre.length > 0 && (
          <p className="text-[10px] text-gray-400">事前申請では、{cityName}の指示どおり事後に書く欄（着工日・完成日など）を空欄で出します。</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="申請日"><DateIn value={a.apply_date} onChange={(v) => update((d) => { d.application.apply_date = v; })} /></Field>
          <Field label="宛先" hint={`空欄なら住所から自動: ${defaultAddressee(address) || "（判定できません）"}`}>
            <Text value={a.addressee} onChange={(v) => update((d) => { d.application.addressee = v; })} />
          </Field>
          {a.phase === "post" && (
            <>
              <Field label="着工日 (実績)"><DateIn value={a.started_date} onChange={(v) => update((d) => { d.application.started_date = v; })} /></Field>
              <Field label="完成日"><DateIn value={a.completed_date} onChange={(v) => update((d) => { d.application.completed_date = v; })} /></Field>
            </>
          )}
        </div>
        {form?.changeReason && a.phase === "post" && (
          <Field label="改修予定費用から変わった理由"><Area rows={2} value={a.change_reason} onChange={(v) => update((d) => { d.application.change_reason = v; })} /></Field>
        )}
        {form?.proxy && <Check label="提出代行者・代理申請事業所として発行元を印字する" checked={a.proxy} onChange={(v) => update((d) => { d.application.proxy = v; })} />}
        <p className="text-[10px] text-gray-400">口座・個人番号の欄は空欄の枠だけ出します（手書き）。</p>
        {cityName === "市原市" && (
          <Field label="以前の住宅改修の履歴（事前協議願の「以前の履歴」）" hint="種類・時期・費用等。無ければ「なし」">
            <Area rows={3} value={a.previous_history} onChange={(v) => update((d) => { d.application.previous_history = v; })} />
            {onFillHistory && (
              <button type="button" onClick={onFillHistory} className="mt-1 text-emerald-600 hover:underline">
                この利用者の過去の住宅改修案件から埋める (今の入力は上書き)
              </button>
            )}
          </Field>
        )}
      </div>
    </>
  );
}

// ─── 領収書 ──────────────────────────────────────────────────────────────────

function ReceiptForm({ docs, update, copay, copayRate, grandTotal }: {
  docs: RenovationDocs; update: Upd; copay: number; copayRate: RenovationProjectWithSteps["copay_rate"]; grandTotal: number;
}) {
  const r = docs.receipt;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="領収額 (円)" hint={`空欄なら自己負担の見込み ¥${yenNum(copay)} (総合計 ¥${yenNum(grandTotal)}・負担割合 ${copayRate ?? "未設定"})`}>
          <Num value={r.amount} onChange={(v) => update((d) => { d.receipt.amount = v; })} />
        </Field>
        <Field label="領収日"><DateIn value={r.date} onChange={(v) => update((d) => { d.receipt.date = v; })} /></Field>
      </div>
      <Field label="但し書き"><Text value={r.note} onChange={(v) => update((d) => { d.receipt.note = v; })} /></Field>
      <p className="text-[10px] text-gray-400">
        自己負担の見込み = 総合計 − floor(min(総合計, 20万円) × 給付率)。端数の扱いや限度額の使用済み分は市町村で違うことがあるので、実際の額で上書きしてください。
      </p>
      {!copayRate && <Warn>案件の負担割合が未設定なので、見込みは総合計の全額にしています。</Warn>}
    </>
  );
}

// ─── 発行元 ──────────────────────────────────────────────────────────────────

function IssuerForm({ docs, update }: { docs: RenovationDocs; update: Upd }) {
  const i = docs.issuer;
  const set = (k: keyof Issuer) => (v: string) => update((d) => { d.issuer[k] = v; });
  return (
    <>
      <p className="text-[10px] text-gray-400">
        見積書・領収書・申請書の会社欄に出ます。新しい案件では、同じ事業所で最後に書類を作った案件の内容を引き継ぎます。
      </p>
      {(!i.address || !i.tel) && <Warn>住所・電話番号が空です。事業所マスタに未登録のため、ここで入力してください。</Warn>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="会社名"><Text value={i.company_name} onChange={set("company_name")} /></Field>
        <Field label="事業所名"><Text value={i.office_name} onChange={set("office_name")} /></Field>
        <Field label="郵便番号"><Text value={i.postal_code} onChange={set("postal_code")} /></Field>
        <Field label="住所"><Text value={i.address} onChange={set("address")} /></Field>
        <Field label="TEL"><Text value={i.tel} onChange={set("tel")} /></Field>
        <Field label="FAX"><Text value={i.fax} onChange={set("fax")} /></Field>
        <Field label="登録番号 (インボイス)"><Text value={i.invoice_number} placeholder="T1234567890123" onChange={set("invoice_number")} /></Field>
        <Field label="代表者氏名 (受領委任の受任者欄)"><Text value={i.representative} onChange={set("representative")} /></Field>
        <Field label="担当者"><Text value={i.staff_name} onChange={set("staff_name")} /></Field>
      </div>
      <div className="border border-gray-200 rounded p-2 space-y-1.5">
        <div className="font-semibold text-gray-600">受領委任払いの振込先 (自社の口座)</div>
        <p className="text-[10px] text-gray-400">茂原市の受領委任届の「口座振替依頼書」に出ます。空欄なら枠だけ出します (手書き)。</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="金融機関名"><Text value={i.bank_name} placeholder="○○銀行" onChange={set("bank_name")} /></Field>
          <Field label="支店名"><Text value={i.bank_branch} placeholder="○○支店" onChange={set("bank_branch")} /></Field>
          <Field label="口座種別">
            <select className={inputCls} value={i.bank_type} onChange={(e) => set("bank_type")(e.target.value)}>
              <option value="普通">普通預金</option>
              <option value="当座">当座預金</option>
              <option value="その他">その他</option>
            </select>
          </Field>
          <Field label="口座番号 (7 桁)"><Text value={i.bank_number} onChange={set("bank_number")} /></Field>
          <Field label="口座名義人 (フリガナ)"><Text value={i.bank_holder_kana} onChange={set("bank_holder_kana")} /></Field>
          <Field label="口座名義人"><Text value={i.bank_holder} onChange={set("bank_holder")} /></Field>
        </div>
      </div>
    </>
  );
}

// ─── 写真 ────────────────────────────────────────────────────────────────────

function PhotosForm({ docs, update, photoUrls, busy, onUpload, onRemove }: {
  docs: RenovationDocs;
  update: Upd;
  photoUrls: Record<string, string>;
  busy: string | null;
  onUpload: (gi: number, side: "before" | "after", file: File) => void;
  onRemove: (gi: number, side: "before" | "after") => void;
}) {
  return (
    <>
      <p className="text-[10px] text-gray-400">
        写真添付用紙は「見積」の改修箇所ごとに 1 枚です (工事前・工事後)。写真は追加・削除した時点で保存されます。
        撮影日を直したときは「保存」を押してください。
      </p>
      {docs.estimate.groups.map((g, gi) => (
        <div key={gi} className="border border-gray-200 rounded p-2 space-y-1.5">
          <div className="font-semibold text-gray-600">
            改修箇所 {gi + 1}{g.photo_no ? `（${g.photo_no}）` : ""}　{[g.place, g.part].filter(Boolean).join(" ") || "（場所未入力）"}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["before", "after"] as const).map((side) => {
              const photo = g.photos[side];
              const url = photo ? photoUrls[photo.path] : undefined;
              const isBusy = busy === `${gi}-${side}`;
              return (
                <div key={side} className="space-y-1">
                  <div className="text-[11px] text-gray-500">{side === "before" ? "工事前" : "工事後"}</div>
                  <div className="h-28 rounded border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center overflow-hidden">
                    {isBusy ? (
                      <Loader2 size={18} className="animate-spin text-emerald-400" />
                    ) : photo && url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 署名付き URL のサムネイル
                      <img src={url} alt="" className="max-h-full max-w-full object-contain" />
                    ) : photo ? (
                      <span className="text-[10px] text-gray-400">読み込み中…</span>
                    ) : (
                      <span className="text-[10px] text-gray-400">未登録</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <label className={`inline-flex items-center gap-0.5 text-emerald-600 hover:underline cursor-pointer ${busy ? "pointer-events-none opacity-40" : ""}`}>
                      <ImagePlus size={12} />{photo ? "差し替え" : "写真を選ぶ"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={!!busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) onUpload(gi, side, file);
                        }}
                      />
                    </label>
                    {photo && (
                      <button onClick={() => onRemove(gi, side)} disabled={!!busy} className="ml-auto text-gray-400 hover:text-red-500 disabled:opacity-30" title="写真を削除">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  {photo && (
                    <Field label="撮影日">
                      <DateIn value={photo.taken_date} onChange={(v) => update((d) => { const p = d.estimate.groups[gi].photos[side]; if (p) p.taken_date = v; })} />
                    </Field>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** 入力欄・書類欄を全画面に広げる / 元に戻すボタン */
function ViewToggle({ expanded, onClick, what }: { expanded: boolean; onClick: () => void; what: string }) {
  return (
    <button
      onClick={onClick}
      className="ml-auto mb-1 shrink-0 text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
      title={expanded ? "入力と書類を並べて表示に戻す" : `${what}を全画面で表示`}
    >
      {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      {expanded ? "並べて表示" : `${what}を全画面`}
    </button>
  );
}

// ─── 施工会社の見積の取込 ────────────────────────────────────────────────────

type ParsedSheet = { name: string; rows: string[][]; truncated: boolean };

/** 施工会社ごとの列の割り当てを覚える (端末ごと。書式は施工会社ごとにほぼ同じため) */
const MAP_KEY = (contractor: string | null) => `renovation-estimate-map:${contractor || "(施工会社なし)"}`;
function loadSavedMap(contractor: string | null): { header: number; map: EstimateColumnMap } | null {
  try {
    const raw = localStorage.getItem(MAP_KEY(contractor));
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 端末の保存領域が使えない (プライベートモード等) ときは毎回推定する
    return null;
  }
}
function saveMap(contractor: string | null, v: { header: number; map: EstimateColumnMap }) {
  try { localStorage.setItem(MAP_KEY(contractor), JSON.stringify(v)); } catch (e) { console.warn("列の割り当てを端末に保存できませんでした:", e); }
}

function EstimateImport({ docs, update, contractor }: { docs: RenovationDocs; update: Upd; contractor: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheets, setSheets] = useState<ParsedSheet[] | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [header, setHeader] = useState(0);
  const [map, setMap] = useState<EstimateColumnMap>({ name: -1, spec: -1, qty: -1, unit: -1, price: -1 });
  const [kind, setKind] = useState<RenovationKindNo>(1);
  const [place, setPlace] = useState("");

  const sheet = sheets?.[sheetIdx];
  const headerRow = sheet?.rows[header] ?? [];
  const colCount = Math.max(0, ...(sheet?.rows.slice(0, 60).map((r) => r.length) ?? [0]));
  const lines = sheet ? rowsToEstimateLines(sheet.rows.slice(header + 1), map, { mode: docs.estimate.markup_mode, rate: docs.estimate.markup_rate }) : [];

  /** 見出し行を推定: 「単価」を含む最初の行 */
  const guessHeader = (rows: string[][]) => Math.max(0, rows.findIndex((r) => r.some((c) => /単価/.test(c))));

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/estimate-parse", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({ error: `読み込みに失敗しました (${res.status})` }));
      if (!res.ok || json.error) throw new Error(json.error ?? `読み込みに失敗しました (${res.status})`);
      const list = json.sheets as ParsedSheet[];
      setSheets(list);
      setSheetIdx(0);
      const saved = loadSavedMap(contractor);
      const h = saved && list[0].rows[saved.header] ? saved.header : guessHeader(list[0].rows);
      setHeader(h);
      setMap(saved?.map ?? detectEstimateColumns(list[0].rows[h] ?? []));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("見積 Excel の読み込みに失敗:", msg);
      alert(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = () => {
    if (lines.length === 0) return;
    saveMap(contractor, { header, map });
    update((d) => {
      // 中身が空の改修箇所 1 つだけなら、それを置き換える (新規の見積で最初に取り込むとき)
      const onlyEmpty = d.estimate.groups.length === 1 && d.estimate.groups[0].lines.every((l) => !l.name && l.unit_price === null);
      const g = { ...emptyGroup(kind, ""), place, lines };
      if (onlyEmpty) {
        g.photo_no = d.estimate.groups[0].photo_no || "①";
        d.estimate.groups = [g];
      } else {
        g.photo_no = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"][d.estimate.groups.length] ?? "";
        d.estimate.groups.push(g);
      }
    });
    setOpen(false);
    setSheets(null);
  };

  const colOptions = (
    <>
      <option value={-1}>（使わない）</option>
      {Array.from({ length: colCount }, (_, i) => (
        <option key={i} value={i}>{String.fromCharCode(65 + i)}列{headerRow[i] ? ` (${headerRow[i].slice(0, 10)})` : ""}</option>
      ))}
    </>
  );

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full border border-dashed border-emerald-300 rounded p-2 text-emerald-700 hover:bg-emerald-50">
        施工会社の見積 (Excel) を取り込む
      </button>
    );
  }
  return (
    <div className="border border-emerald-300 rounded p-2 space-y-2 bg-emerald-50/40">
      <div className="flex items-center">
        <span className="font-semibold text-gray-700">施工会社の見積を取り込む</span>
        <button type="button" onClick={() => { setOpen(false); setSheets(null); }} className="ml-auto text-gray-400 hover:text-gray-600"><X size={14} /></button>
      </div>
      <p className="text-[10px] text-gray-500">
        施工会社の単価を「仕入」に入れ、上の「利益の乗せ方」で単価を計算します。列の割り当ては施工会社（{contractor || "未入力"}）ごとにこの端末で覚えます。
      </p>
      <label className={`inline-flex items-center gap-1 text-emerald-700 hover:underline cursor-pointer ${busy ? "opacity-40 pointer-events-none" : ""}`}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}Excel (.xlsx) を選ぶ
        <input type="file" accept=".xlsx" className="hidden" onChange={(ev) => { const file = ev.target.files?.[0]; ev.target.value = ""; if (file) handleFile(file); }} />
      </label>
      {sheet && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="シート">
              <select className={inputCls} value={sheetIdx} onChange={(ev) => {
                const i = Number(ev.target.value); setSheetIdx(i);
                const h = guessHeader(sheets![i].rows); setHeader(h); setMap(detectEstimateColumns(sheets![i].rows[h] ?? []));
              }}>
                {sheets!.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="見出しの行">
              <select className={inputCls} value={header} onChange={(ev) => { const h = Number(ev.target.value); setHeader(h); setMap(detectEstimateColumns(sheet.rows[h] ?? [])); }}>
                {sheet.rows.slice(0, 40).map((r, i) => <option key={i} value={i}>{i + 1}行目: {r.filter(Boolean).join(" / ").slice(0, 30)}</option>)}
              </select>
            </Field>
            {([["name", "名称"], ["spec", "商品名・規格"], ["qty", "数量"], ["unit", "単位"], ["price", "単価 (仕入)"]] as [keyof EstimateColumnMap, string][]).map(([k, label]) => (
              <Field key={k} label={label}>
                <select className={inputCls} value={map[k]} onChange={(ev) => setMap((m) => ({ ...m, [k]: Number(ev.target.value) }))}>{colOptions}</select>
              </Field>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="住宅改修の種類">
              <select className={inputCls} value={kind} onChange={(ev) => setKind(Number(ev.target.value) as RenovationKindNo)}>
                {RENOVATION_KINDS.map((k) => <option key={k.no} value={k.no}>（{k.no}）{k.label}</option>)}
              </select>
            </Field>
            <Field label="改修場所"><Text value={place} placeholder="廊下" onChange={setPlace} /></Field>
          </div>
          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded bg-white">
            <table className="w-full text-[11px]">
              <thead className="text-gray-500 bg-gray-50"><tr><th className="text-left px-1">名称</th><th className="text-left px-1">規格</th><th className="text-right px-1">数量</th><th className="px-1">単位</th><th className="text-right px-1">仕入</th><th className="text-right px-1">単価</th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-1">{l.name}</td><td className="px-1 text-gray-500">{l.spec}</td><td className="px-1 text-right">{l.qty}</td>
                    <td className="px-1 text-center">{l.unit}</td><td className="px-1 text-right">{yenNum(l.cost_price)}</td><td className="px-1 text-right">{yenNum(l.unit_price)}</td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={6} className="px-1 py-2 text-center text-gray-400">取り込める行がありません (名称と単価の列を確認してください)</td></tr>}
              </tbody>
            </table>
          </div>
          {sheet.truncated && <p className="text-[10px] text-amber-700">シートが長いため先頭 400 行だけ読みました。</p>}
          <button type="button" onClick={handleImport} disabled={lines.length === 0}
            className="w-full text-xs px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40">
            {lines.length} 行を改修箇所として追加
          </button>
        </>
      )}
    </div>
  );
}
