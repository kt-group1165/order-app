import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// スマホページ (/m/demo) 用のデモ機管理 API。
// 認証: URL 共有キー (env MEETING_FORM_KEY。会議録と同じキー 1 本運用) の一致を
// 検証してから service_role で demo_units / demo_loans を読み書きする。
// キー未設定時は 503 を返す (Vercel の環境変数に設定が必要)。
// 台帳の追加・編集は本体アプリのみ (スマホは 持出 / 返却 だけ)。

const TENANT_ID = "kt-group";
const MAX_LEN = 4000;

// 事業所別 URL の slug → 本体 offices.id (データ連結キー) + 表示名
const OFFICES: Record<string, { id: string; label: string }> = {
  "caresupo":   { id: "1bfc0d57-9ee0-4ae2-baa5-80edb776290a", label: "介護ショップケア・サポート千葉" },
  "hana-mutsumi": { id: "bf2cbf8d-d4ca-4887-beae-a867d71a2b16", label: "Ｈａｎａムツミ福祉用具" },
  "takashina":  { id: "ea7d88ea-5373-4054-8b6d-e8a11fbae217", label: "千葉ムツミ福祉用具高品" },
  "hanamigawa": { id: "e1b7b604-a4fd-44d5-98d1-efcb440ba035", label: "Ｈａｎａ福祉用具花見川" },
  "links":      { id: "c3a5a2f7-a8f9-4d7a-81f5-3cf6a9c51f08", label: "リンクス福祉用具" },
};

const s = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, MAX_LEN);
};

// 一覧取得: { units, loans }。office 指定時はその事業所の units + それに紐づく open loans
export async function GET(req: Request) {
  const formKey = process.env.MEETING_FORM_KEY;
  if (!formKey) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (MEETING_FORM_KEY 未設定)" },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== formKey) {
    return NextResponse.json({ error: "キーが正しくありません" }, { status: 403 });
  }
  const officeSlug = url.searchParams.get("office");
  const office = officeSlug ? OFFICES[officeSlug] : null;
  if (officeSlug && !office) {
    return NextResponse.json({ error: "事業所の指定が正しくありません" }, { status: 400 });
  }

  const admin = createAdminClient();
  let unitsQ = admin
    .from("demo_units")
    .select("id, office_id, unit_no, category, product_name, color, storage_location, cleaned, memo, sort_order")
    .eq("tenant_id", TENANT_ID)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("unit_no", { ascending: true });
  // 事業所指定 URL からはその事業所の分だけ (指定なし = 全件)
  if (office) unitsQ = unitsQ.eq("office_id", office.id);
  const { data: units, error: unitsError } = await unitsQ;
  if (unitsError) {
    console.error("demo units list failed:", unitsError.message);
    return NextResponse.json({ error: `取得に失敗しました: ${unitsError.message}` }, { status: 500 });
  }

  const { data: loans, error: loansError } = await admin
    .from("demo_loans")
    .select("id, unit_id, client_name, taken_date, taken_by, due_date, memo, created_at")
    .eq("tenant_id", TENANT_ID)
    .is("returned_date", null)
    .order("created_at", { ascending: false });
  if (loansError) {
    console.error("demo loans list failed:", loansError.message);
    return NextResponse.json({ error: `取得に失敗しました: ${loansError.message}` }, { status: 500 });
  }

  // office 指定時は取得した units に紐づく loan だけに絞る
  const unitIds = new Set((units ?? []).map((u) => u.id));
  const openLoans = (loans ?? []).filter((l) => unitIds.has(l.unit_id));
  return NextResponse.json({ units: units ?? [], loans: openLoans });
}

// 持出 (action="checkout") / 返却 (action="return")
export async function POST(req: Request) {
  const formKey = process.env.MEETING_FORM_KEY;
  if (!formKey) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (MEETING_FORM_KEY 未設定)" },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  if (typeof body.key !== "string" || body.key !== formKey) {
    return NextResponse.json({ error: "キーが正しくありません" }, { status: 403 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  if (body.action === "checkout") {
    const unitId = s(body.unitId);
    if (!unitId) {
      return NextResponse.json({ error: "デモ機の指定が正しくありません" }, { status: 400 });
    }
    const clientName = s(body.clientName);
    if (!clientName) {
      return NextResponse.json({ error: "利用者名は必須です" }, { status: 400 });
    }
    const { error: loanError } = await admin.from("demo_loans").insert({
      tenant_id: TENANT_ID,
      unit_id: unitId,
      client_name: clientName,
      taken_date: s(body.takenDate),
      taken_by: s(body.takenBy),
      due_date: s(body.dueDate),
      memo: s(body.memo),
    });
    if (loanError) {
      console.error("demo checkout insert failed:", loanError.message);
      return NextResponse.json({ error: `保存に失敗しました: ${loanError.message}` }, { status: 500 });
    }
    const { error: unitError } = await admin
      .from("demo_units")
      .update({ storage_location: "利用者宅", cleaned: false, updated_at: nowIso })
      .eq("tenant_id", TENANT_ID)
      .eq("id", unitId);
    if (unitError) {
      console.error("demo checkout unit update failed:", unitError.message);
      return NextResponse.json({ error: `保存に失敗しました: ${unitError.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "return") {
    const loanId = s(body.loanId);
    const unitId = s(body.unitId);
    if (!loanId || !unitId) {
      return NextResponse.json({ error: "返却対象の指定が正しくありません" }, { status: 400 });
    }
    const returnedDate = s(body.returnedDate);
    if (!returnedDate) {
      return NextResponse.json({ error: "返却日は必須です" }, { status: 400 });
    }
    const { error: loanError } = await admin
      .from("demo_loans")
      .update({
        returned_date: returnedDate,
        returned_by: s(body.returnedBy),
      })
      .eq("tenant_id", TENANT_ID)
      .eq("id", loanId);
    if (loanError) {
      console.error("demo return loan update failed:", loanError.message);
      return NextResponse.json({ error: `保存に失敗しました: ${loanError.message}` }, { status: 500 });
    }
    const { error: unitError } = await admin
      .from("demo_units")
      .update({
        storage_location: s(body.storageLocation) ?? "事務所",
        cleaned: body.cleaned === true,
        updated_at: nowIso,
      })
      .eq("tenant_id", TENANT_ID)
      .eq("id", unitId);
    if (unitError) {
      console.error("demo return unit update failed:", unitError.message);
      return NextResponse.json({ error: `保存に失敗しました: ${unitError.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
}
