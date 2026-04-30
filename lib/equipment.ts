import { supabase, Equipment, Supplier, EquipmentPrice, EquipmentPriceHistory } from "./supabase";
import { cached, invalidateCache } from "./cache";

export async function getEquipment(tenantId: string): Promise<Equipment[]> {
  return cached(`equipment:${tenantId}`, async () => {
    const all: Equipment[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("equipment_master")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  });
}

/** 既存用具を更新 */
export async function updateEquipment(
  id: string,
  updates: {
    name?: string;
    furigana?: string | null;
    tais_code?: string | null;
    category?: string | null;
    rental_price?: number | null;
    national_avg_price?: number | null;
    price_limit?: number | null;
    selection_reason?: string | null;
    proposal_reason?: string | null;
  }
): Promise<Equipment> {
  const { data, error } = await supabase
    .from("equipment_master")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  invalidateCache("equipment:");
  return data;
}

/** 用具を1件新規登録（商品コード自動採番） */
export async function createEquipmentItem(
  tenantId: string,
  input: {
    name: string;
    furigana?: string | null;
    tais_code?: string | null;
    category?: string | null;
    rental_price?: number | null;
    national_avg_price?: number | null;
    price_limit?: number | null;
    selection_reason?: string | null;
    proposal_reason?: string | null;
  }
): Promise<Equipment> {
  // DBから最大コードを取得して採番
  const { data: maxCodeData } = await supabase
    .from("equipment_master")
    .select("product_code")
    .eq("tenant_id", tenantId)
    .like("product_code", "EQ-%")
    .order("product_code", { ascending: false })
    .limit(1);
  const maxNum = maxCodeData?.[0]
    ? parseInt(maxCodeData[0].product_code.replace("EQ-", ""), 10)
    : 0;
  const productCode = `EQ-${String(maxNum + 1).padStart(6, "0")}`;

  // 新規登録時は最大sort_orderの次の値を設定
  const { data: maxSortData } = await supabase
    .from("equipment_master")
    .select("sort_order")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1);
  const newSortOrder = ((maxSortData?.[0]?.sort_order ?? 0) as number) + 10;

  const { data, error } = await supabase
    .from("equipment_master")
    .insert({
      tenant_id: tenantId,
      product_code: productCode,
      name: input.name,
      furigana: input.furigana ?? null,
      tais_code: input.tais_code ?? null,
      category: input.category ?? null,
      rental_price: input.rental_price ?? null,
      national_avg_price: input.national_avg_price ?? null,
      price_limit: input.price_limit ?? null,
      selection_reason: input.selection_reason ?? null,
      proposal_reason: input.proposal_reason ?? null,
      sort_order: newSortOrder,
    })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("equipment:");
  return data;
}

export async function getSuppliers(): Promise<Supplier[]> {
  return cached(`suppliers:all`, async () => {
    const { data, error } = await supabase
      .from("suppliers")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });
}

export async function getEquipmentPrices(
  tenantId: string,
  productCode: string
): Promise<EquipmentPrice[]> {
  const { data, error } = await supabase
    .from("equipment_prices")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("product_code", productCode);
  if (error) throw error;
  return data ?? [];
}

export type EquipmentImportRow = {
  product_code?: string;
  tais_code?: string;
  name: string;
  furigana?: string;
  category?: string;
  rental_price?: number;
  national_avg_price?: number;
  price_limit?: number;
  selection_reason?: string;
  proposal_reason?: string;
};

export type ImportResult = {
  inserted: number;
  updated: number;
  errors: string[];
  changes: Array<{
    product_code: string;
    name: string;
    field: string;
    old: string;
    new: string;
  }>;
};

// Generate next product code like EQ-000001
export async function generateProductCode(tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from("equipment_master")
    .select("product_code")
    .eq("tenant_id", tenantId)
    .like("product_code", "EQ-%")
    .order("product_code", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    return "EQ-000001";
  }
  const last = data[0].product_code;
  const num = parseInt(last.replace("EQ-", ""), 10);
  return `EQ-${String(num + 1).padStart(6, "0")}`;
}

