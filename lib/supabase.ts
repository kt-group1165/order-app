// Phase 3-6: Supabase Auth 化に伴い、browser supabase client は
// @supabase/ssr の createBrowserClient (cookie 連携) に切替。
// 既存の `import { supabase } from "@/lib/supabase"` 互換のため
// re-export shim を維持する。型定義はこのファイル内に残す。
import { createClient } from "@/lib/supabase/client";

export const supabase = createClient();

// 利用者（calendar-appと共有）
export type Client = {
  id: string;
  tenant_id: string;
  office_id: string | null;
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
  // マスタ紐付け（あればこちらを優先、無ければテキストを使用）
  care_office_id: string | null;
  care_manager_id: string | null;
  // 紹介機関（居宅の「紹介者」：地域包括、病院等）
  referrer_org: string | null;
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
  // カレンダー上で自由入力された仮登録。本登録時に false に変わる
  is_provisional: boolean;
  // ソフト削除日時（null なら未削除）
  deleted_at: string | null;
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
  // 認定期間ごとに記録される居宅マスタ／ケアマネマスタの参照（NULL = テキストのみで未紐付け）
  care_office_id: string | null;
  care_manager_id: string | null;
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
  // 用具名のカタカナ読み（音声発注のカナマッチング用）
  furigana: string | null;
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

// 書類タスク (v2: event-driven)
// 1 trigger (発注 / レンタル開始 / 一部解約 / 認定更新) ごとに 1 行 INSERT。
// status='pending' / 'completed' / 'cancelled' で受領管理。
export type DocTaskTriggerType =
  | "order_placed"
  | "rental_started"
  | "partial_termination"
  | "cert_renewal"
  | "plan_change"
  | "care_office_change";

export type DocTaskStatus = "pending" | "completed" | "received" | "cancelled";

export type DocTask = {
  id: string;
  tenant_id: string;
  office_id: string;
  client_id: string;
  trigger_type: DocTaskTriggerType;
  trigger_ref_id: string;
  trigger_ref_table: string;
  trigger_label: string | null;
  trigger_date: string; // YYYY-MM-DD
  expected_doc_type: string;
  status: DocTaskStatus;
  linked_document_id: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  // v3: 受領管理
  received_at: string | null;
  received_by: string | null;
  // v3: 統合 (同 client × 同 expected_doc_type × 14 日以内 のときに source 側にセット)
  merged_into_task_id: string | null;
};

// 個別援助計画書 要素 (発生事象を時系列で蓄積)
// 用具追加/解約・保険情報更新/区分変更/居宅変更を 1 行ずつ INSERT し、UI で
// 複数チェックして 1 計画書にまとめる。doc_tasks とは別系統。
export type CarePlanElementType =
  | "new_delivery"        // 新規納品
  | "additional_delivery" // 追加納品
  | "pickup"              // 回収 (一部解約)
  | "plan_renewal"        // プラン更新 (認定期間満了 → 更新)
  | "plan_change"         // プラン変更 (期間中の区分変更)
  | "care_office_change"; // その他 (居宅介護支援事業所変更)

export type CarePlanElementStatus = "pending" | "completed";

export type CarePlanElement = {
  id: string;
  tenant_id: string;
  office_id: string;
  client_id: string;
  occurred_at: string; // YYYY-MM-DD
  element_type: CarePlanElementType;
  ref_table: string;
  ref_id: string;
  detail: Record<string, unknown>;
  status: CarePlanElementStatus;
  linked_care_plan_id: string | null;
  created_at: string;
  completed_at: string | null;
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
  // 発注統合: 統合元 order の発注情報配列 (空配列 = 未統合)
  merged_from_order_ids: MergedOrderInfo[];
  created_at: string;
  updated_at: string;
};

// 統合元 order の発注情報 (orders.merged_from_order_ids JSONB の各要素)
export type MergedOrderInfo = {
  id: string;
  ordered_at: string | null;
  created_by: string | null;
  status: string | null;
  notes: string | null;
  supplier_id: string | null;
  payment_type: string | null;
  delivery_date: string | null;
  delivery_time: string | null;
  delivery_address: string | null;
  delivery_type: string | null;
  attendance_required: boolean | null;
  attendee_ids: string[] | null;
  tokka_set_price: number | null;
  email_sent_at: string | null;
  email_sent_count: number | null;
  office_id: string | null;
  event_id: string | null;
  client_id: string | null;
  tenant_id: string;
  created_at: string | null;
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
