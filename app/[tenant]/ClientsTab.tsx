"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { ChevronRight, ChevronLeft, Search, X, Plus, Loader2, Send, FileText, Trash2, RotateCcw } from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member, EquipmentPriceHistory, ClientDocument, ClientInsuranceRecord, ClientRentalHistory, ClientHospitalization } from "@/lib/supabase";
import { getClientDocuments, deleteClientDocument } from "@/lib/documents";
import { mapWithConcurrency } from "@/lib/concurrency";
import { monthEndYmd, todayYmd } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { getOfficeCompanyInfo } from "@/lib/officeCompanyInfo";
import { type CareOfficeChoice } from "./SendRentalReportModal";
import { HW_KANA, matchClient } from "./search-utils";
import { KANA_ROWS } from "./kana-rows";
import { STATUS_LABEL, STATUS_COLOR, NEXT_STATUSES } from "./order-item-helpers";
import CarePlanModal from "./CarePlanModal";
import ProposalModal from "./ProposalModal";
import ContractDocumentsModal from "./ContractDocumentsModal";
import RentalReportModal from "./RentalReportModal";
import OrderEmailPreviewModal from "./OrderEmailPreviewModal";
import NewOrderModal from "./NewOrderModal";
import { getOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, getMembers } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory, getPriceForMonth } from "@/lib/equipment";
import { getClients, promoteProvisionalClient, softDeleteClient, restoreClient } from "@/lib/clients";
import { getTenantById, type Tenant } from "@/lib/tenants";
import { selectAllPagedParallel } from "@/lib/pagedParallel";
import {
  getOffices, getClientOfficeAssignments, getClientAssignmentsForClient,
  ensureActiveAssignment, closeActiveAssignment, addAssignment, updateAssignment, deleteAssignment,
  type Office, type ClientOfficeAssignment,
} from "@/lib/offices";
import { getMaxUserNumber } from "@kt/shared/user-number";

// ─── Clients Tab ─────────────────────────────────────────────────────────────

