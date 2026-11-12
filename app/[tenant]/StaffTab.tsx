"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Loader2 } from "lucide-react";
import { supabase, Member } from "@/lib/supabase";

export default function StaffTab({ tenantId, currentOfficeId, officeViewAll }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean }) {
  const [members, setMembers] = useState<(Member & { status?: string | null; role?: string | null; employment_type?: string | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ display_name: "", login_id: "", role: "member" as "member" | "office_admin" });
  // 招待をどの職員に紐付けるか (明示的に選ぶ)。"" = 未選択 / "new" = 新しい職員として作る / それ以外 = members.id
  //   紐付けないと consume 時に同じ氏名の職員がもう 1 人作られる。名前の自動一致は同姓同名・異体字に弱いので候補止まりにする
  const [inviteLinkTo, setInviteLinkTo] = useState<string>("");
  const normStaffName = (v: string) => v.replace(/[\s　]/g, "");
  const nameMatches = (name: string) =>
    name.trim() ? members.filter((m) => normStaffName(m.name ?? "") === normStaffName(name)) : [];
  const linkedMember = inviteLinkTo && inviteLinkTo !== "new" ? members.find((m) => m.id === inviteLinkTo) ?? null : null;
  const hasAccount = (m: { auth_user_id?: string | null }) => !!m.auth_user_id;
  const openInvite = (m?: (typeof members)[number]) => {
    setInviteResult(null);
    setInviteError(null);
    setInviteForm({ display_name: m?.name ?? "", login_id: "", role: "member" });
    setInviteLinkTo(m ? m.id : "");
    setInviteOpen(true);
  };
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ invite_url: string; initial_password: string; login_id: string; linked_name: string | null } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const officeFilter = officeViewAll ? null : currentOfficeId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // member_offices junction 経由で member_ids を取得。
        //   ・自事業所モード (officeFilter あり) → その office に link する members
        //   ・全事業所モード (officeFilter なし) → app_type='order-app' の office に link する members
        //     (旧実装は tenant 全 members を見せていたが、kaigo-app ヘルパー数百名も含んでしまうため修正)
        // member_offices junction は default 1000 件 limit があるため明示的にページング
        const fetchJunctionMemberIds = async (officeIds: string[]): Promise<string[]> => {
          if (officeIds.length === 0) return [];
          const PAGE = 1000;
          const ids: string[] = [];
          let from = 0;
          while (true) {
            const { data, error } = await supabase
              .from("member_offices")
              .select("member_id")
              .in("office_id", officeIds)
              .order("member_id").order("office_id").range(from, from + PAGE - 1); // paging-order: unique (member_id, office_id が複合主キー)
            if (error) {
              console.warn("member_offices fetch failed:", error.message);
              break;
            }
            if (!data || data.length === 0) break;
            ids.push(...((data as { member_id: string }[]).map((r) => r.member_id)));
            if (data.length < PAGE) break;
            from += PAGE;
          }
          return ids;
        };
        let memberIds: string[] = [];
        if (officeFilter) {
          memberIds = Array.from(new Set(await fetchJunctionMemberIds([officeFilter])));
        } else {
          const { data: orderOffices, error: offErr } = await supabase
            .from("offices")
            .select("id")
            .eq("app_type", "order-app");
          if (offErr) console.warn("offices fetch failed:", offErr.message);
          const orderOfficeIds = ((orderOffices ?? []) as { id: string }[]).map((o) => o.id);
          memberIds = Array.from(new Set(await fetchJunctionMemberIds(orderOfficeIds)));
        }
        // members .in("id", ...) も IN 句が肥大化しすぎないようチャンク分割。
        // ⚠ 2026-09-03 実測: chunk=500だとPostgresの実行計画がindex scanから
        //   seq scanに非線形に切り替わり1回7.5秒超かかる(300件以下は数十ms、
        //   400件で突然7秒超。membersテーブル1,197行で実測)。150件chunk+
        //   Promise.all並列fetchに変更 (詳細: kaigo-app use-kaigo-office-users.ts)。
        if (memberIds.length === 0) {
          if (!cancelled) setMembers([]);
        } else {
          const CHUNK = 150;
          const chunks: string[][] = [];
          for (let i = 0; i < memberIds.length; i += CHUNK) chunks.push(memberIds.slice(i, i + CHUNK));
          const results = await Promise.all(
            chunks.map((slice) => {
              let q = supabase.from("members").select("*").eq("tenant_id", tenantId).is("deleted_at", null).in("id", slice);
              if (!includeInactive) q = q.eq("status", "active");
              return q;
            }),
          );
          const collected: typeof members = [];
          for (const { data, error } of results) {
            if (error) {
              console.warn("members fetch failed:", error.message);
              continue;
            }
            collected.push(...((data ?? []) as typeof members));
          }
          collected.sort((a, b) => {
            const ra = a as { furigana?: string | null; name?: string | null };
            const rb = b as { furigana?: string | null; name?: string | null };
            const fa = ra.furigana ?? "￿"; // null は末尾扱い
            const fb = rb.furigana ?? "￿";
            if (fa !== fb) return fa.localeCompare(fb, "ja");
            return (ra.name ?? "").localeCompare(rb.name ?? "", "ja");
          });
          if (!cancelled) setMembers(collected);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, officeFilter, includeInactive]);

  const submitInvite = async () => {
    setInviteError(null);
    if (!currentOfficeId) {
      setInviteError("自事業所を選択してから発行してください");
      return;
    }
    if (!inviteForm.display_name.trim()) {
      setInviteError("氏名は必須です");
      return;
    }
    if (!inviteLinkTo) {
      setInviteError("紐付ける職員を選んでください (いない場合は「新しい職員として作る」)");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch("/api/staff/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: inviteForm.display_name.trim(),
          login_id: inviteForm.login_id.trim() || undefined,
          role: inviteForm.role,
          office_id: currentOfficeId,
          member_id: linkedMember?.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setInviteError(json.message ?? json.error ?? "発行に失敗しました");
        return;
      }
      setInviteResult({ invite_url: json.invite_url, initial_password: json.initial_password, login_id: json.login_id, linked_name: linkedMember ? `${linkedMember.name}${linkedMember.role ? ` (${linkedMember.role})` : ""}` : null });
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setInviting(false);
    }
  };

  const closeModal = () => {
    setInviteOpen(false);
    setInviteResult(null);
    setInviteError(null);
    setInviteForm({ display_name: "", login_id: "", role: "member" });
    setInviteLinkTo("");
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-[max(0.75rem,calc((100%-64rem)/2))] py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <Users size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">職員 ({members.length})</h2>
        <label className="ml-2 text-xs text-gray-600 flex items-center gap-1">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          退職者を含める
        </label>
        <div className="ml-auto">
          <button
            onClick={() => openInvite()}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1"
          >
            <Plus size={14} />
            招待発行
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      ) : members.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">職員がいません</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {/* 5列だけの表なので広い画面では中央寄せで幅を抑える (間延び防止) */}
          <div className="max-w-5xl mx-auto w-full">
          <table className="w-full text-sm bg-white">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2">役職</th>
                <th className="text-left px-3 py-2">雇用形態</th>
                <th className="text-left px-3 py-2 w-20">状態</th>
                <th className="text-left px-3 py-2 w-28">アカウント</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2 text-gray-600">{m.role ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-600">{m.employment_type ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-600"}`}>
                      {m.status === "active" ? "在籍" : "退職"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {hasAccount(m as { auth_user_id?: string | null }) ? (
                      <span className="text-[10px] text-gray-500">あり</span>
                    ) : m.status === "active" ? (
                      <button onClick={() => openInvite(m)} className="text-[11px] px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">招待</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {inviteOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            {inviteResult ? (
              <>
                <h3 className="text-base font-semibold mb-3">招待を発行しました</h3>
                <p className="text-xs text-gray-600 mb-2">下記 URL と初期パスワードを本人に伝えてください。</p>
                <p className="text-xs mb-2">{inviteResult.linked_name ? <span className="text-emerald-700">紐付け先: 既存の職員「{inviteResult.linked_name}」</span> : <span className="text-gray-600">紐付け先: 新しい職員として作成</span>}</p>
                <div className="space-y-2 text-xs">
                  <div>
                    <div className="text-gray-500 mb-0.5">ログイン ID</div>
                    <div className="font-mono bg-gray-50 px-2 py-1 rounded">{inviteResult.login_id}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 mb-0.5">招待 URL</div>
                    <div className="flex items-center gap-1">
                      <input readOnly value={inviteResult.invite_url} className="flex-1 font-mono bg-gray-50 px-2 py-1 rounded text-[10px]" />
                      <button onClick={() => navigator.clipboard.writeText(inviteResult.invite_url)} className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">コピー</button>
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 mb-0.5">初期パスワード</div>
                    <div className="flex items-center gap-1">
                      <input readOnly value={inviteResult.initial_password} className="flex-1 font-mono bg-gray-50 px-2 py-1 rounded" />
                      <button onClick={() => navigator.clipboard.writeText(inviteResult.initial_password)} className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">コピー</button>
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={closeModal} className="text-sm px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded">閉じる</button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-base font-semibold mb-3">招待発行</h3>
                <div className="space-y-3 text-sm">
                  <div>
                    <label className="text-xs text-gray-600">氏名 (必須)</label>
                    <input
                      value={inviteForm.display_name}
                      onChange={(e) => setInviteForm((f) => ({ ...f, display_name: e.target.value }))}
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">紐付ける職員 (必須)</label>
                    <select
                      value={inviteLinkTo}
                      onChange={(e) => {
                        const v = e.target.value;
                        setInviteLinkTo(v);
                        const m = members.find((x) => x.id === v);
                        if (m && !inviteForm.display_name.trim()) setInviteForm((f) => ({ ...f, display_name: m.name ?? "" }));
                      }}
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="">— 選んでください —</option>
                      {members
                        .filter((m) => m.status === "active")
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}{m.role ? ` (${m.role})` : ""}{hasAccount(m as { auth_user_id?: string | null }) ? " ※アカウントあり" : ""}
                          </option>
                        ))}
                      <option value="new">＋ 新しい職員として作る</option>
                    </select>
                    {!inviteLinkTo && nameMatches(inviteForm.display_name).length > 0 && (
                      <button
                        type="button"
                        onClick={() => setInviteLinkTo(nameMatches(inviteForm.display_name)[0].id)}
                        className="text-[11px] text-emerald-700 underline mt-1"
                      >
                        候補: 同じ氏名の「{nameMatches(inviteForm.display_name).map((m) => m.name).join(" / ")}」を選ぶ
                      </button>
                    )}
                    {linkedMember && hasAccount(linkedMember as { auth_user_id?: string | null }) && (
                      <p className="text-[11px] text-amber-700 mt-1">この職員は既にアカウントがあります。二重に発行しないか確認してください</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">ログイン ID (英小文字・数字。漢字の氏名からは作れないので入力してください 例: yarita)</label>
                    <input
                      value={inviteForm.login_id}
                      onChange={(e) => setInviteForm((f) => ({ ...f, login_id: e.target.value }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 font-mono"
                      placeholder="例: yamada"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">役職</label>
                    <div className="flex gap-3 mt-1">
                      <label className="text-xs flex items-center gap-1">
                        <input type="radio" checked={inviteForm.role === "member"} onChange={() => setInviteForm((f) => ({ ...f, role: "member" }))} />
                        一般
                      </label>
                      <label className="text-xs flex items-center gap-1">
                        <input type="radio" checked={inviteForm.role === "office_admin"} onChange={() => setInviteForm((f) => ({ ...f, role: "office_admin" }))} />
                        事業所管理者
                      </label>
                    </div>
                  </div>
                  {inviteError && <div className="text-xs text-red-600">{inviteError}</div>}
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={closeModal} className="text-sm px-4 py-1.5 border border-gray-300 rounded hover:bg-gray-50">キャンセル</button>
                  <button onClick={submitInvite} disabled={inviting} className="text-sm px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded disabled:opacity-50">
                    {inviting ? "発行中..." : "発行"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