export async function importEquipment(
  tenantId: string,
  rows: EquipmentImportRow[]
): Promise<ImportResult> {
  const result: ImportResult = {
    inserted: 0,
    updated: 0,
    errors: [],
    changes: [],
  };

  // Get existing equipment（全件取得）
  // 照合は 商品コード（EQ-XXXXXX）または用具名のみ
  // TAISコードは同一コードで別商品がありうるため照合に使わない
  const existing = await getEquipment(tenantId);

  // 名前の正規化：全角スペース→半角、連続スペース→1つ、前後トリム
  const normName = (s: string) =>
    s.replace(/　/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  const existingMap = new Map<string, Equipment>();
  for (const eq of existing) {
    existingMap.set(`name:${normName(eq.name)}`, eq);
    existingMap.set(`code:${eq.product_code}`, eq);
  }

  // DBから直接最大EQコードを取得（スプレッド展開によるスタック問題を回避）
  const { data: maxCodeData } = await supabase
    .from("equipment_master")
    .select("product_code")
    .eq("tenant_id", tenantId)
    .like("product_code", "EQ-%")
    .order("product_code", { ascending: false })
    .limit(1);
  const maxNum = maxCodeData?.[0]
    ? parseInt(maxCodeData[0].product_code.replace("EQ-", ""), 10) || 0
    : 0;
  let nextCodeNum = maxNum + 1;

  // 現在の最大sort_orderを取得（新規行には sort_order を連番で振る）
  const { data: maxSortData } = await supabase
    .from("equipment_master")
    .select("sort_order")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1);
  const baseSortOrder = (maxSortData?.[0]?.sort_order ?? 0) as number;
  let nextSortOrder = baseSortOrder + 10;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.name?.trim()) {
      result.errors.push(`行${i + 2}: 用具名が空です`);
      continue;
    }

    try {
      // 照合：商品コード → 用具名（正規化）の順
      let found: Equipment | undefined;
      if (row.product_code) found = existingMap.get(`code:${row.product_code}`);
      if (!found) found = existingMap.get(`name:${normName(row.name)}`);

      if (found) {
        // Check for changes
        const fieldChanges: typeof result.changes = [];
        const check = (field: string, oldVal: unknown, newVal: unknown) => {
          const o = String(oldVal ?? "");
          const n = String(newVal ?? "");
          if (n && o !== n) {
            fieldChanges.push({
              product_code: found!.product_code,
              name: found!.name,
              field,
              old: o,
              new: n,
            });
          }
        };
        check("名称", found.name, row.name);
        check("フリガナ", found.furigana, row.furigana);
        check("カテゴリ", found.category, row.category);
        check("レンタル価格", found.rental_price, row.rental_price);
        check("全国平均価格", found.national_avg_price, row.national_avg_price);
        check("TAISコード", found.tais_code, row.tais_code);
        check("選定理由", found.selection_reason, row.selection_reason);
        check("提案理由", found.proposal_reason, row.proposal_reason);

        if (fieldChanges.length > 0) {
          result.changes.push(...fieldChanges);
          const updates: Partial<Equipment> = { updated_at: new Date().toISOString() };
          if (row.name) updates.name = row.name;
          if (row.furigana !== undefined) updates.furigana = row.furigana ?? null;
          if (row.category !== undefined) updates.category = row.category ?? null;
          if (row.rental_price !== undefined)
            updates.rental_price = row.rental_price ?? null;
          if (row.national_avg_price !== undefined)
            updates.national_avg_price = row.national_avg_price ?? null;
          if (row.price_limit !== undefined)
            updates.price_limit = row.price_limit ?? null;
          if (row.tais_code !== undefined)
            updates.tais_code = row.tais_code ?? null;
          if (row.selection_reason !== undefined)
            updates.selection_reason = row.selection_reason ?? null;
          if (row.proposal_reason !== undefined)
            updates.proposal_reason = row.proposal_reason ?? null;

          const { error } = await supabase
            .from("equipment_master")
            .update(updates)
            .eq("id", found.id);
          if (error) {
            result.errors.push(`${row.name}: 更新エラー - ${error.message}`);
          } else {
            result.updated++;
          }
        }
      } else {
        // Insert new（重複コードの場合は自動でコードをずらしてリトライ）
        let inserted = false;
        for (let retry = 0; retry < 10 && !inserted; retry++) {
          const productCode =
            retry === 0 && row.product_code
              ? row.product_code
              : `EQ-${String(nextCodeNum).padStart(6, "0")}`;
          if (!row.product_code || retry > 0) nextCodeNum++;

          const { error } = await supabase.from("equipment_master").insert({
            tenant_id: tenantId,
            product_code: productCode,
            tais_code: row.tais_code ?? null,
            name: row.name,
            furigana: row.furigana ?? null,
            category: row.category ?? null,
            rental_price: row.rental_price ?? null,
            national_avg_price: row.national_avg_price ?? null,
            price_limit: row.price_limit ?? null,
            selection_reason: row.selection_reason ?? null,
            proposal_reason: row.proposal_reason ?? null,
            comparison_product_codes: [],
            sort_order: nextSortOrder,
          });
          if (!error) {
            result.inserted++;
            inserted = true;
            nextSortOrder += 10;
          } else if (error.code === "23505" || error.message?.includes("duplicate key")) {
            // 重複コード → nextCodeNum を進めてリトライ
            nextCodeNum++;
          } else {
            result.errors.push(`${row.name}: 追加エラー - ${error.message}`);
            break;
          }
        }
      }
    } catch (e) {
      result.errors.push(`行${i + 2}: 予期しないエラー`);
    }
  }

  invalidateCache("equipment:");
  return result;
}

