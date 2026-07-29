"use client";

// 出勤簿用 スタッフ・事業所 管理モーダル (master user = domen 専用)。
//
// 出勤簿の identity は payroll_employees / payroll_offices (給与計算システムと共有)。
// 従来は payroll-app 側でしか管理できなかったが、本モーダルで order-app から
// 直接 CRUD できるようにする。新しいテーブルは作らない (= 共有マスタをそのまま操作)。
//
//   事業所タブ:
//     - 共通 offices (福祉用具) のうち payroll 未取込のものを取込 (payroll_offices INSERT)
//     - 週の起算曜日 (work_week_start) の変更 — 週40h 残業計算の起点
//   スタッフタブ:
//     - payroll_employees の追加 / 名前・社員番号の編集 / 在職・退職の切替

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, X, Users, Building2, Check, Pencil } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { attendanceOfficesOrFilter } from "@/lib/attendance";

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

type PayrollOffice = {
  id: string;
  office_id: string;
  office_number: string;
  office_type: string;
  work_week_start: number;
  name: string;
};

type CommonOffice = {
  id: string;
  name: string;
  short_name: string | null;
  business_number: string | null;
  service_type: string | null;
};

type Employee = {
  id: string;
  employee_number: string;
  name: string;
  employment_status: string;
  /** 出勤簿での非表示 (擬似エントリ用)。列未適用の環境では undefined */
  attendance_hidden?: boolean;
  /** 人の正マスタ members への紐付け。null/undefined = payroll 専用の独立エントリ */
  member_id?: string | null;
  /** 電話当番の単価 (円/回)。本社の職員のみ意味を持つ */
  phone_duty_pay?: number | null;
  /** 事務員か。true なら出勤簿に出張距離の列が増える */
  is_office_worker?: boolean | null;
};

/** members から取込む候補 (この事業所が主所属で、まだ payroll に居ない人) */
type ImportCandidate = {
  member_id: string;
  name: string;
  internal_number: number | null;
  /** 既に他事業所の payroll に紐付いている (1人1冊のため取込不可) */
  linked_elsewhere: string | null;
  /** この事業所に同名の未紐付け payroll 行がある → 新規作成せず紐付けで済む */
  link_to_employee_id: string | null;
};

