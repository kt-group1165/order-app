/**
 * migrations/_exec_lock.mjs (同じ script の同時 --execute を止める) の検査。★ DB 不使用
 *
 *   npx tsx scripts/exec-lock-test.mts
 *
 * ① 純関数 judgeExecLock の境界値
 * ② execLockStart / execLockAcquire / execLockRun を メモリ上の偽 Supabase で動かし、
 *    2026-11-09 の事故 (fix_rebuild_rentals_202611 を 10 秒違いで 2 回 --execute) の型を再現して止まることを見る
 * 負のコントロール: 判定を「常に ok」にすり替えると ②の事故再現が素通りすることを確かめる (= 検査が効いている)。
 * 手で回す診断 (check:all には入れていない。金額・返戻には直接効かないため)。
 */
import {
  judgeExecLock, execLockStart, execLockAcquire, execLockRun,
  EXEC_LOCK_FRESH_MS, EXEC_LOCK_SKEW_MS, EXEC_LOCK_YIELD_MARK,
} from "../migrations/_exec_lock.mjs";

type B = { id: string; status: string; created_at: string; script: string; step?: string | null; args?: string | null; notes?: string | null; executed_at?: string | null };

let fails = 0, passes = 0;
const ok = (cond: boolean, name: string) => { if (cond) passes++; else { fails++; console.log(`  ✗ ${name}`); } };

// ── ① 純関数 ────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-11-09T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const b = (id: string, status: string, at: number, notes: string | null = null): B => ({ id, status, created_at: iso(at), script: "s", notes });
{
  const j = (bs: B[], o: Parameters<typeof judgeExecLock>[1]) => judgeExecLock(bs, o).verdict;
  ok(j([], { now: T0 }) === "ok", "空なら ok");
  ok(j([b("a", "executed", T0 - 1000)], { now: T0 }) === "ok", "開始時は 終わった batch を見ない");
  ok(j([b("a", "running", T0 - 10_000)], { now: T0 }) === "busy", "10 秒前の running は busy");
  ok(j([b("a", "running", T0 - EXEC_LOCK_FRESH_MS)], { now: T0 }) === "busy", "ちょうど 60 分は busy");
  ok(j([b("a", "running", T0 - EXEC_LOCK_FRESH_MS - 1)], { now: T0 }) === "stale", "60 分超は stale");
  ok(j([b("a", "running", T0 - 10), b("x", "running", T0 - 9e9)], { now: T0 }) === "busy", "busy と stale が両方なら busy");
  ok(j([b("me", "running", T0)], { now: T0, selfId: "me" }) === "ok", "自分は数えない");
  const S = T0 - 60_000;
  ok(j([b("a", "executed", S + 1)], { now: T0, startedAt: S }) === "changed", "開始後に作られて終わった batch は changed");
  ok(j([b("a", "executed", S - EXEC_LOCK_SKEW_MS)], { now: T0, startedAt: S }) === "changed", "時計ずれの余裕 30 秒ちょうどは changed");
  ok(j([b("a", "executed", S - EXEC_LOCK_SKEW_MS - 1)], { now: T0, startedAt: S }) === "ok", "余裕より前は ok");
  ok(j([b("a", "dry_run", S + 1)], { now: T0, startedAt: S }) === "ok", "dry_run は数えない");
  ok(j([b("a", "failed", S + 1, `${EXEC_LOCK_YIELD_MARK} 譲った`)], { now: T0, startedAt: S }) === "ok", "書く前に譲った failed は数えない");
  ok(j([b("a", "failed", S + 1, "失敗: x")], { now: T0, startedAt: S }) === "changed", "途中で落ちた failed は数える (書込みが残る)");
  ok(j([b("a", "reverted", S + 1)], { now: T0, startedAt: S }) === "changed", "取り消しも changed");
}

