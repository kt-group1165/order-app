// 各種帳票 (モニタリング報告書・提案書等) の会社情報レターヘッド。
// page.tsx と分割後のタブファイル (MonitoringTab 等) 双方から参照するため独立させている。
export type CompanyInfo = {
  businessNumber: string;
  companyName: string;
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
