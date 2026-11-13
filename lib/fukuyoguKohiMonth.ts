/**
 * 福祉用具 請求の公費まわりの読み書き (2026-11-09)。
 *   - loadKohiForMonth: 当月に重なる公費 (client_public_expenses) を利用者ごとに 1 件にまとめる
 *       (同じ負担者番号の行の期間を periods に集める = 月途中の判定用 / 本人支払額 self_pay_amount)
 *   - getKohiMonthModes / saveKohiMonthMode: 月途中の公費の扱い (fukuyogu_kohi_month_mode)
 * 計算は lib/kokuho-densou/fukuyogu-amounts.ts (computeFukuyoguAmounts の kohi.periods / selfPay / kohiMode)。
 *
 * ⚠ 表・列は migrations/fukuyogu_kohi_month_mode.sql。**未適用でも請求画面と伝送は壊さない**:
 *   - self_pay_amount 列が無ければ 列を外して読み直し、本人支払額 0 (従来どおり) として理由を返す
 *   - fukuyogu_kohi_month_mode が無ければ 全員「未選択」(既定の扱い) として理由を返す
 */
import { rowsForOffice } from "@/lib/insurance/office-scope";
import { supabase } from "./supabase";
import { selectInChunks } from "./inChunks";
import { isTableMissingError } from "./fukuyoguExceptions";
import { isKohiMonthMode, type FukuyoguKohi, type KohiMonthMode } from "./kokuho-densou/fukuyogu-amounts";

type KohiDbRow = {
  client_id: string;
  office_id?: string | null;
  hohei_code: string | null;
  futan_sha_number: string | null;
  jukyu_sha_number: string | null;
  valid_start: string | null;
  valid_end: string | null;
  self_pay_amount?: number | null;
};

/** 列が無い (PostgREST: 42703 / PGRST204) */
export function isColumnMissingError(error: { code?: string; message?: string } | null): boolean {
  const msg = error?.message ?? "";
  return error?.code === "42703" || error?.code === "PGRST204" || (/self_pay_amount/.test(msg) && /does not exist|Could not find/.test(msg));
}

export type KohiMonthLoad = {
  byClient: Map<string, FukuyoguKohi>;
  /** 読めたが注意が要る事項 (列が未適用 等)。画面・警告に出す */
  notices: string[];
  /** 利用者ごとの注意 (本人支払額が行によって違う 等) */
  clientWarnings: Map<string, string[]>;
};

/**
 * 当月 (monthStart〜monthEnd) に重なる公費を利用者ごとに 1 件にまとめる。読めなければ throw (呼出側で alert)。
 *   主の行 = 当月に重なる行のうち 開始日が最も遅いもの (月途中で始まった生保を優先)。
 *   periods = 主の行と同じ (法別, 負担者番号) の行の期間すべて (9/1〜9/15 と 9/16〜9/30 のような分割をまとめる)。
 *   本人支払額 = それらの行の self_pay_amount の最大 (違う値があれば注意を出す)。
 */
export async function loadKohiForMonth(
  tenantId: string, clientIds: string[], monthStart: string, monthEnd: string,
  /** 事業所別保険 (lib/insurance/office-scope.ts)。省略 = 絞らない */
  scope?: { officeId: string | null | undefined; perOfficeIds: readonly string[] },
): Promise<KohiMonthLoad> {
  const notices: string[] = [];
  const clientWarnings = new Map<string, string[]>();
  const base = "client_id, hohei_code, futan_sha_number, jukyu_sha_number, valid_start, valid_end, office_id";
  const run = (select: string) =>
    selectInChunks<KohiDbRow>(clientIds, (chunk) => supabase
      .from("client_public_expenses")
      .select(select)
      .eq("tenant_id", tenantId)
      .in("client_id", chunk), undefined, 8);
  let rows: KohiDbRow[];
  try {
    rows = await run(`${base}, self_pay_amount`);
  } catch (e) {
    if (!isColumnMissingError(e as { code?: string; message?: string })) throw e;
    console.error("client_public_expenses.self_pay_amount 未適用:", (e as { message?: string })?.message);
    notices.push("公費の本人支払額の列 (client_public_expenses.self_pay_amount) が未適用です — migrations/fukuyogu_kohi_month_mode.sql を適用するまで、本人支払額 0 円 (公費対象の利用者負担を全額公費) で計算します");
    rows = await run(base);
  }
  if (scope) rows = rowsForOffice(rows, scope.officeId, scope.perOfficeIds);
  const inMonth = rows.filter((k) => !!k.hohei_code && !(k.valid_start && k.valid_start > monthEnd) && !(k.valid_end && k.valid_end < monthStart));
  const byClientRows = new Map<string, KohiDbRow[]>();
  for (const k of inMonth) {
    if (!byClientRows.has(k.client_id)) byClientRows.set(k.client_id, []);
    byClientRows.get(k.client_id)!.push(k);
  }
  const byClient = new Map<string, FukuyoguKohi>();
  for (const [cid, list] of byClientRows) {
    const sorted = list.slice().sort((a, b) => (b.valid_start ?? "").localeCompare(a.valid_start ?? ""));
    const main = sorted[0];
    const same = sorted.filter((k) => k.hohei_code === main.hohei_code && (k.futan_sha_number ?? "") === (main.futan_sha_number ?? ""));
    const pays = [...new Set(same.map((k) => k.self_pay_amount).filter((v): v is number => typeof v === "number"))];
    if (pays.length > 1) {
      clientWarnings.set(cid, [`当月の公費の行で本人支払額が違います (${pays.join(" / ")} 円) — 大きいほう (${Math.max(...pays)} 円) で計算しました`]);
    }
    if (sorted.length > same.length) {
      const w = clientWarnings.get(cid) ?? [];
      w.push(`当月に別の公費 (法別/負担者番号) の行もあります — 公費1 は ${main.hohei_code}/${main.futan_sha_number ?? "未登録"} だけで計算しました`);
      clientWarnings.set(cid, w);
    }
    byClient.set(cid, {
      hobetsu: main.hohei_code!,
      futansha: main.futan_sha_number,
      jukyusha: main.jukyu_sha_number,
      selfPay: pays.length ? Math.max(...pays) : null,
      periods: same.map((k) => ({ start: k.valid_start, end: k.valid_end })),
    });
  }
  return { byClient, notices, clientWarnings };
}

