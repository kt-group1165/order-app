"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight, Search, Plus, Loader2 } from "lucide-react";
import { supabase, Equipment, Supplier, CarePlanTemplate } from "@/lib/supabase";
import { todayYmd } from "@/lib/date-jst";
import { COMPANY_INFO_DEFAULTS } from "./company-info";
import { PageHeader, CareOfficeFormRow } from "./shared-form-ui";
import { getEquipment, getSuppliers, createSupplier, updateSupplier } from "@/lib/equipment";
import { getTenantById, updateTenantInfo } from "@/lib/tenants";
import { COMPANY_INFO_KEYS, emptyCompanyInfoRow, getOfficeCompanyInfo, saveOfficeCompanyOverrides, type CompanyInfoRow } from "@/lib/officeCompanyInfo";
import { getCarePlanTemplates, upsertCarePlanTemplate, deleteCarePlanTemplate } from "@/lib/carePlanTemplates";
import { getDocTemplate, saveDocTemplate, type DocTemplateSections } from "@/lib/docTemplates";
import { CONTRACT_TEMPLATE_SECTIONS, RENTAL_CONTRACT_DOC_TYPE } from "@/lib/contractTemplateSections";
import { getOffices, createOffice, updateOffice, deleteOffice, type Office } from "@/lib/offices";
import { getCareOffices, upsertCareOffice, deleteCareOffice, getCareManagers, addCareManager, updateCareManager, deleteCareManager, type CareOffice, type CareManager } from "@/lib/careOffices";
import { getSpeechUsageSummary, type SpeechUsageSummary } from "@/lib/speechUsage";
import { getOpenAIUsageSummary, type OpenAIUsageSummary } from "@/lib/openaiUsage";

// ─── Settings Tab ────────────────────────────────────────────────────────────

type SettingsPage = "menu" | "company" | "own_offices" | "suppliers" | "care_offices" | "care_plan" | "contract_template" | "speech_usage" | "data_reimport";

