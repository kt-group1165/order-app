/**
 * 居宅から届く 提供票 (第6表) / 別表 (第7表) の FAX スキャン PDF を読む — 1 段目 (ローカル OCR・API なし・DB なし)
 *
 *   node scripts/teikyohyo-fax/run.mjs --pdf <FAX.pdf> [--out <dir>] [--pages 1-10] [--workers 3]
 *   node scripts/teikyohyo-fax/run.mjs --pdf <FAX.pdf|写真.jpg> --all [--refresh-db] [--snapshot <json>]   ★ 運用の入口
 *       1 段目 (この script) → 2 段目 claude.mjs (Claude で読む) → DB の控え snapshot.mjs → 照合 match.mjs → 一覧 (CSV / HTML)
 *       DB の控えは 12 時間以内のものがあれば使い回す (--refresh-db で取り直す。★ 全件読みを含むので 並行セッションに一報してから)
 *       精度測定 (正解データがあるとき): node scripts/teikyohyo-fax/eval.mjs <out>/claude.json --gt <gt.json> --snapshot <json>
 *
 *   PDF → ページ分類 (提供票 / 別表 / 実績表 (裏紙) / 白紙 / 不明) → 向き・傾きの補正 → 罫線からセル → 欄ごとの OCR → JSON
 *   出力: <out>/result.json (ページごとの読取結果) と 標準出力の集計。
 *   ★ PDF・画像・読取結果は個人情報。--out は repo の外 (既定 = OS の一時フォルダ/teikyohyo-fax/<PDF名>)。
 *
 * 画像処理は prep.py (Python: PyMuPDF / OpenCV / NumPy)、OCR は tesseract.js (jpn / eng)。
 *   traineddata は初回に CDN から取り、OS の一時フォルダ/teikyohyo-fax-tessdata に置く (--tessdata で別の場所)。
 *
 * 読み方 (座標の決め打ちはしない。居宅のソフトで欄の位置が違うため):
 *   向き   … 4 方向の上端の帯を OCR し、表題 (サービス提供票 / 提供票別表 / サービス利用実績表) が読めた向き
 *   提供票 … 上の表のセルを OCR してラベル (保険者番号 / 被保険者番号 / 被保険者氏名 …) を探し、右のセルを値として読む。
 *            下の表は 見出し行 (サービス内容 / 事業所名 / 用具名称 / 合計回数) の列で 1 行ずつ読む
 *   別表   … 見出し行 (事業所名 / 事業所番号 / サービス内容 / サービスコード / 単位数 / 回数 / サービス単位) の列で 1 行ずつ読む。
 *            検算: 単位数 × 回数 = サービス単位 (割引後の単位数があればそれ)
 * 要介護度 (丸印の位置) はまだ読まない (1 段目では「未対応」と出す)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, createScheduler, PSM } from "tesseract.js";
import { faxOffice } from "./_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
// --pdf は複数可 (提供票の写真と別表の写真を 1 回で: --pdf 提供票.jpg --pdf 別表.jpg)。並べた順にページ番号を振る
const PDFS = argv.flatMap((a, i) => (a === "--pdf" && argv[i + 1] ? [argv[i + 1]] : []));
const PDF = PDFS[0] ?? null;
// 対象の事業所 (--area / --office-bn。既定 ケアサポ = 引数化の前と同じ)。2 段目・控え・照合にも同じ引数を渡す
const FO = faxOffice(argv);
if (!PDF) { console.error("usage: node scripts/teikyohyo-fax/run.mjs --pdf <FAX.pdf> [--out <dir>] [--pages 1-10] [--area ケアサポ|誉田|高品|花見川|茂原]"); process.exit(1); }
const OUT = resolve(opt("--out") ?? join(tmpdir(), "teikyohyo-fax", basename(PDF).replace(/\.pdf$/i, "")));
const TESSDATA = resolve(opt("--tessdata") ?? join(tmpdir(), "teikyohyo-fax-tessdata"));
const WORKERS = Number(opt("--workers") ?? 3);
const PAGES = (() => {
  const p = opt("--pages"); if (!p) return null;
  const s = new Set(); for (const part of p.split(",")) { const [a, b] = part.split("-").map(Number); for (let i = a; i <= (b || a); i++) s.add(i); } return s;
})();
mkdirSync(OUT, { recursive: true });
mkdirSync(TESSDATA, { recursive: true });

// ── 判定の定数 (出力にも書く) ─────────────────────────────────────────────
export const CONST = {
  BLANK_INK: 0.004,        // インク率がこれ未満 = 白紙
  ORIENT_MIN_SCORE: 2,     // 表題の語が この数以上 読めた向きを採る (未満 = 向き不明)
  CARESAPO_BN: FO.bn,
};

// ── Python (prep.py) ─────────────────────────────────────────────────────
function py(...args) {
  const r = spawnSync("python", ["-I", join(HERE, "prep.py"), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`prep.py ${args[0]} 失敗: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

// ── OCR ──────────────────────────────────────────────────────────────────
const nf = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");
async function makeSched(lang, params) {
  const s = createScheduler();
  for (let i = 0; i < WORKERS; i++) {
    const w = await createWorker(lang, 1, { cachePath: TESSDATA, logger: () => {} });
    await w.setParameters(params);
    s.addWorker(w);
  }
  return s;
}
let JP, JPLINE, NUM, CHAR;
async function ocrJp(img, rect) { const { data } = await JP.addJob("recognize", img, rect ? { rectangle: rect } : {}); return { text: data.text, conf: data.confidence }; }
async function ocrJpLine(img, rect) { const { data } = await JPLINE.addJob("recognize", img, rect ? { rectangle: rect } : {}); return { text: data.text, conf: data.confidence }; }
async function ocrNum(img, rect) { const { data } = await NUM.addJob("recognize", img, rect ? { rectangle: rect } : {}); return { text: data.text.replace(/[^0-9A-Za-z().,-]/g, ""), conf: data.confidence }; }
const pad = (c, p = 3) => ({ left: c.x + p, top: c.y + p, width: Math.max(1, c.w - 2 * p), height: Math.max(1, c.h - 2 * p) });

// ── 向き・分類 ───────────────────────────────────────────────────────────
const TITLE_WORDS = { 別表: ["別表", "提供票別表", "区分支給限度管理", "利用者負担計算"], 提供票: ["提供票", "サービス提供票", "月分", "保険者番号"], 実績表: ["実績表", "利用実績", "サービス利用実績表"] };
function scoreTitle(text) {
  const t = nf(text);
  const hit = {};
  for (const [k, ws] of Object.entries(TITLE_WORDS)) hit[k] = ws.filter((w) => t.includes(w)).length;
  // 1 文字ずつの一致も少し足す (OCR が崩れても向きの差は出る)
  const chars = [..."サービス提供票別表月分令和年保険者番号利用実績"].filter((ch) => t.includes(ch)).length;
  return { hit, score: hit.別表 * 3 + hit.提供票 * 3 + hit.実績表 * 3 + chars * 0.25 };
}

// ── セルの並び ───────────────────────────────────────────────────────────
const cx = (c) => c.x + c.w / 2, cy = (c) => c.y + c.h / 2;
const sameRow = (a, b) => cy(b) > a.y && cy(b) < a.y + a.h;
const rightOf = (cells, c) => cells.filter((d) => d !== c && d.x >= c.x + c.w - 6 && sameRow(c, d)).sort((a, b) => a.x - b.x);
const digits = (s) => nf(s).replace(/[^0-9]/g, "");

const kanjiCount = (s) => (nf(s).match(/[一-鿿]/g) ?? []).length;
const notHuge = (c, ref, k = 1.6) => c.w <= ref.w * k + 10;

/** 番号の欄 (セルの列) を 1 文字ずつ読む。● = 伏字 (塗りつぶした丸)。返り値 "1221●2" / 読めない文字は "?" */
async function readDigitCells(page, outdir, cells, key) {
  if (!cells.length) return null;
  const rects = cells.map((c, i) => ({ key: `${key}${i}`, x: c.x, y: c.y, w: c.w, h: c.h }));
  const rf = join(outdir, `p${String(page).padStart(2, "0")}`, `rects_${key}.json`);
  writeFileSync(rf, JSON.stringify(rects));
  const res = py("digits", outdir, String(page), rf);
  let s = "";
  for (const r of res) for (const ch of r.chars) {
    if (ch.kind === "empty") continue;
    if (ch.kind === "dot") { s += "●"; continue; }
    const { text } = await CHAR.addJob("recognize", ch.img);
    const t = nf(text).replace(/[^0-9A-Z]/g, "");
    s += t.length === 1 ? t : t.length > 1 ? t[0] : "?";
  }
  return s || null;
}

