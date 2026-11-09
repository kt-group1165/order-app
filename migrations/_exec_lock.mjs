/**
 * data_import_batches を使った「同じ script の同時 --execute」防止 (2026-11-09 / FY-L)
 *
 * 発端: fix_rebuild_rentals_202611.mjs --execute が 2 か所 (アプリのターミナルと PowerShell) で 10 秒違いで
 *       同時に走り、2 回目が 1 回目の途中の DB で計画を作って価格履歴を重複 insert した (batch e53c6111 / 17fd1f53)。
 *
 * 使い方 (DRY RUN では呼ばない = DRY RUN はロックしない):
 *
 *   import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
 *   const lock = EXECUTE ? await execLockStart(sb, { script: SCRIPT_REL, argv }) : null;  // ★ 計画の DB 読みより前
 *   …計画…
 *   const batch = await execLockAcquire(sb, lock, { tenant_id, source_system, script: SCRIPT_REL, … }); // insert の代わり
 *   // revert など自前の batch を作らない書込みは:
 *   await execLockRun(sb, lock, { tenant_id, source_system, script: SCRIPT_REL, args, step: "revert-lock", notes }, async () => { … });
 *
 * 判定 (同じ data_import_batches.script の行だけを見る):
 *   ① execLockStart (計画の前)
 *        status='running' の batch がある → 止める (exit 2)
 *          作成から 60 分以内 = 「他で実行中」 / 60 分超 = 「異常終了で残った可能性」
 *          どちらも --force-unlock を付ければ その batch を failed にしてから進む (人が確かめた前提)
 *   ② execLockAcquire (書込みの直前。自分の batch を作る前)
 *        running がある → 止める (①の後に誰かが始めた)
 *        ①以降 (時計ずれ 30 秒の余裕込み) に作られた batch がある (executed/failed/reverted…) → 止める
 *          = 自分の計画を作っている間に 他が書いた。計画が古いので 再実行 (DRY RUN から)
 *   ③ 自分の batch を insert した直後にもう一度見る
 *        自分以外の running / ①以降の batch がある → 自分を failed (notes 先頭 "[exec-lock]") にして止める
 *        同時に insert した 2 本は お互いを見て 両方止まる (安全側。片方ずつ再実行)
 *   "[exec-lock]" で始まる failed (= 書く前に譲った batch) と dry_run は ②③ の「他が書いた」に数えない。
 *
 * 判定は純関数 judgeExecLock に切り出してある (scripts/exec-lock-test.mts で DB 無しに検査)。
 */

export const EXEC_LOCK_FRESH_MS = 60 * 60 * 1000;
export const EXEC_LOCK_SKEW_MS = 30 * 1000;
export const EXEC_LOCK_YIELD_MARK = "[exec-lock]";
const EXIT_CODE = 2;

/**
 * @param {{id:string,status:string,created_at:string,step?:string|null,args?:string|null,notes?:string|null}[]} batches 同じ script の batch
 * @param {{ now:number, startedAt?:number|null, selfId?:string|null, freshMs?:number, skewMs?:number }} o
 *   startedAt: execLockStart の時刻 (ms)。null なら「他が書いた」は見ない (①)
 * @returns {{ verdict:"ok"|"busy"|"stale"|"changed", fresh:object[], stale:object[], changed:object[] }}
 */
export function judgeExecLock(batches, { now, startedAt = null, selfId = null, freshMs = EXEC_LOCK_FRESH_MS, skewMs = EXEC_LOCK_SKEW_MS }) {
  const t = (b) => Date.parse(b.created_at);
  const others = batches.filter((b) => b.id !== selfId);
  const running = others.filter((b) => b.status === "running");
  const fresh = running.filter((b) => now - t(b) <= freshMs);
  const stale = running.filter((b) => now - t(b) > freshMs);
  const changed = startedAt == null ? [] : others.filter((b) =>
    b.status !== "running" && b.status !== "dry_run" && !String(b.notes ?? "").startsWith(EXEC_LOCK_YIELD_MARK) && t(b) >= startedAt - skewMs);
  const verdict = fresh.length ? "busy" : stale.length ? "stale" : changed.length ? "changed" : "ok";
  return { verdict, fresh, stale, changed };
}

const fmt = (b, now) => `  batch ${b.id} / ${b.status} / 開始 ${b.created_at} (${Math.round((now - Date.parse(b.created_at)) / 60000)} 分前) / step ${b.step ?? "-"} / args ${b.args ?? ""}`;

/** 判定結果の説明 (表示用) */
export function describeExecLock(res, { script, now, phase }) {
  const out = [];
  if (res.fresh.length) {
    out.push(`★ 他で実行中のため止めた (${phase}): ${script}`);
    for (const b of res.fresh) out.push(fmt(b, now));
    out.push("  → 終わってから再実行 (DRY RUN から)。前回が異常終了で running のまま残っているなら、確かめたうえで --force-unlock を付ける");
  }
  if (res.stale.length) {
    out.push(`★ running のまま ${Math.round(EXEC_LOCK_FRESH_MS / 60000)} 分を超えた batch がある (異常終了の可能性) ため止めた (${phase}): ${script}`);
    for (const b of res.stale) out.push(fmt(b, now));
    out.push("  → 本当に動いていないことを確かめてから --force-unlock を付けて再実行 (その batch を failed にしてから進む)");
  }
  if (!res.fresh.length && !res.stale.length && res.changed.length) {
    out.push(`★ 計画を作っている間に 同じ script の別の実行が DB を書いた ため止めた (${phase}): ${script}`);
    for (const b of res.changed) out.push(fmt(b, now));
    out.push(`  → この計画は古い。DRY RUN からやり直す (時計ずれの余裕で 開始の ${EXEC_LOCK_SKEW_MS / 1000} 秒前までに作られた batch も数える。直前に終わった実行なら 少し待って再実行)`);
  }
  return out;
}