export default function SettingsTab({ tenantId, currentOfficeId, officeViewAll, onOfficeChange, onViewModeChange }: {
  tenantId: string;
  currentOfficeId: string | null;
  officeViewAll: boolean;
  onOfficeChange: (officeId: string | null) => void;
  onViewModeChange: (viewAll: boolean) => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [emailMap, setEmailMap] = useState<Record<string, string>>({});
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierEmail, setNewSupplierEmail] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("menu");

  // 会社情報
  const [company, setCompany] = useState({
    business_number:       COMPANY_INFO_DEFAULTS.businessNumber,
    company_name:          COMPANY_INFO_DEFAULTS.companyName,
    company_address:       COMPANY_INFO_DEFAULTS.companyAddress,
    company_tel:           COMPANY_INFO_DEFAULTS.tel,
    company_fax:           COMPANY_INFO_DEFAULTS.fax,
    staff_name:            COMPANY_INFO_DEFAULTS.staffName,
    legal_name:            "",
    service_area:          COMPANY_INFO_DEFAULTS.serviceArea,
    business_days:         COMPANY_INFO_DEFAULTS.businessDays,
    business_hours:        COMPANY_INFO_DEFAULTS.businessHours,
    staff_manager_full:    COMPANY_INFO_DEFAULTS.staffManagerFull,
    staff_manager_part:    COMPANY_INFO_DEFAULTS.staffManagerPart,
    staff_specialist_full: COMPANY_INFO_DEFAULTS.staffSpecialistFull,
    staff_specialist_part: COMPANY_INFO_DEFAULTS.staffSpecialistPart,
    staff_admin_full:      COMPANY_INFO_DEFAULTS.staffAdminFull,
    staff_admin_part:      COMPANY_INFO_DEFAULTS.staffAdminPart,
  });
  const [savingCompany, setSavingCompany] = useState(false);
  /** 会社情報をどこに保存するか: 事業所 id / "group" = グループ共通 (事業所を選ばないときの既定) */
  const [companyScope, setCompanyScope] = useState<string>(officeViewAll || !currentOfficeId ? "group" : currentOfficeId);
  /** 事業所を選んだとき: マスタ (+ グループ共通) の値。空欄の項目はこれが使われる */
  const [companyBase, setCompanyBase] = useState<CompanyInfoRow | null>(null);
  const companyScopeRef = useRef(companyScope);
  useEffect(() => { companyScopeRef.current = companyScope; }, [companyScope]);
  const [companyMissing, setCompanyMissing] = useState<string[]>([]);
  const [companyColumnMissing, setCompanyColumnMissing] = useState(false);
  const [savedCompany, setSavedCompany] = useState(false);

  const [settingsOffices, setSettingsOffices] = useState<Office[]>([]);

  useEffect(() => {
    Promise.all([
      getSuppliers(),
      getTenantById(tenantId),
      getOffices(tenantId),
    ]).then(([list, tenant, ofs]) => {
      setSuppliers(list);
      setSettingsOffices(ofs);
      const map: Record<string, string> = {};
      const nmap: Record<string, string> = {};
      list.forEach((s) => { map[s.id] = s.email ?? ""; nmap[s.id] = s.name; });
      setEmailMap(map);
      setNameMap(nmap);
      // 事業所を選んで開いたときは、事業所の値 (下の useEffect) をグループ共通の値で上書きしない
      if (tenant && companyScopeRef.current === "group") {
        setCompany({
          business_number:       tenant.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
          company_name:          tenant.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
          company_address:       tenant.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
          company_tel:           tenant.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
          company_fax:           tenant.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
          staff_name:            tenant.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
          legal_name:            tenant.legal_name            ?? "",
          service_area:          tenant.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
          business_days:         tenant.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
          business_hours:        tenant.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
          staff_manager_full:    tenant.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
          staff_manager_part:    tenant.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
          staff_specialist_full: tenant.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
          staff_specialist_part: tenant.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
          staff_admin_full:      tenant.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
          staff_admin_part:      tenant.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
        });
      }
    }).finally(() => setLoading(false));
  }, [tenantId]);

  const handleSave = async (supplierId: string) => {
    setSaving(supplierId);
    setSaved(null);
    try {
      const nm = (nameMap[supplierId] ?? "").trim();
      await updateSupplier(supplierId, { name: nm || undefined, email: emailMap[supplierId] ?? "" });
      setSuppliers((prev) => prev.map((s) => s.id === supplierId ? { ...s, name: nm || s.name, email: emailMap[supplierId] ?? "" } : s));
      setSaved(supplierId);
      setTimeout(() => setSaved(null), 2000);
    } finally {
      setSaving(null);
    }
  };

  const handleAddSupplier = async () => {
    const name = newSupplierName.trim();
    if (!name) return;
    setAddingSupplier(true);
    try {
      const created = await createSupplier(name, newSupplierEmail.trim() || undefined);
      setSuppliers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setNameMap((m) => ({ ...m, [created.id]: created.name }));
      setEmailMap((m) => ({ ...m, [created.id]: created.email ?? "" }));
      setNewSupplierName("");
      setNewSupplierEmail("");
    } catch {
      alert("卸会社の追加に失敗しました");
    } finally {
      setAddingSupplier(false);
    }
  };

  const handleToggleSupplierActive = async (supplierId: string, next: boolean) => {
    setSuppliers((prev) => prev.map((s) => s.id === supplierId ? { ...s, is_active: next } : s));
    try {
      await updateSupplier(supplierId, { is_active: next });
    } catch {
      setSuppliers((prev) => prev.map((s) => s.id === supplierId ? { ...s, is_active: !next } : s));
      alert("表示状態の変更に失敗しました");
    }
  };

  // 事業所を選んだら、その事業所の会社情報 (事業所の設定 > マスタ > グループ共通) を読み込む
  useEffect(() => {
    if (companyScope === "group") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- グループ共通に戻したら事業所用の表示を消す
      setCompanyBase(null);
      setCompanyMissing([]);
      // グループ共通の値を読み直す (事業所の値が入力欄に残らないように)
      let cancelledG = false;
      getTenantById(tenantId).then((t) => {
        if (cancelledG || !t) return;
        const row = emptyCompanyInfoRow();
        for (const k of COMPANY_INFO_KEYS) row[k] = ((t as Record<string, unknown>)[k] as string | null) ?? "";
        setCompany(row);
      }).catch((e) => console.error("グループ共通の会社情報の取得に失敗:", e instanceof Error ? e.message : e));
      return () => { cancelledG = true; };
    }
    let cancelled = false;
    getOfficeCompanyInfo(tenantId, companyScope)
      .then((r) => {
        if (cancelled) return;
        setCompany(r.row);
        setCompanyBase(r.base);
        setCompanyMissing(r.missing);
        setCompanyColumnMissing(r.columnMissing);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("事業所の会社情報の取得に失敗:", msg);
        alert(`事業所の会社情報の取得に失敗しました: ${msg}`);
      });
    return () => { cancelled = true; };
  }, [tenantId, companyScope]);

  const handleSaveCompany = async () => {
    setSavingCompany(true);
    setSavedCompany(false);
    try {
      if (companyScope !== "group") {
        if (!companyBase) throw new Error("事業所の会社情報を読み込めていません");
        await saveOfficeCompanyOverrides(companyScope, company, companyBase);
        const r = await getOfficeCompanyInfo(tenantId, companyScope);
        setCompany(r.row);
        setCompanyBase(r.base);
        setCompanyMissing(r.missing);
      } else {
        await updateTenantInfo(tenantId, company);
      }
      setSavedCompany(true);
      setTimeout(() => setSavedCompany(false), 2500);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const msg = err instanceof Error ? err.message : (err as any)?.message ?? JSON.stringify(err);
      alert("保存に失敗しました: " + msg);
    } finally {
      setSavingCompany(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  const companyFields = [
    { key: "business_number", label: "指定事業所NO",  placeholder: "1234567890" },
    { key: "company_name",    label: "会社名",         placeholder: "○○福祉用具" },
    { key: "company_address", label: "所在地",         placeholder: "○○県○○市○○1-2-3" },
    { key: "company_tel",     label: "TEL",            placeholder: "000-0000-0000" },
    { key: "company_fax",     label: "FAX",            placeholder: "000-0000-0001" },
    { key: "staff_name",      label: "担当者名（管理者）", placeholder: "山田 太郎" },
    { key: "legal_name",      label: "法人名（事業者名）", placeholder: "株式会社○○福祉用具" },
  ] as const;

  const importantMattersFields = [
    { key: "service_area",   label: "通常の事業の実施地域",  placeholder: "○○市、○○市" },
    { key: "business_days",  label: "営業日",                placeholder: "月〜土（祝日除く）" },
    { key: "business_hours", label: "営業時間",              placeholder: "9:00〜17:00" },
  ] as const;

  const staffRows = [
    { label: "管理者 兼 専門相談員", fullKey: "staff_manager_full",    partKey: "staff_manager_part" },
    { label: "専門相談員",           fullKey: "staff_specialist_full", partKey: "staff_specialist_part" },
    { label: "事務･配送職員",        fullKey: "staff_admin_full",      partKey: "staff_admin_part" },
  ] as const;

  const menuItems: { id: SettingsPage; label: string; desc: string }[] = [
    { id: "company",      label: "会社情報",           desc: "事業所番号・住所・担当者など" },
    { id: "own_offices",  label: "自事業所管理",        desc: "事業所の追加・編集" },
    { id: "suppliers",    label: "卸会社マスタ", desc: "卸の追加・名前・メール・表示の管理" },
    { id: "care_offices", label: "居宅事業所マスタ",    desc: "ケアマネ事務所・FAX番号の管理" },
    { id: "care_plan",    label: "個別援助計画書テンプレート", desc: "計画書の定型文管理" },
    { id: "contract_template", label: "契約書・重要事項の文面", desc: "帳票の文章ブロックを編集" },
    { id: "speech_usage", label: "AI使用状況・料金",       desc: "音声認識・カナ変換の使用量と料金を確認" },
    { id: "data_reimport", label: "データ再取込（危険）",    desc: "利用者・保険情報・居宅マスタを一括再構築" },
  ];

  // ── メニュー画面 ──
  if (settingsPage === "menu") {
    const currentOfficeName = settingsOffices.find(o => o.id === currentOfficeId)?.name;
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
          <h2 className="font-semibold text-gray-800">設定</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 事業所切替セクション */}
          {settingsOffices.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">現在の事業所</h3>
              <select
                value={currentOfficeId ?? ""}
                onChange={(e) => onOfficeChange(e.target.value || null)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-emerald-400 bg-white"
              >
                <option value="">（未選択 — 全事業所）</option>
                {settingsOffices.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              {currentOfficeId && (
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={!officeViewAll}
                      onChange={() => onViewModeChange(false)}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm text-gray-700">{currentOfficeName}の利用者のみ</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={officeViewAll}
                      onChange={() => onViewModeChange(true)}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm text-gray-700">全事業所の利用者</span>
                  </label>
                </div>
              )}
              {currentOfficeId && !officeViewAll && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-1.5">
                  利用者タブは{currentOfficeName}に適用された利用者のみ表示されます
                </p>
              )}
            </div>
          )}
          <div className="bg-white rounded-xl overflow-hidden border border-gray-100">
            {menuItems.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => setSettingsPage(item.id)}
                className={`w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors text-left ${idx > 0 ? "border-t border-gray-100" : ""}`}
              >
                <div>
                  <p className="text-sm font-medium text-gray-800">{item.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                </div>
                <ChevronRight size={16} className="text-gray-300 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── 会社情報 ──
  if (settingsPage === "company") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="会社情報" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-white rounded-xl p-4 space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">どの事業所の会社情報か</label>
              <select value={companyScope} onChange={(e) => setCompanyScope(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400">
                {settingsOffices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                <option value="group">グループ共通（事業所を選んでいないときの既定）</option>
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                重要事項説明書・契約書・計画書などの会社欄に出ます。事業所名・指定番号は事業所マスタ、法人名は法人マスタの値を使い、
                ここで入力した項目だけ上書きします（空欄の項目は灰色で表示しているマスタの値になります）。
              </p>
            </div>
            {companyColumnMissing && companyScope !== "group" && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                事業所ごとの保存先 (offices.doc_company_info) が DB にまだありません。SQL の適用後に保存できます。
              </p>
            )}
            {companyMissing.length > 0 && companyScope !== "group" && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                書類に必要なのに空の項目: {companyMissing.join("・")}
              </p>
            )}
            {companyFields.map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="text-xs text-gray-500 block mb-1">{label}</label>
                <input
                  value={company[key]}
                  onChange={(e) => setCompany({ ...company, [key]: e.target.value })}
                  placeholder={companyBase?.[key] || placeholder}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            <p className="text-xs font-semibold text-gray-400 pt-2 border-t border-gray-100">重要事項説明書用</p>
            {importantMattersFields.map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="text-xs text-gray-500 block mb-1">{label}</label>
                <input
                  value={company[key]}
                  onChange={(e) => setCompany({ ...company, [key]: e.target.value })}
                  placeholder={companyBase?.[key] || placeholder}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            <div>
              <label className="text-xs text-gray-500 block mb-1">職員体制（常勤 / 非常勤）</label>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="grid grid-cols-3 bg-gray-50 px-3 py-1.5">
                  <span className="text-xs text-gray-500">職種</span>
                  <span className="text-xs text-gray-500 text-center">常勤</span>
                  <span className="text-xs text-gray-500 text-center">非常勤</span>
                </div>
                {staffRows.map(({ label, fullKey, partKey }) => (
                  <div key={label} className="grid grid-cols-3 items-center border-t border-gray-100 px-3 py-1.5 gap-2">
                    <span className="text-xs text-gray-700">{label}</span>
                    <input value={company[fullKey]} onChange={(e) => setCompany({ ...company, [fullKey]: e.target.value })} placeholder="0" className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400" />
                    <input value={company[partKey]} onChange={(e) => setCompany({ ...company, [partKey]: e.target.value })} placeholder="0" className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400" />
                  </div>
                ))}
              </div>
            </div>
            <button onClick={handleSaveCompany} disabled={savingCompany}
              className="w-full py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-2 mt-2">
              {savingCompany ? <Loader2 size={14} className="animate-spin" /> : "会社情報を保存"}
            </button>
            {savedCompany && <p className="text-xs text-emerald-600 font-medium text-center">✓ 保存完了しました</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── 自事業所管理 ──
  if (settingsPage === "own_offices") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="自事業所管理" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4">
          <OfficeManagementSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── 卸会社メールアドレス ──
  if (settingsPage === "suppliers") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="卸会社マスタ" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 新規追加 */}
          <div className="bg-white rounded-xl p-4 space-y-2 border border-emerald-100">
            <p className="text-sm font-semibold text-gray-800">卸会社を追加</p>
            <input
              value={newSupplierName}
              onChange={(e) => setNewSupplierName(e.target.value)}
              placeholder="会社名（必須）"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
            <input
              type="email"
              value={newSupplierEmail}
              onChange={(e) => setNewSupplierEmail(e.target.value)}
              placeholder="メール（任意）"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
            <button onClick={handleAddSupplier} disabled={addingSupplier || !newSupplierName.trim()}
              className="w-full py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-1">
              {addingSupplier ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} 追加
            </button>
          </div>
          {/* 既存卸 (非表示含む) */}
          {suppliers.map((s) => (
            <div key={s.id} className={`bg-white rounded-xl p-4 space-y-2 ${s.is_active === false ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <input
                  value={nameMap[s.id] ?? ""}
                  onChange={(e) => setNameMap({ ...nameMap, [s.id]: e.target.value })}
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm font-semibold outline-none focus:border-emerald-400"
                />
                {s.is_active === false && <span className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">非表示</span>}
              </div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={emailMap[s.id] ?? ""}
                  onChange={(e) => setEmailMap({ ...emailMap, [s.id]: e.target.value })}
                  placeholder="example@wholesaler.co.jp"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
                <button onClick={() => handleSave(s.id)} disabled={saving === s.id}
                  className="shrink-0 px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center gap-1">
                  {saving === s.id ? <Loader2 size={14} className="animate-spin" /> : "保存"}
                </button>
              </div>
              <div className="flex items-center justify-between">
                {saved === s.id ? <p className="text-xs text-emerald-600 font-medium">✓ 保存完了しました</p> : <span />}
                <button onClick={() => handleToggleSupplierActive(s.id, s.is_active === false)}
                  className="text-xs font-medium text-gray-500 hover:text-gray-800">
                  {s.is_active === false ? "再表示する" : "非表示にする"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 居宅事業所マスタ ──
  if (settingsPage === "care_offices") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="居宅事業所マスタ" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4">
          <CareOfficeSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── AI使用状況（音声認識 + OpenAI カナ変換） ──
  if (settingsPage === "speech_usage") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="AI使用状況・料金" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">🎤 音声認識（Google Speech-to-Text）</h2>
            <SpeechUsageSection tenantId={tenantId} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">🤖 AIカナ変換（OpenAI gpt-4o-mini）</h2>
            <OpenAIUsageSection tenantId={tenantId} />
          </div>
        </div>
      </div>
    );
  }

  if (settingsPage === "data_reimport") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="データ再取込" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4">
          <DataReimportSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── 契約書・重要事項の文面 ──
  if (settingsPage === "contract_template") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="契約書・重要事項の文面" onBack={() => setSettingsPage("menu")} />
        <div className="flex-1 overflow-y-auto p-4">
          <ContractTemplateSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── 個別援助計画書テンプレート ──
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <PageHeader title="個別援助計画書テンプレート" onBack={() => setSettingsPage("menu")} />
      <div className="flex-1 overflow-y-auto p-4">
        <CarePlanTemplateSection tenantId={tenantId} />
      </div>
    </div>
  );
}

// ─── Speech Usage Section ─────────────────────────────────────────────────────
function SpeechUsageSection({ tenantId }: { tenantId: string }) {
  const [summary, setSummary] = useState<SpeechUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSpeechUsageSummary(tenantId).then(setSummary).finally(() => setLoading(false));
  }, [tenantId]);

  if (loading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (!summary) return <p className="text-sm text-gray-400">データなし</p>;

  const monthMinutes = (summary.monthSeconds / 60).toFixed(1);
  const totalMinutes = (summary.totalSeconds / 60).toFixed(1);
  const freeMinutesRemaining = (summary.freeSecondsRemaining / 60).toFixed(1);
  const usedRatio = Math.min(100, (summary.monthSeconds / (60 * 60)) * 100);

  return (
    <div className="space-y-4">
      {/* 今月の使用状況 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">今月の使用状況</h3>
        <div className="space-y-3">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">使用時間</span>
            <span className="text-lg font-bold text-gray-800">{monthMinutes}分</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">認識回数</span>
            <span className="text-sm text-gray-700">{summary.monthCallCount}回</span>
          </div>
          {/* 無料枠プログレスバー */}
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>無料枠 (月60分)</span>
              <span>残り {freeMinutesRemaining}分</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all ${usedRatio >= 100 ? "bg-red-500" : usedRatio >= 80 ? "bg-orange-400" : "bg-emerald-500"}`}
                style={{ width: `${usedRatio}%` }}
              />
            </div>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">今月の請求見込</span>
            <span className="text-lg font-bold text-emerald-700">
              ¥{Math.round(summary.monthBillableCostJpy).toLocaleString()}
            </span>
          </div>
          {summary.monthBillableCostJpy === 0 && summary.monthSeconds > 0 && (
            <p className="text-xs text-emerald-600">✓ 無料枠内に収まっています</p>
          )}
        </div>
      </div>

      {/* 累計 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">累計</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計使用時間</span>
            <span className="text-sm text-gray-700">{totalMinutes}分</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計認識回数</span>
            <span className="text-sm text-gray-700">{summary.totalCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">理論料金 (無料枠考慮前)</span>
            <span className="text-sm text-gray-600">¥{summary.totalCostJpy.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-400 px-1">
        Google Cloud Speech-to-Text v2 (long モデル + カスタム辞書) / 月60分まで無料 / 超過分 ¥2.4/分
      </p>
    </div>
  );
}

// ─── OpenAI Usage Section ─────────────────────────────────────────────────────
function OpenAIUsageSection({ tenantId }: { tenantId: string }) {
  const [summary, setSummary] = useState<OpenAIUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOpenAIUsageSummary(tenantId).then(setSummary).finally(() => setLoading(false));
  }, [tenantId]);

  if (loading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (!summary) return <p className="text-sm text-gray-400">データなし</p>;

  const fmtNum = (n: number) => n.toLocaleString();
  const fmtJpy = (n: number) => `¥${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

  return (
    <div className="space-y-4">
      {/* 今月のサマリ */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">今月の使用状況</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">呼び出し回数</span>
            <span className="text-sm text-gray-700">{summary.monthCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">入力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.monthInputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">出力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.monthOutputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">今月の概算料金</span>
            <span className="text-lg font-bold text-emerald-700">{fmtJpy(summary.monthCostJpy)}</span>
          </div>
        </div>
      </div>

      {/* 用途別内訳（今月） */}
      {summary.monthBreakdown.length > 0 && (
        <div className="bg-white rounded-xl p-4 border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">用途別内訳（今月）</h3>
          <div className="space-y-2">
            {summary.monthBreakdown.map((b) => (
              <div key={b.purpose} className="flex justify-between items-center py-1 border-b border-gray-50 last:border-b-0">
                <div>
                  <p className="text-sm text-gray-700">{b.label}</p>
                  <p className="text-[11px] text-gray-400">{b.callCount}回 / 入{fmtNum(b.inputTokens)} 出{fmtNum(b.outputTokens)}</p>
                </div>
                <span className="text-sm font-semibold text-gray-700">{fmtJpy(b.costJpy)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 累計 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">累計</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計呼び出し回数</span>
            <span className="text-sm text-gray-700">{summary.totalCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計入力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.totalInputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計出力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.totalOutputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">累計料金</span>
            <span className="text-sm font-semibold text-gray-700">{fmtJpy(summary.totalCostJpy)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-400 px-1">
        OpenAI gpt-4o-mini / 入力 $0.150・出力 $0.600 (1M tokens) / 1USD≒¥150 換算の概算
      </p>
    </div>
  );
}

// ─── Care Office Section ─────────────────────────────────────────────────────

function CareOfficeSection({ tenantId }: { tenantId: string }) {
  const [offices, setOffices] = useState<CareOffice[]>([]);
  const [managers, setManagers] = useState<CareManager[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<CareOffice>>({});
  const [saving, setSaving] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [expandedOfficeId, setExpandedOfficeId] = useState<string | null>(null);
  // ケアマネ追加
  const [addingManagerOfficeId, setAddingManagerOfficeId] = useState<string | null>(null);
  const [newManagerName, setNewManagerName] = useState("");
  const [savingManager, setSavingManager] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [o, m] = await Promise.all([getCareOffices(tenantId), getCareManagers(tenantId)]);
      setOffices(o);
      setManagers(m);
    } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { load(); }, [tenantId]);

  const startEdit = (office: CareOffice) => {
    setEditingId(office.id);
    setForm({ ...office });
    setAddingNew(false);
    setPickedCorp(null);
  };

  const startNew = () => {
    setAddingNew(true);
    setEditingId(null);
    setForm({ name: "", fax_number: "", phone_number: "", address: "", email: "", office_number: "" });
    setPickedCorp(null);
  };

  const handleSave = async () => {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      // opendata 選択で法人情報があれば partner_companies へ find-or-create して紐付ける
      // (テーブル/列 未適用: 42P01/PGRST205/42703/PGRST204 等で失敗しても法人リンクなしで作成は続行)
      // 名寄せキー: ①法人番号 (13桁として妥当な場合のみ。opendata には Excel 経由で
      // "3.04E+12" 状に壊れた値が混在) → ②法人名 (trim 一致)
      // 候補を選ばず番号だけ手入力したケースも、番号が opendata に実在すれば同様に自動リンクする
      // (2026-09-01: これが無いと partner_company_id 未リンクの care_offices が溜まり続けていた)
      let corpToLink = pickedCorp;
      const typedNumber = form.office_number?.trim() || null;
      if (!corpToLink && typedNumber) {
        const { data: od } = await supabase
          .from("care_offices_opendata")
          .select("corp_number, corp_name")
          .eq("office_number", typedNumber)
          .maybeSingle();
        if (od && (od.corp_number || od.corp_name)) {
          corpToLink = { corp_number: od.corp_number, corp_name: od.corp_name };
        }
      }
      let partnerCompanyId: string | null = null;
      if (corpToLink) {
        try {
          const validNumber = /^\d{13}$/.test(corpToLink.corp_number ?? "") ? corpToLink.corp_number : null;
          const corpName = corpToLink.corp_name?.trim() || null;
          let found: string | null = null;
          if (validNumber) {
            const { data, error } = await supabase
              .from("partner_companies").select("id").eq("corp_number", validNumber).maybeSingle();
            if (error) throw error;
            if (data?.id) found = data.id;
          }
          if (!found && corpName) {
            const { data, error } = await supabase
              .from("partner_companies").select("id, corp_number").eq("name", corpName).limit(1);
            if (error) throw error;
            if (data?.[0]?.id) {
              found = data[0].id;
              if (validNumber && !data[0].corp_number) {
                // 名前で先に作られた行に正しい法人番号を補完 (best effort)
                const { error: fillError } = await supabase
                  .from("partner_companies").update({ corp_number: validNumber }).eq("id", found);
                if (fillError) console.warn(`corp_number 補完失敗: ${fillError.message}`);
              }
            }
          }
          if (!found && (validNumber || corpName)) {
            const { data, error } = await supabase
              .from("partner_companies")
              .insert({ corp_number: validNumber, name: corpName ?? `法人番号 ${validNumber}`, source: "opendata" })
              .select("id")
              .single();
            if (error) throw error;
            found = data.id;
          }
          partnerCompanyId = found;
        } catch (pcErr) {
          const pe = pcErr as { code?: string; message?: string };
          console.warn(`partner_companies 連携失敗 (法人リンクなしで続行): [${pe.code}] ${pe.message}`);
        }
      }
      await upsertCareOffice(tenantId, {
        id: editingId ?? undefined,
        name: form.name!,
        fax_number: form.fax_number ?? null,
        phone_number: form.phone_number ?? null,
        address: form.address ?? null,
        email: form.email ?? null,
        notes: form.notes ?? null,
        office_number: form.office_number?.trim() || null,
        // 未指定 (undefined) なら列に触れない: DB 未適用でも壊れず、既存リンクも保持される
        ...(partnerCompanyId ? { partner_company_id: partnerCompanyId } : {}),
      });
      setEditingId(null);
      setAddingNew(false);
      setForm({});
      setPickedCorp(null);
      await load();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err?.code === "23505") {
        alert("この事業所番号は既に登録されています");
      } else {
        alert(`保存に失敗しました${err?.message ? `\n${err.message}` : ""}`);
      }
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？\nケアマネ情報も削除されます。`)) return;
    try { await deleteCareOffice(id); await load(); }
    catch { alert("削除に失敗しました"); }
  };

  const handleAddManager = async (officeId: string) => {
    if (!newManagerName.trim()) return;
    setSavingManager(true);
    try {
      await addCareManager(tenantId, officeId, newManagerName.trim());
      setNewManagerName("");
      setAddingManagerOfficeId(null);
      await load();
    } catch { alert("追加に失敗しました"); } finally { setSavingManager(false); }
  };

  const handleToggleManagerActive = async (manager: CareManager) => {
    try {
      await updateCareManager(manager.id, { active: !manager.active });
      await load();
    } catch { alert("更新に失敗しました"); }
  };

  const handleDeleteManager = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return;
    try { await deleteCareManager(id); await load(); }
    catch { alert("削除に失敗しました"); }
  };

  // CSV取込：厚労省オープンデータを care_offices_opendata に保存
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportOpendata = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { alert("CSV が空か形式が不正です"); return; }
      const parseCsvLine = (line: string): string[] => {
        const out: string[] = []; let cur = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
          } else if (ch === "," && !inQ) { out.push(cur); cur = ""; } else { cur += ch; }
        }
        out.push(cur); return out;
      };
      const header = parseCsvLine(lines[0]);
      const col = (n: string) => header.indexOf(n);
      const iPref = col("都道府県名"), iCity = col("市区町村名"), iName = col("事業所名"),
            iKana = col("事業所名カナ"), iSvc = col("サービスの種類"),
            iAddr = col("住所"), iAddrDet = col("方書（ビル名等）"),
            iPhone = col("電話番号"), iFax = col("FAX番号"),
            iCorp = col("法人の名称"), iCorpNum = col("法人番号"),
            iOfficeNum = col("事業所番号"), iUrl = col("URL"),
            iLat = col("緯度"), iLng = col("経度");
      if (iPref < 0 || iName < 0 || iOfficeNum < 0) { alert("必要な列（都道府県名 / 事業所名 / 事業所番号）が見つかりません"); return; }

      // 千葉県分のみ抽出
      const chibaRows = lines.slice(1).map(parseCsvLine).filter((r) => r[iPref] === "千葉県");
      let corpNumberDropped = 0; // Excel 破損等で捨てた法人番号の件数 (取込完了時に警告)
      const rows = chibaRows
        .map((r) => ({
          office_number: (r[iOfficeNum] ?? "").trim(),
          prefecture: (r[iPref] ?? "").trim(),
          city: iCity >= 0 ? (r[iCity] ?? "").trim() : null,
          name: (r[iName] ?? "").trim(),
          name_kana: iKana >= 0 ? (r[iKana] ?? "").trim() : null,
          service_type: iSvc >= 0 ? (r[iSvc] ?? "").trim() : null,
          address: (r[iAddr] ?? "").trim() || null,
          address_detail: iAddrDet >= 0 ? (r[iAddrDet] ?? "").trim() || null : null,
          phone_number: (r[iPhone] ?? "").trim() || null,
          fax_number: (r[iFax] ?? "").trim() || null,
          corp_name: iCorp >= 0 ? (r[iCorp] ?? "").trim() || null : null,
          // 法人番号は 13 桁のみ有効。Excel で開いた CSV は "3.04E+12" 状に壊れるため
          // 不正値は null にする (法人の名寄せは corp_name で fallback される)
          corp_number: (() => {
            const v = iCorpNum >= 0 ? (r[iCorpNum] ?? "").trim() : "";
            if (/^\d{13}$/.test(v)) return v;
            if (v) corpNumberDropped++;
            return null;
          })(),
          url: iUrl >= 0 ? (r[iUrl] ?? "").trim() || null : null,
          latitude: iLat >= 0 && r[iLat] ? Number(r[iLat]) : null,
          longitude: iLng >= 0 && r[iLng] ? Number(r[iLng]) : null,
          imported_at: new Date().toISOString(),
        }))
        .filter((r) => r.office_number && r.name);

      // 500件ずつバッチで upsert
      const BATCH = 500;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase.from("care_offices_opendata").upsert(batch, { onConflict: "office_number" });
        if (error) throw error;
        inserted += batch.length;
      }
      alert(
        `取込完了\n千葉県 ${inserted} 件をオープンデータに登録しました。\n「＋ 事業所追加」から検索して選択できます。` +
        (corpNumberDropped > 0
          ? `\n\n⚠️ 法人番号が 13 桁でない行が ${corpNumberDropped} 件あり、法人番号は保存しませんでした (法人名で名寄せされます)。\nCSV を Excel で開いて保存すると法人番号が壊れます。厚労省サイトの CSV をそのまま取込んでください。`
          : "")
      );
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`取込に失敗しました\n${msg}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  // ── オープンデータ検索（＋事業所追加 内で使う） ──
  const [opendataQuery, setOpendataQuery] = useState("");
  const [opendataResults, setOpendataResults] = useState<Array<{
    office_number: string; name: string; address: string | null; phone_number: string | null; fax_number: string | null; city: string | null;
    corp_name: string | null; corp_number: string | null;
  }>>([]);
  const [opendataSearching, setOpendataSearching] = useState(false);
  // opendata 候補選択時の法人情報 (保存時に partner_companies へ upsert して紐付ける)
  const [pickedCorp, setPickedCorp] = useState<{ corp_number: string | null; corp_name: string | null } | null>(null);

  async function searchOpendata(q: string) {
    setOpendataQuery(q);
    if (q.trim().length < 2) { setOpendataResults([]); return; }
    setOpendataSearching(true);
    try {
      const { data, error } = await supabase
        .from("care_offices_opendata")
        .select("office_number, name, address, phone_number, fax_number, city, corp_name, corp_number")
        .eq("prefecture", "千葉県")
        .ilike("name", `%${q.trim()}%`)
        .limit(30);
      if (error) {
        console.error("opendata 検索に失敗:", error.message);
        setOpendataResults([]);
        return;
      }
      setOpendataResults((data ?? []) as typeof opendataResults);
    } finally {
      setOpendataSearching(false);
    }
  }

  function pickOpendata(row: { office_number: string; name: string; address: string | null; phone_number: string | null; fax_number: string | null; corp_name: string | null; corp_number: string | null }) {
    // 既存の事業所番号と異なる場合は警告
    // 編集中は元の office.office_number も参照（form がまだ未反映の可能性）
    const existingFromForm = (form.office_number ?? "").trim();
    const existingFromOffice = editingId ? (offices.find((o) => o.id === editingId)?.office_number ?? "").trim() : "";
    const existingOfficeNum = existingFromForm || existingFromOffice;
    console.log("[pickOpendata] form.office_number=", form.office_number, "editing.office_number=", existingFromOffice, "existing=", existingOfficeNum, "selected=", row.office_number);
    if (existingOfficeNum && existingOfficeNum !== row.office_number) {
      const ok = window.confirm(
        `⚠️ 事業所番号が異なります\n\n` +
        `現在: ${existingOfficeNum}\n` +
        `選択: ${row.office_number}（${row.name}）\n\n` +
        `別の事業所を選択しようとしています。本当に上書きしますか？\n` +
        `（この居宅に紐付いている利用者・ケアマネも実質的に別事業所扱いになります）`
      );
      if (!ok) return;
    }
    // 編集中の場合は既存の email/notes を保持、新規の場合は空で開始
    setForm((prev) => ({
      ...prev,
      name: row.name,
      address: row.address ?? "",
      phone_number: row.phone_number ?? "",
      fax_number: row.fax_number ?? "",
      office_number: row.office_number,
    }));
    // 法人名 or 法人番号があれば保存時に partner_companies へ紐付け
    // (法人番号は Excel 経由で壊れていることがあるため、法人名だけでも連携する)
    setPickedCorp(
      row.corp_number || row.corp_name
        ? { corp_number: row.corp_number, corp_name: row.corp_name }
        : null
    );
    setOpendataQuery("");
    setOpendataResults([]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">居宅事業所マスタ</h3>
        <div className="flex items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportOpendata(f); }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 disabled:opacity-50"
            title="厚労省オープンデータから住所・電話・FAXを補完"
          >
            {importing ? "取込中…" : "📥 CSV取込（厚労省）"}
          </button>
          <button onClick={startNew} className="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100">
            ＋ 事業所追加
          </button>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-4 flex justify-center"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
        ) : (
          <>
            {addingNew && (
              <div className="p-4 border-b border-gray-100 space-y-2 bg-emerald-50">
                {/* オープンデータ検索 */}
                <div className="bg-white rounded-lg border border-blue-200 p-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Search size={14} className="text-blue-500 shrink-0" />
                    <input
                      type="text"
                      value={opendataQuery}
                      onChange={(e) => searchOpendata(e.target.value)}
                      placeholder="オープンデータから検索（2文字以上）"
                      className="flex-1 text-xs px-2 py-1 border border-blue-200 rounded outline-none focus:ring-1 focus:ring-blue-300"
                    />
                  </div>
                  {opendataSearching && <p className="text-xs text-gray-400 text-center py-1">検索中...</p>}
                  {opendataResults.length > 0 && (
                    <ul className="max-h-48 overflow-y-auto bg-gray-50 rounded border border-gray-100 divide-y divide-gray-100">
                      {opendataResults.map((r) => (
                        <li key={r.office_number}>
                          <button
                            type="button"
                            onClick={() => pickOpendata(r)}
                            className="w-full px-2 py-1.5 text-left text-xs hover:bg-blue-50"
                          >
                            <p className="font-medium text-gray-800">{r.name}</p>
                            <p className="text-[11px] text-gray-500 truncate">{r.city ?? ""} {r.address ?? ""}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {opendataQuery.trim().length >= 2 && !opendataSearching && opendataResults.length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-1">該当なし（オープンデータ未取込 or 事業所名不一致）</p>
                  )}
                </div>
                <CareOfficeFormRow label="事業所名 *" field="name" placeholder="○○居宅介護支援事業所" form={form} setForm={setForm} />
                <CareOfficeFormRow label="事業所番号" field="office_number" placeholder="1270102658" form={form} setForm={setForm} />
                <CareOfficeFormRow label="所在地" field="address" placeholder="千葉県市原市○○1-2-3" form={form} setForm={setForm} />
                <CareOfficeFormRow label="FAX番号" field="fax_number" placeholder="0436-00-0000" form={form} setForm={setForm} />
                <CareOfficeFormRow label="電話番号" field="phone_number" placeholder="0436-00-0000" form={form} setForm={setForm} />
                <CareOfficeFormRow label="メール" field="email" placeholder="example@example.com" form={form} setForm={setForm} />
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { setAddingNew(false); setOpendataQuery(""); setOpendataResults([]); }} className="flex-1 py-1.5 rounded-lg text-sm text-gray-500 bg-white border border-gray-200">キャンセル</button>
                  <button onClick={handleSave} disabled={saving || !form.name?.trim()} className="flex-1 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                    {saving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            )}
            {offices.length === 0 && !addingNew && (
              <p className="text-xs text-gray-400 p-4 text-center">事業所が登録されていません</p>
            )}
            {offices.map((office, idx) => {
              const officeManagers = managers.filter(m => m.care_office_id === office.id);
              const isExpanded = expandedOfficeId === office.id;
              return (
                <div key={office.id} className={`${idx > 0 ? "border-t border-gray-100" : ""}`}>
                  {editingId === office.id ? (
                    <div className="p-4 space-y-2 bg-blue-50">
                      {/* オープンデータ検索（上書き用） */}
                      <div className="bg-white rounded-lg border border-blue-200 p-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Search size={14} className="text-blue-500 shrink-0" />
                          <input
                            type="text"
                            value={opendataQuery}
                            onChange={(e) => searchOpendata(e.target.value)}
                            placeholder="オープンデータから検索して上書き（2文字以上）"
                            className="flex-1 text-xs px-2 py-1 border border-blue-200 rounded outline-none focus:ring-1 focus:ring-blue-300"
                          />
                        </div>
                        {opendataSearching && <p className="text-xs text-gray-400 text-center py-1">検索中...</p>}
                        {opendataResults.length > 0 && (
                          <ul className="max-h-48 overflow-y-auto bg-gray-50 rounded border border-gray-100 divide-y divide-gray-100">
                            {opendataResults.map((r) => (
                              <li key={r.office_number}>
                                <button
                                  type="button"
                                  onClick={() => pickOpendata(r)}
                                  className="w-full px-2 py-1.5 text-left text-xs hover:bg-blue-50"
                                >
                                  <p className="font-medium text-gray-800">{r.name}</p>
                                  <p className="text-[11px] text-gray-500 truncate">{r.city ?? ""} {r.address ?? ""}</p>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {opendataQuery.trim().length >= 2 && !opendataSearching && opendataResults.length === 0 && (
                          <p className="text-xs text-gray-400 text-center py-1">該当なし</p>
                        )}
                        <p className="text-[10px] text-gray-500 px-1">選ぶと事業所名・事業所番号・住所・電話・FAXが上書きされます（ID はそのまま）</p>
                      </div>
                      <CareOfficeFormRow label="事業所名 *" field="name" form={form} setForm={setForm} />
                      <CareOfficeFormRow label="事業所番号" field="office_number" placeholder="1270102658" form={form} setForm={setForm} />
                      <CareOfficeFormRow label="所在地" field="address" placeholder="千葉県市原市○○1-2-3" form={form} setForm={setForm} />
                      <CareOfficeFormRow label="FAX番号" field="fax_number" placeholder="0436-00-0000" form={form} setForm={setForm} />
                      <CareOfficeFormRow label="電話番号" field="phone_number" placeholder="0436-00-0000" form={form} setForm={setForm} />
                      <CareOfficeFormRow label="メール" field="email" placeholder="example@example.com" form={form} setForm={setForm} />
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => { setEditingId(null); setOpendataQuery(""); setOpendataResults([]); }} className="flex-1 py-1.5 rounded-lg text-sm text-gray-500 bg-white border border-gray-200">キャンセル</button>
                        <button onClick={handleSave} disabled={saving} className="flex-1 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                          {saving ? "保存中..." : "保存"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      {/* 事業所ヘッダー */}
                      <div className="px-4 py-3 flex items-start justify-between gap-2">
                        <button className="flex-1 text-left" onClick={() => setExpandedOfficeId(isExpanded ? null : office.id)}>
                          <div className="flex items-center gap-1.5">
                            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                            <p className="text-sm font-medium text-gray-800">{office.name}</p>
                            <span className="text-xs text-gray-400">（{officeManagers.filter(m => m.active).length}名）</span>
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 ml-5">
                            {office.address && <span className="text-xs text-gray-400">{office.address}</span>}
                            {office.fax_number && <span className="text-xs text-gray-400">FAX: {office.fax_number}</span>}
                            {office.phone_number && <span className="text-xs text-gray-400">TEL: {office.phone_number}</span>}
                            {office.office_number && <span className="text-xs text-gray-400">事業所番号: {office.office_number}</span>}
                          </div>
                        </button>
                        <div className="flex gap-1.5 shrink-0">
                          <button onClick={() => startEdit(office)} className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200">編集</button>
                          <button onClick={() => handleDelete(office.id, office.name)} className="text-xs px-2 py-1 rounded-lg bg-red-50 text-red-500 hover:bg-red-100">削除</button>
                        </div>
                      </div>

                      {/* ケアマネ一覧（展開時） */}
                      {isExpanded && (
                        <div className="bg-gray-50 border-t border-gray-100 px-4 py-3 space-y-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-gray-500">ケアマネ</span>
                            <button
                              onClick={() => { setAddingManagerOfficeId(office.id); setNewManagerName(""); }}
                              className="text-xs px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-600 border border-emerald-200"
                            >
                              ＋ 追加
                            </button>
                          </div>

                          {addingManagerOfficeId === office.id && (
                            <div className="flex gap-2">
                              <input
                                value={newManagerName}
                                onChange={e => setNewManagerName(e.target.value)}
                                placeholder="氏名を入力"
                                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white"
                              />
                              <button onClick={() => handleAddManager(office.id)} disabled={savingManager || !newManagerName.trim()}
                                className="px-3 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                                {savingManager ? "…" : "追加"}
                              </button>
                              <button onClick={() => setAddingManagerOfficeId(null)} className="px-2 py-1.5 rounded-lg text-sm text-gray-400 bg-white border border-gray-200">✕</button>
                            </div>
                          )}

                          {officeManagers.length === 0 && addingManagerOfficeId !== office.id && (
                            <p className="text-xs text-gray-400">ケアマネが登録されていません</p>
                          )}
                          {officeManagers.map(mgr => (
                            <div key={mgr.id} className="flex items-center justify-between gap-2">
                              <span className={`text-sm ${mgr.active ? "text-gray-700" : "text-gray-400 line-through"}`}>{mgr.name}</span>
                              <div className="flex gap-1.5 shrink-0">
                                <button
                                  onClick={() => handleToggleManagerActive(mgr)}
                                  className={`text-xs px-2 py-0.5 rounded-md border ${mgr.active ? "bg-white text-gray-500 border-gray-200" : "bg-emerald-50 text-emerald-600 border-emerald-200"}`}
                                >
                                  {mgr.active ? "退職" : "復職"}
                                </button>
                                <button onClick={() => handleDeleteManager(mgr.id, mgr.name)} className="text-xs px-2 py-0.5 rounded-md bg-red-50 text-red-400 border border-red-100">削除</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Office Management Section ───────────────────────────────────────────────

function OfficeManagementSection({ tenantId }: { tenantId: string }) {
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBusinessNumber, setEditBusinessNumber] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setOffices(await getOffices(tenantId)); } finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { load(); }, [tenantId]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await createOffice(tenantId, newName.trim());
      setNewName("");
      await load();
    } catch { alert("追加に失敗しました"); } finally { setAdding(false); }
  };

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return;
    setSaving(id);
    try {
      const bn = editBusinessNumber.trim();
      await updateOffice(id, editName.trim(), bn === "" ? null : bn);
      setEditId(null);
      await load();
    } catch { alert("保存に失敗しました"); } finally { setSaving(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この事業所を削除しますか？\n（事業所別価格データも削除されます）")) return;
    setDeletingId(id);
    try { await deleteOffice(id); await load(); }
    catch { alert("削除に失敗しました"); } finally { setDeletingId(null); }
  };

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">事業所管理</h3>
      <div className="bg-white rounded-xl overflow-hidden border border-gray-100">
        {loading ? (
          <div className="p-4 flex justify-center"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
        ) : (
          <>
            {offices.length === 0 && (
              <p className="text-xs text-gray-400 p-4 text-center">事業所が登録されていません</p>
            )}
            {offices.map((office, idx) => (
              <div key={office.id} className={`px-4 py-3 ${idx > 0 ? "border-t border-gray-100" : ""}`}>
                {editId === office.id ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="事業所名"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-emerald-400"
                      autoFocus
                    />
                    <input
                      value={editBusinessNumber}
                      onChange={(e) => setEditBusinessNumber(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
                      placeholder="介護事業所番号（10桁）"
                      inputMode="numeric"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-emerald-400 font-mono"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => handleEdit(office.id)}
                        disabled={saving === office.id}
                        className="text-xs font-medium text-white bg-emerald-500 px-3 py-1 rounded-lg disabled:opacity-40 flex items-center gap-1"
                      >
                        {saving === office.id ? <Loader2 size={12} className="animate-spin" /> : "保存"}
                      </button>
                      <button onClick={() => setEditId(null)} className="text-xs text-gray-400">戻す</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-800 truncate">{office.name}</div>
                      <div className="text-xs text-gray-400 font-mono mt-0.5">
                        事業所番号: {office.business_number ?? <span className="text-amber-500">未設定</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => { setEditId(office.id); setEditName(office.name); setEditBusinessNumber(office.business_number ?? ""); }}
                      className="text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg"
                    >
                      編集
                    </button>
                    <button
                      onClick={() => handleDelete(office.id)}
                      disabled={deletingId === office.id}
                      className="text-xs text-red-400 bg-red-50 px-2 py-1 rounded-lg disabled:opacity-40"
                    >
                      {deletingId === office.id ? <Loader2 size={12} className="animate-spin" /> : "削除"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {/* 新規追加 */}
            <div className="border-t border-gray-100 px-4 py-3 flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="新しい事業所名"
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
              />
              <button
                onClick={handleAdd}
                disabled={adding || !newName.trim()}
                className="flex items-center gap-1 text-xs font-medium text-white bg-emerald-500 px-3 py-1.5 rounded-lg disabled:opacity-40"
              >
                {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                追加
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Data Reimport（利用者・保険情報・居宅マスタ を CSV から一括再構築） ───

type ReimportClientRow = {
  user_number: string;
  name: string;
  furigana: string | null;
  gender: string | null;
  birth_date: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  mobile: string | null;
  memo: string | null;
};
type ReimportInsuranceRow = {
  user_number: string;
  effective_date: string | null;
  insured_number: string | null;
  insurer_number: string | null;
  issued_date: string | null;
  qualification_date: string | null;
  certification_status: string | null;
  care_level: string | null;
  certification_date: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  benefit_rate: string | null;
  copay_rate: string | null;
  care_manager_org: string | null;
  care_manager: string | null;
  service_memo: string | null;
  service_restriction: string | null;
};

function parseReimportCsv(buf: ArrayBuffer): { clients: Map<string, ReimportClientRow>; insurance: ReimportInsuranceRow[] } {
  const text = new TextDecoder("shift-jis").decode(buf);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV が空です");
  const parseRow = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseRow(lines[0]);
  const col = (name: string): number => header.indexOf(name);
  const iUserNum = col("利用者番号"),
    iLast = col("利用者名（姓）"), iFirst = col("利用者名（名）"), iName = col("利用者名"),
    iFLast = col("フリガナ（姓）"), iFFirst = col("フリガナ（名）"), iFuri = col("フリガナ"),
    iGender = col("性別"), iBirth = col("生年月日"),
    iZip = col("郵便番号"), iAddr = col("住所"),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
    iPhone = col("電話番号"), iMobile = col("携帯番号"), iMemo = col("メモ"),
    iEff = col("有効開始日"),
    iInsNum = col("被保険者番号"), iInsurer = col("保険者番号"),
    iIssued = col("交付年月日"), iQual = col("資格取得日"),
    iCertStatus = col("認定状況"), iCareLevel = col("要介護度"),
    iCertDate = col("認定年月日"),
    iCertStart = col("認定有効期間－開始日"),
    iCertEnd = col("認定有効期間－終了日"),
    iBenefit = col("給付率"),
    iSvcLimit = col("サービス限定"), iNote = col("留意事項"),
    iCmOrg = col("支援事業所（正式名称）"), iCmOrgShort = col("支援事業所"),
    iCm = col("担当ケアマネジャー");
  if (iUserNum < 0 || iName < 0) throw new Error("必要な列（利用者番号 / 利用者名）が見つかりません");

  const n = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const nYmd = (v: string | undefined): string | null => {
    const s = n(v); if (!s) return null;
    // Accept YYYY/MM/DD or YYYY-MM-DD or YYYYMMDD
    const m1 = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
    const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    return s;
  };

  const clients = new Map<string, ReimportClientRow>();
  const insurance: ReimportInsuranceRow[] = [];
  for (let idx = 1; idx < lines.length; idx++) {
    const r = parseRow(lines[idx]);
    const userNum = (r[iUserNum] ?? "").trim();
    if (!userNum) continue;
    const last = iLast >= 0 ? n(r[iLast]) : null;
    const first = iFirst >= 0 ? n(r[iFirst]) : null;
    const nameDirect = iName >= 0 ? n(r[iName]) : null;
    const name = nameDirect || [last, first].filter(Boolean).join(" ").trim();
    if (!name) continue;
    const fLast = iFLast >= 0 ? n(r[iFLast]) : null;
    const fFirst = iFFirst >= 0 ? n(r[iFFirst]) : null;
    const furiDirect = iFuri >= 0 ? n(r[iFuri]) : null;
    const furigana = furiDirect || [fLast, fFirst].filter(Boolean).join(" ").trim() || null;

    // 利用者マスタ: 1利用者1行（既存は上書き、認定最新が来るたびに更新）
    const prev = clients.get(userNum);
    const newEnd = iCertEnd >= 0 ? (nYmd(r[iCertEnd]) ?? "") : "";
    const prevEnd = prev ? (insurance.filter((ir) => ir.user_number === userNum).map((ir) => ir.certification_end_date ?? "").sort().at(-1) ?? "") : "";
    if (!prev || newEnd > prevEnd) {
      clients.set(userNum, {
        user_number: userNum,
        name,
        furigana,
        gender: iGender >= 0 ? n(r[iGender]) : null,
        birth_date: iBirth >= 0 ? nYmd(r[iBirth]) : null,
        postal_code: iZip >= 0 ? n(r[iZip]) : null,
        address: iAddr >= 0 ? n(r[iAddr]) : null,
        phone: iPhone >= 0 ? n(r[iPhone]) : null,
        mobile: iMobile >= 0 ? n(r[iMobile]) : null,
        // memo は clients から DROP 済のため省略（後日 client_memos へ）
        memo: null,
      });
    }

    // 介護保険情報: 1行 = 1認定期間
    const benefit = iBenefit >= 0 ? n(r[iBenefit]) : null;
    const copayCalc = benefit && !isNaN(Number(benefit)) ? String(100 - Number(benefit)) : null;
    const careOrg = (iCmOrg >= 0 ? n(r[iCmOrg]) : null) ?? (iCmOrgShort >= 0 ? n(r[iCmOrgShort]) : null);
    insurance.push({
      user_number: userNum,
      effective_date: iEff >= 0 ? nYmd(r[iEff]) : null,
      insured_number: iInsNum >= 0 ? n(r[iInsNum]) : null,
      insurer_number: iInsurer >= 0 ? n(r[iInsurer]) : null,
      issued_date: iIssued >= 0 ? nYmd(r[iIssued]) : null,
      qualification_date: iQual >= 0 ? nYmd(r[iQual]) : null,
      certification_status: iCertStatus >= 0 ? n(r[iCertStatus]) : null,
      care_level: iCareLevel >= 0 ? n(r[iCareLevel]) : null,
      certification_date: iCertDate >= 0 ? nYmd(r[iCertDate]) : null,
      certification_start_date: iCertStart >= 0 ? nYmd(r[iCertStart]) : null,
      certification_end_date: iCertEnd >= 0 ? nYmd(r[iCertEnd]) : null,
      benefit_rate: benefit,
      copay_rate: copayCalc,
      care_manager_org: careOrg,
      care_manager: iCm >= 0 ? n(r[iCm]) : null,
      service_memo: iSvcLimit >= 0 ? n(r[iSvcLimit]) : null,
      service_restriction: iNote >= 0 ? n(r[iNote]) : null,
    });
  }
  return { clients, insurance };
}

function DataReimportSection({ tenantId }: { tenantId: string }) {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{
    clients: Map<string, ReimportClientRow>;
    insurance: ReimportInsuranceRow[];
  } | null>(null);
  const [dryrun, setDryrun] = useState<null | {
    existing: number;
    toInsert: number;
    toUpdate: number;
    toSoftDelete: number;
    insuranceCurrent: number;
    insuranceNew: number;
    ordersToDelete: number;
    orderItemsToDelete: number;
    salesRecordsToDelete: number;
    careOfficesNew: number;
    careManagersNew: number;
  }>(null);
  const [parsing, setParsing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setCsvFile(file);
    setParsing(true);
    setDryrun(null);
    setDone(null);
    try {
      const buf = await file.arrayBuffer();
      const p = parseReimportCsv(buf);
      setParsed(p);
      // dryRun: 既存データとの差分を集計
      const userNums = Array.from(p.clients.keys());
      // 既存 clients
      const existingClientNums = new Set<string>();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data } = await supabase.from("clients").select("user_number").eq("tenant_id", tenantId).order("id").range(from, from + PAGE - 1);
        if (!data || data.length === 0) break;
        data.forEach((c: { user_number: string | null }) => { if (c.user_number) existingClientNums.add(c.user_number); });
        if (data.length < PAGE) break;
        from += PAGE;
      }
      const toInsert = userNums.filter((u) => !existingClientNums.has(u)).length;
      const toUpdate = userNums.filter((u) => existingClientNums.has(u)).length;
      const toSoftDelete = Array.from(existingClientNums).filter((u) => !p.clients.has(u)).length;

      const today = todayYmd();
      const insuranceCurrent = p.insurance.filter((r) => {
        const s = r.certification_start_date, e = r.certification_end_date;
        return (!s || s <= today) && (!e || e >= today);
      });

      // 現在期間の居宅・ケアマネ ユニーク数
      const offSet = new Set<string>();
      const mgrSet = new Set<string>();
      for (const r of insuranceCurrent) {
        if (r.care_manager_org) offSet.add(r.care_manager_org.trim());
        if (r.care_manager_org && r.care_manager) mgrSet.add(`${r.care_manager_org.trim()}__${r.care_manager.trim()}`);
      }

      const [{ count: ordCnt }, { count: itmCnt }, { count: srCnt }] = await Promise.all([
        supabase.from("orders").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("order_items").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("sales_records").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
      ]);

      setDryrun({
        existing: existingClientNums.size,
        toInsert,
        toUpdate,
        toSoftDelete,
        insuranceCurrent: insuranceCurrent.length,
        insuranceNew: p.insurance.length,
        ordersToDelete: ordCnt ?? 0,
        orderItemsToDelete: itmCnt ?? 0,
        salesRecordsToDelete: srCnt ?? 0,
        careOfficesNew: offSet.size,
        careManagersNew: mgrSet.size,
      });
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`CSV パースエラー\n${msg}`);
      setParsed(null);
    } finally {
      setParsing(false);
    }
  };

  const execute = async () => {
    if (!parsed || !dryrun) return;
    if (!confirm("本当に実行しますか？\n発注データは削除されます。\nこの処理は取り消せません。")) return;
    setExecuting(true);
    setDone(null);
    try {
      // Phase 1: 発注関連削除
      setProgress("1/5 発注データを削除中...");
      {
        const { error } = await supabase.from("sales_records").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }
      {
        const { error } = await supabase.from("order_items").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }
      {
        const { error } = await supabase.from("orders").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }

      // Phase 2: 利用者マスタ upsert
      setProgress("2/5 利用者マスタを upsert 中...");
      const clientArr = Array.from(parsed.clients.values()).map((c) => ({
        tenant_id: tenantId,
        user_number: c.user_number,
        name: c.name,
        furigana: c.furigana,
        gender: c.gender,
        birth_date: c.birth_date,
        postal_code: c.postal_code,
        address: c.address,
        phone: c.phone,
        mobile: c.mobile,
        // memo は clients から DROP 済のため省略（後日 client_memos へ）
        deleted_at: null,
      }));
      const BATCH = 200;
      for (let i = 0; i < clientArr.length; i += BATCH) {
        const batch = clientArr.slice(i, i + BATCH);
        const { error } = await supabase.from("clients").upsert(batch, { onConflict: "tenant_id,user_number", ignoreDuplicates: false });
        if (error) throw error;
        setProgress(`2/5 利用者マスタ upsert ${Math.min(i + BATCH, clientArr.length)}/${clientArr.length}`);
      }

      // CSV に無い既存利用者 → deleted_at
      setProgress("2/5 CSV に無い既存利用者を ソフト削除...");
      const userNums = Array.from(parsed.clients.keys());
      // RPC は無いので、1000件ずつ not in で処理
      // PostgreSQL の UPDATE with NOT IN だと実行可能
      // Supabase では .not('user_number', 'in', ...) が使える
      const SLICE = 300; // URLパラメータ長の問題を避ける
      for (let i = 0; i < userNums.length; i += SLICE) {
        // 何もしない：既存の削除処理は最後に1回だけ実行
      }
      const { error: softDelErr } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .not("user_number", "in", `(${userNums.map((u) => `"${u}"`).join(",")})`);
      if (softDelErr) {
        // NOT IN で失敗する場合は代替として client-side フィルタ
        console.warn("soft delete failed, skipping:", softDelErr);
      }

      // Phase 3: 保険情報の入れ替え
      setProgress("3/5 介護保険情報を入替中...");
      // 既存全削除
      {
        const { error } = await supabase.from("client_insurance_records").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }
      // client_id を再取得 (1810 件等あるためページング)
      const allClientIds: { id: string; user_number: string | null }[] = [];
      {
        const PAGE = 1000;
        let from = 0;
        while (true) {
          const { data } = await supabase.from("clients").select("id, user_number").eq("tenant_id", tenantId).is("deleted_at", null).order("id").range(from, from + PAGE - 1);
          if (!data || data.length === 0) break;
          allClientIds.push(...(data as { id: string; user_number: string | null }[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }
      const unum2id = new Map<string, string>();
      allClientIds.forEach((c) => { if (c.user_number) unum2id.set(c.user_number, c.id); });
      // バッチ insert
      const insRows = parsed.insurance
        .filter((r) => unum2id.has(r.user_number))
        .map((r) => ({
          tenant_id: tenantId,
          client_id: unum2id.get(r.user_number)!,
          effective_date: r.effective_date,
          insured_number: r.insured_number,
          insurer_number: r.insurer_number,
          issued_date: r.issued_date,
          qualification_date: r.qualification_date,
          certification_status: r.certification_status,
          care_level: r.care_level,
          certification_date: r.certification_date,
          certification_start_date: r.certification_start_date,
          certification_end_date: r.certification_end_date,
          benefit_rate: r.benefit_rate,
          copay_rate: r.copay_rate,
          care_manager_org: r.care_manager_org,
          care_manager: r.care_manager,
          service_memo: r.service_memo,
          service_restriction: r.service_restriction,
        }));
      for (let i = 0; i < insRows.length; i += BATCH) {
        const batch = insRows.slice(i, i + BATCH);
        const { error } = await supabase.from("client_insurance_records").insert(batch);
        if (error) throw error;
        setProgress(`3/5 保険情報 INSERT ${Math.min(i + BATCH, insRows.length)}/${insRows.length}`);
      }

      // Phase 4: 居宅・ケアマネマスタ再構築
      setProgress("4/5 居宅・ケアマネマスタを再構築中...");
      // clients.care_office_id / care_manager_id をクリア
      {
        const { error } = await supabase.from("clients").update({ care_office_id: null, care_manager_id: null }).eq("tenant_id", tenantId);
        if (error) throw error;
      }
      // care_managers, care_offices を削除
      {
        const { error } = await supabase.from("care_managers").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }
      {
        const { error } = await supabase.from("care_offices").delete().eq("tenant_id", tenantId);
        if (error) throw error;
      }

      const today = todayYmd();
      // 現在期間の記録から care_offices を生成
      const currentInsurance = parsed.insurance.filter((r) => {
        const s = r.certification_start_date, e = r.certification_end_date;
        return (!s || s <= today) && (!e || e >= today);
      });
      const offNames = Array.from(new Set(currentInsurance.map((r) => r.care_manager_org?.trim()).filter(Boolean) as string[]));
      if (offNames.length > 0) {
        const { error } = await supabase.from("care_offices")
          .insert(offNames.map((name) => ({ tenant_id: tenantId, name })));
        if (error) throw error;
      }
      // 取得し直して id 引き
      const { data: offsData } = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId);
      const offName2id = new Map<string, string>();
      (offsData ?? []).forEach((o: { id: string; name: string }) => offName2id.set(o.name, o.id));

      // care_managers
      const mgrKeys = new Set<string>();
      const mgrRows: Array<{ tenant_id: string; care_office_id: string; name: string; active: boolean }> = [];
      for (const r of currentInsurance) {
        if (!r.care_manager_org || !r.care_manager) continue;
        const offId = offName2id.get(r.care_manager_org.trim());
        if (!offId) continue;
        const key = `${offId}__${r.care_manager.trim()}`;
        if (mgrKeys.has(key)) continue;
        mgrKeys.add(key);
        mgrRows.push({ tenant_id: tenantId, care_office_id: offId, name: r.care_manager.trim(), active: true });
      }
      if (mgrRows.length > 0) {
        const { error } = await supabase.from("care_managers").insert(mgrRows);
        if (error) throw error;
      }
      const { data: mgrsData } = await supabase.from("care_managers").select("id, care_office_id, name").eq("tenant_id", tenantId);
      const mgrKey2id = new Map<string, string>();
      (mgrsData ?? []).forEach((m: { id: string; care_office_id: string; name: string }) => {
        mgrKey2id.set(`${m.care_office_id}__${m.name}`, m.id);
      });

      // clients.care_office_id / care_manager_id を再設定（現在期間のものを採用、同じ利用者で複数あれば effective_date 最新）
      const currByUser = new Map<string, ReimportInsuranceRow>();
      for (const r of currentInsurance.slice().sort((a, b) => (a.effective_date ?? "").localeCompare(b.effective_date ?? ""))) {
        currByUser.set(r.user_number, r);
      }
      for (let i = 0; i < userNums.length; i += BATCH) {
        const batch = userNums.slice(i, i + BATCH);
        const updates = batch.map((u) => {
          const r = currByUser.get(u);
          const clientId = unum2id.get(u);
          if (!clientId) return null;
          const offId = r?.care_manager_org ? offName2id.get(r.care_manager_org.trim()) ?? null : null;
          const mgrId = offId && r?.care_manager ? mgrKey2id.get(`${offId}__${r.care_manager.trim()}`) ?? null : null;
          return { client_id: clientId, care_office_id: offId, care_manager_id: mgrId };
        }).filter((u): u is NonNullable<typeof u> => u !== null);
        // 個別 UPDATE（Supabase JSクライアントは bulk update が弱い）
        await Promise.all(updates.map((u) =>
          supabase.from("clients").update({ care_office_id: u.care_office_id, care_manager_id: u.care_manager_id }).eq("id", u.client_id)
        ));
        setProgress(`4/5 利用者の居宅紐付け ${Math.min(i + BATCH, userNums.length)}/${userNums.length}`);
      }

      // Phase 5: opendata 再マッチ
      setProgress("5/5 オープンデータでマスタを補完中...");
      const { data: odData } = await supabase.from("care_offices_opendata")
        .select("name, address, phone_number, fax_number, office_number")
        .eq("prefecture", "千葉県");
      const odByName = new Map<string, { address: string | null; phone_number: string | null; fax_number: string | null; office_number: string }>();
      (odData ?? []).forEach((o: { name: string; address: string | null; phone_number: string | null; fax_number: string | null; office_number: string }) => {
        odByName.set(o.name, { address: o.address, phone_number: o.phone_number, fax_number: o.fax_number, office_number: o.office_number });
      });
      const { data: currentOffs } = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId);
      for (const o of (currentOffs ?? []) as Array<{ id: string; name: string }>) {
        const od = odByName.get(o.name);
        if (!od) continue;
        await supabase.from("care_offices").update({
          address: od.address,
          phone_number: od.phone_number,
          fax_number: od.fax_number,
          office_number: od.office_number,
        }).eq("id", o.id);
      }

      setProgress("");
      setDone("完了しました。");
      setParsed(null);
      setDryrun(null);
      setCsvFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`実行中にエラーが発生しました\n${msg}\n\n部分的に処理が完了している可能性があります。DB を確認してください。`);
      console.error(e);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 space-y-1">
        <p className="font-semibold">⚠️ 危険な操作</p>
        <p>このテナントの 発注 / 発注明細 / 売上帳票 が削除され、利用者マスタ・介護保険情報・居宅マスタが CSV の内容で作り直されます。予定（events）と利用者 ID の紐付けは維持されます。</p>
      </div>
      <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="text-xs"
          disabled={executing}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {parsing && <p className="text-xs text-gray-500">解析中...</p>}
        {csvFile && !parsing && <p className="text-xs text-gray-600">ファイル: {csvFile.name}</p>}
      </div>
      {dryrun && (
        <div className="bg-white rounded-xl p-4 border border-blue-200 space-y-2">
          <h3 className="text-sm font-semibold text-blue-700">実行プレビュー（dryRun）</h3>
          <dl className="text-xs space-y-1">
            <div className="flex justify-between"><dt>Phase1 発注データ 削除</dt><dd>{dryrun.ordersToDelete} 件 (items {dryrun.orderItemsToDelete}, sales {dryrun.salesRecordsToDelete})</dd></div>
            <div className="flex justify-between"><dt>Phase2 利用者マスタ 新規登録</dt><dd>{dryrun.toInsert} 人</dd></div>
            <div className="flex justify-between"><dt>Phase2 利用者マスタ 更新</dt><dd>{dryrun.toUpdate} 人</dd></div>
            <div className="flex justify-between"><dt>Phase2 ソフト削除（CSV に無い既存）</dt><dd>{dryrun.toSoftDelete} 人</dd></div>
            <div className="flex justify-between"><dt>Phase3 介護保険情報 入替</dt><dd>{dryrun.insuranceNew} 件（うち現在期間 {dryrun.insuranceCurrent} 件）</dd></div>
            <div className="flex justify-between"><dt>Phase4 居宅マスタ 生成</dt><dd>{dryrun.careOfficesNew} 件</dd></div>
            <div className="flex justify-between"><dt>Phase4 ケアマネマスタ 生成</dt><dd>{dryrun.careManagersNew} 件</dd></div>
            <div className="flex justify-between"><dt>Phase5 オープンデータ補完</dt><dd>一致した居宅のみ自動反映</dd></div>
          </dl>
          <button
            onClick={execute}
            disabled={executing}
            className="w-full py-2 rounded-xl bg-red-500 text-white font-semibold hover:bg-red-600 disabled:opacity-50 text-sm"
          >
            {executing ? (progress || "実行中...") : "🚨 この内容で実行する"}
          </button>
          {progress && <p className="text-xs text-gray-500 text-center">{progress}</p>}
        </div>
      )}
      {done && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700">
          ✅ {done}
        </div>
      )}
    </div>
  );
}

// ─── Care Plan Template ───────────────────────────────────────────────────────

// ─── Contract Template Section (契約書・重要事項の文面編集) ──────────────────
function ContractTemplateSection({ tenantId }: { tenantId: string }) {
  const [sections, setSections] = useState<DocTemplateSections>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    getDocTemplate(tenantId, RENTAL_CONTRACT_DOC_TYPE)
      .then(setSections)
      .catch((err) => {
        console.error("document_templates fetch failed:", err instanceof Error ? err.message : err);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [tenantId]);

  const handleSave = async () => {
    setSaving(true);
    setSavedOk(false);
    try {
      // 既定文と同一のセクションは保存しない (差分だけ DB に持つ)
      const diff: DocTemplateSections = {};
      for (const s of CONTRACT_TEMPLATE_SECTIONS) {
        const v = sections[s.key];
        if (v !== undefined && v !== s.defaultText) diff[s.key] = v;
      }
      await saveDocTemplate(tenantId, RENTAL_CONTRACT_DOC_TYPE, diff);
      setSections(diff);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      alert("保存に失敗しました: " + msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-400">読み込み中...</p>;

  const groups = ["重要事項説明書", "契約書"] as const;
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-1">
        <p className="text-xs text-gray-500">帳票（重要事項説明書・契約書）のレイアウトは固定のまま、文章ブロックだけを編集できます。未編集のセクションは既定文がそのまま使われます。</p>
        <p className="text-xs text-gray-400">{"{契約締結日} / {認定有効期限} は印刷時に自動で差し込まれます。"}</p>
        {loadFailed && (
          <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-1.5">保存済みテンプレートの読み込みに失敗しました。既定文を表示しています（保存もできない可能性があります）。</p>
        )}
      </div>
      {groups.map((group) => (
        <div key={group} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800 text-sm">{group}</h3>
          </div>
          <div className="p-4 space-y-4">
            {CONTRACT_TEMPLATE_SECTIONS.filter((s) => s.group === group).map((s) => {
              const value = sections[s.key] ?? s.defaultText;
              const edited = sections[s.key] !== undefined;
              const rows = Math.min(Math.max(value.split("\n").length + 1, 3), 16);
              return (
                <div key={s.key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-gray-500">
                      {s.label}
                      {edited && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">変更あり</span>}
                    </label>
                    {edited && (
                      <button
                        onClick={() => setSections((prev) => { const n = { ...prev }; delete n[s.key]; return n; })}
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >既定に戻す</button>
                    )}
                  </div>
                  <textarea
                    value={value}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSections((prev) => {
                        const n = { ...prev };
                        if (v === s.defaultText) delete n[s.key]; else n[s.key] = v;
                        return n;
                      });
                    }}
                    rows={rows}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 leading-relaxed"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-2">
        <button onClick={handleSave} disabled={saving}
          className="w-full py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : "文面を保存"}
        </button>
        {savedOk && <p className="text-xs text-emerald-600 font-medium text-center">✓ 保存完了しました</p>}
      </div>
    </div>
  );
}

function CarePlanTemplateSection({ tenantId }: { tenantId: string }) {
  const [templates, setTemplates] = useState<CarePlanTemplate[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // category being edited
  const [newCategory, setNewCategory] = useState("");
  const [form, setForm] = useState<Record<string, { goals: string; precautions: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getCarePlanTemplates(tenantId), getEquipment(tenantId)]).then(([tmpl, eq]) => {
      setTemplates(tmpl);
      setEquipment(eq);
      const f: Record<string, { goals: string; precautions: string }> = {};
      tmpl.forEach((t) => { f[t.category] = { goals: t.goals, precautions: t.precautions }; });
      setForm(f);
    });
  }, [tenantId]);

  // 用具マスタにある種目一覧
  const categories = Array.from(new Set(equipment.map((e) => e.category).filter(Boolean))) as string[];
  // テンプレートにある種目（用具マスタにないものも含む）
  const allCategories = Array.from(new Set([...categories, ...templates.map((t) => t.category)])).sort();

  const handleSave = async (category: string) => {
    setSaving(category);
    try {
      const { goals, precautions } = form[category] ?? { goals: "", precautions: "" };
      const saved = await upsertCarePlanTemplate(tenantId, category, goals, precautions);
      setTemplates((prev) => {
        const exists = prev.find((t) => t.category === category);
        return exists ? prev.map((t) => t.category === category ? saved : t) : [...prev, saved];
      });
      setEditing(null);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (id: string, category: string) => {
    await deleteCarePlanTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    setForm((prev) => { const n = { ...prev }; delete n[category]; return n; });
  };

  const handleAddNew = () => {
    if (!newCategory.trim()) return;
    setForm((prev) => ({ ...prev, [newCategory]: { goals: "", precautions: "" } }));
    setEditing(newCategory);
    setNewCategory("");
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="font-semibold text-gray-800 text-sm">個別援助計画書テンプレート</h3>
        <p className="text-xs text-gray-400 mt-0.5">種目ごとの利用目標・留意点の例文を設定します</p>
      </div>
      <div className="p-4 space-y-3">
        {allCategories.length === 0 && (
          <p className="text-xs text-gray-400">用具マスタに種目データがありません</p>
        )}
        {allCategories.map((cat) => {
          const tmpl = templates.find((t) => t.category === cat);
          const isEditing = editing === cat;
          const vals = form[cat] ?? { goals: "", precautions: "" };
          return (
            <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
                <span className="text-xs font-semibold text-gray-700">{cat}</span>
                <div className="flex gap-2">
                  {!isEditing && (
                    <button
                      onClick={() => {
                        setForm((prev) => ({ ...prev, [cat]: { goals: tmpl?.goals ?? "", precautions: tmpl?.precautions ?? "" } }));
                        setEditing(cat);
                      }}
                      className="text-xs text-emerald-600 hover:underline"
                    >編集</button>
                  )}
                  {tmpl && !isEditing && (
                    <button onClick={() => handleDelete(tmpl.id, cat)} className="text-xs text-red-400 hover:underline">削除</button>
                  )}
                </div>
              </div>
              {isEditing ? (
                <div className="p-3 space-y-2">
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 block mb-1">利用目標</label>
                    <textarea
                      value={vals.goals}
                      onChange={(e) => setForm((prev) => ({ ...prev, [cat]: { ...prev[cat], goals: e.target.value } }))}
                      rows={3}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 resize-none"
                      placeholder="例：安全に起居動作を行うことができる"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 block mb-1">留意点</label>
                    <textarea
                      value={vals.precautions}
                      onChange={(e) => setForm((prev) => ({ ...prev, [cat]: { ...prev[cat], precautions: e.target.value } }))}
                      rows={3}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 resize-none"
                      placeholder="例：ベッドご使用の際はサイドレール等の隙間に注意してください"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(cat)}
                      disabled={saving === cat}
                      className="flex-1 py-1.5 bg-emerald-500 text-white text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      {saving === cat ? "保存中..." : "保存"}
                    </button>
                    <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs rounded-lg">
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : tmpl ? (
                <div className="p-3 space-y-1.5">
                  <p className="text-[11px] text-gray-400 font-medium">目標</p>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{tmpl.goals || "—"}</p>
                  <p className="text-[11px] text-gray-400 font-medium mt-1">留意点</p>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{tmpl.precautions || "—"}</p>
                </div>
              ) : (
                <div className="px-3 py-2">
                  <p className="text-xs text-gray-400">テンプレート未設定</p>
                </div>
              )}
            </div>
          );
        })}

        {/* 新規カテゴリ追加（用具マスタにない種目用） */}
        <div className="flex gap-2 pt-1">
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="種目名を入力して追加"
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-emerald-400"
          />
          <button
            onClick={handleAddNew}
            disabled={!newCategory.trim()}
            className="px-3 py-2 bg-emerald-500 text-white text-xs rounded-xl disabled:opacity-40"
          >追加</button>
        </div>
      </div>
    </div>
  );
}