// ── 提供票 ───────────────────────────────────────────────────────────────
async function readTeikyo(img, J, page) {
  const H = J.h;
  const header = J.cells.filter((c) => c.y < H * 0.3 && c.w < J.w * 0.5 && c.h > 25);
  const texts = new Map();
  await Promise.all(header.map(async (c) => texts.set(c, (await ocrJp(img, pad(c))).text)));
  const T = (c) => nf(texts.get(c));
  // 左端の列のラベル (上から 保険者番号 / 被保険者番号 / 生年月日)。文字が崩れても 並び順で決める
  const minX = Math.min(...header.map((c) => c.x));
  const leftCol = header.filter((c) => c.x < minX + 40).sort((a, b) => a.y - b.y);
  const numLabels = leftCol.filter((c) => /番|保険|険者/.test(T(c)));
  const insLab = numLabels[0] ?? null, insdLab = numLabels[1] ?? null;
  const isLabelCell = (c) => kanjiCount(texts.get(c)) >= 2 || /フリガナ|カナ/.test(T(c));
  const valueCells = (lab) => {
    if (!lab) return [];
    const out = [];
    for (const d of rightOf(header, lab)) { if (isLabelCell(d)) break; out.push(d); }
    return out;
  };
  const findLabel = (re) => header.find((c) => re.test(T(c)));
  const nameLab = findLabel(/氏名|フリガナ|被保険者氏/);
  const nameCell = nameLab ? rightOf(header, nameLab)[0] : null;
  const nameLines = nameCell ? texts.get(nameCell).split(/\n/).map(nf).filter(Boolean) : [];
  const nameLine = nameLines.sort((a, b) => kanjiCount(b) - kanjiCount(a))[0] ?? null;
  const officeLab = findLabel(/居宅|支援事業|事業者事業所/);
  const birthLab = findLabel(/生年月日/);
  const r = {
    insurerNumber: await readDigitCells(page, OUT, valueCells(insLab), "ins"),
    insuredNumber: await readDigitCells(page, OUT, valueCells(insdLab), "insd"),
    nameRaw: nameLine ? nameLine.replace(/様$/, "").replace(/[上|]+$/, "") : null,
    kanaRaw: nameLines.find((l) => /^[ァ-ヶー\s]+$/.test(l)) ?? null,
    careOfficeRaw: officeLab ? nf(texts.get(rightOf(header, officeLab)[0]) ?? "") || null : null,
    birthRaw: birthLab ? nf(texts.get(rightOf(header, birthLab)[0]) ?? "") || null : null,
    careLevel: "未対応 (丸印の判定は未実装)",
    labelsFound: { 保険者番号: !!insLab, 被保険者番号: !!insdLab, 被保険者氏名: !!nameLab, 居宅: !!officeLab, 生年月日: !!birthLab },
  };
  // 下の表: 見出し行
  const body = J.cells.filter((c) => c.y >= H * 0.22);
  const headCands = body.filter((c) => c.y < H * 0.42 && c.h > 30);
  const htext = new Map();
  await Promise.all(headCands.map(async (c) => htext.set(c, (await ocrJp(img, pad(c))).text)));
  const col = (re) => headCands.find((c) => re.test(nf(htext.get(c))));
  const cSvc = col(/サービス内容|ス内容|内容/), cOff = col(/事業所名|事業者|業所名/), cEq = col(/用具名称|機種|名称/);
  // 合計回数 = 表の右端の列 (見出しの右端のセル)
  const right = Math.max(...body.map((c) => c.x + c.w));
  const cSum = headCands.filter((c) => c.x + c.w > right - 15).sort((a, b) => a.y - b.y)[0] ?? null;
  r.columnsFound = { サービス内容: !!cSvc, 事業所名: !!cOff, 用具名称: !!cEq, 合計回数: !!cSum };
  r.rows = [];
  if (cSvc) {
    const top = Math.max(...[cSvc, cOff, cEq].filter(Boolean).map((c) => c.y + c.h));
    const rowCells = J.cells.filter((c) => c.y >= top - 4 && Math.abs(cx(c) - cx(cSvc)) < cSvc.w / 2 && notHuge(c, cSvc) && c.h > 25 && c.h < H * 0.12).sort((a, b) => a.y - b.y);
    for (const rc of rowCells) {
      const inCol = (hc) => hc && J.cells.find((d) => Math.abs(cx(d) - cx(hc)) < hc.w / 2 && notHuge(d, hc) && cy(d) > rc.y && cy(d) < rc.y + rc.h);
      const svc = nf((await ocrJp(img, pad(rc))).text);
      if (!svc || kanjiCount(svc) < 2) continue;
      const offC = inCol(cOff), eqC = inCol(cEq);
      // 合計回数: 予定の段 (行の上半分) の 合計列
      const sumC = cSum && J.cells.find((d) => Math.abs(cx(d) - cx(cSum)) < cSum.w / 2 && cy(d) > rc.y && cy(d) < rc.y + rc.h / 2 + 4);
      r.rows.push({
        service: svc,
        office: offC ? nf((await ocrJp(img, pad(offC))).text) : null,
        equipment: eqC ? nf((await ocrJp(img, pad(eqC))).text) || null : null,
        plannedCount: sumC ? digits((await ocrNum(img, pad(sumC, 3))).text) || null : null,
      });
    }
  }
  r.caresapoRows = r.rows.filter((x) => (FO.isDefault ? /ケア.?サポ|サポート/ : FO.nameRe).test(x.office ?? "")).length;
  return r;
}