// ── ② 偽 Supabase (data_import_batches だけ) ─────────────────────────────
class FakeDb {
  rows: B[] = [];
  seq = 0;
  clock = T0;
  from(table: string) {
    if (table !== "data_import_batches") throw new Error(`fake: ${table}`);
    return new Query(this);
  }
}
class Query {
  private filters: ((r: B) => boolean)[] = [];
  private mode: "select" | "insert" | "update" = "select";
  private payload: Partial<B> = {};
  private single_ = false;
  constructor(private db: FakeDb) {}
  select(_cols?: string) { void _cols; return this; }
  order() { return this; }
  limit() { return this; }
  eq(c: keyof B, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  gte(c: keyof B, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  insert(row: Partial<B>) { this.mode = "insert"; this.payload = row; return this; }
  update(p: Partial<B>) { this.mode = "update"; this.payload = p; return this; }
  single() { this.single_ = true; return this; }
  then<R>(res: (v: { data: unknown; error: null }) => R) {
    const db = this.db;
    if (this.mode === "insert") {
      const r = { ...(this.payload as B), id: `b${++db.seq}`, created_at: iso(db.clock) };
      db.rows.push(r);
      return Promise.resolve(res({ data: this.single_ ? { id: r.id } : [r], error: null }));
    }
    const hit = db.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") { for (const r of hit) Object.assign(r, this.payload); return Promise.resolve(res({ data: null, error: null })); }
    return Promise.resolve(res({ data: hit.map((r) => ({ ...r })), error: null }));
  }
}
class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }
const realExit = process.exit, realErr = console.error, realWarn = console.warn;
async function run<T>(fn: () => Promise<T>): Promise<{ exit: number | null; value?: T }> {
  process.exit = ((c?: number) => { throw new Exit(c ?? 0); }) as typeof process.exit;
  console.error = () => {}; console.warn = () => {};
  try { return { exit: null, value: await fn() }; }
  catch (e) { if (e instanceof Exit) return { exit: e.code }; throw e; }
  finally { process.exit = realExit; console.error = realErr; console.warn = realWarn; }
}
const S = "apps/order-app/migrations/fix_rebuild_rentals_202611.mjs";
const row = { tenant_id: "kt-group", source_system: "x", source_files: [], script: S, args: "--execute", step: "teikyo-rebuild-fix", notes: "n" };

async function scenarios(label: string) {
  const out: Record<string, boolean> = {};
  const realNow = Date.now;
  const db = new FakeDb();
  const sb = db as unknown as Parameters<typeof execLockStart>[0];
  try {
    // A: 事故の型 1 — 1 回目が batch を作って書いている最中に 2 回目が始まる
    Date.now = () => db.clock;
    const A = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));
    db.clock += 5_000;
    const Ab = await run(() => execLockAcquire(sb, A.value!, row));
    db.clock += 10_000;
    const B1 = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));
    out["書込み中に始めた 2 回目は 開始時に止まる (exit 2)"] = B1.exit === 2;

    // 事故の型 2 — 2 回目が 計画中に 1 回目が書いて終わる → 2 回目の書込み直前に止まる
    db.rows = []; db.clock += 1000;
    const P = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));
    db.clock += 10_000;
    const Q = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));   // P はまだ batch を作っていない
    db.clock += 1_000;
    const Pb = await run(() => execLockAcquire(sb, P.value!, row));
    db.rows.find((r) => r.id === (Pb.value as { id: string })?.id)!.status = "executed";
    db.clock += 1_000;
    const Qb = await run(() => execLockAcquire(sb, Q.value!, row));
    out["計画中に他が書き終えた 2 回目は 書込み直前に止まる"] = Pb.exit === null && Qb.exit === 2;
    out["止まった 2 回目は batch を作っていない"] = db.rows.length === 1;

    // 同時 insert — 2 本が同じ瞬間に batch を作る → 両方 自分を failed にして止まる
    db.rows = []; db.clock += 1000;
    const X = (await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }))).value!;
    const Y = (await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }))).value!;
    // 事前確認は両方通った後に insert が重なる状況を作る: Y の insert を先に差し込む
    db.rows.push({ ...row, id: "y-concurrent", status: "running", created_at: iso(db.clock) } as B);
    const Xb = await run(() => execLockAcquire(sb, X, row));
    out["同時の相手が running なら 書込み直前で止まる"] = Xb.exit === 2;
    db.rows = [];
    // insert 直後に相手が現れる (事前確認と insert の間に割り込まれた) ケース
    const origInsert = Query.prototype.insert;
    Query.prototype.insert = function (this: Query, r: Partial<B>) { db.rows.push({ ...row, id: "y-race", status: "running", created_at: iso(db.clock) } as B); Query.prototype.insert = origInsert; return origInsert.call(this, r); };
    const Xc = await run(() => execLockAcquire(sb, X, row));
    const mine = db.rows.find((r) => r.id !== "y-race");
    out["insert 直後の再確認で 相手を見たら自分を failed にして止まる"] = Xc.exit === 2 && mine?.status === "failed" && String(mine?.notes).startsWith(EXEC_LOCK_YIELD_MARK);
    void Y;

    // 異常終了で残った running (61 分前) → --force-unlock なしは止まる / ありは failed にして進む
    db.rows = [{ ...row, id: "old", status: "running", created_at: iso(db.clock - EXEC_LOCK_FRESH_MS - 60_000) } as B];
    const St = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));
    const Sf = await run(() => execLockStart(sb, { script: S, argv: ["--execute", "--force-unlock"] }));
    out["古い running は --force-unlock なしで止まる"] = St.exit === 2;
    out["--force-unlock で古い running を failed にして進む"] = Sf.exit === null && db.rows[0].status === "failed";
    const Sb2 = await run(() => execLockAcquire(sb, Sf.value!, row));
    out["force-unlock 後は 書き込める (解除した batch は changed に数えない)"] = Sb2.exit === null;

    // 別 script の running は無関係
    db.rows = [{ ...row, script: "other.mjs", id: "o", status: "running", created_at: iso(db.clock) } as B];
    const Ot = await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }));
    out["別 script の running では止まらない"] = Ot.exit === null;

    // execLockRun: 正常 → executed / 例外 → failed
    db.rows = []; db.clock += 1000;
    const L1 = (await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }))).value!;
    await run(() => execLockRun(sb, L1, { ...row, step: "revert-lock" }, async () => 1));
    db.clock += EXEC_LOCK_SKEW_MS + 1000; // 直前 30 秒以内に終わった実行は changed (時計ずれの余裕) なので少し後にする
    const L2 = (await run(() => execLockStart(sb, { script: S, argv: ["--execute"] }))).value!;
    let threw = false;
    try { await run(() => execLockRun(sb, L2, { ...row, step: "revert-lock" }, async () => { throw new Error("boom"); })); } catch { threw = true; }
    out["execLockRun: 正常は executed / 例外は failed にして投げ直す"] = db.rows[0].status === "executed" && db.rows[1]?.status === "failed" && threw;
    void Ab;
  } finally { Date.now = realNow; }
  console.log(`── ${label}`);
  return out;
}

const real = await scenarios("②本物の判定");
for (const [k, v] of Object.entries(real)) ok(v, k);

// ── 負のコントロール: 判定を常に ok にした版で 事故の型を流すと 止まらないこと ──
// (= ②の検査が「何をしても通る」ものではないことの確認)
{
  const db = new FakeDb();
  const realNow = Date.now; Date.now = () => db.clock;
  const naiveAcquire = async (r: typeof row) => (await db.from("data_import_batches").insert({ ...r, status: "running" }).select("id").single()).data;
  try {
    await naiveAcquire(row);                                 // 1 回目 (書込み中)
    db.clock += 10_000;
    const second = await run(() => naiveAcquire(row));       // 2 回目: ロック無しなら素通り
    const naiveVerdict = judgeExecLock(db.rows, { now: db.clock }).verdict;
    ok(second.exit === null && db.rows.length === 2, "負のコントロール: ロック無しでは 2 本目が batch を作ってしまう (事故の再現)");
    ok(naiveVerdict === "busy", "負のコントロール: その状態を judgeExecLock は busy と判定する");
  } finally { Date.now = realNow; }
}

console.log(`\nexec-lock: ${passes} PASS / ${fails} FAIL`);
if (fails) process.exit(1);
