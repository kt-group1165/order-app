/**
 * 旧 Excel「◆住宅改修 進行表」→ renovation_projects / renovation_project_steps 取込。
 *
 * 元ファイル:
 *   apps/order-app/住宅改修進行表/ケア・サポート千葉◆住宅改修　進行表2023年～.xlsx
 *
 * シート構造 (年度ごと 1 sheet):
 *   - 「n月施工分」の見出し行で施工月ブロックが区切られる
 *   - 1 案件 = 連続する 2〜5 行。行の役割は内容から判定する:
 *       ラベル行  … F..N に「訪問日」「見積提示日」等の見出し文字が入る
 *       予定行    … H..N が数式 (=F4+7 等) で予定日が入る (令和8年度のみ)
 *       実績行    … 実際の日付/自由文が入る
 *       〇×行     … F..N が 〇 / × だけ
 *   - 案件の同一性は (担当CM欄, 氏名, 住所, 工事内容, 仕切り合計, 計上金額) で判定する。
 *     同じ利用者で 2 案件並ぶケース (自費分の別建て等) があるため、金額まで含めないと割れない。
 *
 * Usage:
 *   node migrations/import_renovation_progress_xlsx.mjs                 # DRY RUN (既定)
 *   node migrations/import_renovation_progress_xlsx.mjs --execute       # 本番投入
 *   node migrations/import_renovation_progress_xlsx.mjs --sheet 令和8年度
 *   node migrations/import_renovation_progress_xlsx.mjs --execute --office <uuid> --tenant kt-group
 *
 * 巻き戻し:
 *   DELETE FROM renovation_projects WHERE import_marker = 'excel-jutaku-import-2026-08';
 *   (工程は ON DELETE CASCADE で一緒に消える)
 */

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── env ─────────────────────────────────────────────────────────────────────
// 注意: `const URL = ...` にすると WHATWG の URL を shadow するので SB_URL で受ける
function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
// 取込済みマーカー行を消してから入れ直す (パーサ修正後のやり直し用)
const RESET = args.includes("--reset");
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ONLY_SHEET = argValue("--sheet", null);
const TENANT_ID = argValue("--tenant", "kt-group");
// ケア・サポート千葉 (CLAUDE.md §8.1)
const OFFICE_ID = argValue("--office", "1bfc0d57-9ee0-4ae2-baa5-80edb776290a");
const XLSX_PATH = argValue(
  "--file",
  join(__dirname, "..", "住宅改修進行表", "ケア・サポート千葉◆住宅改修　進行表2023年～.xlsx"),
);
const IMPORT_MARKER = "excel-jutaku-import-2026-08";

// ─── 列・工程のマッピング ────────────────────────────────────────────────────
// 令和5〜8年度の並び。令和4年度だけ全体が 1 列右にずれているので shift で吸収する。
const BASE_COL = {
  staff: 1,        // A 担当
  care: 2,         // B ケアマネ事業所 + ケアマネ名
  clientName: 3,   // C 氏名
  address: 4,      // D 住所
  workContent: 5,  // E 工事内容
  copayRate: 12,   // L 負担割合
  contractor: 15,  // O 施工会社
  // P は年度によって「取り付け費」(数値) と「備考」(自由文) の両方に使われている。
  // 数値なら仕切り合計に加算し、文字なら備考として扱う。
  extra: 16,
  cost: 17,        // Q 仕切り合計
  sales: 18,       // R 計上金額
};

// step_key → Excel の列番号 (令和5〜8年度基準)
const BASE_STEP_COL = [
  ["visit", 6],            // F 訪問(日)
  ["quote_created", 7],    // G 見積作成
  ["quote_presented", 8],  // H 見積提出/見積提示
  ["pre_application", 9],  // I 事前協議
  ["construction", 10],    // J 工事
  ["order_sheet", 11],     // K 受注票作成
  ["collection", 13],      // M 集金
  ["office_submit", 14],   // N 役所提出
];

/** 令和4年度シートは 1 列右にずれている (col1 に ケアマネ の溢れ、col2 に 担当) */
function layoutFor(fiscalYear) {
  const shift = fiscalYear === 2022 ? 1 : 0;
  const col = {};
  for (const [k, v] of Object.entries(BASE_COL)) col[k] = v + shift;
  return { shift, col, stepCol: BASE_STEP_COL.map(([k, c]) => [k, c + shift]) };
}

