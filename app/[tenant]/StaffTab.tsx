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
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ invite_url: string; initial_password: string; login_id: string } | null>(null);
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
              .order("member_id").order("office_id").range(from, from + PAGE - 1);
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
        // members .in("id", ...) も IN 句が肥大化しすぎないようチャンク分割 (URL 長対策)
        if (memberIds.length === 0) {
          if (!cancelled) setMembers([]);
        } else {
          const CHUNK = 500;
          const collected: typeof members = [];
          for (let i = 0; i < memberIds.length; i += CHUNK) {
            const slice = memberIds.slice(i, i + CHUNK);
            let q = supabase.from("members").select("*").eq("tenant_id", tenantId).is("deleted_at", null).in("id", slice);
            if (!includeInactive) q = q.eq("status", "active");
            const { data, error } = await q;
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
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setInviteError(json.message ?? json.error ?? "発行に失敗しました");
        return;
      }
      setInviteResult({ invite_url: json.invite_url, initial_password: json.initial_password, login_id: json.login_id });
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
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <Users size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">職員 ({members.length})</h2>
        <label className="ml-2 text-xs text-gray-600 flex items-center gap-1">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          退職者を含める
        </label>
        <div className="ml-auto">
          <button
            onClick={() => setInviteOpen(true)}
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
          <table className="w-full text-sm bg-white">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2">役職</th>
                <th className="text-left px-3 py-2">雇用形態</th>
                <th className="text-left px-3 py-2 w-20">状態</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inviteOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            {inviteResult ? (
              <>
                <h3 className="text-base font-semibold mb-3">招待を発行しました</h3>
                <p className="text-xs text-gray-600 mb-2">下記 URL と初期パスワードを本人に伝えてください。</p>
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
                    <label className="text-xs text-gray-600">ログイン ID (任意、空欄なら自動派生)</label>
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
