// migrations/order_app_care_plan_elements_backfill.mjs
//
// order-app 個別援助計画書 要素ベース化の backfill
//
// 背景:
//   migrations/order_app_care_plan_elements_triggers.sql の DB trigger は
//   trigger 適用後の INSERT/UPDATE のみを観測する。trigger 適用前から存在する
//   過去の order_items / client_insurance_records は care_plan_elements が
//   空のまま → UI で見えない。
//
//   本 script は既存データを走査して care_plan_elements を初期 INSERT する。
//   ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING で冪等。
//
// 使い方:
//   DRY_RUN=true  node apps/order-app/migrations/order_app_care_plan_elements_backfill.mjs
//   DRY_RUN=false node apps/order-app/migrations/order_app_care_plan_elements_backfill.mjs
//
// 必要 env:
//   SUPABASE_URL              = NEXT_PUBLIC_SUPABASE_URL と同値
//   SUPABASE_SERVICE_ROLE_KEY = service_role key

import { createClient } from '@supabase/supabase-js';

// const URL = WHATWG URL を shadow する罠を避けるため SB_URL に rename
const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error('env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要');
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN !== 'false';
console.log(DRY_RUN
  ? '*** DRY RUN MODE *** (本番は DRY_RUN=false で再実行)'
  : '*** LIVE MODE *** (実際に INSERT します)');