export default function ClientsTab({ tenantId, currentOfficeId, officeViewAll, onOfficeViewAllChange, initialClientId, onClearInitialClient }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean; onOfficeViewAllChange?: (value: boolean) => void; initialClientId?: string | null; onClearInitialClient?: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [kanaFilter, setKanaFilter] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedClientInitialViewMode, setSelectedClientInitialViewMode] = useState<"current" | "insurance" | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"list" | "insurance" | "history">("list");
  const [allInsuranceRecords, setAllInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [newOrderClient, setNewOrderClient] = useState<Client | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ inserted: { name: string; user_number: string }[]; updated: { name: string; user_number: string }[]; merged: { name: string; user_number: string }[]; errors: { name: string; user_number: string; message: string }[]; reunited: number; insuranceAdded: number; addedOffices: number; addedManagers: number } | null>(null);
  // 取込前のプレビュー（差分・警告を確認してから実行）
  type ImportFieldDiff = { label: string; oldValue: string; newValue: string };
  type ImportWarningKind = "deleted_revival" | "provisional_promotion" | "referrer_lost" | "care_office_unlinked" | "care_manager_unlinked";
  type ProvisionalCandidate = {
    id: string;
    user_number: string | null;
    name: string;
    address: string | null;
    phone: string | null;
    matchKind: "exact_name" | "surname" | "address";
  };
  type ImportPreviewRow = {
    user_number: string;
    name: string;
    status: "new" | "unchanged" | "updated";
    diffs: ImportFieldDiff[];
    warnings: ImportWarningKind[];
    // 実行時に使う元データ。memo は CSV インポート経路では扱わない（client_memos へ移行済）
    data: Omit<Client, "id" | "created_at" | "memo">;
    existingId: string | null;
    insurance: Array<Record<string, unknown>>;
    // 新規行のみ：仮登録の候補と、ユーザーがマージ先として選んだID
    provisionalCandidates: ProvisionalCandidate[];
    mergeWithProvisionalId: string | null;
  };
  // CSV内に登場するがマスタ未登録の事業所・ケアマネ
  type UnregisteredOffice = {
    name: string;            // CSVテキスト
    addToMaster: boolean;    // マスタに追加するか
    occurrences: number;     // 何件の利用者・履歴で使われているか
  };
  type UnregisteredManager = {
    name: string;            // CSVテキスト
    officeName: string;      // 所属事業所名（テキスト）
    addToMaster: boolean;
    occurrences: number;
  };
  // CSVテキスト → 既存マスタID のマップ（プレビュー時点で確定する分）
  type MasterMatchMaps = {
    officeNameToId: Record<string, string>;        // care_offices.name → id
    managerKeyToId: Record<string, string>;        // `${officeId}|${manager.name}` → id
  };
  type ImportPreview = {
    rows: ImportPreviewRow[];
    skippedLines: { reason: string; line: string }[];
    insuranceCount: number;
    unregisteredOffices: UnregisteredOffice[];
    unregisteredManagers: UnregisteredManager[];
    matchMaps: MasterMatchMaps;
  };
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [hospitalizations, setHospitalizations] = useState<ClientHospitalization[]>([]);
  const [hospLoading, setHospLoading] = useState<string | null>(null); // client.id being toggled
  const [hospFilter, setHospFilter] = useState(false);
  // 仮登録のみ表示フィルタ
  const [provisionalFilter, setProvisionalFilter] = useState(false);
  // ゴミ箱フィルタ（削除済みのみ表示）
  const [trashFilter, setTrashFilter] = useState(false);
  // 新規利用者追加モーダル
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientForm, setNewClientForm] = useState({ name: "", furigana: "", phone: "", mobile: "", address: "" });
  const [addingClient, setAddingClient] = useState(false);
  const [hospModalMonth, setHospModalMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  // 紐付け候補モーダル用のステート（フックなので early return より前に配置）
  const [similarProvisionalCandidates, setSimilarProvisionalCandidates] = useState<Client[] | null>(null);
  // 入退院日付入力ダイアログ
  const [hospDateDialog, setHospDateDialog] = useState<{ client: Client; mode: "admit" | "discharge"; currentHospId?: string } | null>(null);
  const [hospDateInput, setHospDateInput] = useState(() => todayYmd());
  // 実績表
  const [showJissekiModal, setShowJissekiModal] = useState(false);
  const [jissekiMonth, setJissekiMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [jissekiCmKey, setJissekiCmKey] = useState<string>("__ALL__"); // プレビュー対象（単独）
  const [jissekiSelectedKeys, setJissekiSelectedKeys] = useState<Set<string>>(new Set()); // チェック済みキー
  const [jissekiRentals, setJissekiRentals] = useState<ClientRentalHistory[]>([]);
  const [jissekiLoading, setJissekiLoading] = useState(false);
  const [jissekiPreview, setJissekiPreview] = useState(false);
  // 半額・日割・保留フラグ（rowKey → flags）
  const [jissekiFlags, setJissekiFlags] = useState<Record<string, { half: boolean; daily: boolean; hold: boolean }>>({});
  // テナント（自社）情報
  const [tenantInfo, setTenantInfo] = useState<Tenant | null>(null);
  const [clientOfficeMap, setClientOfficeMap] = useState<Set<string>>(new Set()); // 自事業所の利用者IDセット

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Phase 8: office filter (officeViewAll=false 時)
        const officeFilter = officeViewAll ? null : currentOfficeId;
        const [c, items, eq, ords, sup, mem, hospRes, tenant, assignments, allInsur] = await Promise.all([
          getClients(tenantId, { onlyDeleted: trashFilter, officeId: officeFilter }),
          getAllOrderItemsByTenant(tenantId),
          getEquipment(tenantId),
          getOrders(tenantId, officeFilter),
          getSuppliers(),
          getMembers(tenantId),
          // ⚠ 入院データは **単位数計算 (半月ルール・入院控除) に流れる**ので
          //   1000 行で切れると請求額が狂う。同ファイル内の請求タブ側は
          //   fetchAllPaged を使っており、ここだけ素の select だった (2026-08-31 是正)。
          (async () => {
            const PAGE = 1000;
            const all: ClientHospitalization[] = [];
            for (let from = 0; ; from += PAGE) {
              const { data, error } = await supabase
                .from("client_hospitalizations")
                .select("*")
                .eq("tenant_id", tenantId)
                .order("admission_date", { ascending: false })
                .order("id")
                .range(from, from + PAGE - 1);
              if (error) throw error;
              all.push(...((data ?? []) as ClientHospitalization[]));
              if (!data || data.length < PAGE) break;
            }
            return all;
          })(),
          getTenantById(tenantId),
          getClientOfficeAssignments(tenantId),
          // 保険レコード (約 19,000 行)。以前は上の読み込みが全部終わってから 1000 行ずつ直列に読み、
          // 並び順が effective_date だけ (同じ日付が大量にある) でページの境目の行が抜け・重なりうる状態で、
          // エラーも見ていなかった (2026-10-21 是正)。id を二次キーにして、件数を聞いてページ並列に読む。
          selectAllPagedParallel<ClientInsuranceRecord>(
            () => supabase.from("client_insurance_records").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
            (from, to) => supabase
              .from("client_insurance_records")
              .select("*")
              .eq("tenant_id", tenantId)
              .order("effective_date", { ascending: false })
              .order("id")
              .range(from, to),
          ),
        ]);
        setClients(c);
        setOrderItems(items);
        setEquipment(eq);
        setOrders(ords);
        setSuppliers(sup);
        setMembers(mem);
        setHospitalizations(hospRes);
        setTenantInfo(tenant);
        // 事業所別利用者マップ
        if (currentOfficeId) {
          const assigned = new Set(assignments.filter(a => a.office_id === currentOfficeId).map(a => a.client_id));
          setClientOfficeMap(assigned);
        }
        setAllInsuranceRecords(allInsur);
        if (initialClientId) {
          const target = c.find((cl) => cl.id === initialClientId);
          if (target) setSelectedClient(target);
          onClearInitialClient?.();
        }
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [tenantId, trashFilter, currentOfficeId, officeViewAll]);

  // ⚡ パフォーマンス最適化：Map ルックアップ（O(N) → O(1)）
  // 注意: フックの順序を保つため、必ず早期 return より前に置くこと
  const orderById = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);
  const equipmentByCode = useMemo(() => {
    const m = new Map<string, Equipment>();
    for (const e of equipment) m.set(e.product_code, e);
    return m;
  }, [equipment]);
  const clientById = useMemo(() => {
    const m = new Map<string, Client>();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);

  // 入院フィルター用
  const hospFilteredIds = useMemo(() => {
    if (!hospFilter) return null;
    const [year, month] = hospModalMonth.split("-").map(Number);
    const firstDay = `${hospModalMonth}-01`;
    const lastDay = monthEndYmd(year, month);
    return new Set(
      hospitalizations
        .filter(h => h.admission_date <= lastDay && (h.discharge_date === null || h.discharge_date >= firstDay))
        .map(h => h.client_id)
    );
  }, [hospFilter, hospModalMonth, hospitalizations]);

  const filtered = useMemo(() => clients
    .filter((c) => {
      // 事業所フィルタ（自事業所のみモードの場合）
      if (currentOfficeId && !officeViewAll && clientOfficeMap.size > 0 && !clientOfficeMap.has(c.id)) return false;
      // 仮登録のみ表示
      if (provisionalFilter && !c.is_provisional) return false;
      if (hospFilter) return hospFilteredIds!.has(c.id);
      if (kanaFilter) {
        const row = KANA_ROWS.find((r) => r.label === kanaFilter);
        // ひらがな→カタカナ変換してから比較
        const toKata = (s: string) =>
          s.normalize("NFC")
           .replace(/[ｦ-ﾟ]/g, (ch) => HW_KANA[ch] ?? ch)          // 半角カナ→全角
           .replace(/[\u3041-\u3096]/g, (ch) =>                     // ひらがな→カタカナ
             String.fromCharCode(ch.charCodeAt(0) + 0x60));
        const first = toKata((c.furigana ?? "").trim().charAt(0));
        if (row && (!first || !row.chars.includes(first))) return false;
      }
      return matchClient(c, search);
    })
    // 事業所・施設は末尾、個人利用者は先頭。各ブロック内はフリガナ順
    .sort((a, b) => {
      const fa = a.is_facility ? 1 : 0;
      const fb = b.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
    }),
    [clients, currentOfficeId, officeViewAll, clientOfficeMap, provisionalFilter, hospFilter, hospFilteredIds, kanaFilter, search]);

  // 変更履歴を生成（Mapルックアップで O(N²) → O(N) に、useMemoで再描画時再実行しない）
  // 注意: 早期 return より前に置くこと（フックの順序を保つ）
  const changeHistory = useMemo(() => {
    type ChangeEvent = { date: string; clientId: string; equipName: string; label: string; color: string };
    const events: ChangeEvent[] = [];
    for (const item of orderItems) {
      const order = orderById.get(item.order_id);
      if (!order?.client_id) continue;
      const eq = equipmentByCode.get(item.product_code);
      const name = eq?.name ?? item.product_code;
      if (item.delivered_at) events.push({ date: item.delivered_at.slice(0, 10), clientId: order.client_id, equipName: name, label: "納品", color: "text-blue-600 bg-blue-50" });
      if (item.rental_start_date) events.push({ date: item.rental_start_date, clientId: order.client_id, equipName: name, label: "レンタル開始", color: "text-emerald-600 bg-emerald-50" });
      if (item.rental_end_date) events.push({ date: item.rental_end_date, clientId: order.client_id, equipName: name, label: "解約", color: "text-red-500 bg-red-50" });
      if (item.cancelled_at) events.push({ date: item.cancelled_at.slice(0, 10), clientId: order.client_id, equipName: name, label: "キャンセル", color: "text-gray-500 bg-gray-100" });
    }
    events.sort((a, b) => b.date.localeCompare(a.date));
    // 利用者ごとにグループ化
    const map = new Map<string, ChangeEvent[]>();
    for (const e of events) {
      if (!map.has(e.clientId)) map.set(e.clientId, []);
      map.get(e.clientId)!.push(e);
    }
    return Array.from(map.entries())
      .map(([clientId, evts]) => ({ client: clientById.get(clientId), events: evts }))
      .filter((g) => g.client)
      .sort((a, b) => (b.events[0]?.date ?? "").localeCompare(a.events[0]?.date ?? ""));
  }, [orderItems, orderById, equipmentByCode, clientById]);

  // 全フック呼び出し済み。ここから早期 return が安全に使える ─────────────
  if (selectedClient) {
    return (
      <ClientDetail
        client={selectedClient}
        allOrderItems={orderItems}
        equipment={equipment}
        tenantId={tenantId}
        currentOfficeId={currentOfficeId}
        initialViewMode={selectedClientInitialViewMode}
        hospitalizations={hospitalizations}
        onBack={() => { setSelectedClient(null); setSelectedClientInitialViewMode(undefined); }}
      />
    );
  }

  // Count active rentals per client
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const activeCount = (clientId: string) =>
    orderItems.filter(
      (i) => i.status === "rental_started"
    ).length; // simplified — real app would join through orders

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  const CSV_HEADERS = ["利用者番号", "氏名", "ふりがな", "電話番号", "携帯番号", "住所", "介護度", "給付率", "ケアマネ名", "ケアマネ事業所", "認定終了日", "メモ", "居宅・施設等"];

  const handleExportCSV = () => {
    const rows = clients.map((c) => [
      c.user_number ?? "", c.name, c.furigana ?? "",
      c.phone ?? "", c.mobile ?? "", c.address ?? "",
      c.care_level ?? "", c.benefit_rate ?? "",
      c.care_manager ?? "", c.care_manager_org ?? "",
      c.certification_end_date ?? "", c.memo ?? "",
      c.is_facility ? "1" : "",
    ]);
    const csvText = [CSV_HEADERS, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `利用者一覧_${todayYmd()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 似た仮登録の検出（姓か住所が一致していれば候補）
  function findSimilarProvisionals(name: string, address: string): Client[] {
    const nameTrim = name.trim();
    const addrTrim = address.trim();
    if (!nameTrim && !addrTrim) return [];
    // 姓（先頭のスペースまでの文字列）を比較対象にする
    const surname = nameTrim.split(/[\s　]/)[0];
    return clients.filter((c) => {
      if (!c.is_provisional) return false;
      const cName = c.name ?? "";
      const cAddr = c.address ?? "";
      // 完全一致 / 姓一致 / 住所部分一致のいずれか
      if (nameTrim && cName === nameTrim) return true;
      if (surname && surname.length >= 1 && cName.startsWith(surname)) return true;
      if (addrTrim && cAddr && (cAddr.includes(addrTrim) || addrTrim.includes(cAddr))) return true;
      return false;
    });
  }

  // 実際に新規利用者を作成する処理（紐付けなし or 紐付け確認後）
  const insertFreshClient = async () => {
    // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
    // 旧実装は in-memory clients から reduce していたが、別 app（kaigo-app/calendar-app）
    // で同 tenant に追加された行を反映できなかった。DB クエリにすることで堅牢化。
    const maxNum = await getMaxUserNumber(supabase, tenantId);
    const { data: inserted, error } = await supabase.from("clients").insert({
      tenant_id: tenantId,
      user_number: String(maxNum + 1),
      name: newClientForm.name.trim(),
      furigana: newClientForm.furigana.trim() || null,
      phone: newClientForm.phone.trim() || null,
      mobile: newClientForm.mobile.trim() || null,
      address: newClientForm.address.trim() || null,
      is_provisional: false,
    }).select().single();
    if (error) throw error;
    if (currentOfficeId && inserted) {
      // 利用者は登録済みなので throw しない (「追加に失敗」と出すと二重登録を招く)。紐付けの失敗だけ知らせる
      const { error: asgErr } = await supabase.from("client_office_assignments").upsert({
        tenant_id: tenantId,
        client_id: inserted.id,
        office_id: currentOfficeId,
      }, { onConflict: "tenant_id,client_id,office_id" });
      if (asgErr) {
        console.error("事業所への紐付けに失敗:", asgErr.message);
        alert(`利用者は登録しましたが、自事業所への紐付けに失敗しました (一覧の「自事業所」に出ません): ${asgErr.message}`);
      } else {
        setClientOfficeMap((prev) => new Set([...prev, inserted.id]));
      }
    }
  };

  // 仮登録を本登録化する（その場で編集扱い、UUIDは維持）
  const promoteProvisional = async (provisionalId: string) => {
    // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
    const maxNum = await getMaxUserNumber(supabase, tenantId);
    await promoteProvisionalClient(provisionalId, {
      user_number: String(maxNum + 1),
      name: newClientForm.name.trim(),
      furigana: newClientForm.furigana.trim() || null,
      phone: newClientForm.phone.trim() || null,
      mobile: newClientForm.mobile.trim() || null,
      address: newClientForm.address.trim() || null,
    });
    if (currentOfficeId) {
      // 本登録化は済んでいるので throw しない。紐付けの失敗だけ知らせる
      const { error: asgErr } = await supabase.from("client_office_assignments").upsert({
        tenant_id: tenantId,
        client_id: provisionalId,
        office_id: currentOfficeId,
      }, { onConflict: "tenant_id,client_id,office_id" });
      if (asgErr) {
        console.error("事業所への紐付けに失敗:", asgErr.message);
        alert(`本登録は済みましたが、自事業所への紐付けに失敗しました (一覧の「自事業所」に出ません): ${asgErr.message}`);
      } else {
        setClientOfficeMap((prev) => new Set([...prev, provisionalId]));
      }
    }
  };

  const handleAddNewClient = async () => {
    if (!newClientForm.name.trim()) return;
    // 類似仮登録が無いか確認
    const similar = findSimilarProvisionals(newClientForm.name, newClientForm.address);
    if (similar.length > 0) {
      setSimilarProvisionalCandidates(similar);
      return;
    }
    setAddingClient(true);
    try {
      await insertFreshClient();
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
    } catch (e) {
      alert("利用者の追加に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
  };

  // 紐付けモーダルから選択: その仮登録を本登録化して終了
  const handleLinkToProvisional = async (provisionalId: string) => {
    setAddingClient(true);
    try {
      await promoteProvisional(provisionalId);
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
      setSimilarProvisionalCandidates(null);
    } catch (e) {
      alert("本登録に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
  };

  // 紐付けモーダルから「別人として新規作成」を選んだ場合
  const handleSkipProvisionalLink = async () => {
    setAddingClient(true);
    try {
      await insertFreshClient();
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
      setSimilarProvisionalCandidates(null);
    } catch (e) {
      alert("利用者の追加に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
  };

  const parseCsvRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { result.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    result.push(cur);
    return result;
  };

  const handleImportCSV = async (file: File) => {
    setImporting(true);
    try {
      // エンコーディング判定：UTF-8 BOMがあればUTF-8、無ければShift-JISを試す
      //   介護ソフト出力CSVはShift-JISが多いが、order-app自身の出力はUTF-8 BOM付き
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      let text: string;
      if (hasUtf8Bom) {
        text = new TextDecoder("utf-8").decode(buffer);
      } else {
        // Shift-JIS で試す。変換不能文字（U+FFFD）が多ければ UTF-8 フォールバック
        const sjisText = new TextDecoder("shift-jis", { fatal: false }).decode(buffer);
        const replacementCount = (sjisText.match(/\uFFFD/g) ?? []).length;
        if (replacementCount > 5) {
          text = new TextDecoder("utf-8").decode(buffer);
        } else {
          text = sjisText;
        }
      }
      const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
      if (lines.length < 2) return;
      const headers = parseCsvRow(lines[0]);
      // ヘッダー別名対応：calendar-app や介護ソフト由来のヘッダー名も受け付ける
      const headerAliases: Record<string, string[]> = {
        "利用者番号": ["利用者番号"],
        "氏名": ["氏名", "利用者名"],
        "姓": ["利用者名（姓）", "姓"],
        "名": ["利用者名（名）", "名"],
        "ふりがな": ["ふりがな", "フリガナ"],
        "フリガナ姓": ["フリガナ（姓）"],
        "フリガナ名": ["フリガナ（名）"],
        "性別": ["性別"],
        "居宅・施設等": ["居宅・施設等", "事業所フラグ", "施設フラグ"],
        "電話番号": ["電話番号"],
        "携帯番号": ["携帯番号"],
        "住所": ["住所"],
        "介護度": ["介護度", "要介護度"],
        "給付率": ["給付率"],
        "ケアマネ名": ["ケアマネ名", "担当ケアマネジャー"],
        "ケアマネ事業所": ["ケアマネ事業所", "支援事業所（正式名称）", "支援事業所"],
        "認定終了日": ["認定終了日", "認定有効期間－終了日"],
        "メモ": ["メモ"],
        "被保険者番号": ["被保険者番号"],
        "生年月日": ["生年月日"],
        "認定開始日": ["認定開始日", "認定有効期間－開始日"],
        "保険者番号": ["保険者番号"],
        "利用者負担割合": ["利用者負担割合"],
        "公費負担情報": ["公費負担情報"],
        // 介護保険画面で表示する項目用
        "保険者名": ["保険者", "保険者名"],
        "交付年月日": ["交付年月日"],
        "保険証確認日": ["確認日", "保険証確認日"],
        "資格取得日": ["資格取得日"],
        "保険証有効開始日": ["有効開始日"],
        "保険証有効終了日": ["有効終了日"],
        "認定年月日": ["認定年月日"],
        "認定状況": ["認定状況"],
        "居宅適用期間開始": ["適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"],
        "居宅適用期間終了": ["適用期間－終了日（居宅ｻｰﾋﾞｽ区分）"],
        "区分支給限度額": ["区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"],
        "留意事項": ["留意事項"],
        "サービス限定": ["サービス限定"],
      };
      const col = (canonicalName: string): number => {
        const aliases = headerAliases[canonicalName] ?? [canonicalName];
        for (const alias of aliases) {
          const idx = headers.indexOf(alias);
          if (idx >= 0) return idx;
        }
        return -1;
      };

      // DB から最新の利用者を直接取得（in-memory state が 1000件制限でstaleな可能性があるため）
      // 差分検出に必要なフィールドも一緒に取得（プレビュー用）
      type FreshClient = {
        id: string;
        user_number: string | null;
        name: string | null;
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
        insured_number: string | null;
        birth_date: string | null;
        certification_start_date: string | null;
        insurer_number: string | null;
        copay_rate: string | null;
        public_expense: string | null;
        is_facility: boolean | null;
        is_provisional: boolean | null;
        deleted_at: string | null;
        referrer_org: string | null;
        care_office_id: string | null;
        care_manager_id: string | null;
      };
      const freshClients: FreshClient[] = [];
      {
        const PAGE = 1000;
        let from = 0;
        while (true) {
          const { data } = await supabase
            .from("clients")
            // memo は DROP 済（client_memos に移行）。型互換のため後で undefined を許容。
            .select("id,user_number,name,furigana,phone,mobile,address,gender,care_level,benefit_rate,care_manager,care_manager_org,certification_end_date,insured_number,birth_date,certification_start_date,insurer_number,copay_rate,public_expense,is_facility,is_provisional,deleted_at,referrer_org,care_office_id,care_manager_id")
            .eq("tenant_id", tenantId)
            .order("id").range(from, from + PAGE - 1);
          if (!data || data.length === 0) break;
          freshClients.push(...(data as FreshClient[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }
      const existingByUserNumber = new Map(freshClients.filter(c => c.user_number).map(c => [c.user_number as string, c]));

      const maxNum = freshClients.reduce((mx, c) => {
        const n = parseInt(c.user_number ?? "0");
        return isNaN(n) ? mx : Math.max(mx, n);
      }, 0);
      let nextNum = maxNum + 1;

      const skipped: { reason: string; line: string }[] = [];
      // clients テーブル用: user_number で集約（認定終了日が最新のものを採用）
      // memo は clients から DROP 済（client_memos へ移行）。CSV インポート経路では扱わない
      type ClientData = Omit<Client, "id" | "created_at" | "memo">;
      const clientByUserNumber = new Map<string, ClientData>();
      // 保険情報履歴: 1利用者に複数行（認定期間ごと）を蓄積
      // 画面（介護保険タブ）で表示する項目のみ
      type InsuranceData = {
        insured_number: string | null;
        birth_date: string | null;
        insurer_number: string | null;
        insurer_name: string | null;
        issued_date: string | null;
        insurance_confirmed_date: string | null;
        qualification_date: string | null;
        insurance_valid_start: string | null;
        insurance_valid_end: string | null;
        benefit_rate: string | null;
        care_level: string | null;
        certification_status: string | null;
        certification_date: string | null;
        certification_start_date: string | null;
        certification_end_date: string | null;
        service_limit_period_start: string | null;
        service_limit_period_end: string | null;
        service_limit_amount: number | null;
        service_memo: string | null;
        service_restriction: string | null;
        care_manager: string | null;
        care_manager_org: string | null;
        copay_rate: string | null;
        public_expense: string | null;
      };
      const insuranceRowsByUserNumber = new Map<string, InsuranceData[]>();

      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        // カンマだけの実質空行（例: ",,,,,,,,"）はログせずスキップ
        if (!/[^\s,"]/.test(line)) continue;
        const cols = parseCsvRow(line);
        // 氏名: 「利用者名」列、もしくは「利用者名（姓）」+「利用者名（名）」から構築
        const directName = cols[col("氏名")]?.trim() || "";
        const lastName = cols[col("姓")]?.trim() || "";
        const firstName = cols[col("名")]?.trim() || "";
        const name = directName || `${lastName} ${firstName}`.trim();
        // フリガナも同様に姓/名 → 統合のフォールバック
        const directFurigana = cols[col("ふりがな")]?.trim() || "";
        const fLast = cols[col("フリガナ姓")]?.trim() || "";
        const fFirst = cols[col("フリガナ名")]?.trim() || "";
        const furigana = directFurigana || `${fLast} ${fFirst}`.trim() || null;
        if (!name) {
          // 氏名が完全に空（姓・名・利用者名の全てが空）→ ログせず静かにスキップ
          continue;
        }
        const userNumber = cols[col("利用者番号")]?.trim() || null;
        // clients テーブルに保存する項目一式
        const data: ClientData = {
          tenant_id: tenantId,
          office_id: currentOfficeId ?? null,
          user_number: userNumber ?? String(nextNum++),
          name,
          furigana: furigana,
          phone: cols[col("電話番号")]?.trim() || null,
          mobile: cols[col("携帯番号")]?.trim() || null,
          address: cols[col("住所")]?.trim() || null,
          care_level: cols[col("介護度")]?.trim() || null,
          benefit_rate: cols[col("給付率")]?.trim() || null,
          care_manager: cols[col("ケアマネ名")]?.trim() || null,
          care_manager_org: cols[col("ケアマネ事業所")]?.trim() || null,
          certification_end_date: cols[col("認定終了日")]?.trim() || null,
          // memo は clients から DROP 済。CSV から読んでも保存先がないため省略
          insured_number: cols[col("被保険者番号")]?.trim() || null,
          birth_date: cols[col("生年月日")]?.trim() || null,
          certification_start_date: cols[col("認定開始日")]?.trim() || null,
          insurer_number: cols[col("保険者番号")]?.trim() || null,
          copay_rate: (() => {
            // 利用者負担割合が直接CSVにあればそれを使う
            const direct = cols[col("利用者負担割合")]?.trim();
            if (direct) return direct;
            // 無ければ給付率から計算（給付率70 → 負担割合30）
            const benefit = cols[col("給付率")]?.trim();
            if (benefit && !isNaN(Number(benefit))) {
              return String(100 - Number(benefit));
            }
            return null;
          })(),
          public_expense: cols[col("公費負担情報")]?.trim() || null,
          gender: cols[col("性別")]?.trim() || null,
          // 居宅・施設等フラグ: CSVに値があれば true に設定（1/true/はい/チェック/〇 などを真と判定）
          is_facility: (() => {
            const v = cols[col("居宅・施設等")]?.trim() || "";
            if (!v) return false;
            return /^(1|true|TRUE|yes|YES|はい|チェック|〇|○|●|✓|レ|✔)$/.test(v);
          })(),
          // CSV 取込は正式データなので仮登録フラグは常に false
          is_provisional: false,
          // CSV 取込時点では未削除
          deleted_at: null,
          // 紹介機関は CSV 取込に含まれていない（画面で後から手入力）
          referrer_org: null,
          // マスタ紐付けは CSV 取込では設定しない（後で SQL で一括処理）
          care_office_id: null,
          care_manager_id: null,
        };

        // clients: user_number で集約（認定終了日が最新のものを採用）
        const userNumKey = data.user_number ?? "";
        const existing = clientByUserNumber.get(userNumKey);
        const newEnd = data.certification_end_date ?? "";
        const oldEnd = existing?.certification_end_date ?? "";
        if (!existing || newEnd > oldEnd) {
          clientByUserNumber.set(userNumKey, data);
        }

        // 保険情報: 1行 = 1認定期間。画面表示項目を全て取り込み
        const amountRaw = cols[col("区分支給限度額")]?.trim() || "";
        const amountNum = amountRaw && !isNaN(Number(amountRaw)) ? Number(amountRaw) : null;
        const ins: InsuranceData = {
          insured_number: data.insured_number ?? null,
          birth_date: data.birth_date ?? null,
          insurer_number: data.insurer_number ?? null,
          insurer_name: cols[col("保険者名")]?.trim() || null,
          issued_date: cols[col("交付年月日")]?.trim() || null,
          insurance_confirmed_date: cols[col("保険証確認日")]?.trim() || null,
          qualification_date: cols[col("資格取得日")]?.trim() || null,
          insurance_valid_start: cols[col("保険証有効開始日")]?.trim() || null,
          insurance_valid_end: cols[col("保険証有効終了日")]?.trim() || null,
          benefit_rate: data.benefit_rate ?? null,
          care_level: data.care_level ?? null,
          certification_status: cols[col("認定状況")]?.trim() || null,
          certification_date: cols[col("認定年月日")]?.trim() || null,
          certification_start_date: data.certification_start_date ?? null,
          certification_end_date: data.certification_end_date ?? null,
          service_limit_period_start: cols[col("居宅適用期間開始")]?.trim() || null,
          service_limit_period_end: cols[col("居宅適用期間終了")]?.trim() || null,
          service_limit_amount: amountNum,
          service_memo: cols[col("留意事項")]?.trim() || null,
          service_restriction: cols[col("サービス限定")]?.trim() || null,
          care_manager: data.care_manager ?? null,
          care_manager_org: data.care_manager_org ?? null,
          copay_rate: data.copay_rate ?? null,
          public_expense: data.public_expense ?? null,
        };
        const hasAny = Object.values(ins).some(v => v !== null && v !== undefined && v !== "");
        if (hasAny && data.user_number) {
          const arr = insuranceRowsByUserNumber.get(data.user_number) ?? [];
          arr.push(ins);
          insuranceRowsByUserNumber.set(data.user_number, arr);
        }
      }

      // 集約済みの clients データから ImportPreviewRow を作成
      // 差分検出のフィールド対応表
      const FIELD_LABELS: Record<string, string> = {
        name: "氏名",
        furigana: "フリガナ",
        phone: "電話番号",
        mobile: "携帯番号",
        address: "住所",
        gender: "性別",
        care_level: "介護度",
        benefit_rate: "給付率",
        care_manager: "ケアマネ名",
        care_manager_org: "ケアマネ事業所",
        certification_end_date: "認定終了日",
        memo: "メモ",
        insured_number: "被保険者番号",
        birth_date: "生年月日",
        certification_start_date: "認定開始日",
        insurer_number: "保険者番号",
        copay_rate: "利用者負担割合",
        public_expense: "公費負担情報",
        is_facility: "居宅・施設フラグ",
      };
      const fmtVal = (v: unknown): string => {
        if (v == null || v === "") return "";
        if (typeof v === "boolean") return v ? "✓" : "";
        return String(v);
      };

      // ── マスタ自動マッチ準備 ──
      // 既存の居宅マスタ・ケアマネマスタを取得して、テキスト名 → ID のマップを構築
      const [careOfficesRes, careManagersRes] = await Promise.all([
        supabase.from("care_offices").select("id,name").eq("tenant_id", tenantId),
        supabase.from("care_managers").select("id,name,care_office_id,active").eq("tenant_id", tenantId),
      ]);
      const careOfficeRows = (careOfficesRes.data ?? []) as Array<{ id: string; name: string }>;
      const careManagerRows = (careManagersRes.data ?? []) as Array<{ id: string; name: string; care_office_id: string; active: boolean }>;
      // テキスト名 → ID。同名複数ある場合は最初のヒット
      const officeNameToId: Record<string, string> = {};
      for (const o of careOfficeRows) {
        if (o.name && !(o.name in officeNameToId)) officeNameToId[o.name] = o.id;
      }
      const managerKeyToId: Record<string, string> = {};
      for (const m of careManagerRows) {
        if (m.name && m.care_office_id) {
          const k = `${m.care_office_id}|${m.name}`;
          if (!(k in managerKeyToId)) managerKeyToId[k] = m.id;
        }
      }

      // CSV内に登場する office/manager のテキストを集計し、既存マスタとの突合結果を判定
      const officeOccurrences = new Map<string, number>();         // office_text → count
      const managerOccurrences = new Map<string, number>();        // `${officeText}${managerText}` → count
      const managerOfficeText = new Map<string, string>();         // managerKey → officeText（表示用）
      for (const data of clientByUserNumber.values()) {
        const ot = (data.care_manager_org ?? "").trim();
        if (ot) officeOccurrences.set(ot, (officeOccurrences.get(ot) ?? 0) + 1);
        const mt = (data.care_manager ?? "").trim();
        if (mt && ot) {
          const key = `${ot}${mt}`;
          managerOccurrences.set(key, (managerOccurrences.get(key) ?? 0) + 1);
          managerOfficeText.set(key, ot);
        }
      }
      // 履歴側でも集計（同じ利用者でも認定期間ごとに違う事業所/ケアマネがあるため）
      for (const insArr of insuranceRowsByUserNumber.values()) {
        for (const ins of insArr) {
          const ot = (ins.care_manager_org ?? "").trim();
          if (ot) officeOccurrences.set(ot, (officeOccurrences.get(ot) ?? 0) + 1);
          const mt = (ins.care_manager ?? "").trim();
          if (mt && ot) {
            const key = `${ot}${mt}`;
            managerOccurrences.set(key, (managerOccurrences.get(key) ?? 0) + 1);
            managerOfficeText.set(key, ot);
          }
        }
      }
      // マスタ未登録のものをリストアップ
      const unregisteredOffices: UnregisteredOffice[] = [];
      for (const [name, count] of officeOccurrences.entries()) {
        if (!(name in officeNameToId)) {
          unregisteredOffices.push({ name, addToMaster: true, occurrences: count });
        }
      }
      unregisteredOffices.sort((a, b) => b.occurrences - a.occurrences);
      const unregisteredManagers: UnregisteredManager[] = [];
      for (const [key, count] of managerOccurrences.entries()) {
        const officeText = managerOfficeText.get(key) ?? "";
        const managerText = key.split("")[1] ?? "";
        // 既存マスタにある事業所配下なら、ケアマネ名で照合
        const officeId = officeNameToId[officeText];
        if (officeId) {
          const mk = `${officeId}|${managerText}`;
          if (mk in managerKeyToId) continue; // 既存マッチ
        }
        unregisteredManagers.push({
          name: managerText,
          officeName: officeText,
          addToMaster: true,
          occurrences: count,
        });
      }
      unregisteredManagers.sort((a, b) => b.occurrences - a.occurrences || a.officeName.localeCompare(b.officeName, "ja"));

      // 仮登録の一覧を抽出（CSV取込み時に名前一致で紐付け候補として表示）
      // CSVの user_number と既に一致している仮登録は対象外（=普通にUPDATE）
      const provisionalClients = freshClients.filter(
        (c) => c.is_provisional === true && !c.deleted_at
      );
      const usedProvisionalIds = new Set<string>();
      // 名前を比較しやすい形に正規化（全角空白→半角、前後トリム、連続空白→1個）
      const normName = (s: string | null | undefined): string =>
        (s ?? "").trim().replace(/　/g, " ").replace(/\s+/g, " ");

      const findProvisionalCandidates = (newData: Omit<Client, "id" | "created_at" | "memo">): ProvisionalCandidate[] => {
        const targetName = normName(newData.name);
        const targetAddr = normName(newData.address);
        if (!targetName) return [];
        const surname = targetName.split(/[\s ]/)[0];

        const candidates: ProvisionalCandidate[] = [];
        for (const p of provisionalClients) {
          if (usedProvisionalIds.has(p.id)) continue; // 同一CSV内で重複マッチを防ぐ
          const pName = normName(p.name);
          const pAddr = normName(p.address);
          let kind: ProvisionalCandidate["matchKind"] | null = null;
          if (pName && pName === targetName) kind = "exact_name";
          else if (surname && surname.length >= 1 && pName.startsWith(surname)) kind = "surname";
          else if (targetAddr && pAddr && (pAddr.includes(targetAddr) || targetAddr.includes(pAddr))) kind = "address";
          if (kind) {
            candidates.push({
              id: p.id,
              user_number: p.user_number,
              name: p.name ?? "",
              address: p.address,
              phone: p.phone,
              matchKind: kind,
            });
          }
        }
        // 完全一致 → 姓 → 住所 の順
        candidates.sort((a, b) => {
          const order = { exact_name: 0, surname: 1, address: 2 };
          return order[a.matchKind] - order[b.matchKind];
        });
        return candidates;
      };

      const previewRows: ImportPreviewRow[] = [];
      for (const data of clientByUserNumber.values()) {
        const existing = existingByUserNumber.get(data.user_number ?? "");
        const insurance = insuranceRowsByUserNumber.get(data.user_number ?? "") ?? [];
        if (!existing) {
          // 新規行 → 仮登録の候補を検索
          const candidates = findProvisionalCandidates(data);
          // 完全一致が1件のみならデフォルトでマージ選択、それ以外はOFF
          const exactMatches = candidates.filter((c) => c.matchKind === "exact_name");
          const defaultMergeId = exactMatches.length === 1 ? exactMatches[0].id : null;
          if (defaultMergeId) usedProvisionalIds.add(defaultMergeId);
          previewRows.push({
            user_number: data.user_number ?? "",
            name: data.name,
            status: "new",
            diffs: [],
            warnings: [],
            data,
            existingId: null,
            insurance: insurance as Array<Record<string, unknown>>,
            provisionalCandidates: candidates,
            mergeWithProvisionalId: defaultMergeId,
          });
          continue;
        }
        // 差分計算（fields の旧値と新値を比較）
        const diffs: ImportFieldDiff[] = [];
        for (const k of Object.keys(FIELD_LABELS)) {
          const oldV = (existing as Record<string, unknown>)[k];
          const newV = (data as unknown as Record<string, unknown>)[k];
          const oldS = fmtVal(oldV);
          const newS = fmtVal(newV);
          if (oldS !== newS) {
            diffs.push({ label: FIELD_LABELS[k], oldValue: oldS, newValue: newS });
          }
        }
        // 警告判定（マスタ紐付けは UPDATE 時に保護するので警告にしない）
        const warnings: ImportWarningKind[] = [];
        if (existing.deleted_at) warnings.push("deleted_revival");
        if (existing.is_provisional === true) warnings.push("provisional_promotion");
        // referrer_org / care_office_id / care_manager_id は UPDATE で保護するので警告対象外
        // （CSVに値が無くても既存値を維持する）
        previewRows.push({
          user_number: data.user_number ?? "",
          name: data.name,
          status: diffs.length === 0 && warnings.length === 0 ? "unchanged" : "updated",
          diffs,
          warnings,
          data,
          existingId: existing.id,
          insurance: insurance as Array<Record<string, unknown>>,
          provisionalCandidates: [],
          mergeWithProvisionalId: null,
        });
      }

      const insuranceCount = Array.from(insuranceRowsByUserNumber.values()).reduce((s, arr) => s + arr.length, 0);
      setImportPreview({
        rows: previewRows,
        skippedLines: skipped,
        insuranceCount,
        unregisteredOffices,
        unregisteredManagers,
        matchMaps: { officeNameToId, managerKeyToId },
      });
    } finally {
      setImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  // プレビューを基に実際の取込みを実行
  const executeImport = async (preview: ImportPreview) => {
    setImporting(true);
    try {
      const errors: { name: string; user_number: string; message: string }[] = [];
      const successfullyInserted: { name: string; user_number: string }[] = [];
      const successfullyUpdated: { name: string; user_number: string }[] = [];
      const successfullyMerged: { name: string; user_number: string }[] = [];
      let insertedIds: string[] = [];
      const updatedIds: string[] = [];

      // ── マスタ新規追加（チェック済みのもの） ──
      const officeNameToId = { ...preview.matchMaps.officeNameToId };
      const managerKeyToId = { ...preview.matchMaps.managerKeyToId };
      let addedOfficeCount = 0;
      let addedManagerCount = 0;

      // 1. 居宅事業所をマスタに新規追加
      for (const o of preview.unregisteredOffices) {
        if (!o.addToMaster) continue;
        const { data, error } = await supabase
          .from("care_offices")
          .insert({ tenant_id: tenantId, name: o.name })
          .select("id")
          .single();
        if (!error && data) {
          officeNameToId[o.name] = data.id;
          addedOfficeCount++;
        } else if (error) {
          errors.push({ name: o.name, user_number: "", message: `居宅マスタ追加失敗: ${error.message}` });
        }
      }
      // 2. ケアマネをマスタに新規追加（事業所IDが解決できたものだけ）
      for (const m of preview.unregisteredManagers) {
        if (!m.addToMaster) continue;
        const officeId = officeNameToId[m.officeName];
        if (!officeId) {
          // 親事業所がマスタに無い → 追加できないのでスキップ
          continue;
        }
        const k = `${officeId}|${m.name}`;
        if (k in managerKeyToId) continue; // 既に追加済み
        const { data, error } = await supabase
          .from("care_managers")
          .insert({ tenant_id: tenantId, care_office_id: officeId, name: m.name, active: true })
          .select("id")
          .single();
        if (!error && data) {
          managerKeyToId[k] = data.id;
          addedManagerCount++;
        } else if (error) {
          errors.push({ name: m.name, user_number: "", message: `ケアマネマスタ追加失敗: ${error.message}` });
        }
      }

      // テキストからマスタIDを解決（追加分も反映済み）
      const resolveOfficeId = (officeText: string | null | undefined): string | null => {
        if (!officeText) return null;
        return officeNameToId[officeText.trim()] ?? null;
      };
      const resolveManagerId = (managerText: string | null | undefined, officeText: string | null | undefined): string | null => {
        if (!managerText || !officeText) return null;
        const officeId = resolveOfficeId(officeText);
        if (!officeId) return null;
        return managerKeyToId[`${officeId}|${managerText.trim()}`] ?? null;
      };

      // 仮登録マージ対象（INSERTせず、仮登録レコードをUPDATEで本登録化）
      const toMerge = preview.rows.filter((r) => r.status === "new" && r.mergeWithProvisionalId);
      // 純粋な新規追加
      const toInsert = preview.rows.filter((r) => r.status === "new" && !r.mergeWithProvisionalId);
      // 既存の更新
      const toUpdate = preview.rows.filter((r) => r.status === "updated" || r.status === "unchanged");

      // MERGE: 仮登録のUUIDを維持しつつ、CSVデータで上書き＋is_provisional=falseに
      // 自動マッチで解決したマスタIDも一緒にセット
      for (const r of toMerge) {
        const provisionalId = r.mergeWithProvisionalId!;
        const officeId = resolveOfficeId(r.data.care_manager_org);
        const managerId = resolveManagerId(r.data.care_manager, r.data.care_manager_org);
        const payload = { ...r.data, care_office_id: officeId, care_manager_id: managerId };
        const { error: mergeErr } = await supabase.from("clients").update(payload).eq("id", provisionalId);
        if (mergeErr) {
          errors.push({ name: r.name, user_number: r.user_number, message: `仮登録マージ失敗: ${mergeErr.message}` });
        } else {
          updatedIds.push(provisionalId);
          successfullyMerged.push({ name: r.name, user_number: r.user_number });
        }
      }

      // INSERT: 自動マッチでマスタIDを補完
      if (toInsert.length > 0) {
        const insertPayloads = toInsert.map((r) => ({
          ...r.data,
          care_office_id: resolveOfficeId(r.data.care_manager_org),
          care_manager_id: resolveManagerId(r.data.care_manager, r.data.care_manager_org),
        }));
        const { data: inserted, error: batchErr } = await supabase
          .from("clients")
          .insert(insertPayloads)
          .select("id");
        if (!batchErr && inserted) {
          insertedIds = inserted.map((r: { id: string }) => r.id);
          toInsert.forEach((r) => successfullyInserted.push({ name: r.name, user_number: r.user_number }));
        } else {
          for (let i = 0; i < toInsert.length; i++) {
            const r = toInsert[i];
            const payload = insertPayloads[i];
            const { data: one, error: oneErr } = await supabase.from("clients").insert(payload).select("id").single();
            if (oneErr) {
              errors.push({ name: r.name, user_number: r.user_number, message: oneErr.message });
            } else if (one) {
              insertedIds.push(one.id);
              successfullyInserted.push({ name: r.name, user_number: r.user_number });
            }
          }
        }
      }

      // UPDATE: 既存マスタID・referrer_org は保護。CSV側で解決したIDは未紐付けの場合のみセット
      for (const r of toUpdate) {
        if (!r.existingId) continue;
        // care_office_id / care_manager_id / referrer_org を payload から除外
        const { care_office_id: _coid, care_manager_id: _cmid, referrer_org: _ref, ...rest } = r.data as unknown as Record<string, unknown>;
        void _coid; void _cmid; void _ref; // 未使用警告抑制
        const payload: Record<string, unknown> = { ...rest };
        // 自動マッチで新規にIDが解決でき、かつ既存値が無ければセット（既に紐付いていれば触らない）
        const newOfficeId = resolveOfficeId((r.data as { care_manager_org: string | null }).care_manager_org);
        const newManagerId = resolveManagerId((r.data as { care_manager: string | null }).care_manager, (r.data as { care_manager_org: string | null }).care_manager_org);
        // 既存IDを取得し、null なら自動マッチを反映、紐付け済みなら維持
        const existing = await supabase
          .from("clients")
          .select("care_office_id, care_manager_id, referrer_org")
          .eq("id", r.existingId)
          .maybeSingle();
        const existingOfficeId = (existing.data?.care_office_id as string | null) ?? null;
        const existingManagerId = (existing.data?.care_manager_id as string | null) ?? null;
        if (!existingOfficeId && newOfficeId) payload.care_office_id = newOfficeId;
        if (!existingManagerId && newManagerId) payload.care_manager_id = newManagerId;
        const { error: updErr } = await supabase.from("clients").update(payload).eq("id", r.existingId);
        if (updErr) {
          errors.push({ name: r.name, user_number: r.user_number, message: updErr.message });
        } else {
          updatedIds.push(r.existingId);
          successfullyUpdated.push({ name: r.name, user_number: r.user_number });
        }
      }

      // 自事業所が選択されていれば、取込/更新した全利用者を自動紐付け
      if (currentOfficeId) {
        const allIds = [...insertedIds, ...updatedIds];
        if (allIds.length > 0) {
          const assignmentRows = allIds.map((cid) => ({
            tenant_id: tenantId,
            client_id: cid,
            office_id: currentOfficeId,
          }));
          // 紐付けが落ちると取り込んだ人が「自事業所」の一覧に出ないので、エラー一覧に出す
          const { error: asgErr } = await supabase.from("client_office_assignments").upsert(assignmentRows, {
            onConflict: "tenant_id,client_id,office_id",
          });
          if (asgErr) {
            console.error("事業所への紐付けに失敗:", asgErr.message);
            errors.push({ name: "(事業所への紐付け)", user_number: "", message: `${allIds.length} 名を自事業所に紐付けられませんでした: ${asgErr.message}` });
          }
        }
      }

      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
      setClients(newClients);

      // 保険情報の書き込み
      // 行 (利用者) ごとに独立しているので上限付き並列 (concurrency=6) で処理する。
      // 直列時と同じく「1件失敗しても他は続行・エラーは個別に無視 (insuranceAdded に
      // カウントしないだけ)」という挙動を維持する。行の中の insert/update 順序
      // (existingByDate の自己参照) は 1 行内では直列のまま変えていない。
      // ⚠ 直列版は「予期しない例外が出たらそこで残り全行を打ち切る」try/catch だったが、
      //   並列実行では他の行の処理が既に進行中のため同じ意味を持たせられない。
      //   1 行単位で try/catch し、失敗した行だけスキップする (他の行への影響ゼロ・
      //   バックグラウンドに投げっぱなしの処理を残さない、という点でむしろ安全な設計)。
      let insuranceAdded = 0;
      try {
        const clientIdByUserNumber = new Map<string, string>();
        for (const c of newClients) {
          if (c.user_number) clientIdByUserNumber.set(c.user_number, c.id);
        }
        const rowsWithInsurance = preview.rows.filter(
          (r) => r.insurance.length > 0 && clientIdByUserNumber.has(r.user_number),
        );
        await mapWithConcurrency(
          rowsWithInsurance,
          async (r) => {
            try {
            const clientId = clientIdByUserNumber.get(r.user_number)!;
            const { data: existingRecords } = await supabase
              .from("client_insurance_records")
              .select("id, effective_date")
              .eq("tenant_id", tenantId)
              .eq("client_id", clientId);
            const existingByDate = new Map<string, string>();
            for (const rec of (existingRecords ?? []) as Array<{ id: string; effective_date: string | null }>) {
              existingByDate.set(rec.effective_date ?? "", rec.id);
            }
            for (const ins of r.insurance) {
              const effectiveDate = (ins.certification_start_date as string | null) || null;
              // 履歴行にもマスタIDを自動マッチで紐付け
              const insOfficeId = resolveOfficeId((ins.care_manager_org as string | null) ?? null);
              const insManagerId = resolveManagerId((ins.care_manager as string | null) ?? null, (ins.care_manager_org as string | null) ?? null);
              const payload = {
                tenant_id: tenantId,
                client_id: clientId,
                effective_date: effectiveDate,
                ...ins,
                care_office_id: insOfficeId,
                care_manager_id: insManagerId,
              };
              const exId = existingByDate.get(effectiveDate ?? "");
              if (exId) {
                const { error: upErr } = await supabase.from("client_insurance_records").update(payload).eq("id", exId);
                if (!upErr) insuranceAdded++;
              } else {
                const { error: insErr } = await supabase.from("client_insurance_records").insert(payload);
                if (!insErr) {
                  insuranceAdded++;
                  existingByDate.set(effectiveDate ?? "", "newly-inserted");
                }
              }
            }
            } catch {
              // 1 行の失敗は他行に影響させない (直列版の「致命的ではない」と同じ扱い)
            }
          },
          6,
        );
      } catch {
        // 致命的ではないので握りつぶす
      }

      // 予定の自動再紐付け
      let reunited = 0;
      try {
        const { data: orphanEvents } = await supabase
          .from("events")
          .select("id,title")
          .eq("tenant_id", tenantId)
          .is("client_id", null)
          .is("deleted_at", null);
        if (orphanEvents && orphanEvents.length > 0) {
          const nameToId = new Map<string, string>();
          for (const c of newClients) {
            if (!nameToId.has(c.name)) nameToId.set(c.name, c.id);
          }
          const updates: { id: string; client_id: string }[] = [];
          for (const ev of orphanEvents as Array<{ id: string; title: string }>) {
            const m = ev.title.match(/^(.+?) 様(?:[ 　].*)?$/);
            if (!m) continue;
            const clientId = nameToId.get(m[1].trim());
            if (clientId) updates.push({ id: ev.id, client_id: clientId });
          }
          for (const u of updates) {
            const { error: reErr } = await supabase.from("events").update({ client_id: u.client_id }).eq("id", u.id);
            if (!reErr) reunited++;
          }
        }
      } catch {
        // 致命的ではない
      }

      // スキップ行をエラーに追加
      for (const s of preview.skippedLines) {
        errors.push({ name: "(スキップ)", user_number: "", message: `${s.reason}: ${s.line}` });
      }

      setImportPreview(null);
      setImportResult({
        inserted: successfullyInserted,
        updated: successfullyUpdated,
        merged: successfullyMerged,
        errors,
        reunited,
        insuranceAdded,
        addedOffices: addedOfficeCount,
        addedManagers: addedManagerCount,
      });
    } finally {
      setImporting(false);
    }
  };

  // 入退院ボタン → 日付入力ダイアログを開く
  const toggleHospitalization = (client: Client) => {
    const current = hospitalizations.find(h => h.client_id === client.id && h.discharge_date === null);
    setHospDateInput(todayYmd());
    setHospDateDialog({ client, mode: current ? "discharge" : "admit", currentHospId: current?.id });
  };

  // 日付確定後にDBへ保存
  const confirmHospDate = async () => {
    if (!hospDateDialog) return;
    const { client, mode, currentHospId } = hospDateDialog;
    setHospLoading(client.id);
    setHospDateDialog(null);
    try {
      if (mode === "discharge" && currentHospId) {
        const { error } = await supabase.from("client_hospitalizations")
          .update({ discharge_date: hospDateInput })
          .eq("id", currentHospId);
        if (!error) {
          setHospitalizations(prev => prev.map(h => h.id === currentHospId ? { ...h, discharge_date: hospDateInput } : h));
        }
      } else {
        const { data, error } = await supabase.from("client_hospitalizations")
          .insert({ tenant_id: tenantId, client_id: client.id, admission_date: hospDateInput })
          .select().single();
        if (!error && data) {
          setHospitalizations(prev => [data as ClientHospitalization, ...prev]);
        }
      }
    } finally {
      setHospLoading(null);
    }
  };

  const openJissekiModal = async () => {
    setShowJissekiModal(true);
    if (jissekiRentals.length > 0) return; // already loaded
    setJissekiLoading(true);
    try {
      const all: ClientRentalHistory[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("client_rental_history")
          .select("*")
          .eq("tenant_id", tenantId)
          .is("end_date", null)
          .order("id") // 並び順が無いとページの境目で行が抜ける・重なる
          .range(from, from + 999);
        if (error) throw new Error(`貸与履歴の読み込みに失敗: ${error.message}`);
        if (!data || data.length === 0) break;
        all.push(...(data as ClientRentalHistory[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setJissekiRentals(all);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      alert(msg);
    } finally {
      setJissekiLoading(false);
    }
  };

  // サービスコードマッピング（種目→コード）
  const JISSEKI_SERVICE_CODES: Record<string, string> = {
    "車いす": "17 1001",
    "車椅子": "17 1001",
    "車いす付属品": "17 1002",
    "車椅子付属品": "17 1002",
    "特殊寝台": "17 1003",
    "特殊寝台付属品": "17 1004",
    "床ずれ防止用具": "17 1005",
    "体位変換器": "17 1006",
    "手すり": "17 1007",
    "スロープ": "17 1008",
    "歩行器": "17 1009",
    "歩行補助つえ": "17 1010",
    "徘徊感知機器": "17 1011",
    "認知症老人徘徊感知機器": "17 1011",
    "移動用リフト": "17 1012",
    "自動排泄処理装置": "17 1013",
    "自動排せつ処理装置": "17 1013",
  };

  // 警告ラベル
  const WARNING_LABELS: Record<string, { color: string; bg: string; icon: string; label: string }> = {
    deleted_revival:        { color: "text-red-700",    bg: "bg-red-50",    icon: "🔴", label: "削除済みから復活" },
    provisional_promotion:  { color: "text-amber-700",  bg: "bg-amber-50",  icon: "🟡", label: "仮登録から本登録に昇格" },
    referrer_lost:          { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "紹介機関が消える" },
    care_office_unlinked:   { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "居宅マスタ紐付けが消える" },
    care_manager_unlinked:  { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "ケアマネ紐付けが消える" },
  };

  return (
    <div className="flex flex-col h-full">
      {/* 取込プレビューモーダル */}
      {importPreview && (() => {
        const newRows = importPreview.rows.filter((r) => r.status === "new");
        const updatedRows = importPreview.rows.filter((r) => r.status === "updated");
        const unchangedRows = importPreview.rows.filter((r) => r.status === "unchanged");
        const warningRows = importPreview.rows.filter((r) => r.warnings.length > 0);
        const mergeRows = newRows.filter((r) => r.mergeWithProvisionalId);
        const newRowsWithCandidates = newRows.filter((r) => r.provisionalCandidates.length > 0);
        // 候補のチェックボックスを切り替える
        const setMergeId = (userNumber: string, provisionalId: string | null) => {
          if (!importPreview) return;
          // 同じ仮登録IDが他の新規行で既に選択されている場合はそちらを解除（重複マッチ防止）
          const next = importPreview.rows.map((row) => {
            if (row.user_number === userNumber && row.status === "new") {
              return { ...row, mergeWithProvisionalId: provisionalId };
            }
            // 別の行で同じ仮登録IDを選んでいたら null に戻す
            if (provisionalId && row.mergeWithProvisionalId === provisionalId && row.user_number !== userNumber) {
              return { ...row, mergeWithProvisionalId: null };
            }
            return row;
          });
          setImportPreview({ ...importPreview, rows: next });
        };
        // 警告の種類別グルーピング
        const warningByKind: Record<string, ImportPreviewRow[]> = {};
        for (const r of warningRows) {
          for (const w of r.warnings) {
            if (!warningByKind[w]) warningByKind[w] = [];
            warningByKind[w].push(r);
          }
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 text-sm">
                  📋 取込内容の確認（実行前プレビュー）
                </h3>
                <button onClick={() => setImportPreview(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
              </div>
              <div className="px-5 py-4 overflow-y-auto space-y-4 flex-1">
                {/* サマリ */}
                <div className="grid grid-cols-5 gap-2">
                  <div className="bg-emerald-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-emerald-700">{newRows.length - mergeRows.length}</p>
                    <p className="text-[10px] text-emerald-600">新規追加</p>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-purple-700">{mergeRows.length}</p>
                    <p className="text-[10px] text-purple-600">仮登録→本登録</p>
                  </div>
                  <div className="bg-indigo-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-indigo-700">{updatedRows.length}</p>
                    <p className="text-[10px] text-indigo-600">更新</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-gray-500">{unchangedRows.length}</p>
                    <p className="text-[10px] text-gray-500">変更なし</p>
                  </div>
                  <div className={`rounded-lg p-2 text-center ${warningRows.length > 0 ? "bg-red-50" : "bg-gray-50"}`}>
                    <p className={`text-lg font-bold ${warningRows.length > 0 ? "text-red-600" : "text-gray-500"}`}>{warningRows.length}</p>
                    <p className="text-[10px] text-gray-500">⚠️ 警告</p>
                  </div>
                </div>

                {/* 仮登録の紐付け候補（移行期間用） */}
                {newRowsWithCandidates.length > 0 && (
                  <div className="border border-purple-200 rounded-xl p-3 space-y-3 bg-purple-50/40">
                    <div>
                      <p className="text-sm font-bold text-purple-700">🔗 仮登録との紐付け候補（{newRowsWithCandidates.length}件）</p>
                      <p className="text-[11px] text-purple-600 mt-0.5">
                        カレンダー側で先に仮登録された利用者と同一人物の場合、紐付けると予定・発注がそのまま引き継がれます。
                      </p>
                    </div>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {newRowsWithCandidates.map((r, i) => {
                        const exactCount = r.provisionalCandidates.filter((c) => c.matchKind === "exact_name").length;
                        return (
                          <div key={i} className="bg-white rounded-lg p-2.5 border border-purple-100">
                            <p className="text-xs font-semibold text-gray-800 mb-1.5">
                              <span className="text-gray-400 mr-2">{r.user_number}</span>
                              {r.name}
                              {exactCount > 0 && <span className="ml-2 text-[10px] text-purple-600">完全一致{exactCount}件</span>}
                            </p>
                            <div className="space-y-1 pl-2">
                              {r.provisionalCandidates.map((cand) => (
                                <label key={cand.id} className="flex items-start gap-1.5 text-xs text-gray-700 cursor-pointer hover:bg-purple-50 rounded p-1">
                                  <input
                                    type="radio"
                                    name={`merge-${r.user_number}`}
                                    checked={r.mergeWithProvisionalId === cand.id}
                                    onChange={() => setMergeId(r.user_number, cand.id)}
                                    className="mt-0.5"
                                  />
                                  <span className="flex-1">
                                    <span className="font-medium">{cand.name}</span>
                                    {cand.matchKind === "exact_name" && <span className="ml-1 text-[10px] text-emerald-600 bg-emerald-50 px-1 rounded">完全一致</span>}
                                    {cand.matchKind === "surname" && <span className="ml-1 text-[10px] text-amber-600 bg-amber-50 px-1 rounded">姓一致</span>}
                                    {cand.matchKind === "address" && <span className="ml-1 text-[10px] text-sky-600 bg-sky-50 px-1 rounded">住所一致</span>}
                                    {(cand.address || cand.phone) && (
                                      <span className="block text-[10px] text-gray-400 mt-0.5">
                                        {cand.address ? `🏠 ${cand.address}` : ""}{cand.address && cand.phone ? " / " : ""}{cand.phone ? `📞 ${cand.phone}` : ""}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              ))}
                              <label className="flex items-start gap-1.5 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded p-1">
                                <input
                                  type="radio"
                                  name={`merge-${r.user_number}`}
                                  checked={r.mergeWithProvisionalId === null}
                                  onChange={() => setMergeId(r.user_number, null)}
                                  className="mt-0.5"
                                />
                                <span className="text-gray-500">紐付けず、そのまま新規追加する</span>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 警告一覧 */}
                {warningRows.length > 0 && (
                  <div className="border border-red-200 rounded-xl p-3 space-y-3 bg-red-50/30">
                    <p className="text-sm font-bold text-red-700">⚠️ 警告（実行前に確認してください）</p>
                    {Object.entries(warningByKind).map(([kind, rows]) => {
                      const meta = WARNING_LABELS[kind];
                      if (!meta) return null;
                      return (
                        <div key={kind} className={`rounded-lg p-2.5 ${meta.bg}`}>
                          <p className={`text-xs font-semibold ${meta.color} mb-1.5`}>
                            {meta.icon} {meta.label}（{rows.length}件）
                          </p>
                          <div className="space-y-0.5 max-h-32 overflow-y-auto">
                            {rows.slice(0, 50).map((r, i) => (
                              <p key={i} className="text-xs text-gray-700">
                                <span className="text-gray-400 mr-2">{r.user_number}</span>
                                {r.name}
                              </p>
                            ))}
                            {rows.length > 50 && <p className="text-[10px] text-gray-400">…他 {rows.length - 50}件</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 更新内容詳細 */}
                {updatedRows.length > 0 && (
                  <details className="border border-indigo-200 rounded-xl bg-indigo-50/30">
                    <summary className="px-3 py-2 text-sm font-semibold text-indigo-700 cursor-pointer">
                      ✏️ 更新内容の詳細（{updatedRows.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-2 max-h-72 overflow-y-auto">
                      {updatedRows.map((r, i) => (
                        <div key={i} className="bg-white rounded-lg p-2 border border-indigo-100">
                          <p className="text-xs font-semibold text-gray-800">
                            <span className="text-gray-400 mr-2">{r.user_number}</span>
                            {r.name}
                          </p>
                          {r.diffs.length > 0 ? (
                            <div className="mt-1 space-y-0.5">
                              {r.diffs.map((d, j) => (
                                <div key={j} className="text-[11px] text-gray-600">
                                  <span className="text-gray-400">{d.label}: </span>
                                  <span className="line-through text-gray-400">{d.oldValue || "（空）"}</span>
                                  <span className="mx-1 text-amber-600">→</span>
                                  <span className="text-emerald-700 font-medium">{d.newValue || "（空）"}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-gray-400 mt-0.5">フィールド値の変更なし（警告のみ）</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* 新規追加リスト */}
                {newRows.length > 0 && (
                  <details className="border border-emerald-200 rounded-xl bg-emerald-50/30">
                    <summary className="px-3 py-2 text-sm font-semibold text-emerald-700 cursor-pointer">
                      🆕 新規追加（{newRows.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-0.5 max-h-60 overflow-y-auto">
                      {newRows.map((r, i) => (
                        <p key={i} className="text-xs text-gray-700">
                          <span className="text-gray-400 mr-2">{r.user_number}</span>
                          {r.name}
                        </p>
                      ))}
                    </div>
                  </details>
                )}

                {/* スキップ行 */}
                {importPreview.skippedLines.length > 0 && (
                  <details className="border border-gray-200 rounded-xl bg-gray-50">
                    <summary className="px-3 py-2 text-sm font-semibold text-gray-600 cursor-pointer">
                      ⏭️ スキップ行（{importPreview.skippedLines.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-0.5 max-h-40 overflow-y-auto">
                      {importPreview.skippedLines.map((s, i) => (
                        <p key={i} className="text-[11px] text-gray-500">{s.reason}: <span className="font-mono">{s.line.substring(0, 80)}</span></p>
                      ))}
                    </div>
                  </details>
                )}

                {/* マスタ未登録セクション */}
                {(importPreview.unregisteredOffices.length > 0 || importPreview.unregisteredManagers.length > 0) && (
                  <div className="border border-emerald-200 rounded-xl p-3 space-y-3 bg-emerald-50/30">
                    <div>
                      <p className="text-sm font-bold text-emerald-700">🗂 マスタ未登録の事業所・ケアマネ</p>
                      <p className="text-[11px] text-emerald-700 mt-0.5">
                        チェックを入れたものは取込み時にマスタへ自動追加され、利用者・履歴と紐付けられます。チェックを外すとテキストのみで取り込まれます（後で手動紐付け可能）。
                      </p>
                    </div>

                    {/* 居宅事業所 */}
                    {importPreview.unregisteredOffices.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-emerald-100">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-emerald-700">🏢 居宅事業所（{importPreview.unregisteredOffices.length}件）</p>
                          <div className="flex gap-2 text-[10px]">
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredOffices: importPreview.unregisteredOffices.map((o) => ({ ...o, addToMaster: true })),
                                });
                              }}
                              className="text-emerald-600 hover:underline"
                            >全選択</button>
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredOffices: importPreview.unregisteredOffices.map((o) => ({ ...o, addToMaster: false })),
                                  // 親が外れたらケアマネも自動的にOFFになるよう連動
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: false })),
                                });
                              }}
                              className="text-gray-500 hover:underline"
                            >全解除</button>
                          </div>
                        </div>
                        <div className="space-y-1 max-h-44 overflow-y-auto">
                          {importPreview.unregisteredOffices.map((o, i) => (
                            <label key={i} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-emerald-50 rounded p-1">
                              <input
                                type="checkbox"
                                checked={o.addToMaster}
                                onChange={(e) => {
                                  if (!importPreview) return;
                                  const newOffices = importPreview.unregisteredOffices.map((it) =>
                                    it.name === o.name ? { ...it, addToMaster: e.target.checked } : it
                                  );
                                  // 事業所をOFFにしたら、その配下のケアマネも自動的にOFFに
                                  let newManagers = importPreview.unregisteredManagers;
                                  if (!e.target.checked) {
                                    newManagers = newManagers.map((m) =>
                                      m.officeName === o.name ? { ...m, addToMaster: false } : m
                                    );
                                  }
                                  setImportPreview({ ...importPreview, unregisteredOffices: newOffices, unregisteredManagers: newManagers });
                                }}
                                className="w-4 h-4 shrink-0"
                              />
                              <span className="flex-1 text-gray-800">{o.name}</span>
                              <span className="text-[10px] text-gray-400">{o.occurrences}件</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ケアマネ */}
                    {importPreview.unregisteredManagers.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-emerald-100">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-emerald-700">👤 ケアマネ（{importPreview.unregisteredManagers.length}件）</p>
                          <div className="flex gap-2 text-[10px]">
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: true })),
                                });
                              }}
                              className="text-emerald-600 hover:underline"
                            >全選択</button>
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: false })),
                                });
                              }}
                              className="text-gray-500 hover:underline"
                            >全解除</button>
                          </div>
                        </div>
                        <div className="space-y-1 max-h-44 overflow-y-auto">
                          {importPreview.unregisteredManagers.map((m, i) => {
                            // 親事業所がマスタに有るか or マスタ追加チェックされているかを判定
                            const officeExists = m.officeName in importPreview.matchMaps.officeNameToId;
                            const officeWillBeAdded = importPreview.unregisteredOffices.find((o) => o.name === m.officeName)?.addToMaster ?? false;
                            const canAdd = officeExists || officeWillBeAdded;
                            return (
                              <label
                                key={i}
                                className={`flex items-center gap-2 text-xs rounded p-1 ${canAdd ? "cursor-pointer hover:bg-emerald-50" : "opacity-50"}`}
                                title={!canAdd ? "親事業所がマスタに無い／追加対象外なので追加できません" : ""}
                              >
                                <input
                                  type="checkbox"
                                  checked={m.addToMaster && canAdd}
                                  disabled={!canAdd}
                                  onChange={(e) => {
                                    if (!importPreview) return;
                                    const newManagers = importPreview.unregisteredManagers.map((it) =>
                                      it.name === m.name && it.officeName === m.officeName
                                        ? { ...it, addToMaster: e.target.checked }
                                        : it
                                    );
                                    setImportPreview({ ...importPreview, unregisteredManagers: newManagers });
                                  }}
                                  className="w-4 h-4 shrink-0"
                                />
                                <span className="flex-1 text-gray-800">
                                  {m.name}
                                  <span className="text-[10px] text-gray-400 ml-1.5">@ {m.officeName}</span>
                                </span>
                                <span className="text-[10px] text-gray-400">{m.occurrences}件</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 補足情報 */}
                <div className="bg-sky-50 rounded-lg p-2.5 text-[11px] text-sky-700 space-y-0.5">
                  <p>📌 保険情報履歴も同時に更新されます（{importPreview.insuranceCount}件の認定期間）</p>
                  {currentOfficeId && <p>📌 自事業所が選択中のため、取込/更新した利用者を自動紐付けします</p>}
                  <p>📌 タイトルに「〇〇 様」が含まれる未紐付け予定は、新規取込の利用者へ自動再紐付けします</p>
                  <p>📌 既存利用者のマスタ紐付け（居宅事業所・ケアマネ）は保護され、CSV取込みで上書きされません</p>
                  <p>📌 認定期間ごとの担当ケアマネは履歴として記録されます（マスタ紐付き）</p>
                </div>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 shrink-0 flex gap-2">
                <button
                  onClick={() => setImportPreview(null)}
                  disabled={importing}
                  className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl text-sm disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => executeImport(importPreview)}
                  disabled={importing}
                  className={`flex-1 py-2 font-semibold rounded-xl text-sm disabled:opacity-50 ${warningRows.length > 0 ? "bg-amber-500 hover:bg-amber-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}
                >
                  {importing ? "実行中..." : warningRows.length > 0 ? "⚠️ 警告を承知の上で実行" : "実行する"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 取込結果モーダル */}
      {importResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
              <h3 className="font-semibold text-gray-800 text-sm">
                {importResult.errors.length > 0 ? "⚠️" : "✅"} 取り込み完了（新規 {importResult.inserted.length}件 / 更新 {importResult.updated.length}件{importResult.merged.length > 0 ? ` / 仮登録→本登録 ${importResult.merged.length}件` : ""}{importResult.addedOffices > 0 ? ` / 居宅マスタ追加 ${importResult.addedOffices}件` : ""}{importResult.addedManagers > 0 ? ` / ケアマネマスタ追加 ${importResult.addedManagers}件` : ""}{importResult.insuranceAdded > 0 ? ` / 保険情報 ${importResult.insuranceAdded}件` : ""}{importResult.reunited > 0 ? ` / 予定再紐付け ${importResult.reunited}件` : ""}{importResult.errors.length > 0 ? ` / エラー ${importResult.errors.length}件` : ""}）
              </h3>
              <button onClick={() => setImportResult(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-3 overflow-y-auto space-y-4 flex-1">
              {importResult.errors.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-600 mb-1.5">❌ エラー/スキップ（{importResult.errors.length}件）</p>
                  <div className="bg-red-50 rounded-lg p-2.5 space-y-1 max-h-60 overflow-y-auto">
                    {importResult.errors.map((e, i) => (
                      <div key={i} className="text-xs text-gray-700">
                        <p>
                          <span className="text-gray-400 mr-2">{e.user_number || "-"}</span>
                          <span className="font-medium">{e.name || "(氏名なし)"}</span>
                        </p>
                        <p className="text-[11px] text-red-500 ml-6">{e.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {importResult.inserted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-emerald-600 mb-1.5">🆕 新規登録（{importResult.inserted.length}件）</p>
                  <div className="bg-emerald-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.inserted.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.updated.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-indigo-600 mb-1.5">✏️ 更新（{importResult.updated.length}件）</p>
                  <div className="bg-indigo-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.updated.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.merged.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-purple-600 mb-1.5">🔗 仮登録→本登録（{importResult.merged.length}件）</p>
                  <p className="text-[11px] text-purple-500 mb-1.5">仮登録のUUIDを維持したままCSVデータで本登録化しました。予定・発注の紐付きはそのまま引き継がれています。</p>
                  <div className="bg-purple-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.merged.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.insuranceAdded > 0 && (
                <div className="bg-sky-50 rounded-lg p-2.5 text-xs text-sky-800">
                  🏥 介護保険情報 <strong>{importResult.insuranceAdded}件</strong> を履歴として保存しました（介護保険タブで表示）
                </div>
              )}
              {importResult.reunited > 0 && (
                <div className="bg-amber-50 rounded-lg p-2.5 text-xs text-amber-800">
                  🔗 削除→再取込で切れていた予定 <strong>{importResult.reunited}件</strong> を自動で利用者に再紐付けしました
                </div>
              )}
              {importResult.inserted.length === 0 && importResult.updated.length === 0 && importResult.merged.length === 0 && importResult.errors.length === 0 && importResult.reunited === 0 && importResult.insuranceAdded === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">変更はありませんでした</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 shrink-0">
              <button
                onClick={() => setImportResult(null)}
                className="w-full py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl text-sm"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 shrink-0">
        {(viewMode === "list" || viewMode === "insurance") && (
          <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="名前・かな・カナで検索"
              className="flex-1 bg-transparent text-sm outline-none"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X size={14} className="text-gray-400" />
              </button>
            )}
          </div>
        )}
        {viewMode === "history" && <div className="flex-1" />}
        {/* 自事業所/全利用者 toggle (currentOfficeId が選択されてる場合のみ) */}
        {currentOfficeId && onOfficeViewAllChange && (
          <div className="flex rounded-xl border border-gray-200 overflow-hidden text-xs font-medium shrink-0">
            <button
              onClick={() => onOfficeViewAllChange(false)}
              className={`px-2.5 py-1.5 transition-colors ${!officeViewAll ? "bg-emerald-500 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              自事業所
            </button>
            <button
              onClick={() => onOfficeViewAllChange(true)}
              className={`px-2.5 py-1.5 transition-colors ${officeViewAll ? "bg-emerald-500 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              全利用者
            </button>
          </div>
        )}
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => setShowNewClient(true)}
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors flex items-center gap-1"
          >
            <Plus size={12} />新規
          </button>
          <button
            onClick={openJissekiModal}
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 transition-colors"
          >
            実績表
          </button>
          <button
            onClick={() => { setHospFilter(f => !f); setKanaFilter(""); }}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors ${hospFilter ? "bg-red-500 text-white border-red-500" : "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"}`}
          >
            入院中一覧
          </button>
          <button
            onClick={handleExportCSV}
            title="CSVダウンロード"
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
          >
            CSV出力
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={importing}
            title="CSVから利用者を取り込む"
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {importing ? "取り込み中..." : "CSV取り込み"}
          </button>
          <input ref={csvInputRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportCSV(f); }} />
          {(["list", "insurance", "history"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === m ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
            >
              {m === "list" ? "基本情報" : m === "insurance" ? "保険情報" : "変更履歴"}
            </button>
          ))}
        </div>
      </div>

      {/* 変更履歴ビュー */}
      {viewMode === "history" && (
        <div className="flex-1 overflow-y-auto bg-white p-3 space-y-3">
          {changeHistory.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">変更履歴がありません</p>
          ) : (
            changeHistory.map((g, gi) => (
              <div key={gi} className="bg-gray-50 rounded-xl p-3">
                <button
                  onClick={() => setSelectedClient(g.client!)}
                  className="text-sm font-bold text-gray-800 mb-2 flex items-center gap-1 hover:text-emerald-600"
                >
                  {g.client!.name}
                  <ChevronRight size={13} className="text-gray-400" />
                </button>
                <div className="space-y-1">
                  {g.events.slice(0, 5).map((ev, ei) => (
                    <div key={ei} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400 w-20 shrink-0">{ev.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3")}</span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${ev.color}`}>{ev.label}</span>
                      <span className="text-gray-700 truncate">{ev.equipName}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 保険情報一覧ビュー */}
      {viewMode === "insurance" && (() => {
        // 各利用者の「最新認定の最良レコード」を取得
        //   1. effective_date が最新のものを選ぶ
        //   2. 同じ effective_date なら copay_rate が埋まってるレコードを優先
        //   3. それも同じなら benefit_rate が埋まってるレコードを優先
        const insuranceByClient = new Map<string, ClientInsuranceRecord>();
        const scoreRec = (r: ClientInsuranceRecord): number =>
          (r.copay_rate ? 2 : 0) + (r.benefit_rate ? 1 : 0);
        for (const rec of allInsuranceRecords) {
          const existing = insuranceByClient.get(rec.client_id);
          if (!existing) {
            insuranceByClient.set(rec.client_id, rec);
            continue;
          }
          const existingDate = existing.effective_date ?? "";
          const recDate = rec.effective_date ?? "";
          if (recDate > existingDate) {
            insuranceByClient.set(rec.client_id, rec);
          } else if (recDate === existingDate) {
            // 同じ effective_date の場合は情報が充実してるものを採用
            if (scoreRec(rec) > scoreRec(existing)) {
              insuranceByClient.set(rec.client_id, rec);
            }
          }
        }
        const insuranceFiltered = clients
          .filter((c) => matchClient(c, search))
          .sort((a, b) => {
            const fa = a.is_facility ? 1 : 0;
            const fb = b.is_facility ? 1 : 0;
            if (fa !== fb) return fa - fb;
            return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
          });
        return (
          <div className="flex-1 overflow-y-auto overflow-x-auto bg-white">
            {insuranceFiltered.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-16">該当なし</p>
            ) : (
              <table className="w-full text-xs min-w-[900px]">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">氏名</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-10">性別</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-20">要介護度</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-28">被保険者番号</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-16">負担割合</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">保険者</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">認定開始日</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">認定終了日</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-32">居宅事業所</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">ケアマネ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {insuranceFiltered.map((client) => {
                    const rec = insuranceByClient.get(client.id);
                    const dash = <span className="text-gray-300">—</span>;
                    return (
                      <tr
                        key={client.id}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => { setSelectedClientInitialViewMode("insurance"); setSelectedClient(client); }}
                      >
                        <td className="px-3 py-2 font-medium text-gray-800">
                          {client.name}
                          {client.is_provisional && <span className="ml-1 text-[9px] font-semibold bg-amber-100 text-amber-700 px-1 py-0.5 rounded align-middle">仮</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{client.gender ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_level ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.insured_number ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.copay_rate ? `${rec.copay_rate}%` : dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.insurer_name ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.certification_start_date ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.certification_end_date ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_manager_org ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_manager ?? dash}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}

      {/* 利用者一覧ビュー */}
      {viewMode === "list" && <>
      {/* ア行・カ行フィルター */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-1.5 overflow-x-auto shrink-0 items-center">
        {hospFilter ? (
          <>
            <span className="shrink-0 text-xs font-medium text-red-600 px-1">入院中一覧</span>
            <button onClick={() => { const d = new Date(...(hospModalMonth.split("-").map(Number) as [number, number])); d.setMonth(d.getMonth() - 2); setHospModalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft size={15} /></button>
            <span className="shrink-0 text-xs font-medium text-gray-700 w-16 text-center">{hospModalMonth.replace("-", "年")}月</span>
            <button onClick={() => { const [y, m] = hospModalMonth.split("-").map(Number); const d = new Date(y, m, 1); setHospModalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight size={15} /></button>
            <span className="text-xs text-red-500 font-medium ml-1">{filtered.length}名</span>
          </>
        ) : (
          <>
            <button
              onClick={() => { setKanaFilter(""); setProvisionalFilter(false); setTrashFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${!kanaFilter && !provisionalFilter && !trashFilter ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
            >すべて</button>
            {KANA_ROWS.map((row) => (
              <button
                key={row.label}
                onClick={() => { setKanaFilter(kanaFilter === row.label ? "" : row.label); setProvisionalFilter(false); setTrashFilter(false); }}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${kanaFilter === row.label ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
              >{row.label}行</button>
            ))}
            <button
              onClick={() => { setProvisionalFilter(!provisionalFilter); setKanaFilter(""); setTrashFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${provisionalFilter ? "bg-amber-500 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}
            >🏷️ 仮登録</button>
            <button
              onClick={() => { setTrashFilter(!trashFilter); setKanaFilter(""); setProvisionalFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${trashFilter ? "bg-gray-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
            >🗑️ ゴミ箱</button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-auto bg-white">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            {clients.length === 0 ? "利用者データがありません" : "該当なし"}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 min-w-[480px]">
            {filtered.map((client) => {
              const clientOrders = orders.filter(o => o.client_id === client.id);
              const clientOrderIds = new Set(clientOrders.map(o => o.id));
              const activeItems = orderItems.filter(
                item => clientOrderIds.has(item.order_id) &&
                        item.status !== "cancelled" &&
                        item.status !== "terminated"
              );
              const hasKaigo = activeItems.some(item => {
                const pt = item.payment_type ?? clientOrders.find(o => o.id === item.order_id)?.payment_type;
                return pt === "介護";
              });
              const hasJihi = activeItems.some(item => {
                const pt = item.payment_type ?? clientOrders.find(o => o.id === item.order_id)?.payment_type;
                return pt === "自費";
              });
              const isHospitalized = hospitalizations.some(h => h.client_id === client.id && h.discharge_date === null);
              const isToggling = hospLoading === client.id;
              return (
                <li key={client.id} className={`flex items-center pr-3 ${isHospitalized ? "bg-red-50" : ""}`}>
                  <button
                    onClick={() => setSelectedClient(client)}
                    className="flex-1 min-w-0 px-4 py-3 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-1">
                      <div className={`w-20 shrink-0 flex items-center gap-0.5 text-sm font-medium ${isHospitalized ? "text-red-700" : "text-gray-800"}`}>
                        <span className="truncate min-w-0">{client.name}</span>
                        {client.is_provisional && <span className="shrink-0 text-[9px] font-semibold bg-amber-100 text-amber-700 px-1 py-0.5 rounded">仮</span>}
                      </div>
                      <span className="w-24 shrink-0 text-xs text-gray-400 truncate">{client.furigana ?? ""}</span>
                      <div className="w-8 shrink-0 flex items-center">
                        {hasKaigo && (
                          <span className="text-xs px-1 py-0.5 bg-emerald-100 text-emerald-700 rounded font-medium">介護</span>
                        )}
                      </div>
                      <div className="w-8 shrink-0 flex items-center">
                        {hasJihi && (
                          <span className="text-xs px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">自費</span>
                        )}
                      </div>
                      {isHospitalized && (
                        <span className="text-xs px-1 py-0.5 bg-red-100 text-red-600 rounded font-medium shrink-0">入院中</span>
                      )}
                      <span className="flex-1 min-w-0 text-xs text-gray-400 truncate">{client.address ?? ""}</span>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </button>
                  <button
                    onClick={() => toggleHospitalization(client)}
                    disabled={isToggling}
                    className={`shrink-0 ml-1 px-2 py-1 text-xs font-medium rounded-lg border transition-colors disabled:opacity-40 ${
                      isHospitalized
                        ? "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                        : "text-red-500 border-red-200 hover:bg-red-50"
                    }`}
                  >
                    {isToggling ? "…" : isHospitalized ? "→退院へ" : "→入院へ"}
                  </button>
                  <button
                    onClick={() => setNewOrderClient(client)}
                    className="shrink-0 ml-1 px-3 py-1 text-xs font-medium text-emerald-600 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition-colors"
                  >
                    発注
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>}

      {newOrderClient && (
        <NewOrderModal
          tenantId={tenantId}
          currentOfficeId={currentOfficeId}
          clients={clients}
          equipment={equipment}
          suppliers={suppliers}
          members={members}
          defaultClientId={newOrderClient.id}
          onClose={() => setNewOrderClient(null)}
          onDone={() => setNewOrderClient(null)}
        />
      )}

      {/* 新規利用者追加モーダル */}
      {showNewClient && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">新規利用者追加</h3>
              <button onClick={() => setShowNewClient(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            {currentOfficeId && (
              <p className="text-xs text-emerald-600 bg-emerald-50 rounded-lg px-2.5 py-1.5 mb-3">
                自事業所に自動で紐付けされます
              </p>
            )}
            <div className="space-y-2">
              <input
                type="text"
                placeholder="氏名（必須）"
                value={newClientForm.name}
                onChange={(e) => setNewClientForm({ ...newClientForm, name: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="ふりがな"
                value={newClientForm.furigana}
                onChange={(e) => setNewClientForm({ ...newClientForm, furigana: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="電話番号"
                value={newClientForm.phone}
                onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="携帯番号"
                value={newClientForm.mobile}
                onChange={(e) => setNewClientForm({ ...newClientForm, mobile: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="住所"
                value={newClientForm.address}
                onChange={(e) => setNewClientForm({ ...newClientForm, address: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowNewClient(false)}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddNewClient}
                disabled={addingClient || !newClientForm.name.trim()}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 transition-colors disabled:opacity-50"
              >
                {addingClient ? "追加中…" : "追加"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 似た仮登録の紐付け確認モーダル */}
      {similarProvisionalCandidates && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">似た仮登録があります</h3>
              <button onClick={() => setSimilarProvisionalCandidates(null)}><X size={18} className="text-gray-400" /></button>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2 mb-3">
              🏷️ カレンダーで仮登録された以下の利用者がヒットしました。同一人物の場合、紐付けて本登録すると、関連する予定・発注もそのまま引き継がれます。
            </p>
            <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {similarProvisionalCandidates.map((c) => (
                <li key={c.id} className="border border-amber-200 rounded-xl p-3 bg-amber-50/40">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800">{c.name}</span>
                    <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">仮</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">{c.address ?? "（住所未登録）"}</p>
                  <button
                    onClick={() => handleLinkToProvisional(c.id)}
                    disabled={addingClient}
                    className="mt-2 w-full py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50"
                  >
                    この仮登録と紐付けて本登録
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => setSimilarProvisionalCandidates(null)}
                disabled={addingClient}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
              >
                戻る
              </button>
              <button
                onClick={handleSkipProvisionalLink}
                disabled={addingClient}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-gray-500 hover:bg-gray-600 disabled:opacity-50"
              >
                {addingClient ? "追加中…" : "別人として新規作成"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 入院中一覧モーダル */}
      {hospDateDialog && (() => {
        const day = hospDateInput ? parseInt(hospDateInput.split("-")[2]) : null;
        // 入院：16日以降 → その月は前半分のみ（半月請求）
        // 退院：15日以前 → その月は後半分のみ（半月請求）
        const isFirstHalf = day !== null && day <= 15;
        const isHalfBilling =
          hospDateDialog.mode === "admit" ? !isFirstHalf   // 入院が後半→半月
          : isFirstHalf;                                    // 退院が前半→半月
        const halfLabel = isFirstHalf ? "前半（1〜15日）" : "後半（16日〜月末）";
        const billingLabel = isHalfBilling ? "半月分の請求" : "1か月分の請求";
        const billingColor = isHalfBilling ? "text-amber-600 bg-amber-50" : "text-emerald-700 bg-emerald-50";

        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-5">
              <p className="text-sm font-semibold text-gray-800 mb-1">
                {hospDateDialog.client.name}
              </p>
              <p className="text-xs text-gray-500 mb-3">
                {hospDateDialog.mode === "admit" ? "入院日を入力してください" : "退院日を入力してください"}
              </p>
              <input
                type="date"
                value={hospDateInput}
                onChange={e => setHospDateInput(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 mb-3 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              {day !== null && (
                <div className={`rounded-xl px-3 py-2 mb-4 flex items-center justify-between ${billingColor}`}>
                  <span className="text-xs font-medium">{halfLabel}</span>
                  <span className="text-xs font-bold">{billingLabel}</span>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setHospDateDialog(null)}
                  className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmHospDate}
                  disabled={!hospDateInput}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                    hospDateDialog.mode === "admit" ? "bg-red-500 hover:bg-red-600" : "bg-emerald-500 hover:bg-emerald-600"
                  }`}
                >
                  {hospDateDialog.mode === "admit" ? "入院登録" : "退院登録"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showJissekiModal && (() => {
        const [jYear, jMonth] = jissekiMonth.split("-").map(Number);
        const reiwaYear = jYear - 2018;
        const reiwaLabel = `令和${reiwaYear}年${jMonth}月`;

        const prevJMonth = () => {
          const d = new Date(jYear, jMonth - 2, 1);
          setJissekiMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };
        const nextJMonth = () => {
          const d = new Date(jYear, jMonth, 1);
          setJissekiMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };

        // 入院中（その月）
        const monthStart = `${jissekiMonth}-01`;
        const monthEnd = monthEndYmd(jYear, jMonth);
        const hospInMonth = new Set(
          hospitalizations
            .filter(h => h.admission_date <= monthEnd && (h.discharge_date === null || h.discharge_date >= monthStart))
            .map(h => h.client_id)
        );

        // 統合レンタル行の型
        type JissekiRow = { equipName: string; category: string; code: string; monthlyPrice: number | null; modelNumber: string | null };

        // client_rental_history から
        const rentalByClient = new Map<string, JissekiRow[]>();
        for (const r of jissekiRentals) {
          const category = r.notes ?? "";
          if (!rentalByClient.has(r.client_id)) rentalByClient.set(r.client_id, []);
          rentalByClient.get(r.client_id)!.push({ equipName: r.equipment_name, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: r.monthly_price, modelNumber: r.model_number });
        }
        // orderItems（rental_started）から補完
        for (const item of orderItems) {
          if (item.status !== "rental_started") continue;
          const ord = orders.find(o => o.id === item.order_id);
          if (!ord?.client_id) continue;
          if (rentalByClient.has(ord.client_id)) continue;
          const eq = equipment.find(e => e.product_code === item.product_code);
          const category = eq?.category ?? "";
          rentalByClient.set(ord.client_id, []);
          rentalByClient.get(ord.client_id)!.push({ equipName: eq?.name ?? item.product_code, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: item.rental_price, modelNumber: null });
        }
        // orderItems — 同一利用者の複数用具を追加（rental_historyある利用者も含む）
        for (const item of orderItems) {
          if (item.status !== "rental_started") continue;
          const ord = orders.find(o => o.id === item.order_id);
          if (!ord?.client_id) continue;
          const existing = rentalByClient.get(ord.client_id);
          if (!existing) continue; // historyデータがない場合は上で処理済み
          const eq = equipment.find(e => e.product_code === item.product_code);
          const category = eq?.category ?? "";
          const equipName = eq?.name ?? item.product_code;
          // 同じ用具名が既に入っていれば追加しない
          if (!existing.some(r => r.equipName === equipName)) {
            existing.push({ equipName, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: item.rental_price, modelNumber: null });
          }
        }

        // ケアマネ単位でグループ化: key = "org||name"
        type CmGroup = { org: string; name: string; key: string; clients: { client: Client; rentals: JissekiRow[] }[] };
        const cmGroupMap = new Map<string, CmGroup>();
        for (const c of clients) {
          const rows = rentalByClient.get(c.id);
          if (!rows || rows.length === 0) continue;
          const org = c.care_manager_org ?? "";
          const name = c.care_manager ?? "";
          const key = `${org}||${name}`;
          if (!cmGroupMap.has(key)) cmGroupMap.set(key, { org, name, key, clients: [] });
          cmGroupMap.get(key)!.clients.push({ client: c, rentals: rows });
        }
        const cmGroups = Array.from(cmGroupMap.values())
          .sort((a, b) => a.org.localeCompare(b.org, "ja") || a.name.localeCompare(b.name, "ja"));
        cmGroups.forEach(g => g.clients.sort((a, b) => (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja")));

        // プレビュー対象グループ（チェック済み or 単独指定）
        const previewGroups = jissekiPreview
          ? (jissekiCmKey !== "__ALL__"
              ? cmGroups.filter(g => g.key === jissekiCmKey)
              : cmGroups.filter(g => jissekiSelectedKeys.has(g.key)))
          : [];

        // フラグ操作ヘルパー
        const getFlag = (rowKey: string) => jissekiFlags[rowKey] ?? { half: false, daily: false, hold: false };
        const toggleFlag = (rowKey: string, flag: "half" | "daily" | "hold") => {
          setJissekiFlags(prev => ({ ...prev, [rowKey]: { ...getFlag(rowKey), [flag]: !getFlag(rowKey)[flag] } }));
        };

        // ── プレビュー画面 ──────────────────────────────────────────
        if (jissekiPreview && previewGroups.length > 0) {
          const today = new Date();
          const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

          const renderGroupPage = (group: typeof previewGroups[0]) => (
            <div key={group.key} className="bg-white shadow-xl w-[210mm] px-10 py-8 mb-6 print:shadow-none print:w-full print:px-8 print:py-4 print:mb-0 print:break-after-page" style={{ minHeight: "297mm" }}>
              {/* タイトル行 */}
              <div className="flex items-end justify-between mb-3">
                <div className="text-sm font-bold">{reiwaLabel}分</div>
                <div className="text-xl font-bold underline tracking-widest">サービス利用実績表</div>
                <div className="text-xs text-right">{todayStr}</div>
              </div>
              {/* 送り主 ＋ 矢印 ＋ 受け先 */}
              <div className="flex items-stretch gap-3 mb-4">
                <div className="border border-gray-400 p-3 text-xs flex-none w-52">
                  <div className="font-bold text-sm mb-2">{tenantInfo?.company_name ?? "（会社名未設定）"}</div>
                  <div>事業所番号：{tenantInfo?.business_number ?? "−"}</div>
                  <div>TEL：{tenantInfo?.company_tel ?? "−"}</div>
                  <div>FAX：{tenantInfo?.company_fax ?? "−"}</div>
                </div>
                <div className="flex items-center text-2xl text-gray-400 shrink-0">→</div>
                <div className="border border-gray-400 p-3 text-xs flex-1">
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-sm">{group.org || "（事業所名なし）"}</div>
                    <div className="text-sm font-bold">御中</div>
                  </div>
                  <div className="mt-3 text-base font-bold text-right">{group.name ? `${group.name} 様` : ""}</div>
                </div>
              </div>
              {/* 挨拶文 */}
              <p className="text-xs mb-1">いつもお世話になりありがとうございます。</p>
              <p className="text-xs mb-4">サービス利用実績表をお送りいたします。よろしくお願いいたします。</p>
              {/* メインテーブル */}
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-24">ご利用者様氏名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-28">コード<br/>サービス項目名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium">レンタル商品名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-14">単位数</th>
                    <th colSpan={3} className="border border-gray-600 px-1 py-0.5 text-center font-medium text-[10px]">区分</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-20">備考</th>
                  </tr>
                  <tr>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">半額</th>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">日割</th>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">保留</th>
                  </tr>
                </thead>
                <tbody>
                  {group.clients.map(({ client, rentals }) => {
                    const isHosp = hospInMonth.has(client.id);
                    const totalTani = Math.round(rentals.reduce((s, r) => s + (r.monthlyPrice ?? 0), 0) / 10);
                    return (
                      <Fragment key={client.id}>
                        {rentals.map((r, ri) => {
                          const rowKey = `${client.id}-${ri}`;
                          const flags = getFlag(rowKey);
                          const tani = r.monthlyPrice ? Math.round(r.monthlyPrice / 10) : null;
                          return (
                            <tr key={ri}>
                              {ri === 0 && (
                                <td rowSpan={rentals.length} className={`border border-gray-600 px-1 py-1 text-center align-top font-medium ${isHosp ? "text-red-600" : ""}`}>
                                  {client.name} 様{isHosp && <div className="text-[10px] text-red-500">（入院中）</div>}
                                </td>
                              )}
                              <td className="border border-gray-600 px-1 py-0.5">
                                <div className="font-mono text-[10px]">{r.code}</div>
                                <div>{r.category}</div>
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5">{r.equipName}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-right">{tani !== null ? tani.toLocaleString() : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.half} onChange={() => toggleFlag(rowKey, "half")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.daily} onChange={() => toggleFlag(rowKey, "daily")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.hold} onChange={() => toggleFlag(rowKey, "hold")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.half ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.daily ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.hold ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5"></td>
                            </tr>
                          );
                        })}
                        <tr className="bg-gray-50">
                          <td colSpan={2} className="border border-gray-600 px-2 py-0.5 text-center font-medium">合計</td>
                          <td className="border border-gray-600 px-2 py-0.5 text-right">金額</td>
                          <td className="border border-gray-600 px-1 py-0.5 text-right font-bold">{totalTani.toLocaleString()}</td>
                          <td colSpan={3} className="border border-gray-600 px-2 py-0.5 text-center print:hidden">単位数</td>
                          <td colSpan={3} className="border border-gray-600 px-2 py-0.5 text-center hidden print:table-cell">単位数</td>
                          <td className="border border-gray-600 px-1 py-0.5 text-right font-bold">{totalTani.toLocaleString()}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );

          return (
            <div className="fixed inset-0 bg-gray-300 z-50 flex flex-col">
              <div className="bg-gray-800 text-white px-4 py-2 flex items-center gap-3 shrink-0 print:hidden">
                <button onClick={() => { setJissekiPreview(false); setJissekiCmKey("__ALL__"); }} className="flex items-center gap-1 text-sm text-gray-300 hover:text-white">
                  <ChevronLeft size={16} />戻る
                </button>
                <span className="text-sm flex-1">{reiwaLabel}分　{previewGroups.length}事業所</span>
                <button onClick={() => window.print()} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-400">印刷</button>
              </div>
              <div className="flex-1 overflow-y-auto py-6 flex flex-col items-center print:py-0 print:block">
                {previewGroups.map(g => renderGroupPage(g))}
              </div>
            </div>
          );
        }

        // ── 通常モーダル（ケアマネ一覧・チェック選択） ─────────────
        const allChecked = cmGroups.length > 0 && cmGroups.every(g => jissekiSelectedKeys.has(g.key));
        const checkedCount = cmGroups.filter(g => jissekiSelectedKeys.has(g.key)).length;

        return (
          <div className="fixed inset-0 bg-black/60 flex items-end z-50">
            <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
              {/* ヘッダー */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold text-gray-800 text-sm">サービス利用実績表</span>
                  <div className="flex items-center gap-1">
                    <button onClick={prevJMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft size={16} /></button>
                    <span className="text-sm font-medium text-gray-700 w-32 text-center">{reiwaLabel}</span>
                    <button onClick={nextJMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight size={16} /></button>
                  </div>
                  <span className="text-xs text-gray-500">{cmGroups.length}事業所</span>
                </div>
                <button onClick={() => { setShowJissekiModal(false); setJissekiPreview(false); setJissekiCmKey("__ALL__"); }}>
                  <X size={20} className="text-gray-400" />
                </button>
              </div>
              {/* 全選択・全解除 + プレビューボタン */}
              {cmGroups.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 shrink-0 bg-gray-50">
                  <button
                    onClick={() => setJissekiSelectedKeys(allChecked ? new Set() : new Set(cmGroups.map(g => g.key)))}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    {allChecked ? "全解除" : "全選択"}
                  </button>
                  <span className="text-xs text-gray-500 flex-1">{checkedCount}件選択中</span>
                  <button
                    onClick={() => { setJissekiCmKey("__ALL__"); setJissekiPreview(true); }}
                    disabled={checkedCount === 0}
                    className="px-4 py-1.5 rounded-xl text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-40"
                  >
                    プレビュー・印刷
                  </button>
                </div>
              )}
              {/* ケアマネ一覧 */}
              <div className="flex-1 overflow-y-auto">
                {jissekiLoading ? (
                  <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-emerald-400" /></div>
                ) : cmGroups.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-16">該当する用具レンタルがありません</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {cmGroups.map(g => {
                      const checked = jissekiSelectedKeys.has(g.key);
                      return (
                        <li
                          key={g.key}
                          className={`px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ${checked ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          onClick={() => setJissekiSelectedKeys(prev => {
                            const next = new Set(prev);
                            // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
                            checked ? next.delete(g.key) : next.add(g.key);
                            return next;
                          })}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {}}
                            className="w-4 h-4 rounded accent-blue-500 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">{g.org || "（事業所名なし）"}</div>
                            <div className="text-xs text-gray-500">{g.name || "（担当者名なし）"}　{g.clients.length}名</div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}

// ─── Client Detail ───────────────────────────────────────────────────────────

function ClientDetail({
  client,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  allOrderItems,
  equipment,
  tenantId,
  currentOfficeId,
  initialViewMode,
  hospitalizations,
  onBack,
}: {
  client: Client;
  allOrderItems: OrderItem[];
  equipment: Equipment[];
  tenantId: string;
  currentOfficeId: string | null;
  initialViewMode?: "current" | "insurance";
  hospitalizations?: import("@/lib/supabase").ClientHospitalization[];
  onBack: () => void;
}) {
  const [clientItems, setClientItems] = useState<OrderItem[]>([]);
  const [orderPaymentMap, setOrderPaymentMap] = useState<Record<string, "介護" | "自費">>({});
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [topTab, setTopTab] = useState<"usage" | "basic" | "insurance" | "kouhi" | "keido">(initialViewMode === "insurance" ? "insurance" : "usage");
  const [insuranceSubTab, setInsuranceSubTab] = useState<"care" | "medical">("care");
  const [viewMode, setViewMode] = useState<"current" | "monthly" | "docs" | "rental_history">("current");
  const [editingBasic, setEditingBasic] = useState(false);
  const [basicForm, setBasicForm] = useState({ name: client.name, furigana: client.furigana ?? "", phone: client.phone ?? "", mobile: client.mobile ?? "", address: client.address ?? "", gender: client.gender ?? "", care_manager: client.care_manager ?? "", care_manager_org: client.care_manager_org ?? "", care_office_id: client.care_office_id ?? "", care_manager_id: client.care_manager_id ?? "", referrer_org: client.referrer_org ?? "", memo: "", is_facility: client.is_facility ?? false });
  const [basicSaving, setBasicSaving] = useState(false);
  // ── メモ (client_memos scope='tenant') ──────────────────────────────────────
  // clients.memo 列は DROP 済。メモの実体は client_memos に移っており、
  // kaigo-app の利用者詳細が同じ scope='tenant' で読み書きしている。
  // 以前はここが旧 clients.memo を見ていたため **既存メモが表示されず、
  // 入力しても保存時に捨てられていた** (2026-09-03 是正)。
  const [tenantMemo, setTenantMemo] = useState<{ id: string | null; body: string }>({ id: null, body: "" });
  const editingBasicRef = useRef(false);
  useEffect(() => { editingBasicRef.current = editingBasic; }, [editingBasic]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("client_memos")
        .select("id, body")
        .eq("client_id", client.id)
        .eq("scope", "tenant")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) { console.error("client_memos fetch failed:", error.message); return; }
      const next = { id: (data?.id as string) ?? null, body: (data?.body as string) ?? "" };
      setTenantMemo(next);
      // 編集中でなければ入力欄にも反映 (編集中は入力途中の内容を上書きしない)
      if (!editingBasicRef.current) setBasicForm((f) => ({ ...f, memo: next.body }));
    })();
    return () => { cancelled = true; };
  }, [client.id, tenantId]);

  /**
   * メモを client_memos (scope='tenant') に保存する。kaigo-app の利用者詳細と同じ規則:
   *   既存あり + 空文字 → DELETE / 既存あり + 中身あり → UPDATE / 既存なし + 中身あり → INSERT
   *   author_id・pinned は既定値のまま (kaigo-app 側も設定していない)
   * @returns エラーメッセージ (成功時 null)。silent failure にしないため呼出側で必ず出す。
   */
  const saveTenantMemo = async (input: string): Promise<string | null> => {
    const body = input.trim();
    if (tenantMemo.id) {
      if (body === "") {
        const { error } = await supabase.from("client_memos").delete().eq("id", tenantMemo.id);
        if (error) return error.message;
        setTenantMemo({ id: null, body: "" });
        return null;
      }
      const { error } = await supabase.from("client_memos").update({ body }).eq("id", tenantMemo.id);
      if (error) return error.message;
      setTenantMemo((m) => ({ ...m, body }));
      return null;
    }
    if (body === "") return null; // 元から無く、入力も空 → 何もしない
    const { data, error } = await supabase
      .from("client_memos")
      .insert({ client_id: client.id, scope: "tenant", tenant_id: tenantId, body })
      .select("id")
      .single();
    if (error) return error.message;
    setTenantMemo({ id: (data?.id as string) ?? null, body });
    return null;
  };
  // 居宅/ケアマネマスタ（ドロップダウン用）
  const [careOfficesList, setCareOfficesList] = useState<Array<{ id: string; name: string; self_office_id?: string | null }>>([]);
  const [careManagersList, setCareManagersList] = useState<Array<{ id: string; care_office_id: string; name: string }>>([]);
  useEffect(() => {
    (async () => {
      // self_office_id (自社紐づけ) 込みで取得。列未適用 DB では旧 select に fallback
      type OffRow = { id: string; name: string; self_office_id?: string | null };
      let offData: OffRow[] = [];
      const withSelf = await supabase.from("care_offices").select("id, name, self_office_id").eq("tenant_id", tenantId).order("name");
      if (!withSelf.error) {
        offData = (withSelf.data ?? []) as OffRow[];
      } else if (["42703", "PGRST204", "PGRST205"].includes(withSelf.error.code ?? "")) {
        const plain = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId).order("name");
        if (plain.error) console.error("care_offices fetch failed:", plain.error.message);
        else offData = (plain.data ?? []) as OffRow[];
      } else {
        console.error("care_offices fetch failed:", withSelf.error.message);
      }
      const mgrRes = await supabase.from("care_managers").select("id, care_office_id, name").eq("tenant_id", tenantId).eq("active", true).order("name");
      setCareOfficesList(offData);
      setCareManagersList((mgrRes.data ?? []) as Array<{ id: string; care_office_id: string; name: string }>);
    })();
  }, [tenantId]);

  // 居宅選択時（"__ADD__" で新規追加プロンプト）
  async function handleOfficeChange(value: string) {
    if (value === "__ADD__") {
      const name = window.prompt("新しい居宅介護支援事業所の名前を入力してください");
      if (!name?.trim()) return;
      const { data, error } = await supabase.from("care_offices").insert({ tenant_id: tenantId, name: name.trim() }).select("id, name").single();
      if (error) { alert("追加に失敗しました\n" + error.message); return; }
      const newOffice = data as { id: string; name: string };
      setCareOfficesList((prev) => [...prev, newOffice].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setBasicForm((f) => ({ ...f, care_office_id: newOffice.id, care_manager_org: newOffice.name, care_manager_id: "", care_manager: "" }));
      return;
    }
    const office = careOfficesList.find((o) => o.id === value);
    setBasicForm((f) => ({
      ...f,
      care_office_id: value,
      care_manager_org: office?.name ?? "",
      // 居宅を変えたらケアマネはクリア（事業所ごとに紐付いているため）
      care_manager_id: "",
      care_manager: "",
    }));
  }

  // ケアマネ選択時
  async function handleManagerChange(value: string) {
    if (value === "__ADD__") {
      if (!basicForm.care_office_id) { alert("先に居宅を選択してください"); return; }
      const name = window.prompt("新しいケアマネジャーの氏名を入力してください");
      if (!name?.trim()) return;
      const { data, error } = await supabase.from("care_managers").insert({ tenant_id: tenantId, care_office_id: basicForm.care_office_id, name: name.trim(), active: true }).select("id, care_office_id, name").single();
      if (error) { alert("追加に失敗しました\n" + error.message); return; }
      const newMgr = data as { id: string; care_office_id: string; name: string };
      setCareManagersList((prev) => [...prev, newMgr].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setBasicForm((f) => ({ ...f, care_manager_id: newMgr.id, care_manager: newMgr.name }));
      return;
    }
    const mgr = careManagersList.find((m) => m.id === value);
    setBasicForm((f) => ({ ...f, care_manager_id: value, care_manager: mgr?.name ?? "" }));
  }
  // 本登録モーダル（仮登録→正式登録）
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteSaving, setPromoteSaving] = useState(false);
  const [promoteForm, setPromoteForm] = useState({
    name: client.name,
    furigana: client.furigana ?? "",
    gender: client.gender ?? "",
    phone: client.phone ?? "",
    mobile: client.mobile ?? "",
    address: client.address ?? "",
    is_facility: client.is_facility ?? false,
    care_manager: client.care_manager ?? "",
    care_manager_org: client.care_manager_org ?? "",
    care_level: client.care_level ?? "",
    benefit_rate: client.benefit_rate ?? "",
    copay_rate: client.copay_rate ?? "",
    insured_number: client.insured_number ?? "",
    birth_date: client.birth_date ?? "",
    insurer_number: client.insurer_number ?? "",
    certification_start_date: client.certification_start_date ?? "",
    certification_end_date: client.certification_end_date ?? "",
    memo: "", // client_memos から流し込む
  });
  // 保険情報（複数レコード）
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [selectedInsuranceId, setSelectedInsuranceId] = useState<string | null>(null);
  const [insuranceForm, setInsuranceForm] = useState<Omit<ClientInsuranceRecord, "id" | "tenant_id" | "client_id" | "created_at"> | null>(null);
  const [editingInsuranceId, setEditingInsuranceId] = useState<string | null>(null);
  const [insuranceSaving, setInsuranceSaving] = useState(false);
  // 不完全 (保険者番号 + 被保険者番号 + 認定年月日 がいずれも未設定) の行は default 非表示
  const [showIncompleteInsurance, setShowIncompleteInsurance] = useState(false);

  const emptyInsuranceForm = (): Omit<ClientInsuranceRecord, "id" | "tenant_id" | "client_id" | "created_at"> => ({
    effective_date: null, insured_number: null, birth_date: null, care_level: client.care_level ?? null,
    certification_start_date: null, certification_end_date: null, insurer_name: null, insurer_number: null,
    copay_rate: null, public_expense: null, care_manager: client.care_manager ?? null, care_manager_org: client.care_manager_org ?? null, notes: null,
    issued_date: null, insurance_confirmed_date: null, qualification_date: null,
    insurance_valid_start: null, insurance_valid_end: null,
    certification_date: null, certification_status: "認定済み",
    service_limit_period_start: null, service_limit_period_end: null, service_limit_amount: null,
    service_memo: null, service_restriction: "なし",
    benefit_type: null, benefit_content: null, benefit_rate: null,
    benefit_period_start: null, benefit_period_end: null,
    support_office_date: null, record_status: "認定済み",
    care_office_id: null, care_manager_id: null,
  });
  // レンタル履歴（手動登録）
  const [rentalHistoryRecords, setRentalHistoryRecords] = useState<ClientRentalHistory[]>([]);
  const [rentalHistoryForm, setRentalHistoryForm] = useState<Omit<ClientRentalHistory, "id" | "tenant_id" | "client_id" | "source" | "created_at"> | null>(null);
  const [editingRentalHistoryId, setEditingRentalHistoryId] = useState<string | null>(null);
  const [rentalHistorySaving, setRentalHistorySaving] = useState(false);
  // 公費情報
  const [publicExpenses, setPublicExpenses] = useState<import("@/lib/supabase").ClientPublicExpense[]>([]);
  const [selectedPeId, setSelectedPeId] = useState<string | null>(null);
  const [peForm, setPeForm] = useState<Omit<import("@/lib/supabase").ClientPublicExpense, "id"|"tenant_id"|"client_id"|"created_at"> | null>(null);
  const [editingPeId, setEditingPeId] = useState<string | null>(null);
  const [peSaving, setPeSaving] = useState(false);

  const emptyPeForm = () => ({
    hohei_code: null, futan_sha_number: null, jukyu_sha_number: null,
    valid_start: null, valid_end: null, confirmed_date: null,
    application_type: null, outpatient_copay: null, special_type: null, inpatient_copay: null,
  });

  // 福祉用具 軽度者 例外給付記録 (B-6d・2026-09-05)
  const [keidoGrants, setKeidoGrants] = useState<import("@/lib/fukuyoguExceptions").FukuyoguExceptionGrant[]>([]);
  const [keidoTableMissing, setKeidoTableMissing] = useState(false);
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null);
  const [grantForm, setGrantForm] = useState<Omit<import("@/lib/fukuyoguExceptions").FukuyoguExceptionGrant, "id" | "tenant_id" | "client_id" | "created_at" | "updated_at"> | null>(null);
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [grantSaving, setGrantSaving] = useState(false);
  const emptyGrantForm = () => ({
    restriction_group: "車いす系", judgment_route: null,
    doctor_opinion_date: null, meeting_confirmed_date: null, insurer_confirmed_date: null,
    valid_from: todayYmd(), valid_end: null, notes: null,
  });

  const [regenDoc, setRegenDoc] = useState<ClientDocument | null>(null);
  const [showCarePlan, setShowCarePlan] = useState(false);
  const [carePlanInitialParams, setCarePlanInitialParams] = useState<Record<string, unknown> | null>(null);
  const [showProposal, setShowProposal] = useState(false);
  const [proposalInitialParams, setProposalInitialParams] = useState<Record<string, unknown> | null>(null);
  const [emailPreview, setEmailPreview] = useState<{ order: Order; items: OrderItem[]; suppliers: Supplier[]; members: Member[]; sentAt?: string; emailType?: "new_order" | "rental_started" | "terminated" | "cancelled" } | null>(null);
  const [showDocuments, setShowDocuments] = useState(false);
  const [yearMonth, setYearMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [dateInput, setDateInput] = useState<{
    item: OrderItem;
    nextStatus: OrderItem["status"];
    date: string;
    deliveredAt?: string;
  } | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  // 利用期間 (client_office_assignments) — Stage A
  const [clientAssignments, setClientAssignments] = useState<ClientOfficeAssignment[]>([]);
  const [assignmentOffices, setAssignmentOffices] = useState<Office[]>([]);
  const [assignmentEditingId, setAssignmentEditingId] = useState<string | null>(null);
  const [assignmentEditForm, setAssignmentEditForm] = useState<{ start_date: string; end_date: string }>({ start_date: "", end_date: "" });
  const [assignmentAdding, setAssignmentAdding] = useState<{ office_id: string; start_date: string; end_date: string } | null>(null);
  const [showAssignmentHistory, setShowAssignmentHistory] = useState(false);
  const [startDatePicker, setStartDatePicker] = useState<{ officeId: string; officeName: string; date: string } | null>(null);
  const [endDatePicker, setEndDatePicker] = useState<{ officeId: string; officeName: string; date: string } | null>(null);

  // 月次実績送信 (居宅事業所宛)
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordYearMonth, setRecordYearMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [recordToast, setRecordToast] = useState<{ kind: "success" | "error"; msg: string } | null>(null);

  const reloadAssignments = useCallback(async () => {
    try {
      const rows = await getClientAssignmentsForClient(client.id);
      setClientAssignments(rows);
    } catch (e) { console.error("利用期間の取得に失敗", e); }
  }, [client.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rows, offs] = await Promise.all([
          getClientAssignmentsForClient(client.id),
          getOffices(tenantId),
        ]);
        if (!cancelled) {
          setClientAssignments(rows);
          setAssignmentOffices(offs);
        }
      } catch (e) { console.error("利用期間/事業所の初期取得に失敗", e); }
    })();
    return () => { cancelled = true; };
  }, [client.id, tenantId]);


  // 帳票の会社欄: 事業所ごとの設定 > 事業所・法人マスタ > グループ共通 (lib/officeCompanyInfo.ts)
  useEffect(() => {
    let cancelled = false;
    getOfficeCompanyInfo(tenantId, currentOfficeId)
      .then((r) => { if (!cancelled) setCompanyInfo(r.info); })
      .catch((e) => console.error("会社情報の取得に失敗:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      // 第1バッチ：全て並列
      const [{ data: ordersData }, insurResult, rentalResult, peResult, grantResult, docs] = await Promise.all([
        supabase.from("orders").select("id, payment_type").eq("tenant_id", tenantId).eq("client_id", client.id),
        supabase.from("client_insurance_records").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("effective_date", { ascending: false }),
        supabase.from("client_rental_history").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("start_date", { ascending: false }),
        supabase.from("client_public_expenses").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("valid_start", { ascending: false }),
        supabase.from("fukuyogu_exception_grants").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("valid_from", { ascending: false }),
        getClientDocuments(tenantId, client.id),
      ]);
      setInsuranceRecords((insurResult.data ?? []) as ClientInsuranceRecord[]);
      setRentalHistoryRecords((rentalResult.data ?? []) as ClientRentalHistory[]);
      if (!peResult.error) setPublicExpenses((peResult.data ?? []) as import("@/lib/supabase").ClientPublicExpense[]);
      // ⚠ migrations/fukuyogu_exception_grants.sql 未適用の間は 42P01 (table不在) になる。
      //   その場合はタブ自体に「テーブル未作成」の案内を出す (握りつぶさない)。
      if (grantResult.error) {
        const missing = grantResult.error.code === "42P01" || grantResult.error.code === "PGRST205";
        setKeidoTableMissing(missing);
        if (!missing) console.error("例外給付記録の取得失敗:", grantResult.error.message);
      } else {
        setKeidoTableMissing(false);
        setKeidoGrants((grantResult.data ?? []) as import("@/lib/fukuyoguExceptions").FukuyoguExceptionGrant[]);
      }
      setDocuments(docs);
      if (ordersData && ordersData.length > 0) {
        const orderIds = ordersData.map((o: { id: string; payment_type: string }) => o.id);
        const payMap: Record<string, "介護" | "自費"> = {};
        ordersData.forEach((o: { id: string; payment_type: string }) => {
          if (o.payment_type === "自費") payMap[o.id] = "自費";
          else payMap[o.id] = "介護";
        });
        setOrderPaymentMap(payMap);
        // 第2バッチ：order_items 取得後に price_history も並列
        const { data: items } = await supabase.from("order_items").select("*").in("order_id", orderIds);
        const loaded = items ?? [];
        setClientItems(loaded);
        const codes = [...new Set(loaded.map((i) => i.product_code))];
        const history = await getPriceHistory(tenantId, codes);
        setPriceHistory(history);
      } else {
        setClientItems([]);
        setPriceHistory([]);
      }
    } finally {
      setLoading(false);
    }
  }, [client.id, tenantId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { loadItems(); }, [loadItems]);

  const today = todayYmd();

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"]) => {
    if (nextStatus === "delivered" || nextStatus === "rental_started" || nextStatus === "terminated") {
      setDateInput({ item, nextStatus, date: today });
    } else {
      execStatusChange(item, nextStatus);
    }
  };

  const execStatusChange = async (
    item: OrderItem,
    newStatus: OrderItem["status"],
    date?: string
  ) => {
    setUpdatingId(item.id);
    try {
      const extra: Record<string, string> = {};
      if (newStatus === "delivered" && date) extra.delivered_at = date;
      if (newStatus === "rental_started" && date) extra.rental_start_date = date;
      if (newStatus === "terminated" && date) extra.rental_end_date = date;
      await updateOrderItemStatus(item.id, newStatus, Object.keys(extra).length ? extra : undefined);
      setDateInput(null);
      await loadItems();
      // レンタル開始・解約・キャンセル時はメール送信画面を表示
      if (newStatus === "rental_started" || newStatus === "terminated" || newStatus === "cancelled") {
        const [{ data: orderData }, orderItems, suppliers, members] = await Promise.all([
          supabase.from("orders").select("*").eq("id", item.order_id).single(),
          getOrderItems(item.order_id),
          getSuppliers(),
          getMembers(tenantId),
        ]);
        if (orderData) {
          setEmailPreview({ order: orderData as Order, items: orderItems, suppliers, members, emailType: newStatus as "rental_started" | "terminated" | "cancelled" });
        }
        // Stage A: rental_started 時に利用期間を自動 INSERT (open 行が無ければ)
        // 開始日は item.rental_start_date を使用 (manual 入力の date)
        if (newStatus === "rental_started") {
          const officeId = (orderData as Order | null)?.office_id ?? currentOfficeId;
          if (officeId) {
            try {
              const startDate = date ?? item.rental_start_date ?? todayYmd();
              await ensureActiveAssignment(client.id, officeId, tenantId, startDate);
              await reloadAssignments();
            } catch (e) { console.error("利用期間の自動作成に失敗", e); }
          }
        }
        // Stage A: terminated/cancelled 時に「全 item が非 active」になったか check、
        // なれば利用期間を auto-close (end_date = item の終了日 or 今日)
        if (newStatus === "terminated" || newStatus === "cancelled") {
          const officeId = (orderData as Order | null)?.office_id ?? currentOfficeId;
          if (officeId) {
            try {
              // client × office 配下で rental_started item が他に残ってないか確認
              const { data: remaining } = await supabase
                .from("order_items")
                .select("id, order_id, orders!inner(client_id, office_id)")
                .eq("status", "rental_started")
                .eq("orders.client_id", client.id)
                .eq("orders.office_id", officeId)
                .neq("id", item.id);
              if ((remaining ?? []).length === 0) {
                const endDate = date ?? item.rental_end_date ?? todayYmd();
                await closeActiveAssignment(client.id, officeId, endDate);
                await reloadAssignments();
              }
            } catch (e) { console.error("利用期間の自動クローズに失敗", e); }
          }
        }
      }
    } finally {
      setUpdatingId(null);
    }
  };

  const equipName = (code: string) =>
    equipment.find((e) => e.product_code === code)?.name ?? code;

  // 指定年月にレンタル中だった用具（開始日 <= 月末 かつ 終了日 >= 月初 or まだ終了していない）
  const monthlyItems = (() => {
    const [y, m] = yearMonth.split("-").map(Number);
    const monthStart = `${yearMonth}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
    return clientItems.filter((i) => {
      if (i.status === "cancelled") return false;
      const start = i.rental_start_date;
      const end = i.rental_end_date;
      if (!start) return false;
      if (start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    });
  })();

  const activeItems = clientItems.filter((i) => i.status === "rental_started");
  const orderedItems = clientItems.filter((i) => i.status === "ordered");
  const deliveredItems = clientItems.filter((i) => ["delivered", "trial"].includes(i.status));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const pendingItems = clientItems.filter((i) =>
    ["ordered", "delivered", "trial"].includes(i.status)
  );
  const historyItems = clientItems.filter((i) =>
    i.status === "terminated" || i.status === "cancelled"
  );
  const monthlyTotal = activeItems.reduce((sum, i) => sum + (i.rental_price ?? 0), 0);

  const changeYearMonth = (delta: number) => {
    const [y, m] = yearMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setYearMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleSaveInsuranceRecord = async () => {
    if (!insuranceForm) return;
    setInsuranceSaving(true);
    try {
      if (editingInsuranceId) {
        const { error } = await supabase.from("client_insurance_records").update(insuranceForm).eq("id", editingInsuranceId);
        if (error) {
          console.warn("client_insurance_records update failed:", error.message);
          alert(`保険情報の更新に失敗しました: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("client_insurance_records").insert({ ...insuranceForm, tenant_id: tenantId, client_id: client.id });
        if (error) {
          console.warn("client_insurance_records insert failed:", error.message);
          alert(`保険情報の登録に失敗しました: ${error.message}`);
          return;
        }
      }
      setInsuranceForm(null);
      setEditingInsuranceId(null);
      await loadItems();
    } finally {
      setInsuranceSaving(false);
    }
  };

  const handleDeleteInsuranceRecord = async (id: string) => {
    if (!confirm("この保険情報を削除しますか？")) return;
    const { error } = await supabase.from("client_insurance_records").delete().eq("id", id);
    if (error) { alert(`保険情報の削除に失敗しました: ${error.message}`); return; }
    await loadItems();
  };

  const handleSaveRentalHistory = async () => {
    if (!rentalHistoryForm || !rentalHistoryForm.equipment_name.trim()) return;
    setRentalHistorySaving(true);
    try {
      if (editingRentalHistoryId) {
        const { error } = await supabase.from("client_rental_history").update(rentalHistoryForm).eq("id", editingRentalHistoryId);
        if (error) {
          console.warn("client_rental_history update failed:", error.message);
          alert(`レンタル履歴の更新に失敗しました: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("client_rental_history").insert({ ...rentalHistoryForm, tenant_id: tenantId, client_id: client.id, source: "manual" });
        if (error) {
          console.warn("client_rental_history insert failed:", error.message);
          alert(`レンタル履歴の登録に失敗しました: ${error.message}`);
          return;
        }
      }
      setRentalHistoryForm(null);
      setEditingRentalHistoryId(null);
      await loadItems();
    } finally {
      setRentalHistorySaving(false);
    }
  };

  const handleDeleteRentalHistory = async (id: string) => {
    if (!confirm("このレンタル履歴を削除しますか？")) return;
    const { error } = await supabase.from("client_rental_history").delete().eq("id", id);
    if (error) { alert(`レンタル履歴の削除に失敗しました: ${error.message}`); return; }
    await loadItems();
  };

  // 用具行共通（ステータス変更ボタン付き）- table行として使用
  const ItemCard = ({ item, dim = false, priceOverride }: { item: OrderItem; dim?: boolean; priceOverride?: number }) => (
    <Fragment>
      <tr className={dim ? "opacity-75" : ""}>
        {/* ステータス（左ボーダー付き） */}
        <td className={`pl-2 py-2 w-[5.5rem] border-l-4 ${dim ? "border-gray-200" : "border-emerald-400"}`}>
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_COLOR[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
        </td>
        {/* 用具名 */}
        <td className="py-2 pr-2 max-w-0">
          <span className={`block truncate text-sm font-medium ${dim ? "text-gray-600" : "text-gray-800"}`}>
            {equipName(item.product_code)}
          </span>
        </td>
        {/* レンタル価格 */}
        <td className="py-2 pr-3 w-[7rem] whitespace-nowrap text-right">
          {(() => { const p = priceOverride ?? item.rental_price; return p ? (
            <span className="text-sm font-bold text-emerald-600">
              ¥{p.toLocaleString()}<span className="text-xs font-normal">/月</span>
            </span>
          ) : null; })()}
        </td>
        {/* 開始・終了日 */}
        <td className="py-2 pr-2 w-[15rem] text-xs text-gray-400 whitespace-nowrap">
          {item.rental_start_date && <span className="mr-3">開始: {item.rental_start_date}</span>}
          {item.rental_end_date && <span>終了: {item.rental_end_date}</span>}
        </td>
        {/* アクションボタン */}
        <td className="py-2 pr-3 whitespace-nowrap">
          {NEXT_STATUSES[item.status].length > 0 && dateInput?.item.id !== item.id && (
            <div className="flex gap-1.5">
              {NEXT_STATUSES[item.status].map((next) => (
                <button
                  key={next}
                  disabled={updatingId === item.id}
                  onClick={() => handleStatusClick(item, next)}
                  className={`shrink-0 text-xs px-3 py-1 rounded-full border font-medium transition-colors disabled:opacity-50 ${
                    next === "cancelled" || next === "terminated"
                      ? "border-red-200 text-red-500 hover:bg-red-50"
                      : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                  }`}
                >
                  {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : `→ ${STATUS_LABEL[next]}`}
                </button>
              ))}
            </div>
          )}
        </td>
      </tr>
      {/* 日付入力行 */}
      {dateInput?.item.id === item.id && (
        <tr>
          <td colSpan={5} className="px-3 pb-2">
            <div className="bg-emerald-50 rounded-xl p-3 space-y-2">
              <p className="text-xs font-medium text-emerald-700">
                {dateInput.nextStatus === "delivered" ? "納品日" : dateInput.nextStatus === "rental_started" ? "レンタル開始日" : "解約日"}を入力
              </p>
              <div className="flex gap-2 items-center">
                <input
                  type="date"
                  value={dateInput.date}
                  onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                  className="w-44 border border-blue-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue-400 bg-white"
                />
                <button
                  disabled={!dateInput.date || updatingId === item.id}
                  onClick={() => execStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
                  className="px-4 bg-blue-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : "確定"}
                </button>
                <button onClick={() => setDateInput(null)} className="px-3 py-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack}>
          <ChevronLeft size={20} className="text-gray-500" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-800">{client.name}</h2>
            {client.gender && <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-md">{client.gender}</span>}
            {hospitalizations?.some(h => h.client_id === client.id && h.discharge_date === null)
              ? <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-600">入院中</span>
              : <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">在籍中</span>
            }
          </div>
          {client.furigana && <p className="text-xs text-gray-400">{client.furigana}</p>}
        </div>
        <button
          onClick={() => setShowDocuments(true)}
          title="重要事項説明書・契約書を作成"
          className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-xl hover:bg-blue-50 transition-colors"
        >
          <FileText size={14} />
          書類作成
        </button>
        <button
          onClick={() => setShowReport(true)}
          title="貸与提供報告書を作成"
          className="flex items-center gap-1.5 text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1.5 rounded-xl hover:bg-emerald-50 transition-colors"
        >
          <FileText size={14} />
          報告書
        </button>
        {/* 削除 / 復元ボタン（ソフト削除） */}
        {client.deleted_at ? (
          <button
            onClick={async () => {
              if (!confirm("この利用者を復元しますか？")) return;
              setBasicSaving(true);
              try {
                await restoreClient(client.id);
                Object.assign(client, { deleted_at: null });
                alert("復元しました");
                onBack();
              } catch (e) {
                const msg = (e as { message?: string })?.message ?? String(e);
                alert(`復元に失敗しました\n${msg}`);
              } finally {
                setBasicSaving(false);
              }
            }}
            disabled={basicSaving}
            title="削除済み利用者を復元"
            className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-2.5 py-1.5 rounded-xl disabled:opacity-50 transition-colors"
          >
            <RotateCcw size={14} />
            復元
          </button>
        ) : (
          <button
            onClick={async () => {
              const orderCount = clientItems.length;
              if (!client.is_provisional && orderCount > 0) {
                alert(`この利用者には発注履歴が ${orderCount} 件あるため削除できません。\n\n削除したい場合は、先に発注をキャンセルまたは完了してください。`);
                return;
              }
              const extraNote = client.is_provisional && orderCount > 0
                ? `\n（発注 ${orderCount} 件は残ります）`
                : "";
              if (!confirm(`利用者「${client.name}」を削除しますか？${extraNote}\n\nソフト削除のため、ゴミ箱から復元可能です。`)) return;
              setBasicSaving(true);
              try {
                await softDeleteClient(client.id);
                onBack();
              } catch (e) {
                const msg = (e as { message?: string })?.message ?? String(e);
                alert(`削除に失敗しました\n${msg}`);
              } finally {
                setBasicSaving(false);
              }
            }}
            disabled={basicSaving}
            title="この利用者を削除（ソフト削除）"
            className="flex items-center gap-1.5 text-xs text-red-500 border border-red-200 px-2.5 py-1.5 rounded-xl hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={14} />
            削除
          </button>
        )}
      </div>

      {/* 発注メール再送モーダル */}
      {emailPreview && (
        <OrderEmailPreviewModal
          order={emailPreview.order}
          orderItems={emailPreview.items}
          clients={[client]}
          equipment={equipment}
          suppliers={emailPreview.suppliers}
          members={emailPreview.members}
          emailType={emailPreview.emailType ?? "new_order"}
          tenantId={tenantId}
          sentAt={emailPreview.sentAt}
          onClose={() => setEmailPreview(null)}
          onBack={() => setEmailPreview(null)}
          onDone={() => setEmailPreview(null)}
        />
      )}

      {/* 貸与報告書モーダル */}
      {(showReport || regenDoc) && (
        <RentalReportModal
          client={client}
          items={clientItems}
          orderPaymentMap={orderPaymentMap}
          equipment={equipment}
          companyInfo={companyInfo}
          priceHistory={priceHistory}
          tenantId={tenantId}
          initialParams={regenDoc ? (regenDoc.params as { targetMonth: string; visitDate: string; memo: string; selectedUsage: string[] }) : undefined}
          onClose={() => { setShowReport(false); setRegenDoc(null); }}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
          }}
        />
      )}

      {/* 書類作成モーダル（重要事項説明書＋契約書） */}
      {showDocuments && (
        <ContractDocumentsModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          onClose={() => setShowDocuments(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowDocuments(false);
          }}
        />
      )}

      {/* 個別援助計画書モーダル */}
      {showCarePlan && (
        <CarePlanModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          initialParams={carePlanInitialParams ?? undefined}
          onClose={() => setShowCarePlan(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowCarePlan(false);
          }}
        />
      )}

      {/* 選定提案書モーダル */}
      {showProposal && (
        <ProposalModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          initialParams={proposalInitialParams ?? undefined}
          onClose={() => setShowProposal(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowProposal(false);
          }}
        />
      )}

      {/* トップタブ */}
      <div className="bg-white border-b border-gray-200 px-4 flex gap-0 shrink-0">
        {([["usage","利用状況"],["basic","基本情報"],["insurance","介護保険"],["kouhi","公費"],["keido","福祉用具 例外給付"]] as [typeof topTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTopTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${topTab === t ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            {label}
          </button>
        ))}
      </div>
      {/* 利用状況サブタブ */}
      {topTab === "usage" && (
        <div className="bg-white border-b border-gray-100 px-4 py-2 flex gap-1.5 shrink-0">
          <button onClick={() => setViewMode("current")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "current" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            現在
          </button>
          <button onClick={() => setViewMode("monthly")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "monthly" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            月別
          </button>
          <button onClick={() => setViewMode("rental_history")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "rental_history" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            履歴
          </button>
          <button onClick={() => setViewMode("docs")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "docs" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            書類{documents.length > 0 && <span className="ml-1 opacity-70">({documents.length})</span>}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : topTab === "basic" ? (
        /* 基本情報タブ */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-800">基本情報</h3>
                {client.is_provisional && (
                  <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded">🏷️ 仮登録</span>
                )}
              </div>
              {!editingBasic ? (
                <div className="flex gap-2">
                  {client.is_provisional && (
                    <button
                      onClick={() => {
                        setPromoteForm({
                          name: client.name,
                          furigana: client.furigana ?? "",
                          gender: client.gender ?? "",
                          phone: client.phone ?? "",
                          mobile: client.mobile ?? "",
                          address: client.address ?? "",
                          is_facility: client.is_facility ?? false,
                          care_manager: client.care_manager ?? "",
                          care_manager_org: client.care_manager_org ?? "",
                          care_level: client.care_level ?? "",
                          benefit_rate: client.benefit_rate ?? "",
                          copay_rate: client.copay_rate ?? "",
                          insured_number: client.insured_number ?? "",
                          birth_date: client.birth_date ?? "",
                          insurer_number: client.insurer_number ?? "",
                          certification_start_date: client.certification_start_date ?? "",
                          certification_end_date: client.certification_end_date ?? "",
                          memo: tenantMemo.body,
                        });
                        setPromoteOpen(true);
                      }}
                      disabled={basicSaving}
                      className="text-xs text-white bg-amber-500 hover:bg-amber-600 px-3 py-1 rounded-lg disabled:opacity-50"
                    >
                      本登録する
                    </button>
                  )}
                  <button onClick={() => setEditingBasic(true)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">編集</button>
                  {/* 削除 / 復元 ボタン */}
                  {client.deleted_at ? (
                    <button
                      onClick={async () => {
                        if (!confirm("この利用者を復元しますか？")) return;
                        setBasicSaving(true);
                        try {
                          await restoreClient(client.id);
                          Object.assign(client, { deleted_at: null });
                          alert("復元しました");
                          onBack();
                        } catch (e) {
                          const msg = (e as { message?: string })?.message ?? String(e);
                          alert(`復元に失敗しました\n${msg}`);
                        } finally {
                          setBasicSaving(false);
                        }
                      }}
                      disabled={basicSaving}
                      className="text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1 rounded-lg disabled:opacity-50"
                    >
                      復元
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        // 発注履歴の有無をチェック（仮登録は無条件で削除可）
                        const orderCount = clientItems.length;
                        if (!client.is_provisional && orderCount > 0) {
                          alert(`この利用者には発注履歴が ${orderCount} 件あるため削除できません。\n\n削除したい場合は、先に発注をキャンセルまたは完了してください。`);
                          return;
                        }
                        const extraNote = client.is_provisional && orderCount > 0
                          ? `\n（発注 ${orderCount} 件は残ります）`
                          : "";
                        if (!confirm(`利用者「${client.name}」を削除しますか？${extraNote}\n\nソフト削除のため、ゴミ箱から復元可能です。`)) return;
                        setBasicSaving(true);
                        try {
                          await softDeleteClient(client.id);
                          onBack();
                        } catch (e) {
                          const msg = (e as { message?: string })?.message ?? String(e);
                          alert(`削除に失敗しました\n${msg}`);
                        } finally {
                          setBasicSaving(false);
                        }
                      }}
                      disabled={basicSaving}
                      className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      削除
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { setEditingBasic(false); setBasicForm({ name: client.name, furigana: client.furigana ?? "", phone: client.phone ?? "", mobile: client.mobile ?? "", address: client.address ?? "", gender: client.gender ?? "", care_manager: client.care_manager ?? "", care_manager_org: client.care_manager_org ?? "", care_office_id: client.care_office_id ?? "", care_manager_id: client.care_manager_id ?? "", referrer_org: client.referrer_org ?? "", memo: tenantMemo.body, is_facility: client.is_facility ?? false }); }} className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg">キャンセル</button>
                  <button onClick={async () => {
                    setBasicSaving(true);
                    // 空文字のIDは NULL に変換して保存。
                    // memo は clients から DROP 済なので payload には含めず、
                    // client_memos (scope='tenant') 側へ保存する (kaigo-app と同じ形)。
                    const { memo: memoInput, ...basicWithoutMemo } = basicForm;
                    const payload = {
                      ...basicWithoutMemo,
                      care_office_id: basicForm.care_office_id || null,
                      care_manager_id: basicForm.care_manager_id || null,
                    };
                    const { error } = await supabase.from("clients").update(payload).eq("id", client.id);
                    if (error) { setBasicSaving(false); alert(`基本情報の保存に失敗しました: ${error.message}`); return; }
                    const memoErr = await saveTenantMemo(memoInput);
                    setBasicSaving(false);
                    if (memoErr) { alert(`メモの保存に失敗しました: ${memoErr}`); return; }
                    setEditingBasic(false);
                    Object.assign(client, payload);
                  }} disabled={basicSaving} className="text-xs text-white bg-blue-500 px-3 py-1 rounded-lg disabled:opacity-50">{basicSaving ? "保存中…" : "保存"}</button>
                </div>
              )}
            </div>
            {([
              ["氏名", "name"],["ふりがな","furigana"],["性別","gender"],
              ["電話","phone"],["携帯","mobile"],["住所","address"],
              ["紹介機関","referrer_org"],
            ] as [string, "name"|"furigana"|"gender"|"phone"|"mobile"|"address"|"referrer_org"][]).map(([label, key]) => (
              <div key={key} className="flex items-start gap-3 border-b border-gray-50 pb-2">
                <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">{label}</span>
                {editingBasic ? (
                  <input
                    type="text"
                    value={basicForm[key]}
                    onChange={(e) => setBasicForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400"
                  />
                ) : (
                  <span className="flex-1 text-sm text-gray-800">{(client as Record<string, unknown>)[key] as string || <span className="text-gray-300">—</span>}</span>
                )}
              </div>
            ))}
            {/* 居宅（マスタ連携） */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">居宅</span>
              {editingBasic ? (
                <select
                  value={basicForm.care_office_id}
                  onChange={(e) => handleOfficeChange(e.target.value)}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400 bg-white"
                >
                  <option value="">—</option>
                  {careOfficesList.some((o) => o.self_office_id) && (
                    <optgroup label="自社グループ">
                      {careOfficesList.filter((o) => o.self_office_id).map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="他社">
                    {careOfficesList.filter((o) => !o.self_office_id).map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </optgroup>
                  <option value="__ADD__">＋ 新規追加...</option>
                </select>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.care_office_id
                    ? (careOfficesList.find((o) => o.id === client.care_office_id)?.name ?? client.care_manager_org ?? <span className="text-gray-300">—</span>)
                    : (client.care_manager_org || <span className="text-gray-300">—</span>)}
                </span>
              )}
            </div>
            {/* ケアマネ（マスタ連携。居宅が選択されていないと選べない） */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">ケアマネ</span>
              {editingBasic ? (
                <select
                  value={basicForm.care_manager_id}
                  onChange={(e) => handleManagerChange(e.target.value)}
                  disabled={!basicForm.care_office_id}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400 bg-white disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">—</option>
                  {careManagersList
                    .filter((m) => m.care_office_id === basicForm.care_office_id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  <option value="__ADD__">＋ 新規追加...</option>
                </select>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.care_manager_id
                    ? (careManagersList.find((m) => m.id === client.care_manager_id)?.name ?? client.care_manager ?? <span className="text-gray-300">—</span>)
                    : (client.care_manager || <span className="text-gray-300">—</span>)}
                </span>
              )}
            </div>
            {/* メモ */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">メモ</span>
              {editingBasic ? (
                <input
                  type="text"
                  value={basicForm.memo}
                  onChange={(e) => setBasicForm((f) => ({ ...f, memo: e.target.value }))}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400"
                />
              ) : (
                <span className="flex-1 text-sm text-gray-800">{tenantMemo.body || <span className="text-gray-300">—</span>}</span>
              )}
            </div>
            {/* 居宅・施設等（事業所/施設フラグ） */}
            <div className="flex items-center gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400">居宅・施設等</span>
              {editingBasic ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={basicForm.is_facility}
                    onChange={(e) => setBasicForm((f) => ({ ...f, is_facility: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-gray-700">事業所・施設としてマーク</span>
                </label>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.is_facility
                    ? <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">🏢 事業所・施設</span>
                    : <span className="text-gray-300">—</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : topTab === "usage" && viewMode === "current" ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-emerald-600">{activeItems.length}</p>
              <p className="text-xs text-emerald-600">レンタル中</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-gray-700">¥{monthlyTotal.toLocaleString()}</p>
              <p className="text-xs text-gray-500">月額合計</p>
            </div>
          </div>

          {/* 利用期間 (client_office_assignments) — kaigo-app 風 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500">事業所別 利用状況</h3>
              <button
                onClick={() => setShowAssignmentHistory((v) => !v)}
                className="text-[11px] text-gray-500 hover:text-gray-700 underline">
                {showAssignmentHistory ? "履歴を閉じる" : "履歴を開く"}
              </button>
            </div>

            {/* 月次実績送信 (居宅事業所宛) */}
            <div className="bg-white rounded-xl shadow-sm px-3 py-2.5 mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">月次実績</span>
              <input
                type="month"
                value={recordYearMonth}
                onChange={(e) => setRecordYearMonth(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <button
                onClick={() => setShowRecordModal(true)}
                disabled={!currentOfficeId}
                title={!currentOfficeId ? "送信元事業所が選択されていません" : "居宅事業所に当月の福祉用具実績を送信"}
                className="ml-auto text-[11px] px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5">
                <Send size={12} />
                居宅事業所に実績送信
              </button>
            </div>

            {/* 全 office (福祉用具) 一覧 + toggle */}
            <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-100 mb-3">
              {assignmentOffices.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">事業所が登録されていません</p>
              ) : assignmentOffices.map((o) => {
                const activeAssignment = clientAssignments.find((a) => a.office_id === o.id && a.end_date === null);
                const isActive = !!activeAssignment;
                return (
                  <div key={o.id} className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-medium text-sm truncate ${o.id === currentOfficeId ? "text-gray-800" : "text-gray-500"}`}>{o.name}</span>
                      {o.id === currentOfficeId && <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0">自事業所</span>}
                      {isActive && <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded shrink-0">利用中</span>}
                      {isActive && activeAssignment.start_date && (
                        <span className="text-[10px] text-gray-400 shrink-0">{activeAssignment.start_date}〜</span>
                      )}
                    </div>
                    {o.id === currentOfficeId ? (
                      <button
                        onClick={() => {
                          const today = todayYmd();
                          if (isActive) {
                            setEndDatePicker({ officeId: o.id, officeName: o.name, date: today });
                          } else {
                            setStartDatePicker({ officeId: o.id, officeName: o.name, date: today });
                          }
                        }}
                        className={`text-[11px] px-2.5 py-1 rounded-lg shrink-0 ${isActive ? "bg-red-500 hover:bg-red-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}>
                        {isActive ? "利用終了" : "利用開始"}
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400 shrink-0">他事業所のため操作不可</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 履歴 (折り畳み) */}
            {showAssignmentHistory && (
            <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-gray-500">履歴 (期間 詳細編集)</h4>
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    const today = todayYmd();
                    const defaultOffice = currentOfficeId ?? assignmentOffices[0]?.id ?? "";
                    setAssignmentAdding({ office_id: defaultOffice, start_date: today, end_date: "" });
                  }}
                  className="text-[11px] px-2 py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
                  期間追加
                </button>
              </div>
            </div>
            {assignmentAdding && (
              <div className="bg-blue-50 rounded-xl p-3 mb-2 space-y-2">
                <div className="flex flex-wrap gap-2 items-center text-xs">
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">事業所</span>
                    <select
                      value={assignmentAdding.office_id}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, office_id: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs">
                      {assignmentOffices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">開始</span>
                    <input
                      type="date"
                      value={assignmentAdding.start_date}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, start_date: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs" />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">終了</span>
                    <input
                      type="date"
                      value={assignmentAdding.end_date}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, end_date: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs" />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setAssignmentAdding(null)}
                    className="text-[11px] px-2 py-1 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">キャンセル</button>
                  <button
                    onClick={async () => {
                      if (!assignmentAdding.office_id || !assignmentAdding.start_date) {
                        alert("事業所と開始日を入力してください"); return;
                      }
                      try {
                        await addAssignment(
                          tenantId, client.id, assignmentAdding.office_id,
                          assignmentAdding.start_date,
                          assignmentAdding.end_date || null,
                        );
                        setAssignmentAdding(null);
                        await reloadAssignments();
                      } catch (e) { alert("追加に失敗: " + (e instanceof Error ? e.message : String(e))); }
                    }}
                    className="text-[11px] px-2 py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600">保存</button>
                </div>
              </div>
            )}
            {clientAssignments.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">利用期間の記録はありません</p>
            ) : (
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left text-xs">
                <tbody className="divide-y divide-gray-100">
                  {clientAssignments.map((a) => {
                    const officeName = assignmentOffices.find((o) => o.id === a.office_id)?.name ?? "(未設定の事業所)";
                    const isActive = a.end_date === null;
                    const isEditing = assignmentEditingId === a.id;
                    return (
                      <tr key={a.id} className="px-2">
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-800">{officeName}</span>
                            {isActive && <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">利用中</span>}
                          </div>
                          {isEditing ? (
                            <div className="flex flex-wrap gap-2 items-center mt-1.5">
                              <input
                                type="date"
                                value={assignmentEditForm.start_date}
                                onChange={(e) => setAssignmentEditForm({ ...assignmentEditForm, start_date: e.target.value })}
                                className="border border-gray-300 rounded px-2 py-1 text-xs" />
                              <span className="text-gray-400">〜</span>
                              <input
                                type="date"
                                value={assignmentEditForm.end_date}
                                onChange={(e) => setAssignmentEditForm({ ...assignmentEditForm, end_date: e.target.value })}
                                className="border border-gray-300 rounded px-2 py-1 text-xs" />
                              <button
                                onClick={async () => {
                                  try {
                                    await updateAssignment(a.id, {
                                      start_date: assignmentEditForm.start_date || null,
                                      end_date: assignmentEditForm.end_date || null,
                                    });
                                    setAssignmentEditingId(null);
                                    await reloadAssignments();
                                  } catch (e) { alert("更新に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                }}
                                className="text-[11px] px-2 py-0.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600">保存</button>
                              <button
                                onClick={() => setAssignmentEditingId(null)}
                                className="text-[11px] px-2 py-0.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">×</button>
                            </div>
                          ) : (
                            <div className="text-gray-600 mt-0.5">
                              {a.start_date ?? "(開始未設定)"} 〜 {a.end_date ?? "(継続中)"}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top w-32 text-right">
                          {!isEditing && (
                            <div className="flex flex-col items-end gap-1">
                              <button
                                onClick={() => {
                                  setAssignmentEditingId(a.id);
                                  setAssignmentEditForm({ start_date: a.start_date ?? "", end_date: a.end_date ?? "" });
                                }}
                                className="text-[11px] text-blue-600 hover:underline">編集</button>
                              {isActive && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`${officeName} の利用を終了しますか？(終了日 = 今日)`)) return;
                                    try {
                                      await closeActiveAssignment(client.id, a.office_id);
                                      await reloadAssignments();
                                    } catch (e) { alert("利用終了に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                  }}
                                  className="text-[11px] text-red-600 hover:underline">利用終了</button>
                              )}
                              <button
                                onClick={async () => {
                                  if (!confirm("この利用期間を削除しますか？(履歴から消えます)")) return;
                                  try {
                                    await deleteAssignment(a.id);
                                    await reloadAssignments();
                                  } catch (e) { alert("削除に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                }}
                                className="text-[11px] text-gray-400 hover:underline">削除</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            </div>
            )}
          </section>

          {orderedItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">発注済み</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{orderedItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {deliveredItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">納品済み</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{deliveredItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {activeItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">レンタル中</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{activeItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {historyItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">過去のレンタル</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{historyItems.map((i) => <ItemCard key={i.id} item={i} dim />)}</tbody></table>
            </section>
          )}
          {clientItems.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">発注データがありません</p>
          )}
        </div>
      ) : viewMode === "monthly" ? (
        /* 月別ビュー */
        <div className="flex flex-col h-full">
          {/* 年月切り替え */}
          <div className="bg-white border-b border-gray-100 px-4 py-2 flex items-center justify-between shrink-0">
            <button onClick={() => changeYearMonth(-1)} className="p-2 hover:bg-gray-100 rounded-xl">
              <ChevronLeft size={18} className="text-gray-500" />
            </button>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-800">
                {yearMonth.replace("-", "年")}月
              </p>
              <p className="text-xs text-gray-400">{monthlyItems.filter(i => i.status !== "terminated").length}点レンタル中</p>
            </div>
            <button onClick={() => changeYearMonth(1)} className="p-2 hover:bg-gray-100 rounded-xl">
              <ChevronRight size={18} className="text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {monthlyItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">この月のレンタルはありません</p>
            ) : (() => {
              const activeMonthly = monthlyItems.filter((i) => i.status !== "terminated");
              const terminatedMonthly = monthlyItems.filter((i) => i.status === "terminated");
              const getHistoricalPrice = (item: OrderItem) =>
                getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? item.rental_price ?? 0;
              const activeTotal = activeMonthly.reduce((s, i) => s + getHistoricalPrice(i), 0);
              return (
                <>
                  {/* レンタル中 */}
                  {activeMonthly.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">レンタル中</p>
                      <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left">
                        <tbody className="divide-y divide-dashed divide-gray-200">
                          {activeMonthly.map((item) => (
                            <ItemCard key={item.id} item={item}
                              priceOverride={getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? undefined}
                            />
                          ))}
                        </tbody>
                      </table>
                      {/* 月額合計 */}
                      <div className="bg-emerald-50 rounded-xl px-3 py-2.5 mt-2 flex items-center justify-between">
                        <span className="text-xs text-emerald-700 font-medium">月額合計</span>
                        <span className="text-base font-bold text-emerald-700">
                          ¥{activeTotal.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                  {/* 解約済 */}
                  {terminatedMonthly.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">解約済</p>
                      <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left">
                        <tbody className="divide-y divide-dashed divide-gray-200">
                          {terminatedMonthly.map((item) => (
                            <ItemCard key={item.id} item={item} dim
                              priceOverride={getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? undefined}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      ) : viewMode === "docs" ? (
        /* 書類タブ */
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 作成ボタン */}
          <div className="flex gap-2">
            <button
              onClick={() => { setCarePlanInitialParams(null); setShowCarePlan(true); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium rounded-xl hover:bg-blue-100"
            >
              <Plus size={13} /> 個別援助計画書
            </button>
            <button
              onClick={() => { setProposalInitialParams(null); setShowProposal(true); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium rounded-xl hover:bg-blue-100"
            >
              <Plus size={13} /> 選定提案書
            </button>
          </div>

          {documents.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">保存済みの書類はありません<br /><span className="text-xs">報告書を開いて「履歴に保存」を押すと記録されます</span></p>
          ) : (
            documents.map((doc) => (
              <div key={doc.id} className="bg-white rounded-xl px-3 py-2.5 flex items-center gap-2 shadow-sm">
                <FileText size={16} className={doc.type === "supplier_email" ? "text-blue-400" : doc.type === "care_plan" ? "text-purple-400" : doc.type === "proposal" ? "text-amber-400" : "text-emerald-400"} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{doc.title}</p>
                  <p className="text-xs text-gray-400">{new Date(doc.created_at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })}</p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      if (doc.type === "rental_report") setRegenDoc(doc);
                      else if (doc.type === "care_plan") { setCarePlanInitialParams(doc.params); setShowCarePlan(true); }
                      else if (doc.type === "proposal") { setProposalInitialParams(doc.params); setShowProposal(true); }
                      else if (doc.type === "contract" || doc.type === "rental_contract" || doc.type === "important_matters") setShowDocuments(true);
                      else if (doc.type === "supplier_email") {
                        const orderId = doc.params?.orderId as string | undefined;
                        if (!orderId) {
                          alert("この発注メール書類には発注ID(orderId)が記録されていないため、再生成できません。\n古い書類の可能性があります。");
                          return;
                        }
                        // まず orderId で直接検索 (未統合 or 統合先)
                        const [orderRes, suppliers, members] = await Promise.all([
                          supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
                          getSuppliers(),
                          getMembers(tenantId),
                        ]);
                        if (orderRes.error) {
                          console.error("発注取得エラー:", orderRes.error);
                          alert(`発注の取得に失敗しました: ${orderRes.error.message}`);
                          return;
                        }
                        let foundOrder: Order | null = (orderRes.data as Order) ?? null;
                        // 見つからなければ merged_from_order_ids で統合先 order を検索
                        if (!foundOrder) {
                          const { data: mergedRows } = await supabase
                            .from("orders")
                            .select("*")
                            .contains("merged_from_order_ids", [{ id: orderId }]);
                          if (mergedRows && mergedRows.length > 0) {
                            foundOrder = mergedRows[0] as Order;
                          }
                        }
                        if (!foundOrder) {
                          alert("元の発注が見つかりません（削除された可能性があります）。");
                          return;
                        }
                        const items = await getOrderItems(foundOrder.id);
                        setEmailPreview({ order: foundOrder, items, suppliers, members, sentAt: doc.created_at });
                      }
                    } catch (e) {
                      console.error("再生成エラー:", e);
                      alert(`再生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                  className="shrink-0 text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50"
                >
                  再生成
                </button>
                <button
                  onClick={async () => {
                    await deleteClientDocument(doc.id);
                    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
                  }}
                  className="shrink-0 text-xs text-red-400 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50"
                >
                  削除
                </button>
              </div>
            ))
          )}
        </div>
      ) : topTab === "insurance" ? (
        /* 介護保険タブ */
        (() => {
          const selRec = insuranceRecords.find(r => r.id === selectedInsuranceId) ?? insuranceRecords[0] ?? null;
          const F = insuranceForm;
          const fv = (key: string) => F ? ((F as Record<string, unknown>)[key] as string) ?? "" : "";
          const sf = (key: string, val: string) => setInsuranceForm(f => f ? { ...f, [key]: val || null } : f);
          const CARE_LEVELS = ["要支援1","要支援2","要介護1","要介護2","要介護3","要介護4","要介護5"];
          return (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 介護認定 / 医療保険 サブタブ */}
            <div className="shrink-0 flex gap-0 border-b border-gray-200 bg-gray-50 px-4 pt-2">
              {([["care","介護認定"],["medical","医療保険"]] as ["care"|"medical",string][]).map(([t, label]) => (
                <button key={t} onClick={() => setInsuranceSubTab(t)}
                  className={`px-5 py-2 text-sm font-medium border-b-2 transition-colors ${insuranceSubTab === t ? "border-blue-500 text-blue-600 bg-white" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
                  {label}
                </button>
              ))}
            </div>

            {insuranceSubTab === "medical" ? (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">医療保険情報（準備中）</div>
            ) : (<>

            {/* 履歴一覧テーブル */}
            {(() => {
              const incompleteCount = insuranceRecords.filter(
                (r) => !r.insurer_number && !r.insured_number && !r.certification_date,
              ).length;
              const visibleRecords = showIncompleteInsurance
                ? insuranceRecords
                : insuranceRecords.filter(
                    (r) => r.insurer_number || r.insured_number || r.certification_date,
                  );
              return (
            <div className="shrink-0 mx-4 mt-3 mb-3 border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-700">
                  介護認定 履歴一覧
                  {incompleteCount > 0 && (
                    <span className="ml-2 text-[10px] text-gray-500">
                      ({showIncompleteInsurance ? "全件" : `${visibleRecords.length} 件 + 未入力 ${incompleteCount} 件`})
                    </span>
                  )}
                </span>
                {incompleteCount > 0 && (
                  <label className="flex items-center gap-1 text-[11px] text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showIncompleteInsurance}
                      onChange={(e) => setShowIncompleteInsurance(e.target.checked)}
                      className="accent-blue-500"
                    />
                    未入力行も表示
                  </label>
                )}
              </div>
              <div className="overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs min-w-[700px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {["保険者","被保険者番号","保険有効期間","要介護度","認定年月日","認定有効期間",""].map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {visibleRecords.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">保険情報がありません</td></tr>
                  ) : visibleRecords.map((rec, idx) => {
                    const isSelected = (selectedInsuranceId ? rec.id === selectedInsuranceId : idx === 0) && !insuranceForm;
                    const careColor = rec.care_level?.includes("支援") ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700";
                    return (
                      <tr key={rec.id}
                        onClick={() => { if (!insuranceForm) { setSelectedInsuranceId(rec.id); } }}
                        className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50 border-l-2 border-blue-500" : "hover:bg-gray-50"}`}>
                        <td className="px-3 py-2 text-gray-700">{rec.insurer_number ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 tabular-nums text-gray-700">{rec.insured_number ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {rec.insurance_valid_start && rec.insurance_valid_end
                            ? `${rec.insurance_valid_start} 〜 ${rec.insurance_valid_end}`
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {rec.care_level
                            ? <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${careColor}`}>{rec.care_level}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{rec.certification_date ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {rec.certification_start_date && rec.certification_end_date
                            ? `${rec.certification_start_date} 〜 ${rec.certification_end_date}`
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteInsuranceRecord(rec.id); }} className="text-red-300 hover:text-red-500">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
              );
            })()}

            {/* 詳細フォーム */}
            <div className="flex-1 overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-2.5 border-b-2 border-gray-200 bg-gray-50 sticky top-0">
                <span className="text-sm font-semibold text-gray-800">介護認定 詳細</span>
                <div className="flex gap-2">
                  {insuranceForm ? (
                    <>
                      <button onClick={() => { setInsuranceForm(null); setEditingInsuranceId(null); }} className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50">キャンセル</button>
                      <button onClick={handleSaveInsuranceRecord} disabled={insuranceSaving} className="text-xs text-white bg-blue-500 px-4 py-1.5 rounded-lg disabled:opacity-50">{insuranceSaving ? "保存中…" : "保存"}</button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => { setEditingInsuranceId(null); setInsuranceForm(emptyInsuranceForm()); }}
                        className="flex items-center gap-1 text-xs text-blue-600 border border-blue-300 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100">
                        保険変更
                      </button>
                      <button
                        onClick={() => {
                          const base = selRec ? { ...emptyInsuranceForm(), insured_number: selRec.insured_number, insurer_number: selRec.insurer_number, insurer_name: selRec.insurer_name, copay_rate: selRec.copay_rate, benefit_rate: selRec.benefit_rate } : emptyInsuranceForm();
                          setEditingInsuranceId(null); setInsuranceForm(base);
                        }}
                        className="flex items-center gap-1 text-xs text-white bg-emerald-500 border border-emerald-500 px-3 py-1.5 rounded-lg hover:bg-emerald-600">
                        認定更新
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 3カラムフォーム */}
              <div className="grid grid-cols-3 gap-0 divide-x divide-gray-200 px-0 bg-white">
                {/* 左列: 保険証情報 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">保険証情報</p>
                  {[
                    ["被保険者番号","insured_number"],
                    ["交付年月日","issued_date"],
                    ["保険者番号","insurer_number"],
                    ["保険者名","insurer_name"],
                  ].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="text" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">給付率（%）</label>
                    {insuranceForm
                      ? <input type="text" value={fv("benefit_rate")} onChange={e => sf("benefit_rate", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.benefit_rate || selRec?.copay_rate || "—"}</div>}
                  </div>
                  {[
                    ["保険証確認日","insurance_confirmed_date"],
                    ["資格取得日","qualification_date"],
                  ].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="date" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">保険証有効期間</div>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("insurance_valid_start")} onChange={e => sf("insurance_valid_start", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("insurance_valid_end")} onChange={e => sf("insurance_valid_end", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.insurance_valid_start && selRec?.insurance_valid_end ? `${selRec.insurance_valid_start} 〜 ${selRec.insurance_valid_end}` : "—"}</div>}
                    </div>
                  </div>
                </div>

                {/* 中列: 認定情報 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">認定情報</p>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">要介護状態等</label>
                    <div className="flex gap-4">
                      {["認定済み","申請中"].map(v => (
                        <label key={v} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input type="radio" value={v} checked={(insuranceForm ? fv("certification_status") : selRec?.certification_status) === v || (!insuranceForm && !selRec?.certification_status && v === "認定済み")} onChange={() => insuranceForm && sf("certification_status", v)} disabled={!insuranceForm} className="accent-blue-500" />
                          {v}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">介護度</label>
                    {insuranceForm
                      ? <select value={fv("care_level")} onChange={e => sf("care_level", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="">未設定</option>{CARE_LEVELS.map(v => <option key={v} value={v}>{v}</option>)}</select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_level || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">認定年月日</label>
                    {insuranceForm
                      ? <input type="date" value={fv("certification_date")} onChange={e => sf("certification_date", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.certification_date || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">認定有効期間</div>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("certification_start_date")} onChange={e => sf("certification_start_date", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("certification_end_date")} onChange={e => sf("certification_end_date", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.certification_start_date && selRec?.certification_end_date ? `${selRec.certification_start_date} 〜 ${selRec.certification_end_date}` : "—"}</div>}
                    </div>
                  </div>
                  <div className="border border-gray-200 rounded-xl p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-gray-600">居宅サービス区分</p>
                    <div className="space-y-1">
                      <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">適用期間</div>
                      <div className="flex items-center gap-1">
                        {insuranceForm
                          ? <><input type="date" value={fv("service_limit_period_start")} onChange={e => sf("service_limit_period_start", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("service_limit_period_end")} onChange={e => sf("service_limit_period_end", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                          : <div className="text-sm text-gray-800">{selRec?.service_limit_period_start && selRec?.service_limit_period_end ? `${selRec.service_limit_period_start} 〜 ${selRec.service_limit_period_end}` : "—"}</div>}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-gray-500">区分支給限度額（円）</label>
                      {insuranceForm
                        ? <input type="number" value={F?.service_limit_amount ?? ""} onChange={e => setInsuranceForm(f => f ? {...f, service_limit_amount: e.target.value ? Number(e.target.value) : null} : f)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800">{selRec?.service_limit_amount?.toLocaleString() || "—"}</div>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">留意事項</label>
                    {insuranceForm
                      ? <textarea value={fv("service_memo")} onChange={e => sf("service_memo", e.target.value)} rows={3} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 resize-none" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5 min-h-[60px]">{selRec?.service_memo || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">サービス限定</label>
                    {insuranceForm
                      ? <select value={fv("service_restriction")} onChange={e => sf("service_restriction", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="なし">なし</option><option value="あり">あり</option></select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.service_restriction || "なし"}</div>}
                  </div>
                </div>

                {/* 右列: 介護保険負担割合証・給付制限等 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">介護保険負担割合証・給付制限等</p>
                  {[["給付種類","benefit_type"],["内容","benefit_content"],["給付率（%）","benefit_rate"]].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="text" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">期間</label>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("benefit_period_start")} onChange={e => sf("benefit_period_start", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("benefit_period_end")} onChange={e => sf("benefit_period_end", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.benefit_period_start && selRec?.benefit_period_end ? `${selRec.benefit_period_start} 〜 ${selRec.benefit_period_end}` : "—"}</div>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">支援事業所届出日</label>
                    {insuranceForm
                      ? <input type="date" value={fv("support_office_date")} onChange={e => sf("support_office_date", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.support_office_date || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">居宅介護支援事業所</label>
                    {insuranceForm
                      ? <select
                          value={F?.care_office_id ?? ""}
                          onChange={e => setInsuranceForm(f => f ? { ...f, care_office_id: e.target.value || null } : f)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value="">未選択</option>
                          {careOfficesList.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_office_id ? (careOfficesList.find(o => o.id === selRec.care_office_id)?.name ?? selRec?.care_manager_org ?? "—") : (selRec?.care_manager_org || "—")}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">担当ケアマネージャー</label>
                    {insuranceForm
                      ? <input type="text" value={fv("care_manager")} onChange={e => sf("care_manager", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_manager || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">ステータス</label>
                    {insuranceForm
                      ? <select value={fv("record_status")} onChange={e => sf("record_status", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="認定済み">認定済み</option><option value="申請中">申請中</option><option value="暫定">暫定</option></select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.record_status || "認定済み"}</div>}
                  </div>
                </div>
              </div>
            </div>
            </>)}
          </div>
          );
        })()
      ) : viewMode === "rental_history" ? (
        /* レンタル履歴タブ */
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500">レンタル履歴</h3>
              {!rentalHistoryForm && (
                <button
                  onClick={() => {
                    setEditingRentalHistoryId(null);
                    setRentalHistoryForm({ equipment_name: "", model_number: null, start_date: null, end_date: null, monthly_price: null, notes: null });
                  }}
                  className="text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50"
                >
                  ＋ 手動追加
                </button>
              )}
            </div>

            {/* 手動登録フォーム */}
            {rentalHistoryForm && (
              <div className="bg-blue-50 rounded-xl p-4 mb-3 space-y-2.5">
                <p className="text-xs font-semibold text-blue-700">{editingRentalHistoryId ? "レンタル履歴を編集" : "レンタル履歴を追加"}</p>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">用具名 <span className="text-red-400">*</span></span>
                  <input type="text" value={rentalHistoryForm.equipment_name}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, equipment_name: e.target.value })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">型番</span>
                  <input type="text" value={rentalHistoryForm.model_number ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, model_number: e.target.value || null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                {([["開始日","start_date"],["終了日","end_date"]] as [string,string][]).map(([label, key]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-gray-500">{label}</span>
                    <input type="date" value={(rentalHistoryForm as Record<string,unknown>)[key] as string ?? ""}
                      onChange={(e) => setRentalHistoryForm((f) => f && { ...f, [key]: e.target.value || null })}
                      className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">月額</span>
                  <input type="number" value={rentalHistoryForm.monthly_price ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, monthly_price: e.target.value ? Number(e.target.value) : null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500 pt-0.5">メモ</span>
                  <textarea value={rentalHistoryForm.notes ?? ""} onChange={(e) => setRentalHistoryForm((f) => f && { ...f, notes: e.target.value || null })} rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white resize-none" />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => { setRentalHistoryForm(null); setEditingRentalHistoryId(null); }}
                    className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-white">
                    キャンセル
                  </button>
                  <button onClick={handleSaveRentalHistory} disabled={rentalHistorySaving}
                    className="text-xs text-white bg-blue-500 px-4 py-1.5 rounded-lg disabled:opacity-50">
                    {rentalHistorySaving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            )}

            {/* 合算一覧（システム由来 + 手動） */}
            {(() => {
              const systemEntries = historyItems.map((i) => ({
                id: i.id, source: "system" as const,
                equipment_name: equipName(i.product_code),
                model_number: null as string | null,
                start_date: i.rental_start_date,
                end_date: i.rental_end_date,
                monthly_price: i.rental_price,
                notes: i.notes,
              }));
              const manualEntries = rentalHistoryRecords.map((r) => ({
                id: r.id, source: "manual" as const,
                equipment_name: r.equipment_name,
                model_number: r.model_number,
                start_date: r.start_date,
                end_date: r.end_date,
                monthly_price: r.monthly_price,
                notes: r.notes,
              }));
              const combined = [...systemEntries, ...manualEntries].sort((a, b) =>
                (b.start_date ?? "").localeCompare(a.start_date ?? "")
              );
              if (combined.length === 0) return (
                <p className="text-sm text-gray-400 text-center py-6">レンタル履歴がありません</p>
              );
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[500px]">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">用具名</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">型番</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">開始日</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">終了日</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">月額</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">備考</th>
                        <th className="px-2 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {combined.map((item) => (
                        <tr key={item.id} className="bg-white">
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              {item.source === "manual" && (
                                <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full whitespace-nowrap">手動</span>
                              )}
                              <span className="text-gray-800 font-medium">{item.equipment_name}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-gray-500">{item.model_number ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-2 text-gray-600 whitespace-nowrap">{item.start_date ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-2 text-gray-600 whitespace-nowrap">{item.end_date ?? "継続中"}</td>
                          <td className="px-2 py-2 text-emerald-600 whitespace-nowrap">
                            {item.monthly_price != null ? `¥${item.monthly_price.toLocaleString()}/月` : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-2 py-2 text-gray-400">{item.notes ?? ""}</td>
                          <td className="px-2 py-2">
                            {item.source === "manual" && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    const rec = rentalHistoryRecords.find((r) => r.id === item.id);
                                    if (!rec) return;
                                    setEditingRentalHistoryId(rec.id);
                                    setRentalHistoryForm({ equipment_name: rec.equipment_name, model_number: rec.model_number, start_date: rec.start_date, end_date: rec.end_date, monthly_price: rec.monthly_price, notes: rec.notes });
                                  }}
                                  className="text-gray-400 hover:text-gray-600"
                                >編集</button>
                                <button onClick={() => handleDeleteRentalHistory(item.id)} className="text-red-300 hover:text-red-500">削除</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
        </div>
      ) : topTab === "kouhi" ? (
        /* 公費タブ */
        (() => {
          const HOHEI_OPTIONS = [
            { code: "12", label: "12：生活保護" },
            { code: "21", label: "21：障害（精神通院）" },
            { code: "22", label: "22：更生医療" },
            { code: "25", label: "25：育成医療" },
            { code: "51", label: "51：特定疾患（難病）" },
            { code: "54", label: "54：小児慢性特定疾病" },
          ];
          const APP_TYPES = ["継続", "申請中"];
          const SPECIAL_TYPES = ["職務上", "下船3月以内", "通勤災害"];
          const sel = publicExpenses.find(r => r.id === selectedPeId) ?? publicExpenses[0] ?? null;
          const pf = peForm;
          const pfv = (k: string) => pf ? (String((pf as Record<string,unknown>)[k] ?? "")) : "";
          const spf = (k: string, v: string | number | null) => setPeForm(f => f ? { ...f, [k]: v === "" ? null : v } : f);

          const saveNew = async () => {
            if (!pf) return;
            setPeSaving(true);
            const { data, error } = await supabase.from("client_public_expenses").insert({
              tenant_id: tenantId, client_id: client.id, ...pf,
            }).select().single();
            setPeSaving(false);
            if (!error && data) {
              setPublicExpenses(prev => [data as import("@/lib/supabase").ClientPublicExpense, ...prev]);
              setSelectedPeId(data.id);
              setPeForm(null);
              setEditingPeId(null);
            }
          };
          const saveEdit = async () => {
            if (!pf || !editingPeId) return;
            setPeSaving(true);
            const { error } = await supabase.from("client_public_expenses").update(pf).eq("id", editingPeId);
            setPeSaving(false);
            if (error) { alert(`公費情報の保存に失敗しました: ${error.message}`); return; }
            setPublicExpenses(prev => prev.map(r => r.id === editingPeId ? { ...r, ...pf } : r));
            setEditingPeId(null);
            setPeForm(null);
          };
          const startEdit = (rec: import("@/lib/supabase").ClientPublicExpense) => {
            setSelectedPeId(rec.id);
            setEditingPeId(rec.id);
            setPeForm({
              hohei_code: rec.hohei_code, futan_sha_number: rec.futan_sha_number,
              jukyu_sha_number: rec.jukyu_sha_number, valid_start: rec.valid_start,
              valid_end: rec.valid_end, confirmed_date: rec.confirmed_date,
              application_type: rec.application_type, outpatient_copay: rec.outpatient_copay,
              special_type: rec.special_type, inpatient_copay: rec.inpatient_copay,
            });
          };
          const deleteRec = async (id: string) => {
            if (!confirm("この公費情報を削除しますか？")) return;
            const { error } = await supabase.from("client_public_expenses").delete().eq("id", id);
            if (error) { alert(`公費情報の削除に失敗しました: ${error.message}`); return; }
            setPublicExpenses(prev => prev.filter(r => r.id !== id));
            if (selectedPeId === id) { setSelectedPeId(null); setPeForm(null); setEditingPeId(null); }
          };

          return (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* 一覧テーブル */}
              <div className="shrink-0 mx-4 mt-3 mb-3 border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-700">公費情報 一覧</span>
                  <button
                    onClick={() => { setSelectedPeId(null); setEditingPeId(null); setPeForm(emptyPeForm()); }}
                    className="text-xs text-white bg-emerald-500 px-3 py-1 rounded-lg hover:bg-emerald-600"
                  >＋ 新規</button>
                </div>
                <div className="overflow-x-auto max-h-48 overflow-y-auto">
                  <table className="w-full text-xs min-w-[600px]">
                    <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                      <tr>
                        {["法制コード","負担者番号","受給者番号","有効期間開始日","有効期間終了日","確認日",""].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {publicExpenses.length === 0 ? (
                        <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">公費情報がありません</td></tr>
                      ) : publicExpenses.map(rec => {
                        const hoheiLabel = HOHEI_OPTIONS.find(o => o.code === rec.hohei_code)?.label ?? rec.hohei_code ?? "—";
                        const isSelected = rec.id === selectedPeId;
                        return (
                          <tr key={rec.id}
                            onClick={() => { setSelectedPeId(rec.id); if (editingPeId !== rec.id) { setEditingPeId(null); setPeForm(null); } }}
                            className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          >
                            <td className="px-3 py-2 font-medium text-gray-800">{hoheiLabel}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.futan_sha_number ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.jukyu_sha_number ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_start ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_end ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.confirmed_date ?? "—"}</td>
                            <td className="px-3 py-2 flex gap-1.5 justify-end">
                              <button onClick={e => { e.stopPropagation(); startEdit(rec); }}
                                className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-50">編集</button>
                              <button onClick={e => { e.stopPropagation(); deleteRec(rec.id); }}
                                className="text-xs text-red-400 border border-red-200 px-2 py-0.5 rounded hover:bg-red-50">削除</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 入力フォーム */}
              {pf !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-semibold text-gray-700">
                        {editingPeId ? "公費情報 編集" : "公費情報 新規登録"}
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={() => { setPeForm(null); setEditingPeId(null); }}
                          className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg">キャンセル</button>
                        <button onClick={editingPeId ? saveEdit : saveNew} disabled={peSaving}
                          className="text-xs text-white bg-blue-500 px-3 py-1 rounded-lg disabled:opacity-50">
                          {peSaving ? "保存中…" : "保存"}
                        </button>
                      </div>
                    </div>

                    {/* 法制コード・負担者・受給者番号 */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 法制コード</label>
                        <select value={pfv("hohei_code")} onChange={e => spf("hohei_code", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value="">選択してください</option>
                          {HOHEI_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 負担者番号</label>
                        <input type="text" value={pfv("futan_sha_number")} onChange={e => spf("futan_sha_number", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="8桁" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 受給者番号</label>
                        <input type="text" value={pfv("jukyu_sha_number")} onChange={e => spf("jukyu_sha_number", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="7桁" />
                      </div>
                    </div>

                    {/* 有効期間・確認日 */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 有効期間 開始</label>
                        <input type="date" value={pfv("valid_start")} onChange={e => spf("valid_start", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 有効期間 終了</label>
                        <input type="date" value={pfv("valid_end")} onChange={e => spf("valid_end", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">確認日</label>
                        <input type="date" value={pfv("confirmed_date")} onChange={e => spf("confirmed_date", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                    </div>

                    {/* 申請区分・特別区分・負担金 */}
                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">申請区分</label>
                        <select value={pfv("application_type")} onChange={e => spf("application_type", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value=""></option>
                          {APP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">外来負担金</label>
                        <input type="number" value={pfv("outpatient_copay")} onChange={e => spf("outpatient_copay", e.target.value ? Number(e.target.value) : null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="円" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">特別区分</label>
                        <select value={pfv("special_type")} onChange={e => spf("special_type", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value=""></option>
                          {SPECIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">入院負担金</label>
                        <input type="number" value={pfv("inpatient_copay")} onChange={e => spf("inpatient_copay", e.target.value ? Number(e.target.value) : null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="円" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 選択中の詳細表示（編集モードでない場合） */}
              {pf === null && sel !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-700">公費情報 詳細</h3>
                      <button onClick={() => startEdit(sel)}
                        className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">編集</button>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      {[
                        ["法制コード", HOHEI_OPTIONS.find(o => o.code === sel.hohei_code)?.label ?? sel.hohei_code ?? "—"],
                        ["負担者番号", sel.futan_sha_number ?? "—"],
                        ["受給者番号", sel.jukyu_sha_number ?? "—"],
                        ["有効期間 開始", sel.valid_start ?? "—"],
                        ["有効期間 終了", sel.valid_end ?? "—"],
                        ["確認日", sel.confirmed_date ?? "—"],
                        ["申請区分", sel.application_type ?? "—"],
                        ["外来負担金", sel.outpatient_copay != null ? `${sel.outpatient_copay}円` : "—"],
                        ["特別区分", sel.special_type ?? "—"],
                        ["入院負担金", sel.inpatient_copay != null ? `${sel.inpatient_copay}円` : "—"],
                      ].map(([label, value]) => (
                        <div key={label} className="space-y-0.5">
                          <div className="text-[11px] text-gray-500">{label}</div>
                          <div className="text-sm text-gray-800 font-medium">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {pf === null && sel === null && (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                  「＋ 新規」から公費情報を登録してください
                </div>
              )}
            </div>
          );
        })()
      ) : topTab === "keido" ? (
        /* 福祉用具 軽度者 例外給付タブ (B-6d・2026-09-05) */
        (() => {
          const RESTRICTION_GROUPS = ["車いす系", "特殊寝台系", "床ずれ防止用具", "体位変換器", "徘徊感知機器", "移動用リフト", "自動排泄処理装置"];
          const JUDGMENT_ROUTES = ["医師意見書", "サービス担当者会議等", "その他"];
          const sel = keidoGrants.find(r => r.id === selectedGrantId) ?? null;
          const gf = grantForm;
          const sgf = <K extends keyof NonNullable<typeof gf>>(k: K, v: NonNullable<typeof gf>[K]) =>
            setGrantForm(f => f ? { ...f, [k]: v } : f);

          const saveNew = async () => {
            if (!gf) return;
            setGrantSaving(true);
            const { data, error } = await supabase.from("fukuyogu_exception_grants").insert({
              tenant_id: tenantId, client_id: client.id, ...gf,
            }).select().single();
            setGrantSaving(false);
            if (error) { alert(`例外給付記録の保存に失敗しました: ${error.message}`); return; }
            if (data) {
              setKeidoGrants(prev => [data as import("@/lib/fukuyoguExceptions").FukuyoguExceptionGrant, ...prev]);
              setSelectedGrantId(data.id);
              setGrantForm(null);
              setEditingGrantId(null);
            }
          };
          const saveEdit = async () => {
            if (!gf || !editingGrantId) return;
            setGrantSaving(true);
            const { error } = await supabase.from("fukuyogu_exception_grants").update(gf).eq("id", editingGrantId);
            setGrantSaving(false);
            if (error) { alert(`例外給付記録の保存に失敗しました: ${error.message}`); return; }
            setKeidoGrants(prev => prev.map(r => r.id === editingGrantId ? { ...r, ...gf } : r));
            setEditingGrantId(null);
            setGrantForm(null);
          };
          const startEdit = (rec: import("@/lib/fukuyoguExceptions").FukuyoguExceptionGrant) => {
            setSelectedGrantId(rec.id);
            setEditingGrantId(rec.id);
            setGrantForm({
              restriction_group: rec.restriction_group, judgment_route: rec.judgment_route,
              doctor_opinion_date: rec.doctor_opinion_date, meeting_confirmed_date: rec.meeting_confirmed_date,
              insurer_confirmed_date: rec.insurer_confirmed_date,
              valid_from: rec.valid_from, valid_end: rec.valid_end, notes: rec.notes,
            });
          };
          const deleteRec = async (id: string) => {
            if (!confirm("この例外給付記録を削除しますか？")) return;
            const { error } = await supabase.from("fukuyogu_exception_grants").delete().eq("id", id);
            if (error) { alert(`削除に失敗しました: ${error.message}`); return; }
            setKeidoGrants(prev => prev.filter(r => r.id !== id));
            if (selectedGrantId === id) { setSelectedGrantId(null); setGrantForm(null); setEditingGrantId(null); }
          };

          if (keidoTableMissing) {
            return (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400 px-4 text-center">
                このテーブルはまだ作成されていません (migrations/fukuyogu_exception_grants.sql 未適用)。<br />
                適用後にこのタブが使えるようになります。
              </div>
            );
          }

          return (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="mx-4 mt-3 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                ⚠ このタブは「軽度者(要支援1・2/要介護1)への原則対象外品目」の例外給付を<b>記録するだけ</b>の場所です。
                <b>記録が無い = 例外給付を取っていない、ではありません。</b>現場で例外給付を受けている場合は、その内容をここに記録してください。
                自動排泄処理装置は判定を保留しています(要介護4・5のみ対象という別ルールがあり、当システムでは型を区別できないため)。
              </div>
              {/* 一覧テーブル */}
              <div className="shrink-0 mx-4 mb-3 border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-700">例外給付 記録一覧</span>
                  <button
                    onClick={() => { setSelectedGrantId(null); setEditingGrantId(null); setGrantForm(emptyGrantForm()); }}
                    className="text-xs text-white bg-emerald-500 px-3 py-1 rounded-lg hover:bg-emerald-600"
                  >＋ 新規</button>
                </div>
                <div className="overflow-x-auto max-h-48 overflow-y-auto">
                  <table className="w-full text-xs min-w-[700px]">
                    <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                      <tr>
                        {["対象品目区分", "判定経路", "有効期間開始", "有効期間終了", ""].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {keidoGrants.length === 0 ? (
                        <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">記録がありません</td></tr>
                      ) : keidoGrants.map(rec => {
                        const isSelected = rec.id === selectedGrantId;
                        return (
                          <tr key={rec.id}
                            onClick={() => { setSelectedGrantId(rec.id); if (editingGrantId !== rec.id) { setEditingGrantId(null); setGrantForm(null); } }}
                            className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          >
                            <td className="px-3 py-2 font-medium text-gray-800">{rec.restriction_group}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.judgment_route ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_from}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_end ?? "(期限なし)"}</td>
                            <td className="px-3 py-2 flex gap-1.5 justify-end">
                              <button onClick={e => { e.stopPropagation(); startEdit(rec); }}
                                className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-50">編集</button>
                              <button onClick={e => { e.stopPropagation(); deleteRec(rec.id); }}
                                className="text-xs text-red-400 border border-red-200 px-2 py-0.5 rounded hover:bg-red-50">削除</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 入力フォーム */}
              {gf !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-semibold text-gray-700">
                        {editingGrantId ? "例外給付記録 編集" : "例外給付記録 新規登録"}
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={() => { setGrantForm(null); setEditingGrantId(null); }}
                          className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg">キャンセル</button>
                        <button onClick={editingGrantId ? saveEdit : saveNew} disabled={grantSaving}
                          className="text-xs text-white bg-blue-500 px-3 py-1 rounded-lg disabled:opacity-50">
                          {grantSaving ? "保存中…" : "保存"}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 対象品目区分</label>
                        <select value={gf.restriction_group} onChange={e => sgf("restriction_group", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          {RESTRICTION_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">判定経路</label>
                        <select value={gf.judgment_route ?? ""} onChange={e => sgf("judgment_route", (e.target.value || null) as typeof gf.judgment_route)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value=""></option>
                          {JUDGMENT_ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">医師意見書取得日</label>
                        <input type="date" value={gf.doctor_opinion_date ?? ""} onChange={e => sgf("doctor_opinion_date", e.target.value || null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">サービス担当者会議等 確認日</label>
                        <input type="date" value={gf.meeting_confirmed_date ?? ""} onChange={e => sgf("meeting_confirmed_date", e.target.value || null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">保険者確認・届出日</label>
                        <input type="date" value={gf.insurer_confirmed_date ?? ""} onChange={e => sgf("insurer_confirmed_date", e.target.value || null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 有効期間 開始</label>
                        <input type="date" value={gf.valid_from} onChange={e => sgf("valid_from", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">有効期間 終了 (空欄 = 期限なし)</label>
                        <input type="date" value={gf.valid_end ?? ""} onChange={e => sgf("valid_end", e.target.value || null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs text-gray-500">備考</label>
                      <textarea value={gf.notes ?? ""} onChange={e => sgf("notes", e.target.value || null)} rows={2}
                        className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                    </div>
                  </div>
                </div>
              )}

              {gf === null && sel !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-700">例外給付記録 詳細</h3>
                      <button onClick={() => startEdit(sel)}
                        className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">編集</button>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      {[
                        ["対象品目区分", sel.restriction_group],
                        ["判定経路", sel.judgment_route ?? "—"],
                        ["医師意見書取得日", sel.doctor_opinion_date ?? "—"],
                        ["サービス担当者会議等 確認日", sel.meeting_confirmed_date ?? "—"],
                        ["保険者確認・届出日", sel.insurer_confirmed_date ?? "—"],
                        ["有効期間 開始", sel.valid_from],
                        ["有効期間 終了", sel.valid_end ?? "(期限なし)"],
                        ["備考", sel.notes ?? "—"],
                      ].map(([label, value]) => (
                        <div key={label} className="space-y-0.5">
                          <div className="text-[11px] text-gray-500">{label}</div>
                          <div className="text-sm text-gray-800 font-medium">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {gf === null && sel === null && (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                  「＋ 新規」から例外給付記録を登録してください
                </div>
              )}
            </div>
          );
        })()
      ) : null}

      {/* 仮登録→本登録モーダル */}
      {promoteOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-800">本登録する</h3>
                <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded">🏷️ 仮登録</span>
              </div>
              <button onClick={() => setPromoteOpen(false)} disabled={promoteSaving}>
                <X size={18} className="text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                必要項目を埋めて「本登録」を押すと、仮フラグが外れて正式な利用者になります。関連する予定・発注はそのまま引き継がれます（UUIDは維持）。
              </p>
              {/* 基本情報 */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">基本情報</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2">
                    <label className="text-[11px] text-gray-400 block mb-1">氏名 <span className="text-red-400">*</span></label>
                    <input type="text" value={promoteForm.name} onChange={(e) => setPromoteForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">ふりがな</label>
                    <input type="text" value={promoteForm.furigana} onChange={(e) => setPromoteForm((f) => ({ ...f, furigana: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">性別</label>
                    <select value={promoteForm.gender} onChange={(e) => setPromoteForm((f) => ({ ...f, gender: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400">
                      <option value="">—</option><option value="男性">男性</option><option value="女性">女性</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">電話</label>
                    <input type="text" value={promoteForm.phone} onChange={(e) => setPromoteForm((f) => ({ ...f, phone: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">携帯</label>
                    <input type="text" value={promoteForm.mobile} onChange={(e) => setPromoteForm((f) => ({ ...f, mobile: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[11px] text-gray-400 block mb-1">住所</label>
                    <input type="text" value={promoteForm.address} onChange={(e) => setPromoteForm((f) => ({ ...f, address: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                      <input type="checkbox" checked={promoteForm.is_facility} onChange={(e) => setPromoteForm((f) => ({ ...f, is_facility: e.target.checked }))} className="w-4 h-4" />
                      居宅・施設等（事業所・施設としてマーク）
                    </label>
                  </div>
                </div>
              </section>
              {/* ケアマネ */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">ケアマネジャー</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">担当ケアマネ</label>
                    <input type="text" value={promoteForm.care_manager} onChange={(e) => setPromoteForm((f) => ({ ...f, care_manager: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">所属事業所</label>
                    <input type="text" value={promoteForm.care_manager_org} onChange={(e) => setPromoteForm((f) => ({ ...f, care_manager_org: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                </div>
              </section>
              {/* 保険情報 */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">保険情報（任意）</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">被保険者番号</label>
                    <input type="text" value={promoteForm.insured_number} onChange={(e) => setPromoteForm((f) => ({ ...f, insured_number: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">生年月日</label>
                    <input type="date" value={promoteForm.birth_date} onChange={(e) => setPromoteForm((f) => ({ ...f, birth_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">要介護度</label>
                    <input type="text" value={promoteForm.care_level} placeholder="例: 要介護2"
                      onChange={(e) => setPromoteForm((f) => ({ ...f, care_level: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">保険者番号</label>
                    <input type="text" value={promoteForm.insurer_number} onChange={(e) => setPromoteForm((f) => ({ ...f, insurer_number: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">給付率 (%)</label>
                    <input type="text" value={promoteForm.benefit_rate}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPromoteForm((f) => {
                          // 給付率を変更したら負担割合を自動計算
                          const n = parseInt(v);
                          const copay = !isNaN(n) ? String(100 - n) : f.copay_rate;
                          return { ...f, benefit_rate: v, copay_rate: copay };
                        });
                      }}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">負担割合 (%)</label>
                    <input type="text" value={promoteForm.copay_rate} onChange={(e) => setPromoteForm((f) => ({ ...f, copay_rate: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">認定開始日</label>
                    <input type="date" value={promoteForm.certification_start_date} onChange={(e) => setPromoteForm((f) => ({ ...f, certification_start_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">認定終了日</label>
                    <input type="date" value={promoteForm.certification_end_date} onChange={(e) => setPromoteForm((f) => ({ ...f, certification_end_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                </div>
              </section>
              {/* メモ */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">メモ</h4>
                <textarea value={promoteForm.memo} onChange={(e) => setPromoteForm((f) => ({ ...f, memo: e.target.value }))} rows={2}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 resize-none" />
              </section>
            </div>
            <div className="flex gap-2 px-5 py-3 border-t border-gray-100 shrink-0">
              <button onClick={() => setPromoteOpen(false)} disabled={promoteSaving}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 disabled:opacity-50">
                キャンセル
              </button>
              <button
                onClick={async () => {
                  if (!promoteForm.name.trim()) { alert("氏名を入力してください"); return; }
                  setPromoteSaving(true);
                  try {
                    // 数値/日付は空文字なら null に
                    const n = (v: string) => v.trim() || null;
                    // memo は clients から DROP 済なので promoteProvisionalClient には渡さず、
                    // 下で client_memos (scope='tenant') に保存する。
                    await promoteProvisionalClient(client.id, {
                      name: promoteForm.name.trim(),
                      furigana: n(promoteForm.furigana),
                      gender: n(promoteForm.gender),
                      phone: n(promoteForm.phone),
                      mobile: n(promoteForm.mobile),
                      address: n(promoteForm.address),
                      is_facility: promoteForm.is_facility,
                      care_manager: n(promoteForm.care_manager),
                      care_manager_org: n(promoteForm.care_manager_org),
                      care_level: n(promoteForm.care_level),
                      benefit_rate: n(promoteForm.benefit_rate),
                      copay_rate: n(promoteForm.copay_rate),
                      insured_number: n(promoteForm.insured_number),
                      birth_date: n(promoteForm.birth_date),
                      insurer_number: n(promoteForm.insurer_number),
                      certification_start_date: n(promoteForm.certification_start_date),
                      certification_end_date: n(promoteForm.certification_end_date),
                    });
                    // メモは client_memos へ (旧実装は下の Object.assign で client.memo に
                    // 入れるだけだったため、画面上は保存されたように見えてリロードで消えていた)
                    const memoErr = await saveTenantMemo(promoteForm.memo);
                    if (memoErr) alert(`メモの保存に失敗しました: ${memoErr}`);
                    // client オブジェクトを直接更新（local state 反映）
                    Object.assign(client, {
                      is_provisional: false,
                      name: promoteForm.name.trim(),
                      furigana: n(promoteForm.furigana),
                      gender: n(promoteForm.gender),
                      phone: n(promoteForm.phone),
                      mobile: n(promoteForm.mobile),
                      address: n(promoteForm.address),
                      is_facility: promoteForm.is_facility,
                      care_manager: n(promoteForm.care_manager),
                      care_manager_org: n(promoteForm.care_manager_org),
                      care_level: n(promoteForm.care_level),
                      benefit_rate: n(promoteForm.benefit_rate),
                      copay_rate: n(promoteForm.copay_rate),
                      insured_number: n(promoteForm.insured_number),
                      birth_date: n(promoteForm.birth_date),
                      insurer_number: n(promoteForm.insurer_number),
                      certification_start_date: n(promoteForm.certification_start_date),
                      certification_end_date: n(promoteForm.certification_end_date),
                      // memo はここには入れない (clients に列が無く、実体は client_memos 側)
                    });
                    setPromoteOpen(false);
                  } catch (e) {
                    const msg = (e as { message?: string })?.message ?? String(e);
                    alert(`本登録に失敗しました\n${msg}`);
                    console.error(e);
                  } finally {
                    setPromoteSaving(false);
                  }
                }}
                disabled={promoteSaving || !promoteForm.name.trim()}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50">
                {promoteSaving ? "保存中…" : "本登録する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 月次実績送信モーダル */}
      {showRecordModal && currentOfficeId && (
        <SendMonthlyRecordModal
          tenantId={tenantId}
          client={client}
          sourceOfficeId={currentOfficeId}
          yearMonth={recordYearMonth}
          clientItems={clientItems}
          equipment={equipment}
          priceHistory={priceHistory}
          onClose={() => setShowRecordModal(false)}
          onSuccess={() => {
            setShowRecordModal(false);
            setRecordToast({ kind: "success", msg: "月次実績を送信しました" });
            setTimeout(() => setRecordToast(null), 3500);
          }}
          onError={(msg) => {
            setRecordToast({ kind: "error", msg: `送信失敗: ${msg}` });
            setTimeout(() => setRecordToast(null), 5000);
          }}
        />
      )}

      {/* 月次実績送信トースト */}
      {recordToast && (
        <div className={`fixed top-4 right-4 z-[80] px-4 py-2 rounded-lg shadow-lg text-sm text-white ${recordToast.kind === "success" ? "bg-emerald-500" : "bg-red-500"}`}>
          {recordToast.msg}
        </div>
      )}

      {/* 利用開始日 picker modal */}
      {startDatePicker && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setStartDatePicker(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">利用開始</h3>
            <p className="text-xs text-gray-500 mb-3">{startDatePicker.officeName} の利用を開始します。</p>
            <label className="text-xs text-gray-600 block mb-1">開始日</label>
            <input
              type="date"
              value={startDatePicker.date}
              onChange={(e) => setStartDatePicker({ ...startDatePicker, date: e.target.value })}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStartDatePicker(null)} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50">キャンセル</button>
              <button
                onClick={async () => {
                  try {
                    const inserted = await ensureActiveAssignment(client.id, startDatePicker.officeId, tenantId, startDatePicker.date);
                    if (inserted === null) alert("既に現在利用中の期間があります。");
                    setStartDatePicker(null);
                    await reloadAssignments();
                  } catch (e) { alert("利用開始に失敗: " + (e instanceof Error ? e.message : String(e))); }
                }}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white">開始</button>
            </div>
          </div>
        </div>
      )}

      {/* 利用終了日 picker modal */}
      {endDatePicker && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setEndDatePicker(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">利用終了</h3>
            <p className="text-xs text-gray-500 mb-3">{endDatePicker.officeName} の利用を終了します。</p>
            <label className="text-xs text-gray-600 block mb-1">終了日</label>
            <input
              type="date"
              value={endDatePicker.date}
              onChange={(e) => setEndDatePicker({ ...endDatePicker, date: e.target.value })}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEndDatePicker(null)} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50">キャンセル</button>
              <button
                onClick={async () => {
                  try {
                    await closeActiveAssignment(client.id, endDatePicker.officeId, endDatePicker.date);
                    setEndDatePicker(null);
                    await reloadAssignments();
                  } catch (e) { alert("利用終了に失敗: " + (e instanceof Error ? e.message : String(e))); }
                }}
                className="text-sm px-3 py-1.5 rounded bg-red-500 hover:bg-red-600 text-white">終了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SendMonthlyRecordModal ──────────────────────────────────────────────────
// 福祉用具の月次実績を居宅介護支援事業所に送付する確認モーダル

type MonthlyRecordRow = {
  date_range_start: string;
  date_range_end: string;
  equipment_name: string;
  tais_code: string | null;
  monthly_rental_fee: number;
  category: string | null;
};

function buildRecordsForMonth(
  yearMonth: string,
  clientItems: OrderItem[],
  equipment: Equipment[],
  priceHistory: EquipmentPriceHistory[],
): MonthlyRecordRow[] {
  const [y, m] = yearMonth.split("-").map(Number);
  const monthStart = `${yearMonth}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
  return clientItems
    .filter((i) => {
      if (i.status === "cancelled") return false;
      const start = i.rental_start_date;
      const end = i.rental_end_date;
      if (!start) return false;
      if (start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    })
    .map((i) => {
      const eq = equipment.find((e) => e.product_code === i.product_code);
      const price = getPriceForMonth(priceHistory, i.product_code, yearMonth) ?? i.rental_price ?? 0;
      const rangeStart = i.rental_start_date && i.rental_start_date > monthStart ? i.rental_start_date : monthStart;
      const rangeEnd = i.rental_end_date && i.rental_end_date < monthEnd ? i.rental_end_date : monthEnd;
      return {
        date_range_start: rangeStart,
        date_range_end: rangeEnd,
        equipment_name: eq?.name ?? i.product_code,
        tais_code: eq?.tais_code ?? null,
        monthly_rental_fee: price,
        category: eq?.category ?? null,
      };
    });
}

function buildRecordHtml(yearMonth: string, clientName: string, records: MonthlyRecordRow[]): string {
  const totalRows = records
    .map(
      (r) =>
        `<tr><td>${r.date_range_start}</td><td>${r.date_range_end}</td><td>${r.equipment_name}</td><td>${r.tais_code ?? "-"}</td><td>${r.category ?? "-"}</td><td style="text-align:right">¥${r.monthly_rental_fee.toLocaleString()}</td></tr>`,
    )
    .join("");
  const sum = records.reduce((s, r) => s + r.monthly_rental_fee, 0);
  return `<div style="font-family:sans-serif;font-size:12px;padding:16px;">
<h2 style="font-size:16px;margin:0 0 8px;">${yearMonth} 福祉用具実績 - ${clientName} 様</h2>
<table style="width:100%;border-collapse:collapse;font-size:11px" border="1" cellpadding="6">
<thead><tr style="background:#f3f4f6"><th>開始</th><th>終了</th><th>用具名</th><th>TAIS</th><th>区分</th><th>月額</th></tr></thead>
<tbody>${totalRows || '<tr><td colspan="6" style="text-align:center;color:#888">対象なし</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right;font-weight:bold">合計</td><td style="text-align:right;font-weight:bold">¥${sum.toLocaleString()}</td></tr></tfoot>
</table>
</div>`;
}

function SendMonthlyRecordModal({
  tenantId, client, sourceOfficeId, yearMonth, clientItems, equipment, priceHistory,
  onClose, onSuccess, onError,
}: {
  tenantId: string;
  client: Client;
  sourceOfficeId: string;
  yearMonth: string;
  clientItems: OrderItem[];
  equipment: Equipment[];
  priceHistory: EquipmentPriceHistory[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<CareOfficeChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const records = useMemo(
    () => buildRecordsForMonth(yearMonth, clientItems, equipment, priceHistory),
    [yearMonth, clientItems, equipment, priceHistory],
  );
  const total = useMemo(() => records.reduce((s, r) => s + r.monthly_rental_fee, 0), [records]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: asgn, error: asgnErr } = await supabase
          .from("client_office_assignments")
          .select("office_id")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id);
        if (asgnErr) throw asgnErr;
        const assignedIds = new Set((asgn ?? []).map((a) => a.office_id as string));

        const { data: careOffices, error: careErr } = await supabase
          .from("offices")
          .select("id, name, service_type")
          .eq("tenant_id", tenantId)
          .eq("service_type", "居宅介護支援")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });
        if (careErr) throw careErr;

        const { data: srcOffice } = await supabase
          .from("offices")
          .select("name")
          .eq("id", sourceOfficeId)
          .maybeSingle();
        if (cancelled) return;
        if (srcOffice?.name) setSourceOfficeName(srcOffice.name as string);

        const all: CareOfficeChoice[] = (careOffices ?? []).map((o) => ({
          id: o.id as string,
          name: o.name as string,
          is_assigned: assignedIds.has(o.id as string),
        }));
        const assigned = all.filter((c) => c.is_assigned);
        setChoices(all);
        if (assigned.length > 0) {
          setShowAll(false);
          setSelectedId(assigned[0].id);
        } else {
          setShowAll(true);
          setSelectedId(all[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, client.id, sourceOfficeId]);

  const visibleChoices = showAll ? choices : choices.filter((c) => c.is_assigned);
  const assignedCount = choices.filter((c) => c.is_assigned).length;

  const handleSend = async () => {
    if (!selectedId) return;
    setSending(true);
    setErrorMsg(null);
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) throw new Error("ユーザー情報が取得できません");
      const userId = userData.user.id;

      const html = buildRecordHtml(yearMonth, client.name, records);
      const title = `${yearMonth} 福祉用具実績 - ${client.name} 様`;
      const payload = {
        service_type: "福祉用具",
        year_month: yearMonth,
        client_id: client.id,
        client_name: client.name,
        records,
      };

      const { data: sd, error: sdErr } = await supabase
        .from("shared_documents")
        .insert({
          tenant_id: tenantId,
          client_id: client.id,
          source_office_id: sourceOfficeId,
          target_office_id: selectedId,
          document_type: "service_record_monthly",
          title,
          html_content: html,
          payload,
          sent_by: userId,
        })
        .select("id")
        .single();
      if (sdErr || !sd) throw sdErr ?? new Error("shared_documents 作成失敗");

      const { error: ntErr } = await supabase
        .from("notifications")
        .insert({
          tenant_id: tenantId,
          office_id: selectedId,
          user_id: null,
          type: "document_received",
          ref_table: "shared_documents",
          ref_id: sd.id,
          title: `福祉用具実績を受信: ${client.name} 様 (${yearMonth})`,
          body: `${sourceOfficeName || "送信元事業所"} から`,
        });
      if (ntErr) throw ntErr;

      onSuccess();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] bg-black/60 flex items-center justify-center p-4 print:hidden" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">居宅介護支援事業所に月次実績を送信</h3>
          <p className="text-xs text-gray-500 mt-1">
            {client.name} 様 / {yearMonth} / 全 {records.length} 件 / 合計 ¥{total.toLocaleString()}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {records.length === 0 ? (
            <p className="text-sm text-amber-600">この月にレンタル中だった用具がありません。</p>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">期間</th>
                    <th className="text-left px-2 py-1.5">用具名</th>
                    <th className="text-right px-2 py-1.5">月額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {records.map((r, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{r.date_range_start.slice(5)}〜{r.date_range_end.slice(5)}</td>
                      <td className="px-2 py-1.5 text-gray-800 truncate">{r.equipment_name}</td>
                      <td className="px-2 py-1.5 text-right text-gray-700 whitespace-nowrap">¥{r.monthly_rental_fee.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-6"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
          ) : choices.length === 0 ? (
            <p className="text-sm text-red-500">tenant 内に居宅介護支援事業所が登録されていません</p>
          ) : (
            <div>
              <label className="text-xs text-gray-500 block mb-1.5">送付先</label>
              {assignedCount === 0 && (
                <p className="text-xs text-amber-600 mb-2">
                  この利用者に紐付く居宅介護支援事業所がありません。全候補から手動選択してください。
                </p>
              )}
              {assignedCount > 0 && (
                <label className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)}
                    className="w-3.5 h-3.5 accent-emerald-500" />
                  <span>全 居宅介護支援事業所 から選ぶ</span>
                </label>
              )}
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {visibleChoices.map((c) => (
                  <label key={c.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${selectedId === c.id ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"}`}>
                    <input type="radio" name="target_office_record" value={c.id}
                      checked={selectedId === c.id}
                      onChange={() => setSelectedId(c.id)}
                      className="accent-emerald-500" />
                    <span className="text-sm text-gray-800 flex-1 truncate">{c.name}</span>
                    {c.is_assigned && <span className="text-[10px] text-emerald-600 shrink-0 px-1.5 py-0.5 bg-emerald-100 rounded">担当</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {errorMsg}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} disabled={sending}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            キャンセル
          </button>
          <button onClick={handleSend}
            disabled={loading || sending || !selectedId || records.length === 0}
            className="text-sm text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            送信確定
          </button>
        </div>
      </div>
    </div>
  );
}