const LABEL_WORDS = [
  "訪問", "訪問日", "見積作成", "見積作成日", "見積提出", "見積提示", "見積提示日",
  "事前協議", "事前申請", "工事", "受注票作成日", "負担割合", "集金日", "集金",
  "役所提出", "施工会社", "仕切り合計", "計上金額", "仕入率", "粗利",
  "認定下りたら\n事後申請", "事後申請",
];

// ─── セル値の正規化 ──────────────────────────────────────────────────────────

/** exceljs のセル値を { text, date, number, isFormula } に均す */
function readCell(cell) {
  let v = cell.value;
  let isFormula = false;
  if (v && typeof v === "object") {
    if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if (v.formula !== undefined || v.sharedFormula !== undefined) {
      isFormula = true;
      v = v.result ?? null;
    } else if (v.text !== undefined) v = v.text;
  }
  if (v === null || v === undefined || v === "") return { text: "", date: null, number: null, isFormula };
  if (v instanceof Date) {
    // 数式の基準セルが文字列 ("2/18\n3/3" 等) だと exceljs は Invalid Date を返す。
    // JSON では null に見えるが nullish ではないので、ここで明示的に弾かないと NaN-NaN-NaN になる。
    if (Number.isNaN(v.getTime())) return { text: "", date: null, number: null, isFormula };
    return { text: "", date: toYmd(v), number: null, isFormula };
  }
  if (typeof v === "number") {
    // Excel シリアル値の範囲 (1990-ish 〜 2060-ish) なら日付として解釈する。
    // 金額列は 6 桁以上になることが多く、この範囲とは実用上ぶつからない。
    if (v > 30000 && v < 60000 && Number.isInteger(v)) {
      return { text: "", date: serialToYmd(v), number: v, isFormula };
    }
    return { text: "", date: null, number: v, isFormula };
  }
  const s = String(v).trim();
  if (!s) return { text: "", date: null, number: null, isFormula };
  // "2026/1/16" 等の日付文字列
  const m = s.match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
  if (m) return { text: "", date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, number: null, isFormula };
  return { text: s, date: null, number: null, isFormula };
}

function toYmd(d) {
  // exceljs は日付を UTC 起点で返すので UTC 側の getter を使う
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Excel シリアル値 → "YYYY-MM-DD" (1900 うるう年バグ込み)。範囲外は null */
function serialToYmd(serial) {
  const d = new Date((serial - 25569) * 86400000);
  return Number.isNaN(d.getTime()) ? null : toYmd(d);
}

const isMark = (t) => t === "〇" || t === "○" || t === "◯";
const isCross = (t) => t === "×" || t === "✕" || t === "x" || t === "X";

// ─── 行の役割判定 ────────────────────────────────────────────────────────────

function classifyRow(cells, stepCol) {
  const stepCells = stepCol.map(([, col]) => cells[col]).filter(Boolean);
  const nonEmpty = stepCells.filter((c) => c.text || c.date || c.number !== null);
  if (nonEmpty.length === 0) return "empty";

  const labelHits = nonEmpty.filter((c) => c.text && LABEL_WORDS.includes(c.text)).length;
  if (labelHits >= 2) return "label";

  const markHits = nonEmpty.filter((c) => isMark(c.text) || isCross(c.text)).length;
  if (markHits >= 1 && markHits >= nonEmpty.length - 1) return "mark";

  // 予定行: 工程列に数式が 2 本以上 (=F4+7 のチェーン)
  const formulaHits = nonEmpty.filter((c) => c.isFormula && c.date).length;
  if (formulaHits >= 2) return "planned";

  return "actual";
}

// ─── ケアマネ欄の分解 ────────────────────────────────────────────────────────

/** "KT在宅\n栗原ｃｍ" / "ｾﾝﾄｹｱ看護小規模市原　　辻cm" → { office, manager } */
function splitCareText(raw) {
  if (!raw) return { office: null, manager: null };
  const s = raw.replace(/\r/g, "").trim();
  const parts = s.split("\n").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { office: parts.slice(0, -1).join(" "), manager: parts[parts.length - 1] };
  }
  // 改行なし: 末尾の「〇〇cm」を担当者名として切り出す
  const m = s.match(/^(.*?)[\s　]{1,}([^\s　]{1,12}(?:ｃｍ|cm|CM|ＣＭ|㎝))$/);
  if (m && m[1].trim()) return { office: m[1].trim(), manager: m[2].trim() };
  return { office: s, manager: null };
}

