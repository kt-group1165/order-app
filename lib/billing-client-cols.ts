/**
 * 請求タブ (BillingTab / UserBillingTab) が利用者 (clients) から読む列 (2026-11-13 高速化)。
 * 旧: select("*") 47 列。型 BillingClient は Pick なので、画面がここに無い列を読むと tsc が落ちる。
 * ⚠ 請求タブは利用者を編集・保存しない (読むだけ) ので列を絞ってよい。編集する画面 (ClientsTab の詳細) には使わない。
 */
import type { Client } from "./supabase";

export const BILLING_CLIENT_COLS = [
  "id", "tenant_id", "office_id", "user_number", "name", "furigana",
  "birth_date", "gender", "care_level", "certification_start_date", "certification_end_date",
  "insurer_number", "insured_number", "benefit_rate", "copay_rate",
  "care_office_id", "care_manager", "care_manager_org",
  "address", "phone", "is_facility", "is_provisional", "care_manager_id", "referrer_org",
] as const satisfies readonly (keyof Client)[];

export type BillingClient = Pick<Client, (typeof BILLING_CLIENT_COLS)[number]>;

/** 書類タスク (DocTasksTab) が利用者から読む列。読むだけ (保存は doc_tasks / client_documents のみ) */
export const DOC_TASK_CLIENT_COLS = [
  "id", "tenant_id", "office_id", "user_number", "name", "furigana", "care_level",
  "certification_start_date", "certification_end_date", "is_facility",
] as const satisfies readonly (keyof Client)[];

export type DocTaskClient = Pick<Client, (typeof DOC_TASK_CLIENT_COLS)[number]>;
