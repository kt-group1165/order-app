import { supabase } from "./supabase";
import { getTenantById, type Tenant } from "./tenants";
import { invalidateCache } from "./cache";
import type { CompanyInfo } from "@/app/[tenant]/company-info";

// 帳票 (重要事項説明書・契約書・個別援助計画書・選定提案書・貸与報告書 等) の会社欄。
//
// 2026-10-17 まではテナント (グループ) で 1 つの会社情報 (tenants.company_name 等) を使っていたが、
// kt-group テナントにはケア・サポート千葉 (ケイ・ティ・サービス)・リンクス福祉用具 (儀八) など
// 法人も指定番号も違う事業所がある。重要事項説明書には「その事業所」の名前・指定番号・住所・管理者が要る。
// しかもテナント側は未入力で、帳票に「○○福祉用具」「0000000000」が印字されていた。
//
// 値の優先順 (上ほど強い):
//   1. 事業所ごとの設定 offices.doc_company_info (設定タブの「会社情報」で事業所を選んで入力)
//   2. マスタ: 事業所名・指定番号・住所・電話・FAX・管理者 = offices / 法人名 = companies
//   3. グループ共通の設定 tenants.* (従来の値。事業所を選んでいないときの既定)
// どこにも無い項目は空欄 (仮の「○○」は印字しない)。

/** 設定画面・保存で使う形 (tenants の列名と同じ) */
export type CompanyInfoRow = {
  business_number: string;
  company_name: string;
  company_address: string;
  company_tel: string;
  company_fax: string;
  staff_name: string;
  legal_name: string;
  service_area: string;
  business_days: string;
  business_hours: string;
  staff_manager_full: string;
  staff_manager_part: string;
  staff_specialist_full: string;
  staff_specialist_part: string;
  staff_admin_full: string;
  staff_admin_part: string;
};

export const COMPANY_INFO_KEYS: (keyof CompanyInfoRow)[] = [
  "business_number", "company_name", "company_address", "company_tel", "company_fax", "staff_name", "legal_name",
  "service_area", "business_days", "business_hours",
  "staff_manager_full", "staff_manager_part", "staff_specialist_full", "staff_specialist_part", "staff_admin_full", "staff_admin_part",
];

export function emptyCompanyInfoRow(): CompanyInfoRow {
  return Object.fromEntries(COMPANY_INFO_KEYS.map((k) => [k, ""])) as CompanyInfoRow;
}

export function toCompanyInfo(r: CompanyInfoRow): CompanyInfo {
  return {
    businessNumber: r.business_number,
    companyName: r.company_name,
    legalName: r.legal_name,
    companyAddress: r.company_address,
    tel: r.company_tel,
    fax: r.company_fax,
    staffName: r.staff_name,
    serviceArea: r.service_area,
    businessDays: r.business_days,
    businessHours: r.business_hours,
    staffManagerFull: r.staff_manager_full,
    staffManagerPart: r.staff_manager_part,
    staffSpecialistFull: r.staff_specialist_full,
    staffSpecialistPart: r.staff_specialist_part,
    staffAdminFull: r.staff_admin_full,
    staffAdminPart: r.staff_admin_part,
  };
}

type OfficeRow = {
  name: string | null; business_number: string | null; address: string | null; postal_code: string | null;
  phone: string | null; fax: string | null; manager_name: string | null; company_id: string | null;
  doc_company_info?: Partial<CompanyInfoRow> | null;
};

export type ResolvedCompanyInfo = {
  info: CompanyInfo;
  /** 3 層を合わせた値 (設定画面の表示用) */
  row: CompanyInfoRow;
  /** マスタ (+ グループ共通) だけから作った値 = 事業所の設定が空のときに使われる値 */
  base: CompanyInfoRow;
  /** 事業所ごとの設定 (保存されている値) */
  overrides: Partial<CompanyInfoRow>;
  /** 帳票に必要なのに空の項目 (画面で注意を出す) */
  missing: string[];
  /** doc_company_info 列が DB に無い (migration 未適用) */
  columnMissing: boolean;
};