// ── 別表 ─────────────────────────────────────────────────────────────────
async function readBeppyo(img, J) {
  const H = J.h;
  // 氏名 (表の上の「〇〇 様」)。セルの外なので 表の上の帯の左を読む
  const firstTop = Math.min(...J.cells.filter((c) => c.w > 40 && c.h > 25).map((c) => c.y));
  const nameBand = { left: 0, top: Math.max(0, firstTop - Math.round(H * 0.11)), width: Math.round(J.w * 0.35), height: Math.round(H * 0.06) };
  const nameText = nf((await ocrJpLine(img, nameBand)).text);
  const r = { nameRaw: (nameText.split("様")[0] || nameText) || null };
  // 見出し: サービスコード の列を目印にして、同じ高さの背の高いセルを左から並べる (文字が崩れても並び順で決める)
  const cand = J.cells.filter((c) => c.y < H * 0.3 && c.h > 40);
  const ht = new Map();
  await Promise.all(cand.map(async (c) => ht.set(c, (await ocrJp(img, pad(c))).text)));
  const T = (c) => nf(ht.get(c));
  const codeH = cand.find((c) => /コード/.test(T(c)) && !/TAIS|届出|居宅/.test(T(c)) && c.w < J.w * 0.06);
  const C = {};
  if (codeH) {
    const row = cand.filter((c) => Math.abs(c.y - codeH.y) < 20).sort((a, b) => a.x - b.x);
    const i = row.indexOf(codeH);
    C.事業所名 = row[0]; C.事業所番号 = i >= 2 ? row[1] : null; C.サービス内容 = i >= 3 ? row[i - 1] : null; C.サービスコード = codeH;
    const eq = row.find((c) => c.x > codeH.x && /TAIS|届出|機種|名称/.test(T(c))) ?? row[i + 1];
    const ei = row.indexOf(eq);
    C.単位数 = row[ei + 1] ?? null;
    const su = row.find((c) => c.x > (C.単位数?.x ?? 0) && /金額|サービス単/.test(T(c)));
    C.サービス単位 = su ?? null;
    C.回数 = su ? row[row.indexOf(su) - 1] : null;
  }
  r.columnsFound = Object.fromEntries(["事業所名", "事業所番号", "サービス内容", "サービスコード", "単位数", "回数", "サービス単位"].map((k) => [k, !!C[k]]));
  r.rows = [];
  const anchor = C.事業所名 ?? C.サービス内容;
  if (anchor && codeH) {
    const headBottom = Math.max(...Object.values(C).filter(Boolean).map((c) => c.y + c.h));
    const rowCells = J.cells.filter((c) => c.y >= headBottom - 4 && Math.abs(cx(c) - cx(anchor)) < anchor.w / 2 && notHuge(c, anchor) && c.h > 20 && c.h < H * 0.08).sort((a, b) => a.y - b.y);
    for (const rc of rowCells) {
      const at = (hc) => hc && J.cells.find((d) => Math.abs(cx(d) - cx(hc)) < hc.w / 2 && notHuge(d, hc) && cy(d) > rc.y && cy(d) < rc.y + rc.h);
      const read = async (hc, num) => { const c = at(hc); if (!c) return null; const t = num ? (await ocrNum(img, pad(c, 3))).text : nf((await ocrJp(img, pad(c))).text); return t || null; };
      const row = {
        office: await read(C.事業所名), officeNumber: digits(await read(C.事業所番号, true)) || null, service: await read(C.サービス内容),
        code: (await read(C.サービスコード, true))?.toUpperCase() ?? null, unit: digits(await read(C.単位数, true)) || null,
        count: digits(await read(C.回数, true)) || null, serviceUnits: (await read(C.サービス単位, true)) ?? null,
      };
      if (!row.office && !row.service && !row.code) continue;
      if (/合計|計$/.test(row.service ?? "") && !row.code) row.kind = "合計行";
      // 検算: 単位数 × 回数 = サービス単位 (括弧付き = 限度外の内訳・合計行は外す)
      const su = digits(row.serviceUnits);
      if (row.code && row.unit && row.count && su && !/\(/.test(row.serviceUnits)) row.check = Number(row.unit) * Number(row.count) === Number(su) ? "一致" : `★ 不一致 ${row.unit}×${row.count}≠${su}`;
      // ケアサポの行: 事業所番号 (頭の桁が欠けやすいので 下 7 桁) か 事業所名
      row.caresapo = (row.officeNumber && row.officeNumber.length >= 7 && CONST.CARESAPO_BN.endsWith(row.officeNumber.slice(-7))) || (FO.isDefault ? /サポート千|ケア.?サポ/ : FO.nameRe).test(row.office ?? "");
      r.rows.push(row);
    }
  }
  r.caresapoRows = r.rows.filter((x) => x.caresapo).length;
  r.target = r.caresapoRows > 0 ? "対象" : `対象外 (${FO.area}の行が無い = 宛先違いの可能性)`;
  return r;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`PDF: ${PDF}\n出力: ${OUT}`);
  for (const l of ["jpn", "eng"]) { // 試作で取った traineddata があれば使う (無ければ CDN から自動で取る)
    const proto = process.env.TESSDATA_SEED ? join(process.env.TESSDATA_SEED, `${l}.traineddata`) : null;
    if (proto && existsSync(proto) && !existsSync(join(TESSDATA, `${l}.traineddata`))) copyFileSync(proto, join(TESSDATA, `${l}.traineddata`));
  }
  const t0 = Date.now();
  py("pages", resolve(PDF), OUT, ...PDFS.slice(1).map((p) => resolve(p)));
  const PJ = JSON.parse(readFileSync(join(OUT, "pages.json"), "utf8"));
  JP = await makeSched("jpn", { tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  JPLINE = await makeSched("jpn", { tessedit_pageseg_mode: PSM.SINGLE_LINE });
  NUM = await makeSched("eng", { tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "0123456789ABCDEFGHJKLMNPRSTUVWXYZ()" });
  CHAR = await makeSched("eng", { tessedit_pageseg_mode: PSM.SINGLE_CHAR, tessedit_char_whitelist: "0123456789H" });
  const results = [];
  for (const pg of PJ.pages) {
    if (PAGES && !PAGES.has(pg.page)) continue;
    const res = { page: pg.page, ink: pg.ink, photo: !!pg.photo, source: pg.source ?? null };
    if (pg.ink < CONST.BLANK_INK) { res.type = "白紙"; results.push(res); console.log(`p${pg.page}: 白紙`); continue; }
    const tries = await Promise.all(Object.entries(pg.bands).map(async ([deg, p]) => ({ deg: Number(deg), ...(await ocrJp(p)), })));
    for (const t of tries) Object.assign(t, scoreTitle(t.text));
    tries.sort((a, b) => b.score - a.score || b.conf - a.conf);
    const best = tries[0];
    res.rotate = best.deg; res.orientScore = Math.round(best.score * 100) / 100;
    res.type = best.score < CONST.ORIENT_MIN_SCORE ? "不明" : best.hit.別表 > 0 ? "別表" : best.hit.実績表 > 0 ? "実績表 (裏紙)" : best.hit.提供票 > 0 ? "提供票" : "不明";
    res.title = nf(best.text).slice(0, 60);
    if (res.type === "提供票" || res.type === "別表") {
      const pc = py("cells", OUT, String(pg.page), String(best.deg));
      res.skew = pc.skew;
      const J = JSON.parse(readFileSync(join(OUT, `p${String(pg.page).padStart(2, "0")}`, "cells.json"), "utf8"));
      const img = join(OUT, `p${String(pg.page).padStart(2, "0")}`, "page.png");
      res.cells = J.cells.length;
      Object.assign(res, res.type === "提供票" ? await readTeikyo(img, J, pg.page) : await readBeppyo(img, J));
    }
    results.push(res);
    console.log(`p${pg.page}: ${res.type} (回転 ${res.rotate ?? "-"}° 傾き ${res.skew ?? "-"}°)${res.insurerNumber || res.insuredNumber ? ` 番号 ${res.insurerNumber ?? "?"}|${res.insuredNumber ?? "?"}` : ""}${res.nameRaw ? ` 氏名「${res.nameRaw}」` : ""}${res.rows ? ` 行 ${res.rows.length} (ケアサポ ${res.caresapoRows})` : ""}`);
  }
  for (const s of [JP, JPLINE, NUM, CHAR]) await s.terminate();
  // 集計
  const by = (t) => results.filter((r) => r.type === t);
  const tk = by("提供票"), bp = by("別表");
  const filled = (xs, k) => xs.filter((r) => r[k]).length;
  const summary = {
    pages: results.length, 種類: Object.fromEntries(["提供票", "別表", "実績表 (裏紙)", "白紙", "不明"].map((t) => [t, by(t).length])),
    提供票: { 保険者番号_6桁: tk.filter((r) => r.insurerNumber?.length === 6).length, 被保険者番号_10桁: tk.filter((r) => r.insuredNumber?.length === 10).length, 氏名: filled(tk, "nameRaw"), 居宅: filled(tk, "careOfficeRaw"), 行: tk.reduce((s, r) => s + (r.rows?.length ?? 0), 0), ケアサポの行: tk.reduce((s, r) => s + (r.caresapoRows ?? 0), 0), 回数あり: tk.reduce((s, r) => s + (r.rows ?? []).filter((x) => x.plannedCount).length, 0) },
    別表: { 氏名: filled(bp, "nameRaw"), 行: bp.reduce((s, r) => s + (r.rows?.length ?? 0), 0), ケアサポの行: bp.reduce((s, r) => s + (r.caresapoRows ?? 0), 0), 検算一致: bp.reduce((s, r) => s + (r.rows ?? []).filter((x) => x.check === "一致").length, 0), 検算不一致: bp.reduce((s, r) => s + (r.rows ?? []).filter((x) => x.check?.startsWith("★")).length, 0), 対象外ページ: bp.filter((r) => r.target !== "対象").length },
    秒: Math.round((Date.now() - t0) / 1000), const: CONST,
  };
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ pdf: PDF, summary, pages: results }, null, 1));
  console.log("\n══ 集計 ══\n" + JSON.stringify(summary, null, 1) + `\n→ ${join(OUT, "result.json")}`);
  if (argv.includes("--all")) pipeline();
}

