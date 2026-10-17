// 各種帳票 (モニタリング報告書・提案書等) の会社情報レターヘッド。
// page.tsx と分割後のタブファイル (MonitoringTab 等) 双方から参照するため独立させている。
export type CompanyInfo = {
  businessNumber: string;
  companyName: string;
  /** 法人名 (重要事項説明書・契約書の「事業者名」)。無ければ companyName を使う */
  legalName?: string;
  /** 適格請求書発行事業者の登録番号 (T + 13 桁)。請求書・領収書に出す */
  invoiceNumber?: string;
  companyAddress: string;
  tel: string;
  fax: string;
  staffName: string;
  serviceArea: string;
  businessDays: string;
  businessHours: string;
  staffManagerFull: string;
  staffManagerPart: string;
  staffSpecialistFull: string;
  staffSpecialistPart: string;
  staffAdminFull: string;
  staffAdminPart: string;
};

export const COMPANY_INFO_DEFAULTS: CompanyInfo = {
  businessNumber: "0000000000",
  companyName: "○○福祉用具",
  companyAddress: "○○県○○市○○1-2-3",
  tel: "000-0000-0000",
  fax: "000-0000-0001",
  staffName: "担当者",
  serviceArea: "",
  businessDays: "月〜土（祝日除く）",
  businessHours: "9:00〜17:00",
  staffManagerFull: "",
  staffManagerPart: "",
  staffSpecialistFull: "",
  staffSpecialistPart: "",
  staffAdminFull: "",
  staffAdminPart: "",
};