export function parseEquipmentCSV(csvText: string): EquipmentImportRow[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"(.*)"$/, "$1"));

  const colMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (lower.includes("商品コード") || lower.includes("product_code")) colMap.product_code = i;
    else if (lower.includes("tais") || lower.includes("taisコード")) colMap.tais_code = i;
    else if (lower.includes("フリガナ") || lower.includes("ふりがな") || lower.includes("カナ") || lower.includes("furigana") || lower.includes("kana")) colMap.furigana = i;
    else if (lower.includes("用具名") || lower.includes("name") || lower.includes("商品名")) colMap.name = i;
    else if (lower.includes("カテゴリ") || lower.includes("category") || lower.includes("種目")) colMap.category = i;
    else if (lower.includes("レンタル価格") || lower.includes("貸与価格") || lower.includes("rental_price") || lower.includes("単価") || lower.includes("月額")) colMap.rental_price = i;
    else if (lower.includes("全国平均") || lower.includes("national_avg")) colMap.national_avg_price = i;
    else if (lower.includes("限度額") || lower.includes("上限価格") || lower.includes("price_limit")) colMap.price_limit = i;
    else if (lower.includes("選定")) colMap.selection_reason = i;
    else if (lower.includes("提案")) colMap.proposal_reason = i;
  });

  if (colMap.name === undefined) {
    // Try positional: assume name is first column
    colMap.name = 0;
  }

  const rows: EquipmentImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    const get = (key: string) =>
      colMap[key] !== undefined ? cols[colMap[key]]?.replace(/^"(.*)"$/, "$1").trim() : undefined;
    const getNum = (key: string) => {
      const v = get(key);
      if (!v) return undefined;
      const n = parseFloat(v.replace(/[,，￥¥]/g, ""));
      return isNaN(n) ? undefined : n;
    };

    const name = get("name");
    if (!name) continue;

    rows.push({
      product_code: get("product_code") || undefined,
      tais_code: get("tais_code") || undefined,
      name,
      furigana: get("furigana") || undefined,
      category: get("category") || undefined,
      rental_price: getNum("rental_price"),
      national_avg_price: getNum("national_avg_price"),
      price_limit: getNum("price_limit"),
      selection_reason: get("selection_reason") || undefined,
      proposal_reason: get("proposal_reason") || undefined,
    });
  }
  return rows;
}

// ─── 価格改定履歴 ─────────────────────────────────────────────────────────────

/** 指定テナント・用具コードの価格履歴を取得 */
export async function getPriceHistory(
  tenantId: string,
  productCodes: string[]
): Promise<EquipmentPriceHistory[]> {
  if (productCodes.length === 0) return [];
  const { data, error } = await supabase
    .from("equipment_price_history")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("product_code", productCodes)
    .order("valid_from", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** 価格改定を記録する */
export async function addPriceHistory(
  tenantId: string,
  productCode: string,
  rentalPrice: number,
  validFrom: string // "YYYY-MM-DD"
): Promise<void> {
  const { error } = await supabase
    .from("equipment_price_history")
    .insert({ tenant_id: tenantId, product_code: productCode, rental_price: rentalPrice, valid_from: validFrom });
  if (error) throw error;
}

/**
 * 指定月（yearMonth = "YYYY-MM"）時点での有効価格を返す。
 * 価格改定は必ず月初（YYYY-MM-01）単位で行われる前提。
 * 履歴がない場合は null。
 */
export function getPriceForMonth(
  history: EquipmentPriceHistory[],
  productCode: string,
  yearMonth: string
): number | null {
  const monthStart = `${yearMonth}-01`;
  const records = history
    .filter((h) => h.product_code === productCode && h.valid_from <= monthStart)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  return records[0]?.rental_price ?? null;
}

/** sort_order を一括更新（並び替え保存用） */
export async function updateEquipmentSortOrders(
  updates: Array<{ id: string; sort_order: number }>
): Promise<void> {
  for (const u of updates) {
    const { error } = await supabase
      .from("equipment_master")
      .update({ sort_order: u.sort_order })
      .eq("id", u.id);
    if (error) throw error;
  }
  invalidateCache("equipment:");
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
