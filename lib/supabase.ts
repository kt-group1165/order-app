import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 利用者（calendar-appと共有）
export type Client = {
  id: string;
  tenant_id: string;
  user_number: string | null;
  name: string;
  furigana: string | null;
  phone: string | null;
  mobile: string | null;
  address: string | null;
  gender: string | null;
  care_level: string | null;
  benefit_rate: string | null;
  care_manager: string | null;
  care_manager_org: string | null;
  certification_end_date: string | null;
  memo: string | null;
  // 保険情報（clientsテーブルにも再追加済み。最新値をキャッシュ）
  insured_number: string | null;
  birth_date: string | null;
  certification_start_date: string | null;
  insurer_number: string | null;
  copay_rate: string | null;
  public_expense: string | null;
  // 居宅・施設等フラグ（事業所/施設の場合 true、個人利用者は false）
  is_facility: boolean;
  created_at: string;
};

// 保険情報レコード（利用者1人に対して複数）
export type ClientInsuranceRecord = {
  id: string;
  tenant_id: string;
  client_id: string;
  effective_date: string | null;
  insured_number: string | null;
  birth_date: string | null;
  care_level: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  insurer_name: string | null;
  insurer_number: string | null;
  copay_rate: string | null;
  public_expense: string | null;
  care_manager: string | null;
  care_manager_org: string | null;
  notes: string | null;
  // 追加フィールド
  issued_date: string | null;
  insurance_confirmed_date: string | null;
  qualification_date: string | null;
  insurance_valid_start: string | null;
  insurance_valid_end: string | null;
  certification_date: string | null;
  certification_status: string | null;
  service_limit_period_start: string | null;
  service_limit_period_end: string | null;
  service_limit_amount: number | null;
  service_memo: string | null;
  service_restriction: string | null;
  benefit_type: string | null;
  benefit_content: string | null;
  benefit_rate: string | null;
  benefit_period_start: string | null;
  benefit_period_end: string | null;
  support_office_date: string | null;
  record_status: string | null;
  created_at: string;
};

// レンタル履歴（手動登録）
export type ClientRentalHistory = {
  id: string;
  tenant_id: string;
  client_id: string;
  equipment_name: string;
  model_number: string | null;
  start_date: string | null;
  end_date: string | null;
  monthly_price: number | null;
  notes: string | null;
  source: string;
  created_at: string;
};

// 入退院管理
export type ClientHospitalization = {
  id: string;
  tenant_id: string;
  client_id: string;
  admission_date: string;   // 入院日 (YYYY-MM-DD)
  discharge_date: string | null; // 退院日 (null = 現在入院中)
  notes: string | null;
  created_at: string;
};

// 用具マスタ
export type Equipment = {
  id: string;
  tenant_id: string;
  product_code: string;
  tais_code: string | null;
  name: string;
  category: string | null;
  rental_price: number | null;
  national_avg_price: number | null;
  price_limit: number | null;
  selection_reason: string | null;
  proposal_reason: string | null;
  comparison_product_codes: string[];
  created_at: string;
  updated_at: string;
  sort_order: number | null;
};

// 卸会社
export type Supplier = {
  id: string;
  name: string;
  email: string | null;
  memo: string | null;
  created_at: string;
};

// 仕入れ価格
export type EquipmentPrice = {
  id: string;
  tenant_id: string;
  product_code: string;
  supplier_id: string;
  purchase_price: number;
  updated_at: string;
};

// 価格改定履歴
export type EquipmentPriceHistory = {
  id: string;
  tenant_id: string;
  product_code: string;
  rental_price: number;
  valid_from: string; // DATE "YYYY-MM-DD"
  created_at: string;
};

// 担当者（calendar-appと共有）
export type Member = {
  id: string;
  tenant_id: string;
  name: string;
  color: string;
  sort_order: number | null;
  created_at: string;
};

// 個別援助計画書テンプレート（種目別）
export type CarePlanTemplate = {
  id: string;
  tenant_id: string;
  category: string;
  goals: string;
  precautions: string;
  created_at: string;
  updated_at: string;
};

// 利用者書類履歴
export type ClientDocument = {
  id: string;
  tenant_id: string;
  client_id: string;
  type: string; // 'rental_report' など
  title: string;
  params: Record<string, unknown>;
  created_at: string;
};

// 発注
export type Order = {
  id: string;
  tenant_id: string;
  client_id: string | null;
  event_id: string | null;
  ordered_at: string;
  created_by: string | null;
  status: "ordered" | "completed" | "cancelled";
  notes: string | null;
  payment_type: "介護" | "自費" | "特価自費";
  delivery_date: string | null;
  delivery_time: string | null;
  delivery_address: string | null;
  delivery_type: "直納" | "自社納品";
  attendance_required: boolean;
  attendee_ids: string[];
  supplier_id: string | null;
  email_sent_at: string | null;
  email_sent_count: number;
  tokka_set_price: number | null;
  office_id: string | null;
  created_at: string;
  updated_at: string;
};

// 発注明細
export type OrderItem = {
  id: string;
  order_id: string;
  tenant_id: string;
  product_code: string;
  supplier_id: string | null;
  purchase_price: number | null;
  rental_price: number | null;
  payment_type: "介護" | "自費" | "特価自費" | null;
  status: "ordered" | "delivered" | "trial" | "rental_started" | "cancelled" | "terminated";
  quantity: number;
  rental_start_decided_at: string | null;
  rental_start_date: string | null;
  rental_end_date: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  notes: string | null;
  tokka_group: string | null;
  tokka_group_price: number | null;
  created_at: string;
  updated_at: string;
};

// モニタリング記録
export type MonitoringRecord = {
  id: string;
  tenant_id: string;
  client_id: string;
  visit_date: string | null;
  target_month: string | null;
  report_date: string | null;
  staff_name: string | null;
  continuity_comment: string | null;
  report_comment: string | null;
  previous_comment: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

// 公費情報（生活保護等）
export type ClientPublicExpense = {
  id: string;
  tenant_id: string;
  client_id: string;
  hohei_code: string | null;       // 法制コード
  futan_sha_number: string | null; // 負担者番号
  jukyu_sha_number: string | null; // 受給者番号
  valid_start: string | null;      // 有効期間開始日
  valid_end: string | null;        // 有効期間終了日
  confirmed_date: string | null;   // 確認日
  application_type: string | null; // 申請区分
  outpatient_copay: number | null; // 外来負担金
  special_type: string | null;     // 特別区分
  inpatient_copay: number | null;  // 入院負担金
  created_at: string;
};

// モニタリング用具チェック
export type MonitoringItem = {
  id: string;
  monitoring_id: string;
  tenant_id: string;
  order_item_id: string | null;
  product_code: string;
  equipment_name: string | null;
  category: string | null;
  quantity: number;
  no_issue: boolean;
  has_malfunction: boolean;
  has_deterioration: boolean;
  needs_replacement: boolean;
  created_at: string;
};
