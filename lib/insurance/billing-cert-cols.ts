/**
 * 請求タブ (BillingTab / UserBillingTab) が 認定 (client_insurance_records) から読む列 (2026-11-13)。
 *
 * 旧: select("*") で 約 22,500 行 × 56 列 (≒ 36MB) を読んでいた。使うのはここに並べた列だけ。
 * 型 BillingCertRow は Pick で縛ってあるので、画面のコードが ここに無い列を読むと tsc が落ちる。
 * ⚠ lib の関数 (pickCertForMonth / certFieldsForDensou / resolveBenefitForMonth / rowsForOffice) の引数の型は
 *   列が全部「省略可」なので、列を落としても tsc は気づかず 黙って undefined を読む。
 *   → 下の _LIB_COLS_COVERED で「lib の型にある列は全部ここに入っている」ことを型で検査する。
 */
import type { ClientInsuranceRecord } from "../supabase";
import type { CertLike } from "../kokuho-densou/cert-for-month";
import type { CertRowForBenefit } from "./cert-month";

export const BILLING_CERT_COLS = [
  "id", "client_id", "office_id",
  "effective_date", "certification_start_date", "certification_end_date", "certification_status",
  "care_level", "insurer_number", "insurer_name", "insured_number",
  "copay_rate", "benefit_rate", "service_limit_amount",
  "care_office_id",
] as const;

export type BillingCertRow = Pick<ClientInsuranceRecord, (typeof BILLING_CERT_COLS)[number]>;

/** PostgREST の select 文字列 */
export const BILLING_CERT_SELECT = BILLING_CERT_COLS.join(", ");

// lib の関数が読む列 (省略可の列) が 1 つでも欠けたら ここが型エラーになる
type MissingLibCols = Exclude<keyof CertLike | keyof CertRowForBenefit, keyof BillingCertRow>;
export const _LIB_COLS_COVERED: [MissingLibCols] extends [never] ? true : MissingLibCols = true;
