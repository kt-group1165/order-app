// 住宅改修 取込後の検算 (読み取りのみ)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(path) {
  try {
    const vars = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch { return {}; }
}
const e1 = loadEnvFile(join(__dirname, "..", ".env.local"));
const e2 = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const sb = createClient(
  e1.NEXT_PUBLIC_SUPABASE_URL || e2.NEXT_PUBLIC_SUPABASE_URL,
  e1.SUPABASE_SERVICE_ROLE_KEY || e2.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: projects, error } = await sb
  .from("renovation_projects")
  .select("id,fiscal_year,client_name,cost_total,sales_total,status")
  .eq("import_marker", "excel-jutaku-import-2026-08");
if (error) { console.error(error.message); process.exit(1); }
console.log(`案件 ${projects.length} 件`);

// 年度別
const byYear = new Map();
for (const p of projects) {
  const e = byYear.get(p.fiscal_year) ?? { n: 0, cost: 0, sales: 0 };
  e.n += 1; e.cost += Number(p.cost_total ?? 0); e.sales += Number(p.sales_total ?? 0);
  byYear.set(p.fiscal_year, e);
}
for (const y of [...byYear.keys()].sort()) {
  const e = byYear.get(y);
  console.log(`令和${y - 2018}年度: ${String(e.n).padStart(3)}件 仕切り ¥${Math.round(e.cost).toLocaleString()} / 計上 ¥${Math.round(e.sales).toLocaleString()} / 粗利 ¥${Math.round(e.sales - e.cost).toLocaleString()}`);
}

// 工程の件数 (案件 × 8 になっているか) と状態内訳
const ids = projects.map((p) => p.id);
let steps = [];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  let from = 0;
  while (true) {
    const { data, error: e } = await sb
      .from("renovation_project_steps")
      .select("project_id,step_key,status,planned_date,actual_date")
      .in("project_id", chunk)
      .order("project_id").order("step_key")
      .range(from, from + 999);
    if (e) { console.error(e.message); process.exit(1); }
    if (!data || data.length === 0) break;
    steps = steps.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
}
console.log(`\n工程 ${steps.length} 行 (期待 ${projects.length * 8} 行) → ${steps.length === projects.length * 8 ? "一致" : "不一致"}`);
const byStatus = steps.reduce((a, s) => ({ ...a, [s.status]: (a[s.status] ?? 0) + 1 }), {});
console.log(`状態内訳: ${JSON.stringify(byStatus)}`);
console.log(`工程が 8 本揃っていない案件: ${
  [...steps.reduce((m, s) => m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1), new Map()).values()].filter((n) => n !== 8).length
} 件`);

// 令和8年度「1月施工分」ブロックの 7 件を Excel 側の小計と突き合わせる。
// Excel はシート上の位置で月をまとめているので、工事日でグルーピングすると
// 元データの年入力ミス (鈴木 道子 = 2026-11-26 等) がある案件は別の月に落ちる。
// そのため照合は氏名指定で行う。
const JAN_BLOCK = ["稲垣 スギ子", "八島 節子", "正司 博徳", "元吉 徳雄", "鈴木 道子", "新保 三枝子", "齋藤 正則"];
const jan = JAN_BLOCK.map((n) => projects.find((p) => p.fiscal_year === 2026 && p.client_name === n));
const missing = JAN_BLOCK.filter((n, i) => !jan[i]);
const jc = jan.filter(Boolean).reduce((a, p) => a + Number(p.cost_total ?? 0), 0);
const js = jan.filter(Boolean).reduce((a, p) => a + Number(p.sales_total ?? 0), 0);
console.log(`\n令和8年度 1月施工分ブロック ${jan.filter(Boolean).length}/7 件${missing.length ? ` (未検出: ${missing.join(", ")})` : ""}`);
console.log(`  仕切り合計 = ${jc} / Excel 小計 573,929.6 + 八島 21,780 = 595,709.6 → ${Math.abs(jc - 595709.6) < 0.01 ? "一致" : "不一致"}`);
console.log(`  計上金額   = ${js} / Excel 小計 829,948                        → ${js === 829948 ? "一致" : "不一致"}`);