const REQUIRED: [keyof CompanyInfoRow, string][] = [
  ["company_name", "事業所名"], ["business_number", "指定事業所番号"], ["company_address", "所在地"],
  ["company_tel", "電話番号"], ["staff_name", "管理者名"],
];

function nonEmpty(v: string | null | undefined): string | undefined {
  const s = (v ?? "").trim();
  return s ? s : undefined;
}

export async function getOfficeCompanyInfo(tenantId: string, officeId: string | null): Promise<ResolvedCompanyInfo> {
  const tenant: Tenant | null = await getTenantById(tenantId);
  const fromTenant = emptyCompanyInfoRow();
  for (const k of COMPANY_INFO_KEYS) fromTenant[k] = nonEmpty((tenant as Record<string, string | null> | null)?.[k]) ?? "";

  let office: OfficeRow | null = null;
  let columnMissing = false;
  if (officeId) {
    const sel = "name, business_number, address, postal_code, phone, fax, manager_name, company_id";
    const res = await supabase.from("offices").select(`${sel}, doc_company_info`).eq("id", officeId).maybeSingle();
    if (res.error) {
      // 列追加 (office_doc_company_info.sql) の前でも帳票が出るよう、列なしで読み直す
      if (/doc_company_info/.test(res.error.message)) {
        columnMissing = true;
        const r2 = await supabase.from("offices").select(sel).eq("id", officeId).maybeSingle();
        if (r2.error) throw r2.error;
        office = r2.data as OfficeRow | null;
      } else {
        throw res.error;
      }
    } else {
      office = res.data as OfficeRow | null;
    }
  }
  let companyName: string | undefined;
  if (office?.company_id) {
    const { data, error } = await supabase.from("companies").select("name").eq("id", office.company_id).maybeSingle();
    if (error) console.warn("法人名の取得に失敗 (法人名は設定の値を使う):", error.message);
    companyName = nonEmpty((data as { name: string | null } | null)?.name);
  }

  const base: CompanyInfoRow = { ...fromTenant };
  if (office) {
    const addr = nonEmpty(office.address);
    const master: Partial<CompanyInfoRow> = {
      company_name: nonEmpty(office.name),
      business_number: nonEmpty(office.business_number),
      company_address: addr ? `${office.postal_code ? `〒${office.postal_code} ` : ""}${addr}` : undefined,
      company_tel: nonEmpty(office.phone),
      company_fax: nonEmpty(office.fax),
      staff_name: nonEmpty(office.manager_name),
      legal_name: companyName,
    };
    for (const [k, v] of Object.entries(master)) if (v) base[k as keyof CompanyInfoRow] = v;
  }
  const overrides: Partial<CompanyInfoRow> = {};
  for (const [k, v] of Object.entries(office?.doc_company_info ?? {})) {
    if ((COMPANY_INFO_KEYS as string[]).includes(k) && nonEmpty(v as string)) overrides[k as keyof CompanyInfoRow] = (v as string).trim();
  }
  const row: CompanyInfoRow = { ...base, ...overrides };
  const missing = REQUIRED.filter(([k]) => !row[k]).map(([, label]) => label);
  return { info: toCompanyInfo(row), row, base, overrides, missing, columnMissing };
}

/** 事業所ごとの設定を保存する。マスタと同じ値・空欄は保存しない (マスタを直したときに追従させるため) */
export async function saveOfficeCompanyOverrides(officeId: string, edited: CompanyInfoRow, base: CompanyInfoRow): Promise<void> {
  const out: Partial<CompanyInfoRow> = {};
  for (const k of COMPANY_INFO_KEYS) {
    const v = (edited[k] ?? "").trim();
    if (v && v !== base[k]) out[k] = v;
  }
  const { data, error } = await supabase.from("offices").update({ doc_company_info: out }).eq("id", officeId).select("id");
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`保存できませんでした (更新 ${data?.length ?? 0} 件)。事業所を編集する権限を確認してください`);
  invalidateCache(`tenant:`);
}