/** --all: 2 段目 → DB の控え → 照合 → 一覧。途中で失敗したら止める (リトライしない) */
function pipeline() {
  const node = (script, args) => {
    console.log(`\n▶ ${script} ${args.join(" ")}`);
    const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" });
    if (r.status !== 0) { console.error(`✗ ${script} が失敗 (exit ${r.status})。ここで止める`); process.exit(r.status ?? 1); }
  };
  node("claude.mjs", ["--out", OUT, ...(PAGES ? ["--pages", opt("--pages")] : []), ...FO.args]);
  // 控えは事業所ごとに別ファイル (既定 ケアサポは引数化の前と同じ snapshot.json)
  const SNAP = resolve(opt("--snapshot") ?? join(tmpdir(), "teikyohyo-fax", FO.isDefault ? "snapshot.json" : `snapshot_${FO.area}.json`));
  const fresh = existsSync(SNAP) && Date.now() - statSync(SNAP).mtimeMs < 12 * 3600 * 1000;
  if (fresh && !argv.includes("--refresh-db")) console.log(`\nDB の控え: ${SNAP} を使い回す (${Math.round((Date.now() - statSync(SNAP).mtimeMs) / 60000)} 分前。取り直すなら --refresh-db)`);
  else node("snapshot.mjs", ["--out", SNAP, ...FO.args]);
  node("match.mjs", [join(OUT, "claude.json"), "--snapshot", SNAP, "--out", join(OUT, "match_result.json"), ...FO.args]);
}
main().catch((e) => { console.error(e); process.exit(1); });