async function listBatches(sb, script, sinceMs) {
  const cols = "id,status,created_at,step,args,notes";
  const q1 = await sb.from("data_import_batches").select(cols).eq("script", script).eq("status", "running").order("created_at").order("id").limit(1000);
  if (q1.error) throw new Error(`exec-lock: data_import_batches を読めない: ${q1.error.message}`);
  let rows = q1.data ?? [];
  if (sinceMs != null) {
    const q2 = await sb.from("data_import_batches").select(cols).eq("script", script).gte("created_at", new Date(sinceMs - EXEC_LOCK_SKEW_MS).toISOString()).order("created_at").order("id").limit(1000);
    if (q2.error) throw new Error(`exec-lock: data_import_batches を読めない: ${q2.error.message}`);
    const seen = new Set(rows.map((r) => r.id));
    rows = rows.concat((q2.data ?? []).filter((r) => !seen.has(r.id)));
  }
  return rows;
}

function stop(lines) {
  for (const l of lines) console.error(l);
  process.exit(EXIT_CODE);
}

/**
 * ① --execute の最初 (計画の DB 読みより前) に呼ぶ。止めるときは exit 2。
 * @returns {Promise<{script:string, startedAt:number, argv:string[]}>}
 */
export async function execLockStart(sb, { script, argv = process.argv.slice(2) }) {
  if (!script) throw new Error("exec-lock: script が空");
  const now = Date.now();
  const res = judgeExecLock(await listBatches(sb, script, null), { now });
  if (res.verdict !== "ok") {
    if (!argv.includes("--force-unlock")) stop(describeExecLock(res, { script, now, phase: "開始時" }));
    for (const b of [...res.fresh, ...res.stale]) {
      const note = `${EXEC_LOCK_YIELD_MARK} --force-unlock で failed に (${new Date(now).toISOString()} / 解除した実行の args: ${argv.join(" ")})${b.notes ? ` / 元の notes: ${b.notes}` : ""}`.slice(0, 2000);
      const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: note }).eq("id", b.id).eq("status", "running");
      if (error) throw new Error(`exec-lock: batch ${b.id} を failed にできない: ${error.message}`);
      console.warn(`⚠ --force-unlock: batch ${b.id} (開始 ${b.created_at}) を failed にした。書込みが途中なら data_import_rows から --revert で戻せる`);
    }
  }
  return { script, startedAt: now, argv };
}

/**
 * ②③ 自分の batch を作る (status は running で入れる)。sb.from("data_import_batches").insert(row).select(select).single() の代わり。
 * 止めるときは exit 2 (自分の batch を作った後なら それを failed にしてから)。
 */
export async function execLockAcquire(sb, lock, row, select = "id") {
  if (!lock || typeof lock.startedAt !== "number") throw new Error("exec-lock: execLockStart を先に呼ぶ (--execute の最初に)");
  if (row.script !== lock.script) throw new Error(`exec-lock: script が違う (${row.script} ≠ ${lock.script})`);
  let now = Date.now();
  const pre = judgeExecLock(await listBatches(sb, lock.script, lock.startedAt), { now, startedAt: lock.startedAt });
  if (pre.verdict !== "ok") stop(describeExecLock(pre, { script: lock.script, now, phase: "書込み直前" }));

  const sel = select.split(",").map((s) => s.trim()).includes("id") ? select : `id,${select}`;
  const { data, error } = await sb.from("data_import_batches").insert({ ...row, status: "running" }).select(sel).single();
  if (error || !data) throw new Error(`data_import_batches: ${error?.message ?? "insert が行を返さない"}`);

  now = Date.now();
  const post = judgeExecLock(await listBatches(sb, lock.script, lock.startedAt), { now, startedAt: lock.startedAt, selfId: data.id });
  if (post.verdict !== "ok") {
    const lines = describeExecLock(post, { script: lock.script, now, phase: "batch 作成直後" });
    const { error: e2 } = await sb.from("data_import_batches").update({ status: "failed", notes: `${EXEC_LOCK_YIELD_MARK} 同時実行を検知して書く前に止めた (書込み 0 行)` }).eq("id", data.id);
    if (e2) lines.push(`★ 自分の batch ${data.id} を failed にできなかった: ${e2.message} (running のまま残る。確かめて --force-unlock)`);
    else lines.push(`  自分の batch ${data.id} は failed にした (書込み 0 行)`);
    stop(lines);
  }
  return data;
}

/**
 * revert など 自前の batch を作らない書込みを ロック用の batch で包む。
 * fn が投げたらロック batch を failed、正常なら executed にする。
 */
export async function execLockRun(sb, lock, row, fn) {
  const b = await execLockAcquire(sb, lock, row);
  try {
    const r = await fn(b.id);
    const { error } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", b.id);
    if (error) throw new Error(`exec-lock: ロック batch ${b.id} を executed にできない: ${error.message}`);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `${row.notes ?? ""} / 失敗: ${msg}`.slice(0, 2000) }).eq("id", b.id);
    if (error) console.error(`exec-lock: ロック batch ${b.id} を failed にできない: ${error.message}`);
    throw e;
  }
}
