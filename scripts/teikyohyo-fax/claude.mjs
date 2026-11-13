/**
 * 居宅から届く 提供票 / 別表 の FAX — 2 段目: Claude で読む (1 段目 run.mjs の結果を使う)
 *
 *   node scripts/teikyohyo-fax/claude.mjs --out <run.mjs の --out> [--pages 1-6] [--max 4] [--long 2000] [--no-escalate]
 *
 *   1 段目で 提供票 / 別表 と分かったページだけ送る (白紙・裏紙の実績表・不明は送らない)。
 *   まず claude-haiku-5-5 で読み、検算などで怪しいときだけ claude-sonnet-5-5 で読み直す。
 *   出力: <out>/claude.json (1 ページ 1 件。照合側と取り決めた形) と ページごとの費用・合計。
 *
 * ★ API キーは order-app/.env.local の ANTHROPIC_API_KEY (値はログにも出力にも出さない)。
 * ★ 画像・読取結果は個人情報。<out> は repo の外。
 *
 * 出力の形 (照合側と取り決め 2026-11-13):
 *   { page, kind: "teikyo"|"beppyo"|"other"|"blank", rotate, fax_seq,
 *     teikyo?: { ym, insurer_no, insured_no, name, kana, birth, care_level, cert_from, cert_to, kyotaku_name, kyotaku_no, cm_name,
 *                rows:[{service, office, kind}], digits_local },
 *     beppyo?: { name, kyotaku_name, ym, rows:[{office, office_no, service_name, service_code, tais, units, discount_pct, units_after, count, service_units, kyufu_units}] },
 *     conf: { field: 1|0.5|0 }, source: "ocr"|"claude-haiku"|"claude-sonnet", cost: { model, input_tokens, output_tokens, usd } }
 *   読めない欄は null。● (伏字) は文字のまま。
 *   conf: 1 = ローカル OCR と Claude が一致 / 0.5 = 片方だけ / 0 = 検算 (単位数×回数=サービス単位) が合わない
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const OUT = opt("--out");
if (!OUT) { console.error("usage: node scripts/teikyohyo-fax/claude.mjs --out <dir> [--pages 1-6] [--max 4]"); process.exit(1); }
const LONG = Number(opt("--long") ?? 2000);
const MAX = opt("--max") ? Number(opt("--max")) : Infinity;
const ESCALATE = !argv.includes("--no-escalate");
const PAGES = (() => { const p = opt("--pages"); if (!p) return null; const s = new Set(); for (const part of p.split(",")) { const [a, b] = part.split("-").map(Number); for (let i = a; i <= (b || a); i++) s.add(i); } return s; })();

// 料金 (USD / 1M トークン。2026-11 時点の公表値)
export const PRICE = { "claude-haiku-5-5": { in: 0.10, out: 0.50 }, "claude-sonnet-5-5": { in: 2.0, out: 10.0 } };
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const USD_JPY = 155; // 目安の換算 (表示用)

function apiKey() {
  const txt = readFileSync(join(HERE, "../../.env.local"), "utf8");
  const m = /^ANTHROPIC_API_KEY=(.*)$/m.exec(txt);
  const v = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  if (!v) throw new Error("order-app/.env.local に ANTHROPIC_API_KEY が無い");
  return v;
}
const py = (...a) => { const r = spawnSync("python", ["-I", join(HERE, "prep.py"), ...a], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); };

// ── 出力の型 (structured outputs) ─────────────────────────────────────────
// ★ union 型 (["string","null"]) が多いと 400 (17 個で上限) になるので、全部 string にして「読めない = 空文字」で返させ、受け取ったあと null / 数値に直す
const S = (d) => ({ type: "string", description: `${d}。読めない・書いていなければ空文字` });
const N = (d) => ({ type: "string", description: `${d} (数字だけ)。読めない・書いていなければ空文字` });
const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const SCHEMA_TEIKYO = obj({
  fax_seq: S("FAX の送信ヘッダの通し番号 (例 004/007)。無ければ null"),
  ym: S("サービス提供年月 YYYY-MM (令和は西暦に直す。令和8年=2026)"),
  insurer_no: S("保険者番号 (6 桁。伏字は ● のまま)"),
  insured_no: S("被保険者番号 (10 桁。英字 H を含むことがある。伏字は ● のまま)"),
  name: S("被保険者氏名 (漢字。様 は付けない。伏字は ● のまま)"),
  kana: S("フリガナ (伏字は ● のまま)"),
  birth_raw: S("生年月日を書いてあるとおりに (例 昭和21年01月05日 / 昭●年9月24日)。元号は「明・大・昭・平」のうち ★丸で囲んである字 を選ぶ (印字の順番や近さで選ばない)"),
  birth: S("生年月日 YYYY-MM-DD (昭和=1925+年 で西暦に直す)。年・月・日のどれかが伏字なら空文字"),
  gender: S("性別: 丸の付いた方 (男 / 女)"),
  care_level: S("要介護状態区分: 丸の付いたもの (要支援1 / 要支援2 / 要介護1〜5 / 事業対象者)。変更後の欄に丸があればそちら"),
  cert_from: S("限度額適用期間の開始 YYYY-MM"), cert_to: S("限度額適用期間の終了 YYYY-MM"),
  kyotaku_name: S("居宅介護支援事業者の事業所名 (「居宅介護支援事業者事業所名 担当者名」の欄。表の上段・右寄りにあることが多い。カタカナは一字ずつ正確に (例 ケイ・ティ・サービス))"), kyotaku_no: S("居宅の事業所番号 (書いてあれば)"), cm_name: S("担当者 (ケアマネ) 氏名 (同じ欄の 2 行目など)"),
  rows: { type: "array", description: "下の表の サービス内容 が書いてある行 (空行は入れない)", items: obj({ service: S("サービス内容"), office: S("サービス事業者事業所名"), equipment: S("用具名称・TAIS (書いてあれば)"), planned_count: N("予定の合計回数") }) },
});
const SCHEMA_BEPPYO = obj({
  fax_seq: S("FAX の送信ヘッダの通し番号 (例 005/007)。無ければ null"),
  name: S("表の上の利用者氏名 (様 は付けない。伏字は ● のまま)"),
  insured_no: S("被保険者番号 (書いてある様式だけ。伏字は ● のまま)"),
  kyotaku_name: S("居宅の事業所名 (右上)"), ym: S("提供年月 YYYY-MM"),
  rows: { type: "array", description: "区分支給限度管理の表の行を上から全部 (合計行も。空行は入れない)", items: obj({
    office: S("事業所名"), office_no: S("事業所番号 (10 桁)"), service_name: S("サービス内容/種類"), service_code: S("サービスコード (6 桁。A6 などの英数字も)"),
    tais: S("用具名称・TAIS"), units: N("単位数 (この欄が空欄なら空文字。0 にしない。サービス単位数の欄だけにカッコ付きで書いてある様式がある)"), discount_pct: N("割引後 率%"), units_after: N("割引後 単位数"), count: N("回数"),
    service_units: S("サービス単位/金額 (括弧付きならそのまま (1370) と書く)"), kyufu_units: N("給付管理単位数"),
  }) },
});
// ★ 伏字: 個人情報保護で ● に置き換えた文字がある (氏名・番号・生年月日の一部)。推測で埋めさせない (照合側は ● をワイルドカードとして扱う)
const MASK_RULE = "重要: 個人情報保護のため、一部の文字が「●」(塗りつぶした丸) で伏せてあることがあります。● は推測で埋めず、必ず ● のまま返してください (例 被保険者番号 0●0●0●2●1●、氏名 石● 玲●)。番号の桁数も ● を含めて書いてあるとおりにしてください。";
const PROMPT = {
  teikyo: "これは居宅介護支援事業所から届いた「サービス提供票」(第6表) の FAX スキャン (またはスマホの写真) です。書いてあるとおりに読み取ってください。推測で埋めず、読めない欄は空文字。丸印は、丸で囲まれた選択肢を答えます。" + MASK_RULE,
  beppyo: "これは居宅介護支援事業所から届いた「サービス提供票別表」(第7表) の FAX スキャン (またはスマホの写真) です。表を行ごとに書いてあるとおりに読み取ってください。推測で埋めず、読めない欄は空文字。数字は桁を落とさないよう注意してください (例 620 を 62 にしない)。" + MASK_RULE,
};

/** 空文字 → null / 数値の欄 → number */
const NUM_KEYS = new Set(["planned_count", "units", "discount_pct", "units_after", "count", "kyufu_units"]);
function normalize(v, k) {
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, normalize(vv, kk)]));
  if (typeof v !== "string") return v;
  let t = v.trim();
  if (t === "") return null;
  // 番号の欄は空白を詰める (Haiku が「H3510006 96」のように空白を挟むことがある。2026-11-13 p21)
  if (/_no$/.test(k ?? "")) t = t.normalize("NFKC").replace(/\s+/g, "").replace(/[⚫•○◯]/g, "●");
  if (NUM_KEYS.has(k)) { const n = Number(t.normalize("NFKC").replace(/[^0-9.]/g, "")); return t.normalize("NFKC").replace(/[^0-9.]/g, "") === "" ? null : n; }
  return t;
}
const CARESAPO_BN = "1272400050";
/** 生年月日として受け入れる年齢 (提供月の時点)。外れたら Sonnet で読み直し、それでも外れたら birth を null にする */
export const CONST_AGE = { min: 40, max: 110 };
const isCaresapo = (r) => dig(r.office_no).endsWith(CARESAPO_BN.slice(-7)) || /サポート千葉|ケア.?サポ/.test(r.office ?? "");
const dig = (s) => String(s ?? "").normalize("NFKC").replace(/[^0-9]/g, "");
/** 読み直しが要るか (Sonnet に回す理由)。空配列なら OK */
function problems(kind, d) {
  const p = [];
  if (kind === "teikyo") {
    if (!d.insured_no || !/^[0-9H●]{10}$/.test(d.insured_no.normalize("NFKC"))) p.push(`被保険者番号 ${d.insured_no}`);
    if (!d.insurer_no || !/^[0-9●]{6}$/.test(d.insurer_no.normalize("NFKC"))) p.push(`保険者番号 ${d.insurer_no}`);
    if (!d.name) p.push("氏名なし");
    if (!d.kyotaku_name) p.push("居宅名なし");
    // 生年月日の妥当性: 提供月の時点で 40〜110 歳 (福祉用具の利用者。元号の取り違え 昭和↔平成 を弾く。p1 相田で実例)
    if (d.birth && d.ym) {
      const age = Number(d.ym.slice(0, 4)) - Number(d.birth.slice(0, 4));
      if (!(age >= CONST_AGE.min && age <= CONST_AGE.max)) p.push(`生年月日 ${d.birth} (${age} 歳。元号の読み違いの疑い)`);
    }
  } else {
    // 検算はケアサポ (福祉用具) の行だけ。通所型などの月額サービスは 回数 4 でも 単位は 1 か月分なので 単位数×回数 にならない
    for (const r of (d.rows ?? []).filter(isCaresapo)) {
      const su = dig(r.service_units);
      if (r.service_code && (r.units_after ?? r.units) && r.count && su && !/\(/.test(r.service_units ?? "")) {
        if ((r.units_after ?? r.units) * r.count !== Number(su)) p.push(`検算 ${r.service_code} ${(r.units_after ?? r.units)}×${r.count}≠${su}`);
      }
    }
    if (!(d.rows ?? []).length) p.push("行なし");
  }
  return p;
}

async function main() {
  const S1 = JSON.parse(readFileSync(join(resolve(OUT), "result.json"), "utf8"));
  const client = new Anthropic({ apiKey: apiKey() });
  const out = [];
  let sent = 0, total = 0;
  for (const p of S1.pages) {
    if (PAGES && !PAGES.has(p.page)) continue;
    let kind = p.type === "提供票" ? "teikyo" : p.type === "別表" ? "beppyo" : p.type === "白紙" ? "blank" : p.type === "不明" ? "unknown" : "other";
    const rec = { page: p.page, kind, rotate: p.rotate ?? null, fax_seq: null, conf: {}, source: "ocr", cost: [] };
    if (kind !== "teikyo" && kind !== "beppyo" && kind !== "unknown") { rec.note = p.type; out.push(rec); continue; }
    if (sent >= MAX) { rec.note = "--max で送らなかった"; out.push(rec); continue; }
    sent++;
    // 1 段目で種類が決まらなかったページ (スマホの写真など) は、補正前の画像を送り、まず種類を Claude に聞く
    const img = py(kind === "unknown" ? "exportraw" : "export", resolve(OUT), String(p.page), String(LONG));
    if (kind === "unknown") {
      const res = await client.messages.create({
        model: MODELS[0], max_tokens: 2000,
        output_config: { format: { type: "json_schema", schema: obj({ kind: { type: "string", enum: ["teikyo", "beppyo", "other", "blank"], description: "teikyo = 居宅介護支援事業所が作った サービス提供票 (第6表。右上が「居宅介護支援事業者→サービス事業者」) / beppyo = その別表 (第7表) / other = それ以外 (サービス利用実績表、サービス事業者が居宅に出した実績報告「サービス事業者→居宅介護支援事業者」の控えなど) / blank = 白紙" } }) } },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(img.path).toString("base64") } },
          { type: "text", text: "この画像は介護の書類の FAX かスマホの写真です。どの書類か答えてください。" },
        ] }],
      });
      const u = res.usage, usd = (u.input_tokens * PRICE[MODELS[0]].in + u.output_tokens * PRICE[MODELS[0]].out) / 1e6;
      total += usd;
      rec.cost.push({ model: MODELS[0], step: "種類", input_tokens: u.input_tokens, output_tokens: u.output_tokens, usd: Math.round(usd * 1e6) / 1e6 });
      try { kind = JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "{}").kind ?? "other"; } catch { kind = "other"; }
      rec.kind = kind; rec.kindBy = "claude";
      if (kind !== "teikyo" && kind !== "beppyo") { rec.note = "Claude の判定で 提供票・別表ではない"; out.push(rec); continue; }
    }
    const data = readFileSync(img.path).toString("base64");
    let d = null, why = [];
    for (const model of ESCALATE ? MODELS : MODELS.slice(0, 1)) {
      let res;
      try {
        res = await client.messages.create({
          model, max_tokens: 16000,
          output_config: { format: { type: "json_schema", schema: kind === "teikyo" ? SCHEMA_TEIKYO : SCHEMA_BEPPYO } },
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: PROMPT[kind] },
          ] }],
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) { console.error(`p${p.page} ${model}: API エラー ${e.status} ${e.message.slice(0, 200)}`); break; }
        throw e;
      }
      const u = res.usage;
      const usd = (u.input_tokens * PRICE[model].in + u.output_tokens * PRICE[model].out) / 1e6;
      total += usd;
      rec.cost.push({ model, input_tokens: u.input_tokens, output_tokens: u.output_tokens, usd: Math.round(usd * 1e6) / 1e6 });
      if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") { why = [`stop_reason ${res.stop_reason}`]; continue; }
      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      try { d = normalize(JSON.parse(text)); } catch { why = ["JSON にならない"]; continue; }
      rec.source = model.includes("haiku") ? "claude-haiku" : "claude-sonnet";
      why = problems(kind, d);
      if (!why.length) break;
      console.log(`p${p.page}: ${model} の結果に問題 (${why.join(" / ")})${ESCALATE && model !== MODELS.at(-1) ? " → Sonnet で読み直す" : ""}`);
    }
    if (d) {
      rec.fax_seq = d.fax_seq ?? null;
      if (kind === "beppyo") for (const r of d.rows ?? []) if (r.units === 0) r.units = null; // 空欄を 0 と読んだもの (いわい型の別表)
      if (kind === "teikyo" && why.some((w) => w.startsWith("生年月日"))) { d.birth_rejected = d.birth; d.birth = null; } // 最後まで年齢が合わない生年月日は使わない
      const body = { ...d };
      delete body.fax_seq;
      rec[kind] = body;
      // conf: ローカル OCR (1 段目) と比べる
      if (kind === "teikyo") {
        body.digits_local = { insurer_no: p.insurerNumber ?? null, insured_no: p.insuredNumber ?? null };
        for (const k of ["insurer_no", "insured_no"]) {
          const loc = body.digits_local[k], cl = body[k];
          rec.conf[k] = cl && loc && dig(loc) === dig(cl) ? 1 : cl || loc ? 0.5 : 0;
        }
      } else {
        rec.conf.rows = why.some((w) => w.startsWith("検算")) ? 0 : 0.5;
      }
      rec.problems = why;
    }
    out.push(rec);
    const c = rec.cost.reduce((s, x) => s + x.usd, 0);
    const brief = kind === "teikyo" ? `${d?.insurer_no ?? "?"}|${d?.insured_no ?? "?"} ${d?.name ?? "?"} ${d?.care_level ?? ""} 行${d?.rows?.length ?? 0}` : `${d?.name ?? "?"} 行${d?.rows?.length ?? 0}`;
    console.log(`p${p.page} ${kind} ${rec.source}: ${brief}${why.length ? ` ⚠ ${why.join(" / ")}` : ""}  [${rec.cost.map((x) => `${x.model.replace("claude-", "")} in${x.input_tokens}/out${x.output_tokens}`).join(" → ")} $${c.toFixed(5)}]`);
  }
  const perPage = sent ? total / sent : 0;
  const summary = { sent, usd: Math.round(total * 1e6) / 1e6, jpy: Math.round(total * USD_JPY * 100) / 100, per_page_usd: Math.round(perPage * 1e6) / 1e6, price: PRICE, usd_jpy: USD_JPY };
  writeFileSync(join(resolve(OUT), "claude.json"), JSON.stringify({ pdf: S1.pdf, summary, pages: out }, null, 1));
  console.log(`\n══ 費用 ══\n  送ったページ ${sent} / 合計 $${summary.usd} (約 ${summary.jpy} 円・${USD_JPY}円/$ 換算) / 1 ページ平均 $${summary.per_page_usd}`);
  console.log(`  → 月 1,000 ページなら 約 ${Math.round(perPage * 1000 * USD_JPY)} 円の見込み\n→ ${join(resolve(OUT), "claude.json")}`);
}
main().catch((e) => { console.error(e instanceof Anthropic.APIError ? `API エラー ${e.status}` : e); process.exit(1); });