export type KohiMonthModeLoad = {
  /** client_id → 扱い */
  byClient: Map<string, KohiMonthMode>;
  /** 表が読めたか (false = 未適用・権限なし・通信エラー。全員「未選択」扱い) */
  available: boolean;
  message: string | null;
};

/**
 * 当月の「公費の扱い」を読む。officeId を渡すとその事業所の値だけ。
 * null (全事業所表示) のときは利用者ごとに 1 種類だけなら使い、事業所によって違う利用者は「未選択」にして知らせる。
 */
export async function getKohiMonthModes(tenantId: string, month: string, officeId: string | null): Promise<KohiMonthModeLoad> {
  const byClient = new Map<string, KohiMonthMode>();
  const rows: { client_id: string; mode: string }[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("fukuyogu_kohi_month_mode")
      .select("client_id, mode")
      .eq("tenant_id", tenantId)
      .eq("service_month", month);
    if (officeId) q = q.eq("office_id", officeId);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) {
      const why = isTableMissingError(error)
        ? "公費の扱いの表 (fukuyogu_kohi_month_mode) が未適用です — migrations/fukuyogu_kohi_month_mode.sql を適用するまで、月途中の公費は全員 既定の扱いで請求します"
        : `公費の扱いを読めませんでした (${error.message}) — 月途中の公費は全員 既定の扱いで請求します`;
      console.error("fukuyogu_kohi_month_mode 読込失敗:", error.code, error.message);
      return { byClient, available: false, message: why };
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isKohiMonthMode(r.mode)) continue;
    if (!seen.has(r.client_id)) seen.set(r.client_id, new Set());
    seen.get(r.client_id)!.add(r.mode);
  }
  let conflicted = 0;
  for (const [cid, vals] of seen) {
    if (vals.size === 1) byClient.set(cid, [...vals][0] as KohiMonthMode);
    else conflicted++;
  }
  return {
    byClient,
    available: true,
    message: conflicted
      ? `事業所によって公費の扱いが違う利用者が ${conflicted} 名います — 事業所を選ぶとその事業所の値で計算します (全事業所表示では未選択扱い)`
      : null,
  };
}

/** 公費の扱いを保存する (同じ 利用者×月×事業所 は上書き)。mode=null で削除 (= 未選択に戻す) */
export async function saveKohiMonthMode(args: {
  tenantId: string;
  officeId: string;
  clientId: string;
  month: string;
  mode: KohiMonthMode | null;
}): Promise<void> {
  const { tenantId, officeId, clientId, month, mode } = args;
  if (mode == null) {
    const { error } = await supabase
      .from("fukuyogu_kohi_month_mode")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("office_id", officeId)
      .eq("client_id", clientId)
      .eq("service_month", month);
    if (error) throw new Error(`公費の扱いの削除に失敗: ${error.message}`);
    return;
  }
  const { error } = await supabase.from("fukuyogu_kohi_month_mode").upsert(
    {
      tenant_id: tenantId,
      office_id: officeId,
      client_id: clientId,
      service_month: month,
      mode,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,office_id,client_id,service_month" },
  );
  if (error) throw new Error(`公費の扱いの保存に失敗: ${error.message}`);
}