// ─── 負担割合の正規化 ────────────────────────────────────────────────────────
function normalizeCopay(text) {
  if (!text) return null;
  const s = text.trim();
  if (s.includes("自費")) return "自費";
  const m = s.match(/([123１２３])\s*割/);
  if (!m) return null;
  const digit = m[1].replace(/[１２３]/g, (c) => String("１２３".indexOf(c) + 1));
  return `${digit}割`;
}

// ─── シート → 案件配列 ───────────────────────────────────────────────────────

/** シート名 "令和8年度" → 西暦年度 2026 */
function fiscalYearFromSheetName(name) {
  const m = name.match(/令和\s*([0-9０-９元]+)\s*年度/);
  if (!m) return null;
  const raw = m[1].replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)));
  const n = raw === "元" ? 1 : Number(raw);
  if (!Number.isFinite(n)) return null;
  return 2018 + n; // 令和元年 = 2019
}

function parseSheet(ws, warnings) {
  const fiscalYear = fiscalYearFromSheetName(ws.name);
  if (fiscalYear === null) return [];
  const { shift, col: COL, stepCol: STEP_COL } = layoutFor(fiscalYear);

  // 全行を読み込んで役割を判定
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    const cells = {};
    row.eachCell({ includeEmpty: true }, (cell, cn) => { cells[cn] = readCell(cell); });
    rows.push({ rn, cells, role: classifyRow(cells, STEP_COL) });
  });

  const txt = (cells, col) => (cells[col] ? cells[col].text : "");
  const num = (cells, col) => (cells[col] && cells[col].number !== null ? cells[col].number : null);
  // 令和4年度は ケアマネ 欄が col1 に溢れている行がある
  const careTextOf = (cells) => txt(cells, COL.care) || (shift ? txt(cells, 1) : "");

  // 案件の同一性キー。金額は含めない (ラベル行は金額が空で、含めると 1 案件が複数に割れる)
  const keyOf = (cells) =>
    [
      careTextOf(cells),
      txt(cells, COL.clientName),
      txt(cells, COL.address),
      txt(cells, COL.workContent),
    ].join("|");

  // 金額 (仕切り合計 / 計上金額)。同じ利用者の別案件 (自費分の別建て等) はここで割る
  const moneyOf = (cells) => {
    const c = num(cells, COL.cost);
    const s = num(cells, COL.sales);
    return c === null && s === null ? null : `${c ?? ""}/${s ?? ""}`;
  };

  // 連続する同一キーの行をブロックにまとめる。
  // 金額が空の行 (ラベル行) は現在のブロックに吸収し、金額が変わったところで割る。
  const blocks = [];
  let cur = null;
  for (const r of rows) {
    if (r.role === "empty" && !txt(r.cells, COL.clientName)) { cur = null; continue; }
    const k = keyOf(r.cells);
    const m = moneyOf(r.cells);
    const sameBlock = cur && cur.key === k && (m === null || cur.money === null || cur.money === m);
    if (!sameBlock) {
      cur = { key: k, money: m, fiscalYear, rows: [r] };
      blocks.push(cur);
    } else {
      if (cur.money === null) cur.money = m;
      cur.rows.push(r);
    }
  }

  // 担当 (A 列) は先頭ブロックにだけ入り、以降は空欄で「同じ担当」を意味する運用
  let carriedStaff = null;

  const projects = [];
  for (const b of blocks) {
    // 属性はブロック内の全行に複製されているので、最初に値がある行から拾う
    const pickTxt = (c, fn) => {
      for (const r of b.rows) {
        const cell = r.cells[c];
        if (!cell || !cell.text) continue;
        if (isMark(cell.text) || isCross(cell.text)) continue;
        if (LABEL_WORDS.includes(cell.text)) continue;
        const v = fn ? fn(cell.text) : cell.text;
        if (v) return v;
      }
      return null;
    };
    // 数値は「数式でない行」を優先 (数式は前の行を参照しているだけのことがある)
    const pickNum = (c) => {
      for (const r of b.rows) {
        const cell = r.cells[c];
        if (cell && cell.number !== null && !cell.isFormula) return cell.number;
      }
      for (const r of b.rows) {
        const cell = r.cells[c];
        if (cell && cell.number !== null) return cell.number;
      }
      return null;
    };

    const clientName = pickTxt(COL.clientName);
    const staffHere = pickTxt(COL.staff);
    if (staffHere) carriedStaff = staffHere;

    // 氏名が無いブロックは 月見出し行 / 月次集計行 / ヘッダ行。案件ではない
    if (!clientName) continue;

    const careRaw = pickTxt(COL.care) || (shift ? pickTxt(1) : null);
    const care = splitCareText(careRaw);

    // 工程を組み立てる
    const steps = [];
    for (const [stepKey, col] of STEP_COL) {
      let planned = null;
      let actual = null;
      let status = "pending";
      const notes = [];
      for (const r of b.rows) {
        const c = r.cells[col];
        if (!c) continue;
        if (r.role === "label") continue;
        if (r.role === "mark") {
          if (isMark(c.text)) status = "done";
          else if (isCross(c.text)) status = "skipped";
          else if (c.text) notes.push(c.text); // 「ポスト」「引き落とし」等
          continue;
        }
        if (r.role === "planned") {
          if (c.date) planned = c.date;
          continue;
        }
        // actual 行
        if (c.date) actual = c.date;
        else if (isMark(c.text)) status = "done";
        else if (isCross(c.text)) status = "skipped";
        else if (c.text) notes.push(c.text); // 「1/23.25」「1月希望」等
      }
      // 実績日が入っていて 〇/× が無いブロック (古い年度) は完了扱い
      if (status === "pending" && actual) status = "done";
      steps.push({
        step_key: stepKey,
        planned_date: planned,
        actual_date: actual,
        status,
        note: notes.length > 0 ? Array.from(new Set(notes)).join(" / ") : null,
      });
    }

    // P 列は年度によって「取り付け費」(数値) と「備考」(自由文) の両方に使われている
    const extraFee = pickNum(COL.extra);
    const extraNote = pickTxt(COL.extra);
    const baseCost = pickNum(COL.cost);
    const costTotal = baseCost === null && extraFee === null ? null : (baseCost ?? 0) + (extraFee ?? 0);

    const allSettled = steps.every((s) => s.status === "done" || s.status === "skipped");
    const project = {
      _sheet: ws.name,
      _row: b.rows[0].rn,
      fiscal_year: fiscalYear,
      client_name: clientName.replace(/\s+/g, " ").trim(),
      client_address: (pickTxt(COL.address) ?? "").replace(/\n/g, "").trim() || null,
      care_office_text: care.office,
      care_manager_text: care.manager,
      staff_name: staffHere || carriedStaff,
      _staffCarried: !staffHere && !!carriedStaff,
      work_content: (pickTxt(COL.workContent) ?? "").replace(/\n/g, "").trim() || null,
      contractor: pickTxt(COL.contractor),
      copay_rate: pickTxt(COL.copayRate, normalizeCopay),
      notes: [extraNote, extraFee !== null ? `取り付け費 ¥${extraFee.toLocaleString()}` : null]
        .filter(Boolean)
        .join(" / ")
        .replace(/\n/g, " ") || null,
      cost_total: costTotal,
      sales_total: pickNum(COL.sales),
      status: allSettled ? "completed" : "in_progress",
      steps,
    };

    // 明らかに壊れているデータは警告として残す (取込はする)
    if (project.cost_total !== null && project.sales_total !== null && project.sales_total > 0 && project.cost_total > project.sales_total) {
      warnings.push(`${ws.name} r${b.rows[0].rn} ${project.client_name}: 仕切り合計 > 計上金額 (原価割れ)`);
    }
    const constructionStep = project.steps.find((s) => s.step_key === "construction");
    const cd = constructionStep?.actual_date ?? null;
    if (cd) {
      const y = Number(cd.slice(0, 4));
      if (y < fiscalYear || y > fiscalYear + 1) {
        warnings.push(`${ws.name} r${b.rows[0].rn} ${project.client_name}: 工事日 ${cd} が年度と噛み合わない (元 Excel の入力ミスの可能性)`);
      }
    }

    projects.push(project);
  }

  return projects;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== 住宅改修 進行表 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`file   : ${XLSX_PATH}`);
  console.log(`tenant : ${TENANT_ID}`);
  console.log(`office : ${OFFICE_ID}`);
  console.log(`marker : ${IMPORT_MARKER}`);
  console.log("");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);

  const warnings = [];
  let all = [];
  wb.eachSheet((ws) => {
    if (ONLY_SHEET && ws.name.trim() !== ONLY_SHEET.trim()) return;
    if (fiscalYearFromSheetName(ws.name) === null) {
      console.log(`skip sheet: ${ws.name} (年度シートではない)`);
      return;
    }
    if (ws.name.includes("原本")) {
      console.log(`skip sheet: ${ws.name} (テンプレート)`);
      return;
    }
    const rows = parseSheet(ws, warnings);
    console.log(`sheet ${ws.name.padEnd(12)} → ${rows.length} 件`);
    all = all.concat(rows);
  });

  console.log(`\n合計 ${all.length} 件`);

  if (all.length === 0) {
    console.log("取込対象がありません。--sheet 指定や列マッピングを確認してください。");
    return;
  }

  // ── サマリ (取込前の目視確認用) ────────────────────────────────────────
  const byYear = new Map();
  for (const p of all) {
    const e = byYear.get(p.fiscal_year) ?? { count: 0, cost: 0, sales: 0, completed: 0 };
    e.count += 1;
    e.cost += p.cost_total ?? 0;
    e.sales += p.sales_total ?? 0;
    if (p.status === "completed") e.completed += 1;
    byYear.set(p.fiscal_year, e);
  }
  console.log("\n--- 年度別サマリ ---");
  for (const y of Array.from(byYear.keys()).sort()) {
    const e = byYear.get(y);
    const profit = e.sales - e.cost;
    console.log(
      `令和${y - 2018}年度 (${y}): ${String(e.count).padStart(3)} 件 / 完了 ${String(e.completed).padStart(3)} / ` +
      `仕切り ¥${Math.round(e.cost).toLocaleString()} / 計上 ¥${Math.round(e.sales).toLocaleString()} / 粗利 ¥${Math.round(profit).toLocaleString()}`,
    );
  }

  const carried = all.filter((p) => p._staffCarried).length;
  const noStaff = all.filter((p) => !p.staff_name).length;
  const noMoney = all.filter((p) => p.cost_total === null && p.sales_total === null).length;
  console.log(`\n担当を上の行から引き継いだ件数: ${carried} (元 Excel が空欄。誤りは UI で修正してください)`);
  console.log(`担当 未設定: ${noStaff} 件 / 金額 未入力: ${noMoney} 件`);

  console.log("\n--- サンプル 5 件 ---");
  for (const p of all.slice(0, 5)) {
    const done = p.steps.filter((s) => s.status === "done").length;
    const skipped = p.steps.filter((s) => s.status === "skipped").length;
    console.log(
      `[${p._sheet} r${p._row}] ${p.client_name} / ${p.care_office_text ?? "-"} ${p.care_manager_text ?? ""} / ` +
      `${p.work_content ?? "-"} / 完了${done} 対象外${skipped} / ¥${p.cost_total ?? "-"}→¥${p.sales_total ?? "-"}`,
    );
    for (const s of p.steps) {
      if (s.status === "pending" && !s.planned_date && !s.actual_date && !s.note) continue;
      console.log(`    ${s.step_key.padEnd(16)} 予定${s.planned_date ?? "-"} 実績${s.actual_date ?? "-"} ${s.status}${s.note ? ` (${s.note})` : ""}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n--- 警告 ${warnings.length} 件 ---`);
    for (const w of warnings.slice(0, 30)) console.log(`  ! ${w}`);
    if (warnings.length > 30) console.log(`  ... 他 ${warnings.length - 30} 件`);
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN のため DB には書き込んでいません。--execute で投入します。");
    return;
  }

  if (!SB_URL || !SB_KEY) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が見つかりません");
    process.exit(1);
  }
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // 日付が壊れた行が 1 件でもあれば、部分投入を作らないよう投入前に止める
  const badDates = [];
  for (const p of all) {
    for (const s of p.steps) {
      for (const [k, v] of [["planned_date", s.planned_date], ["actual_date", s.actual_date]]) {
        if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          badDates.push(`${p._sheet} r${p._row} ${p.client_name} ${s.step_key}.${k} = ${v}`);
        }
      }
    }
  }
  if (badDates.length > 0) {
    console.error(`\n日付として不正な値が ${badDates.length} 件あります。投入を中止しました:`);
    for (const b of badDates.slice(0, 20)) console.error(`  ! ${b}`);
    process.exit(1);
  }

  if (RESET) {
    const { error: delErr } = await sb.from("renovation_projects").delete().eq("import_marker", IMPORT_MARKER);
    if (delErr) { console.error("既存取込分の削除に失敗:", delErr.message); process.exit(1); }
    console.log(`\n--reset: marker='${IMPORT_MARKER}' の既存行を削除しました`);
  }

  // 二重投入の防止
  const { count: existing, error: countErr } = await sb
    .from("renovation_projects")
    .select("id", { count: "exact", head: true })
    .eq("import_marker", IMPORT_MARKER);
  if (countErr) {
    console.error("既存マーカーの確認に失敗:", countErr.message);
    process.exit(1);
  }
  if ((existing ?? 0) > 0) {
    console.error(
      `既に marker='${IMPORT_MARKER}' の行が ${existing} 件あります。二重投入を避けるため中止しました。\n` +
      `再取込する場合は先に DELETE FROM renovation_projects WHERE import_marker = '${IMPORT_MARKER}'; を実行してください。`,
    );
    process.exit(1);
  }

  // 利用者マスタとの名前一致 (空白差を無視)。一致しなくても取込は続行する
  const norm = (s) => s.replace(/[\s　]/g, "");
  const clientIdByName = new Map();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("clients")
        .select("id,name")
        .eq("tenant_id", TENANT_ID)
        .is("deleted_at", null)
        .range(from, from + PAGE - 1);
      if (error) { console.error("clients 取得に失敗:", error.message); process.exit(1); }
      if (!data || data.length === 0) break;
      for (const c of data) {
        const k = norm(c.name);
        // 同名が複数いる場合は紐付けない (誤紐付けを避ける)
        if (clientIdByName.has(k)) clientIdByName.set(k, null);
        else clientIdByName.set(k, c.id);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  let inserted = 0;
  let stepsInserted = 0;
  let linked = 0;
  for (const p of all) {
    const clientId = clientIdByName.get(norm(p.client_name)) ?? null;
    if (clientId) linked += 1;

    const { data: proj, error: projErr } = await sb
      .from("renovation_projects")
      .insert({
        tenant_id: TENANT_ID,
        office_id: OFFICE_ID,
        fiscal_year: p.fiscal_year,
        client_id: clientId,
        client_name: p.client_name,
        client_address: p.client_address,
        care_office_text: p.care_office_text,
        care_manager_text: p.care_manager_text,
        staff_name: p.staff_name,
        work_content: p.work_content,
        contractor: p.contractor,
        copay_rate: p.copay_rate,
        notes: p.notes,
        cost_total: p.cost_total,
        sales_total: p.sales_total,
        status: p.status,
        import_marker: IMPORT_MARKER,
      })
      .select("id")
      .single();
    if (projErr) {
      console.error(`INSERT 失敗 [${p._sheet} r${p._row}] ${p.client_name}:`, projErr.message);
      continue;
    }
    inserted += 1;

    const stepRows = p.steps.map((s) => ({ ...s, project_id: proj.id }));
    const { error: stepErr } = await sb.from("renovation_project_steps").insert(stepRows);
    if (stepErr) {
      console.error(`工程 INSERT 失敗 [${p._sheet} r${p._row}] ${p.client_name}:`, stepErr.message);
      continue;
    }
    stepsInserted += stepRows.length;
  }

  console.log(`\n投入完了: 案件 ${inserted} / ${all.length} 件、工程 ${stepsInserted} 行`);
  console.log(`利用者マスタと紐付いた件数: ${linked} / ${all.length}`);
  console.log("\n--- 件数確認 SQL (Supabase SQL Editor で実行) ---");
  console.log(`SELECT fiscal_year, count(*) FROM renovation_projects WHERE import_marker = '${IMPORT_MARKER}' GROUP BY 1 ORDER BY 1;`);
  console.log(`SELECT count(*) FROM renovation_project_steps s JOIN renovation_projects p ON p.id = s.project_id WHERE p.import_marker = '${IMPORT_MARKER}';`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
