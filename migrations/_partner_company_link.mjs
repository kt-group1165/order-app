// care_offices の office_number から opendata 経由で partner_companies を find-or-create し
// care_offices.partner_company_id をリンクする共通ヘルパー。
// ロジックは kaigo-app 側の migrations/_partner_company_link.mjs / partner-companies.ts の
// upsertPartnerCompany と同一 (13桁法人番号 → 法人名 の順で名寄せ。opendata の corp_number は
// Excel 経由で大半が壊れているため法人名フォールバックが主経路になる)。
//
// care_offices へ新規 INSERT する migration script は、INSERT 直後にこれを呼ぶこと。
// 呼ばなければ partner_company_id が null のまま溜まり、集中減算の集計から漏れる
// (2026-09-01 事業所マスタ整理で発覚: 344件が未リンクのまま蓄積していた)。

const norm = (s) => (s ?? "").replace(/[\s　]/g, "");
const isValidCorpNumber = (v) => /^\d{13}$/.test(v ?? "");

let ownCompanyNamesCache = null;
async function getOwnCompanyNames(sb) {
  if (ownCompanyNamesCache) return ownCompanyNamesCache;
  const { data } = await sb.from("companies").select("name");
  ownCompanyNamesCache = new Set((data ?? []).map((c) => norm(c.name)).filter(Boolean));
  return ownCompanyNamesCache;
}

let selfOfficesByNumberCache = null;
async function getSelfOfficesByNumber(sb) {
  if (selfOfficesByNumberCache) return selfOfficesByNumberCache;
  const { data } = await sb.from("offices").select("id, business_number").not("business_number", "is", null);
  selfOfficesByNumberCache = new Map((data ?? []).map((o) => [o.business_number, o.id]));
  return selfOfficesByNumberCache;
}

/**
 * office_number から opendata を引き、partner_companies を find-or-create して
 * care_offices.partner_company_id を PATCH する。
 * office_number が自社 (offices.business_number) と一致する場合は他社リンクをせず
 * self_office_id を直接張る (opendata は居宅介護支援のみの収録なので、それ以外の
 * サービス種別の自社事業所はこちらでしか拾えない)。
 * 解決できない場合 (opendata不在・番号なし・自社法人で番号不一致) は何もせず null を返す。
 * @returns {Promise<string|null>} 設定した partner_company_id、自社リンクまたは未リンクなら null
 */
export async function linkPartnerCompany(sb, careOfficeId, officeNumber) {
  if (!officeNumber) return null;

  const selfByNumber = await getSelfOfficesByNumber(sb);
  const selfOfficeId = selfByNumber.get(officeNumber);
  if (selfOfficeId) {
    const { error } = await sb.from("care_offices").update({ self_office_id: selfOfficeId }).eq("id", careOfficeId);
    if (error) console.error(`  ⚠ care_offices.self_office_id 更新失敗 (${careOfficeId}): ${error.message}`);
    return null;
  }

  const { data: od } = await sb
    .from("care_offices_opendata")
    .select("corp_name, corp_number")
    .eq("office_number", officeNumber)
    .maybeSingle();
  if (!od) return null;

  const ownNames = await getOwnCompanyNames(sb);
  if (ownNames.has(norm(od.corp_name))) return null; // 自社法人の居宅は他社マスタにリンクしない

  const validNumber = isValidCorpNumber(od.corp_number) ? od.corp_number : null;
  const name = (od.corp_name ?? "").trim() || null;
  if (!validNumber && !name) return null;

  let corpId = null;
  if (validNumber) {
    const { data: byNum } = await sb.from("partner_companies").select("id").eq("corp_number", validNumber).maybeSingle();
    corpId = byNum?.id ?? null;
  }
  if (!corpId && name) {
    const { data: byName } = await sb.from("partner_companies").select("id, corp_number").eq("name", name).limit(1);
    const hit = byName?.[0];
    if (hit?.id) {
      corpId = hit.id;
      if (validNumber && !hit.corp_number) {
        await sb.from("partner_companies").update({ corp_number: validNumber, updated_at: new Date().toISOString() }).eq("id", corpId);
      }
    }
  }
  if (!corpId) {
    const { data: inserted, error } = await sb
      .from("partner_companies")
      .insert({ corp_number: validNumber, name: name ?? `法人番号 ${validNumber}`, source: "opendata" })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505" && validNumber) {
        const { data: raced } = await sb.from("partner_companies").select("id").eq("corp_number", validNumber).maybeSingle();
        corpId = raced?.id ?? null;
      } else {
        console.error(`  ⚠ partner_companies作成失敗 (${officeNumber}): ${error.message}`);
        return null;
      }
    } else {
      corpId = inserted.id;
    }
  }
  if (!corpId) return null;

  const { error: patchErr } = await sb.from("care_offices").update({ partner_company_id: corpId }).eq("id", careOfficeId);
  if (patchErr) {
    console.error(`  ⚠ care_offices.partner_company_id 更新失敗 (${careOfficeId}): ${patchErr.message}`);
    return null;
  }
  return corpId;
}