/** 氏名正規化 (空白除去 + 全角英数→半角)。members ↔ payroll の同名判定用 */
function normName(name: string): string {
  return (name ?? "")
    .replace(/[\s　]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
}

type SubTab = "staff" | "offices";

export default function AttendanceAdminModal({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const [subTab, setSubTab] = useState<SubTab>("staff");
  const [loading, setLoading] = useState(true);
  const [offices, setOffices] = useState<PayrollOffice[]>([]);
  const [unimported, setUnimported] = useState<CommonOffice[]>([]);
  const [busy, setBusy] = useState(false);

  // ─── 事業所 + 未取込 読込 ──────────────────────────────────────────
  const loadOffices = useCallback(async () => {
    setLoading(true);
    try {
      // 共通マスタの福祉用具 + 本社 (統括営業本部は tenant=sales-hq) 事業所
      const { data: commons, error: cErr } = await supabase
        .from("offices")
        .select("id, name, short_name, business_number, service_type, is_active")
        .or(attendanceOfficesOrFilter(tenantId));
      if (cErr) throw new Error(`共通マスタの取得に失敗: ${cErr.message}`);
      const activeCommons = (commons ?? []).filter(
        (c) => (c as { is_active?: boolean }).is_active !== false,
      ) as CommonOffice[];

      const commonIds = activeCommons.map((c) => c.id);
      if (commonIds.length === 0) {
        setOffices([]);
        setUnimported([]);
        return;
      }
      const { data: payrolls, error: pErr } = await supabase
        .from("payroll_offices")
        .select("id, office_id, office_number, office_type, work_week_start")
        .in("office_id", commonIds);
      if (pErr) throw new Error(`payroll 事業所の取得に失敗: ${pErr.message}`);

      const nameById = new Map(activeCommons.map((c) => [c.id, c.name]));
      const linked = new Set<string>();
      const rows: PayrollOffice[] = (payrolls ?? []).map((p) => {
        linked.add(p.office_id as string);
        return {
          id: p.id as string,
          office_id: p.office_id as string,
          office_number: (p.office_number as string) ?? "",
          office_type: (p.office_type as string) ?? "",
          work_week_start: (p.work_week_start as number | null) ?? 0,
          name: nameById.get(p.office_id as string) ?? "(名称不明)",
        };
      });
      rows.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(rows);
      setUnimported(activeCommons.filter((c) => !linked.has(c.id)));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の async fetch
    loadOffices();
  }, [loadOffices]);

  // ─── 共通マスタから取込 ───────────────────────────────────────────
  const handleImport = async (c: CommonOffice) => {
    const isHonbu = c.service_type === "本社";
    // 本社は介護事業所番号を持たないため placeholder を採番する (payroll_offices 内でのみ使用)。
    // 共通マスタの business_number には fake を書かない (伝送・請求で使う欄のため)。
    const officeNumber = c.business_number ?? (isHonbu ? `HONBU-${c.id.slice(0, 8)}` : null);
    if (!officeNumber) {
      alert("事業所番号 (business_number) が未設定のため取込めません。先に共通マスタで設定してください。");
      return;
    }
    if (!window.confirm(`「${c.name}」を給与計算システムの事業所として取込みますか？`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("payroll_offices").insert({
        office_id: c.id,
        office_number: officeNumber,
        short_name: c.short_name ?? c.name,
        // payroll_offices.office_type: 本社はそのまま、それ以外 (福祉用具/未設定) は福祉用具貸与
        office_type: isHonbu ? "本社" : "福祉用具貸与",
      });
      if (error) throw new Error(`取込に失敗: ${error.message}`);
      await loadOffices();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ─── 週起算曜日の変更 ─────────────────────────────────────────────
  const handleWeekStartChange = async (o: PayrollOffice, ws: number) => {
    setBusy(true);
    try {
      const { error } = await supabase
        .from("payroll_offices")
        .update({ work_week_start: ws })
        .eq("id", o.id);
      if (error) throw new Error(`週起算の変更に失敗: ${error.message}`);
      setOffices((prev) => prev.map((p) => (p.id === o.id ? { ...p, work_week_start: ws } : p)));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Users size={16} className="text-emerald-600" />
          <h3 className="text-sm font-semibold text-gray-700 flex-1">スタッフ・事業所 管理</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-2 flex gap-1 border-b border-gray-100">
          {(
            [
              ["staff", "スタッフ", Users],
              ["offices", "事業所", Building2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 inline-flex items-center gap-1 transition-colors ${
                subTab === id ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-400 hover:text-gray-600"
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
          ) : subTab === "offices" ? (
            <OfficesView
              offices={offices}
              unimported={unimported}
              busy={busy}
              onImport={handleImport}
              onWeekStartChange={handleWeekStartChange}
            />
          ) : (
            <StaffView offices={offices} />
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-gray-100 text-[10px] text-gray-400">
          ここで登録した事業所・スタッフは給与計算システムと共有されます (同じマスタを直接編集)。
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// 事業所タブ
// =====================================================================

function OfficesView({
  offices,
  unimported,
  busy,
  onImport,
  onWeekStartChange,
}: {
  offices: PayrollOffice[];
  unimported: CommonOffice[];
  busy: boolean;
  onImport: (c: CommonOffice) => void;
  onWeekStartChange: (o: PayrollOffice, ws: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-600 mb-2">登録済み事業所 ({offices.length})</h4>
        {offices.length === 0 ? (
          <p className="text-xs text-gray-400">まだありません。下の未取込一覧から取込んでください。</p>
        ) : (
          <div className="space-y-1.5">
            {offices.map((o) => (
              <div key={o.id} className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 truncate">{o.name}</p>
                  <p className="text-[10px] text-gray-400">事業所番号 {o.office_number || "—"} ・ {o.office_type}</p>
                </div>
                <label className="text-[11px] text-gray-500 flex items-center gap-1 shrink-0">
                  週起算
                  <select
                    value={o.work_week_start}
                    disabled={busy}
                    onChange={(e) => onWeekStartChange(o, parseInt(e.target.value, 10))}
                    className="border border-gray-200 rounded px-1 py-0.5 text-xs"
                    title="週40時間残業の計算で使う週の始まり曜日"
                  >
                    {WEEK_DAY_LABELS.map((w, i) => (
                      <option key={i} value={i}>{w}曜</option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        )}
      </div>

      {unimported.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-600 mb-2">未取込の共通マスタ事業所 ({unimported.length})</h4>
          <div className="space-y-1.5">
            {unimported.map((c) => {
              const isHonbu = c.service_type === "本社";
              const importable = !!c.business_number || isHonbu;
              return (
                <div key={c.id} className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2 bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-600 truncate">{c.name}</p>
                    <p className="text-[10px] text-gray-400">
                      事業所番号{" "}
                      {c.business_number ??
                        (isHonbu ? "なし (本社は番号なしで取込可)" : "未設定 (取込不可)")}
                    </p>
                  </div>
                  <button
                    onClick={() => onImport(c)}
                    disabled={busy || !importable}
                    className="text-[11px] px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
                  >
                    <Plus size={12} />
                    取込
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// スタッフタブ
// =====================================================================

function StaffView({ offices }: { offices: PayrollOffice[] }) {
  const [officeId, setOfficeId] = useState<string>(offices[0]?.id ?? "");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  const commonOfficeId = offices.find((o) => o.id === officeId)?.office_id ?? null;

  // 追加フォーム
  const [newNumber, setNewNumber] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  // 行内編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNumber, setEditNumber] = useState("");
  const [editName, setEditName] = useState("");
  const [editPhonePay, setEditPhonePay] = useState("");
  const [editOfficeWorker, setEditOfficeWorker] = useState(false);

  const load = useCallback(async () => {
    if (!officeId) {
      setEmployees([]);
      setCandidates([]);
      return;
    }
    setLoading(true);
    try {
      // attendance_hidden / member_id は後付け列 (migration 未適用でも動くよう select("*"))
      const { data, error } = await supabase
        .from("payroll_employees")
        .select("*")
        .eq("office_id", officeId)
        .order("employee_number");
      if (error) throw new Error(`スタッフの取得に失敗: ${error.message}`);
      const emps = (data ?? []) as Employee[];
      setEmployees(emps);

      // ─── members からの取込候補 ───
      // この共通 office が「主所属」の在籍 members のうち、payroll 未紐付けの人。
      // 1人1冊 (主所属のみ) 運用: 他事業所で紐付け済みなら取込不可として表示。
      if (!commonOfficeId) {
        setCandidates([]);
        return;
      }
      const { data: links, error: linkErr } = await supabase
        .from("member_offices")
        .select("member_id")
        .eq("office_id", commonOfficeId)
        .eq("is_primary", true);
      if (linkErr) throw new Error(`所属の取得に失敗: ${linkErr.message}`);
      const mids = [...new Set((links ?? []).map((l) => (l as { member_id: string }).member_id))];
      if (mids.length === 0) {
        setCandidates([]);
        return;
      }
      const [{ data: mems, error: memErr }, { data: linkedRows, error: linkedErr }] =
        await Promise.all([
          supabase
            .from("members")
            .select("id, name, status, deleted_at, internal_number")
            .in("id", mids),
          supabase
            .from("payroll_employees")
            .select("member_id, office_id")
            .in("member_id", mids),
        ]);
      if (memErr) throw new Error(`members の取得に失敗: ${memErr.message}`);
      // member_id 列未適用 (42703) はまだ紐付け運用前 → 候補表示をスキップ
      if (linkedErr) {
        if (linkedErr.code === "42703") {
          setCandidates([]);
          return;
        }
        throw new Error(`紐付け状況の取得に失敗: ${linkedErr.message}`);
      }
      const linkedByMember = new Map<string, string>();
      for (const r of linkedRows ?? []) {
        const row = r as { member_id: string | null; office_id: string };
        if (row.member_id) linkedByMember.set(row.member_id, row.office_id);
      }
      const officeName = (pid: string) => offices.find((o) => o.id === pid)?.name ?? "他事業所";
      // この事業所の未紐付け payroll 行 (正規化名 → employee id)。同名なら新規でなく紐付けにする
      const unlinkedByName = new Map<string, string>();
      for (const e of emps) {
        if (!e.member_id) unlinkedByName.set(normName(e.name), e.id);
      }
      const cands: ImportCandidate[] = (mems ?? [])
        .filter((m) => !m.deleted_at && m.status === "active")
        .map((m) => {
          const linkedOffice = linkedByMember.get(m.id as string);
          return {
            member_id: m.id as string,
            name: m.name as string,
            internal_number: (m.internal_number as number | null) ?? null,
            linked_elsewhere:
              linkedOffice && linkedOffice !== officeId ? officeName(linkedOffice) : null,
            link_to_employee_id: unlinkedByName.get(normName(m.name as string)) ?? null,
          };
        })
        // この事業所に紐付け済みの人は候補から外す
        .filter((c) => !(linkedByMember.get(c.member_id) === officeId));
      cands.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setCandidates(cands);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [officeId, commonOfficeId, offices]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替時の async fetch
    load();
  }, [load]);

  const handleAdd = async () => {
    const num = newNumber.trim();
    const name = newName.trim();
    if (!officeId || !num || !name) {
      alert("社員番号と名前を入力してください");
      return;
    }
    setAdding(true);
    try {
      const { error } = await supabase.from("payroll_employees").insert({
        employee_number: num,
        name,
        office_id: officeId,
        employment_status: "在職者",
      });
      if (error) throw new Error(`追加に失敗: ${error.message}`);
      setNewNumber("");
      setNewName("");
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  // ─── members からの取込 / 紐付け ────────────────────────────────────
  const handleImportMember = async (c: ImportCandidate) => {
    setBusyId(c.member_id);
    try {
      if (c.link_to_employee_id) {
        // 同名の既存 payroll 行に紐付けるだけ (新規行は作らない)
        const { error } = await supabase
          .from("payroll_employees")
          .update({ member_id: c.member_id })
          .eq("id", c.link_to_employee_id)
          .is("member_id", null);
        if (error) throw new Error(`紐付けに失敗: ${error.message}`);
      } else {
        // 社員番号は members の internal_number ベースで自動採番 (後で編集可)
        const num = c.internal_number !== null ? `M${c.internal_number}` : `M-${c.member_id.slice(0, 8)}`;
        const { error } = await supabase.from("payroll_employees").insert({
          employee_number: num,
          name: c.name,
          office_id: officeId,
          employment_status: "在職者",
          member_id: c.member_id,
        });
        if (error) throw new Error(`取込に失敗: ${error.message}`);
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleImportAll = async () => {
    const targets = candidates.filter((c) => !c.linked_elsewhere);
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length} 名をまとめて取込みますか？`)) return;
    for (const c of targets) {
      // 1件ずつ逐次 (エラーはその場で alert される)
      await handleImportMember(c);
    }
  };

  const startEdit = (emp: Employee) => {
    setEditingId(emp.id);
    setEditNumber(emp.employee_number);
    setEditName(emp.name);
    setEditPhonePay(String(emp.phone_duty_pay ?? 3000));
    setEditOfficeWorker(emp.is_office_worker === true);
  };

  const handleEditSave = async (emp: Employee) => {
    const num = editNumber.trim();
    const name = editName.trim();
    if (!num || !name) {
      alert("社員番号と名前を入力してください");
      return;
    }
    setBusyId(emp.id);
    try {
      // 社員番号は payroll 側の属性なので常に payroll 行を更新
      const phonePay = parseInt(editPhonePay, 10);
      if (!Number.isFinite(phonePay) || phonePay < 0) {
        alert("電話当番の単価が不正です");
        return;
      }
      const { error } = await supabase
        .from("payroll_employees")
        .update({
          employee_number: num,
          ...(emp.member_id ? {} : { name }),
          // 列未適用の環境では 42703 になるので送らない (値が undefined のとき)
          ...(emp.phone_duty_pay === undefined ? {} : { phone_duty_pay: phonePay }),
          ...(emp.is_office_worker === undefined ? {} : { is_office_worker: editOfficeWorker }),
        })
        .eq("id", emp.id);
      if (error) throw new Error(`更新に失敗: ${error.message}`);
      // 氏名は members が正。紐付け済みなら members を更新 → trigger が全アプリに反映
      if (emp.member_id && name !== emp.name) {
        const { error: memErr } = await supabase
          .from("members")
          .update({ name })
          .eq("id", emp.member_id);
        if (memErr) throw new Error(`氏名の更新に失敗 (members): ${memErr.message}`);
      }
      setEditingId(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleHidden = async (emp: Employee) => {
    const toHidden = emp.attendance_hidden !== true;
    setBusyId(emp.id);
    try {
      const { error } = await supabase
        .from("payroll_employees")
        .update({ attendance_hidden: toHidden })
        .eq("id", emp.id);
      if (error) {
        // 42703 = 列が無い (migration 未適用)
        if (error.code === "42703") {
          throw new Error(
            "非表示フラグの列が未適用です。migrations/payroll_employees_attendance_hidden.sql を Supabase で適用してください。",
          );
        }
        throw new Error(`変更に失敗: ${error.message}`);
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleStatus = async (emp: Employee) => {
    const toRetired = emp.employment_status !== "退職者";
    const linked = !!emp.member_id;
    if (
      toRetired &&
      !window.confirm(
        linked
          ? `${emp.name} を退職者にしますか？\nカレンダー・給与計算など全アプリで退職扱いになります (記録は残ります)。`
          : `${emp.name} を退職者にしますか？\n出勤簿の対象・自己入力 URL から外れます (記録は残ります)。`,
      )
    ) {
      return;
    }
    setBusyId(emp.id);
    try {
      if (linked) {
        // 在籍状態は members が正 → trigger が payroll (と他アプリの見え方) に反映
        const { error } = await supabase
          .from("members")
          .update({ status: toRetired ? "inactive" : "active" })
          .eq("id", emp.member_id as string);
        if (error) throw new Error(`変更に失敗 (members): ${error.message}`);
      } else {
        const { error } = await supabase
          .from("payroll_employees")
          .update({ employment_status: toRetired ? "退職者" : "在職者" })
          .eq("id", emp.id);
        if (error) throw new Error(`変更に失敗: ${error.message}`);
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // 退職者と非表示は同じチェックボックスでまとめて出す (普段のリストから隠す対象)
  const visible = showRetired
    ? employees
    : employees.filter((e) => e.employment_status !== "退職者" && e.attendance_hidden !== true);
  const retiredCount = employees.filter(
    (e) => e.employment_status === "退職者" || e.attendance_hidden === true,
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={officeId}
          onChange={(e) => setOfficeId(e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 max-w-[16rem]"
        >
          {offices.length === 0 && <option value="">事業所がありません</option>}
          {offices.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        {retiredCount > 0 && (
          <label className="text-[11px] text-gray-500 flex items-center gap-1">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
              className="accent-emerald-600"
            />
            退職者・非表示も表示 ({retiredCount})
          </label>
        )}
      </div>

      {/* 追加フォーム */}
      <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50">
        <input
          type="text"
          placeholder="社員番号"
          value={newNumber}
          onChange={(e) => setNewNumber(e.target.value)}
          className="w-28 border border-gray-200 rounded px-2 py-1 text-xs"
        />
        <input
          type="text"
          placeholder="名前"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="flex-1 min-w-0 border border-gray-200 rounded px-2 py-1 text-xs"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !officeId}
          className="text-[11px] px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
        >
          {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          追加
        </button>
      </div>

      {/* members からの取込候補 (この事業所が主所属で出勤簿に未登録の人) */}
      {!loading && candidates.length > 0 && (
        <div className="border border-dashed border-sky-300 rounded-lg px-3 py-2 bg-sky-50/50 space-y-1.5">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold text-sky-700 flex-1">
              職員マスタに居て出勤簿に未登録 ({candidates.length})
            </p>
            {candidates.some((c) => !c.linked_elsewhere) && (
              <button
                onClick={handleImportAll}
                disabled={busyId !== null}
                className="text-[11px] px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-600 text-white shrink-0 disabled:opacity-40"
              >
                まとめて取込
              </button>
            )}
          </div>
          {candidates.map((c) => (
            <div key={c.member_id} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-xs text-gray-700 truncate">{c.name}</span>
              {c.linked_elsewhere ? (
                <span className="text-[10px] text-gray-400 shrink-0">
                  出勤簿は {c.linked_elsewhere} 側 (1人1冊)
                </span>
              ) : (
                <button
                  onClick={() => handleImportMember(c)}
                  disabled={busyId !== null}
                  className="text-[11px] px-2 py-0.5 rounded border border-sky-400 text-sky-600 hover:bg-sky-100 shrink-0 disabled:opacity-40"
                >
                  {busyId === c.member_id ? "…" : c.link_to_employee_id ? "既存行に紐付け" : "取込"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 一覧 */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
      ) : visible.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-6">スタッフがいません</p>
      ) : (
        <div className="space-y-1.5">
          {visible.map((emp) => {
            const retired = emp.employment_status === "退職者";
            const hidden = emp.attendance_hidden === true;
            const editing = editingId === emp.id;
            return (
              <div
                key={emp.id}
                className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${retired || hidden ? "border-gray-200 bg-gray-50 opacity-70" : "border-gray-200"}`}
              >
                {editing ? (
                  <>
                    <input
                      type="text"
                      value={editNumber}
                      onChange={(e) => setEditNumber(e.target.value)}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-xs"
                    />
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs"
                    />
                    <label className="flex items-center gap-1 text-[10px] text-gray-500 shrink-0">
                      電話当番
                      <input
                        type="number"
                        min={0}
                        step={500}
                        value={editPhonePay}
                        onChange={(e) => setEditPhonePay(e.target.value)}
                        className="w-20 border border-gray-300 rounded px-1 py-1 text-xs text-right"
                        title="電話当番 1 回あたりの手当 (円)"
                      />
                      円
                    </label>
                    <label
                      className="flex items-center gap-1 text-[10px] text-gray-500 shrink-0"
                      title="事務員は出勤簿に 通勤距離 と 出張距離 の 2 列が出ます"
                    >
                      <input
                        type="checkbox"
                        checked={editOfficeWorker}
                        onChange={(e) => setEditOfficeWorker(e.target.checked)}
                        className="accent-emerald-600"
                      />
                      事務員
                    </label>
                    <button
                      onClick={() => handleEditSave(emp)}
                      disabled={busyId === emp.id}
                      className="text-[11px] px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
                    >
                      <Check size={12} />
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 shrink-0"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-[10px] text-gray-400 w-20 shrink-0 font-mono truncate">{emp.employee_number}</span>
                    <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">{emp.name}</span>
                    {retired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 shrink-0">退職者</span>}
                    {hidden && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 shrink-0">非表示</span>}
                    {emp.is_office_worker && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600 shrink-0"
                        title="事務員 (出勤簿に出張距離の列が出ます)"
                      >
                        事務
                      </span>
                    )}
                    {emp.member_id && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-600 shrink-0"
                        title="職員マスタ (members) と連携中。氏名・在籍の変更は全アプリに反映されます"
                      >
                        連携
                      </span>
                    )}
                    <button
                      onClick={() => startEdit(emp)}
                      disabled={busyId === emp.id}
                      className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
                    >
                      <Pencil size={11} />
                      編集
                    </button>
                    <button
                      onClick={() => handleToggleHidden(emp)}
                      disabled={busyId === emp.id}
                      className={`text-[11px] px-2 py-1 rounded border shrink-0 disabled:opacity-40 ${
                        hidden
                          ? "border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                          : "border-amber-300 text-amber-600 hover:bg-amber-50"
                      }`}
                      title={
                        hidden
                          ? "出勤簿の職員選択・URL 発行に再び表示する"
                          : "出勤簿の職員選択・URL 発行から隠す (対応者調整などの擬似エントリ用。給与計算側には残る)"
                      }
                    >
                      {busyId === emp.id ? "…" : hidden ? "表示に戻す" : "非表示"}
                    </button>
                    <button
                      onClick={() => handleToggleStatus(emp)}
                      disabled={busyId === emp.id}
                      className={`text-[11px] px-2 py-1 rounded border shrink-0 disabled:opacity-40 ${
                        retired
                          ? "border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                          : "border-red-200 text-red-500 hover:bg-red-50"
                      }`}
                    >
                      {busyId === emp.id ? "…" : retired ? "在職に戻す" : "退職"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