const admin = createClient(SB_URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGE = 1000;

async function fetchAllPaged(table, query) {
  const all = [];
  let from = 0;
  while (true) {
    const q = query(admin.from(table)).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) {
      console.error(`${table} fetch error:`, error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  // ── 1. 既存 care_plan_elements (skip 判定用) ───────────────────────
  const existing = await fetchAllPaged('care_plan_elements', q =>
    q.select('element_type, ref_table, ref_id'));
  const existingKey = (e) => `${e.element_type}|${e.ref_table}|${e.ref_id}`;
  const existingSet = new Set(existing.map(existingKey));
  console.log(`既存 care_plan_elements: ${existing.length} 件`);

  // ── 2. clients (tenant/office 解決用) ──────────────────────────────
  const clients = await fetchAllPaged('clients', q =>
    q.select('id, tenant_id, office_id'));
  const clientById = new Map(clients.map(c => [c.id, c]));

  // ── 3. orders (office/client/tenant 解決用) ─────────────────────────
  const orders = await fetchAllPaged('orders', q =>
    q.select('id, tenant_id, office_id, client_id'));
  const orderById = new Map(orders.map(o => [o.id, o]));

  // ── 4. equipment_master (用具名 lookup) ─────────────────────────────
  const equip = await fetchAllPaged('equipment_master', q =>
    q.select('product_code, name'));
  const equipName = new Map(equip.map(e => [e.product_code, e.name]));

  // ── 5. care_offices (居宅名 lookup) ─────────────────────────────────
  const careOffices = await fetchAllPaged('care_offices', q =>
    q.select('id, name'));
  const careOfficeName = new Map(careOffices.map(o => [o.id, o.name]));

  // ── 6. order_items 全件 (status 変動を時系列で iterate) ─────────────
  const items = await fetchAllPaged('order_items', q =>
    q.select('id, order_id, product_code, status, rental_start_date, rental_end_date, cancelled_at'));
  console.log(`order_items: ${items.length} 件`);

  // ── 7. client_insurance_records 全件 ──────────────────────────────
  const records = await fetchAllPaged('client_insurance_records', q =>
    q.select('id, client_id, effective_date, care_level, certification_start_date, certification_end_date, care_office_id, created_at'));
  console.log(`client_insurance_records: ${records.length} 件`);

  // ── 要素生成 ──────────────────────────────────────────────────────
  const toInsert = [];

  // 7-1: order_items を rental_start_date ASC で並べて new_delivery / additional_delivery
  // 同 client 内の「より早い rental_start_date を持つ active item」数で判定
  const itemsByClient = new Map();
  for (const it of items) {
    const ord = orderById.get(it.order_id);
    if (!ord || !ord.client_id) continue;
    if (!itemsByClient.has(ord.client_id)) itemsByClient.set(ord.client_id, []);
    itemsByClient.get(ord.client_id).push({ ...it, _order: ord });
  }

  for (const [clientId, clientItems] of itemsByClient) {
    // rental_started されたことのある item のみ (rental_start_date が入ってる)
    const startedItems = clientItems
      .filter(i => i.rental_start_date)
      .sort((a, b) => String(a.rental_start_date).localeCompare(String(b.rental_start_date)));

    for (const it of startedItems) {
      // この item より前に rental_start_date を持つ item が他にあるか
      const earlier = startedItems.filter(o =>
        o.id !== it.id &&
        String(o.rental_start_date) < String(it.rental_start_date)
      );
      // 当該 item の rental_start_date 時点で active (= まだ解約してなかった) ものの count
      const earlierActiveAtStart = earlier.filter(o => {
        const endDate = o.rental_end_date || o.cancelled_at?.slice(0, 10) || null;
        if (!endDate) return true;
        return String(endDate) > String(it.rental_start_date);
      });
      const elementType = earlierActiveAtStart.length > 0 ? 'additional_delivery' : 'new_delivery';

      const key = `${elementType}|order_items|${it.id}`;
      if (existingSet.has(key)) continue;

      toInsert.push({
        tenant_id: it._order.tenant_id,
        office_id: it._order.office_id,
        client_id: clientId,
        occurred_at: it.rental_start_date,
        element_type: elementType,
        ref_table: 'order_items',
        ref_id: it.id,
        detail: {
          equipment_name: equipName.get(it.product_code) ?? null,
          product_code: it.product_code,
        },
        status: 'pending',
      });
    }

    // 7-2: 一部解約 (元 rental_started で今は terminated/cancelled、解約日時点で active 残 > 0)
    const terminated = clientItems.filter(i =>
      i.rental_start_date &&
      ['terminated', 'cancelled'].includes(i.status) &&
      (i.rental_end_date || i.cancelled_at)
    );

    for (const it of terminated) {
      const endDate = it.rental_end_date || it.cancelled_at?.slice(0, 10);
      if (!endDate) continue;

      // 解約日時点での同 client active count (この item を除く)
      // active = rental_start_date <= endDate AND (rental_end_date IS NULL OR rental_end_date > endDate)
      const activeAtEnd = startedItems.filter(o => {
        if (o.id === it.id) return false;
        const oEnd = o.rental_end_date || o.cancelled_at?.slice(0, 10) || null;
        return String(o.rental_start_date) <= String(endDate)
            && (oEnd === null || String(oEnd) > String(endDate));
      });

      if (activeAtEnd.length === 0) continue; // 全解約は無視

      const key = `pickup|order_items|${it.id}`;
      if (existingSet.has(key)) continue;

      toInsert.push({
        tenant_id: it._order.tenant_id,
        office_id: it._order.office_id,
        client_id: clientId,
        occurred_at: endDate,
        element_type: 'pickup',
        ref_table: 'order_items',
        ref_id: it.id,
        detail: {
          equipment_name: equipName.get(it.product_code) ?? null,
          product_code: it.product_code,
        },
        status: 'pending',
      });
    }
  }

  // 7-3: client_insurance_records を effective_date ASC で iterate、前回比較
  const recordsByClient = new Map();
  for (const r of records) {
    if (!recordsByClient.has(r.client_id)) recordsByClient.set(r.client_id, []);
    recordsByClient.get(r.client_id).push(r);
  }

  for (const [clientId, recs] of recordsByClient) {
    const cli = clientById.get(clientId);
    if (!cli || !cli.office_id) continue;

    const sorted = recs.sort((a, b) => {
      const ka = a.effective_date ?? a.certification_start_date ?? a.created_at;
      const kb = b.effective_date ?? b.certification_start_date ?? b.created_at;
      return String(ka).localeCompare(String(kb));
    });

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];

      // 前回の care_level が NULL / 申請中 / apply なら初回認定とみなして発火しない
      const prevLevel = prev.care_level;
      const isInitial = !prevLevel || prevLevel === '' || ['申請中', 'apply'].includes(prevLevel);

      const occurredAt = cur.effective_date || cur.certification_start_date || cur.created_at?.slice(0, 10);

      if (!isInitial) {
        // (a) plan_renewal: 期間連続
        if (cur.certification_start_date && prev.certification_end_date) {
          const prevEnd = new Date(prev.certification_end_date);
          const nextDay = new Date(prevEnd.getTime() + 86400000).toISOString().slice(0, 10);
          if (cur.certification_start_date === nextDay) {
            const key = `plan_renewal|client_insurance_records|${cur.id}`;
            if (!existingSet.has(key)) {
              toInsert.push({
                tenant_id: cli.tenant_id,
                office_id: cli.office_id,
                client_id: clientId,
                occurred_at: occurredAt,
                element_type: 'plan_renewal',
                ref_table: 'client_insurance_records',
                ref_id: cur.id,
                detail: {
                  from_care_level: prev.care_level,
                  to_care_level: cur.care_level,
                  cert_start: cur.certification_start_date,
                  cert_end: cur.certification_end_date,
                },
                status: 'pending',
              });
            }
          // (b) plan_change: 期間中差し込み (new start < prev end) AND care_level 違う
          } else if (cur.certification_start_date < prev.certification_end_date
                     && cur.care_level !== prev.care_level) {
            const key = `plan_change|client_insurance_records|${cur.id}`;
            if (!existingSet.has(key)) {
              toInsert.push({
                tenant_id: cli.tenant_id,
                office_id: cli.office_id,
                client_id: clientId,
                occurred_at: occurredAt,
                element_type: 'plan_change',
                ref_table: 'client_insurance_records',
                ref_id: cur.id,
                detail: {
                  from_care_level: prev.care_level,
                  to_care_level: cur.care_level,
                  cert_start: cur.certification_start_date,
                  cert_end: cur.certification_end_date,
                },
                status: 'pending',
              });
            }
          }
        }

        // (c) care_office_change: 独立 OR
        if ((prev.care_office_id ?? null) !== (cur.care_office_id ?? null)) {
          const key = `care_office_change|client_insurance_records|${cur.id}`;
          if (!existingSet.has(key)) {
            toInsert.push({
              tenant_id: cli.tenant_id,
              office_id: cli.office_id,
              client_id: clientId,
              occurred_at: occurredAt,
              element_type: 'care_office_change',
              ref_table: 'client_insurance_records',
              ref_id: cur.id,
              detail: {
                from_care_office_id: prev.care_office_id,
                to_care_office_id: cur.care_office_id,
                from_care_office_name: careOfficeName.get(prev.care_office_id) ?? null,
                to_care_office_name: careOfficeName.get(cur.care_office_id) ?? null,
              },
              status: 'pending',
            });
          }
        }
      }
    }
  }

  console.log(`\n要素 INSERT 候補: ${toInsert.length} 件`);
  const breakdown = toInsert.reduce((acc, e) => {
    acc[e.element_type] = (acc[e.element_type] ?? 0) + 1;
    return acc;
  }, {});
  console.log('内訳:', breakdown);

  if (DRY_RUN) {
    console.log('\nDRY_RUN なので INSERT しません。サンプル 5 件:');
    console.log(JSON.stringify(toInsert.slice(0, 5), null, 2));
    return;
  }

  // chunk INSERT (PostgREST の row 上限を避けるため 500 ずつ)
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const { error } = await admin.from('care_plan_elements').insert(slice);
    if (error) {
      console.error('INSERT error:', error.message);
      process.exit(1);
    }
    inserted += slice.length;
    console.log(`  ${inserted} / ${toInsert.length} INSERT 完了`);
  }
  console.log(`\n✓ 完了: ${inserted} 件 INSERT`);
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
