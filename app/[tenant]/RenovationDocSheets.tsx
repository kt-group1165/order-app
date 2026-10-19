"use client";
import { todayYmd } from "@/lib/date-jst";

// 住宅改修の書類 (印刷用 A4)。旧 Excel「<利用者>様住改見積.xlsx」の各シートを HTML で再現する。
// 入力は RenovationDocsModal、計算は lib/renovationDocs.ts。ここは表示だけ (状態を持たない)。
//
// 用紙: 見積書・理由書 P1/P2 = A4 横 / 承諾書・支給申請書・領収書・送付状 = A4 縦 (旧 Excel の印刷設定どおり)。
// 1 シート = 1 ページ。印刷 CSS (名前付き @page) は RenovationDocsModal が差し込む。

import type { CSSProperties, ReactNode } from "react";
import type { Client } from "@/lib/supabase";
import type { RenovationProject } from "@/lib/renovations";
import {
  REASON_ACTIVITIES, REASON_PURPOSES, REASON_TOOLS, REASON_WORK_ITEMS, RENOVATION_KINDS,
  ageAt, photoWorkLabel, splitTaxIncluded, toWareki, warekiLabel, yenNum,
  type EstimateGroup, type EstimateTotals, type PhotoRef, type RenovationDocs,
} from "@/lib/renovationDocs";

export type DocSheetProps = {
  docs: RenovationDocs;
  project: RenovationProject;
  client: Client | null;
  totals: EstimateTotals;
  /** 領収額 (入力が無ければ自己負担の見込み) */
  receiptAmount: number;
  /** 支給申請書・承諾書の宛先 (入力が無ければ住所から自動) */
  addressee: string;
  /** 写真の表示用 URL (Storage のパス → 署名付き URL) */
  photoUrls?: Record<string, string>;
};

// ─── 共通 ────────────────────────────────────────────────────────────────────

const B = "1px solid #000";
const cell: CSSProperties = { border: B, padding: "1mm 1.5mm", verticalAlign: "middle" };
const th: CSSProperties = { ...cell, background: "#f2f2f2", fontWeight: "normal", textAlign: "center" };

export function Sheet({ landscape, children }: { landscape?: boolean; children: ReactNode }) {
  return (
    <div
      className={`rdoc-sheet ${landscape ? "rdoc-landscape" : "rdoc-portrait"}`}
      style={{
        width: landscape ? "281mm" : "190mm",
        minHeight: landscape ? "190mm" : "275mm",
        background: "#fff",
        color: "#000",
        fontSize: "9.5pt",
        lineHeight: 1.35,
        fontFamily: '"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "MS PMincho", serif',
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

/** 選んだ選択肢を ○ で囲む (「明・大・昭」「要支援 1・2」等) */
function Choice({ options, selected }: { options: string[]; selected: string | null }) {
  return (
    <span>
      {options.map((o, i) => (
        <span key={o}>
          {i > 0 && "・"}
          <span style={o === selected ? { border: B, borderRadius: "50%", padding: "0 1mm" } : undefined}>{o}</span>
        </span>
      ))}
    </span>
  );
}

const box = (on: boolean) => (on ? "☑" : "☐");
const pre: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-all" };

function IssuerBlock({ docs, align = "left" }: { docs: RenovationDocs; align?: "left" | "right" }) {
  const i = docs.issuer;
  return (
    <div style={{ textAlign: align, lineHeight: 1.5 }}>
      {i.postal_code || i.address ? <div>〒{i.postal_code}　{i.address}</div> : null}
      <div style={{ fontSize: "11pt", fontWeight: "bold" }}>{i.company_name}</div>
      <div style={{ fontSize: "11pt", fontWeight: "bold" }}>{i.office_name}</div>
      {(i.tel || i.fax) && <div>TEL:{i.tel}　FAX:{i.fax}</div>}
    </div>
  );
}

// ─── 見積書 (A4 横) ─────────────────────────────────────────────────────────

export function EstimateSheet({ docs, project, client, totals }: DocSheetProps) {
  const e = docs.estimate;
  const name = client?.name ?? project.client_name;
  // 明細行 (改修箇所ごとに「小計」行を挟む)。旧 Excel と同じく 2 箇所目以降の種類・番号は「〃」にしない (箇所ごとに明示)
  const rows: ReactNode[] = [];
  e.groups.forEach((g, gi) => {
    g.lines.forEach((l, li) => {
      const amt = totals.lineAmounts[gi][li];
      rows.push(
        <tr key={`${gi}-${li}`}>
          <td style={{ ...cell, textAlign: "center" }}>{li === 0 ? `（${g.kind}）` : "〃"}</td>
          <td style={{ ...cell, textAlign: "center" }}>{li === 0 ? g.photo_no : "〃"}</td>
          <td style={cell}>{li === 0 ? g.place : "〃"}</td>
          <td style={cell}>{li === 0 ? g.part : "〃"}</td>
          <td style={cell}>{l.name}</td>
          <td style={cell}>{l.spec}</td>
          <td style={{ ...cell, textAlign: "right" }}>{l.qty ?? ""}</td>
          <td style={{ ...cell, textAlign: "center" }}>{l.unit}</td>
          <td style={{ ...cell, textAlign: "right" }}>{yenNum(l.unit_price)}</td>
          <td style={{ ...cell, textAlign: "right" }}>{yenNum(amt)}</td>
          <td style={cell}>{l.basis}</td>
        </tr>,
      );
    });
    rows.push(
      <tr key={`${gi}-sub`}>
        <td style={cell} colSpan={4} />
        <td style={{ ...cell, textAlign: "center" }}>小計</td>
        <td style={cell} colSpan={4} />
        <td style={{ ...cell, textAlign: "right" }}>{yenNum(totals.groupSubtotals[gi])}</td>
        <td style={cell} />
      </tr>,
    );
  });
  const sumRow = (label: string, v: number, bold = false) => (
    <tr key={label}>
      <td style={cell} colSpan={4} />
      <td style={{ ...cell, textAlign: "center", fontWeight: bold ? "bold" : undefined }}>{label}</td>
      <td style={cell} />
      <td style={{ ...cell, textAlign: "right" }}>1</td>
      <td style={{ ...cell, textAlign: "center" }}>式</td>
      <td style={cell} />
      <td style={{ ...cell, textAlign: "right", fontWeight: bold ? "bold" : undefined }}>{yenNum(v)}</td>
      <td style={cell} />
    </tr>
  );
  return (
    <Sheet landscape>
      <div style={{ textAlign: "right" }}>{warekiLabel(e.issue_date)}</div>
      <div style={{ textAlign: "center", fontSize: "18pt", letterSpacing: "1em", margin: "1mm 0 3mm" }}>見積書</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8mm" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "14pt", borderBottom: B, paddingBottom: "1mm", marginBottom: "2mm" }}>
            {name}　様
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              {[
                ["件　　名", e.title],
                ["工事場所", e.site],
                ["支払条件", e.payment_terms],
                ["有効期限", e.validity],
                ["工事着工予定日", e.start_date ? warekiLabel(e.start_date) : "令和　　年　　月　　日"],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: "0.8mm 2mm 0.8mm 0", whiteSpace: "nowrap" }}>{k}</td>
                  <td style={{ padding: "0.8mm 0", borderBottom: "1px dotted #000", width: "100%" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: "3mm", display: "flex", alignItems: "baseline", gap: "4mm", borderBottom: "2px solid #000", paddingBottom: "1mm" }}>
            <span>合計金額（消費税等込）</span>
            <span style={{ fontSize: "16pt", fontWeight: "bold" }}>¥{yenNum(totals.grandTotal)}－</span>
          </div>
        </div>
        <div style={{ width: "95mm" }}>
          <IssuerBlock docs={docs} />
          {docs.issuer.staff_name && <div style={{ marginTop: "2mm" }}>担当　{docs.issuer.staff_name}</div>}
        </div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "4mm", fontSize: "8.5pt" }}>
        <colgroup>
          <col style={{ width: "8%" }} /><col style={{ width: "6%" }} /><col style={{ width: "8%" }} /><col style={{ width: "8%" }} />
          <col style={{ width: "14%" }} /><col style={{ width: "17%" }} /><col style={{ width: "5%" }} /><col style={{ width: "4%" }} />
          <col style={{ width: "7%" }} /><col style={{ width: "8%" }} /><col style={{ width: "15%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={th} rowSpan={2}>住宅改修の種類<br />（※1）</th>
            <th style={th} rowSpan={2}>写真等<br />番号</th>
            <th style={th} rowSpan={2}>改修場所</th>
            <th style={th} rowSpan={2}>改修部分</th>
            <th style={th} rowSpan={2}>名　称（※2）</th>
            <th style={th} rowSpan={2}>商品名・規格・寸法等</th>
            <th style={th} colSpan={4}>介護保険対象部分</th>
            <th style={th} rowSpan={2}>算出根拠</th>
          </tr>
          <tr>
            <th style={th}>数量</th><th style={th}>単位</th><th style={th}>単価</th><th style={th}>金額</th>
          </tr>
        </thead>
        <tbody>
          {rows}
          {sumRow("工事費用計", totals.workTotal)}
          {sumRow(`諸経費`, totals.overhead)}
          {sumRow("合計", totals.subtotal)}
          {sumRow("消費税", totals.tax)}
          {sumRow("総合計", totals.grandTotal, true)}
        </tbody>
      </table>
      <div style={{ fontSize: "7.5pt", marginTop: "2mm", lineHeight: 1.5 }}>
        <div>
          （※１）住宅改修の種類：
          {RENOVATION_KINDS.map((k) => `（${k.no}）${k.label}`).join("")}
        </div>
        <div>（※２）名称：　材料費、施工費、諸経費等を分けて記載すること</div>
      </div>
    </Sheet>
  );
}

// ─── 理由書 P1 (A4 横) ──────────────────────────────────────────────────────

const CARE_LEVEL_SHIEN = ["1", "2"];
const CARE_LEVEL_KAIGO = ["経過的", "1", "2", "3", "4", "5"];

function careLevelParts(level: string | null | undefined): { kind: "要支援" | "要介護" | null; n: string | null } {
  const s = (level ?? "").normalize("NFKC").replace(/\s/g, "");
  const m = /^(要支援|要介護)(\d)?/.exec(s);
  if (!m) return { kind: null, n: null };
  return { kind: m[1] as "要支援" | "要介護", n: m[2] ?? null };
}

export function ReasonP1Sheet({ docs, project, client }: DocSheetProps) {
  const r = docs.reason;
  const birth = toWareki(client?.birth_date);
  const age = ageAt(client?.birth_date, r.created_date ?? r.site_visit_date ?? todayYmd());
  const cl = careLevelParts(client?.care_level);
  const gender = client?.gender?.startsWith("男") ? "男" : client?.gender?.startsWith("女") ? "女" : null;
  const postal = (client as unknown as { postal_code?: string | null } | null)?.postal_code ?? "";
  const label: CSSProperties = { ...th, width: "20mm", whiteSpace: "nowrap", fontSize: "8pt", padding: "0.8mm 1mm" };
  const toolRows = [
    ...REASON_TOOLS.map((t) => ({ name: t, ...(r.tools[t] ?? { before: false, after: false }) })),
    { name: "その他", before: false, after: false, header: true },
    ...r.tools_other.map((t) => ({ ...t, name: t.name ? `・${t.name}` : "・" })),
  ] as { name: string; before: boolean; after: boolean; header?: boolean }[];
  return (
    <Sheet landscape>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: "15pt", letterSpacing: "0.3em" }}>住宅改修が必要な理由書</div>
        <div>（P1）</div>
      </div>
      <div style={{ margin: "1mm 0" }}>＜基本情報＞</div>
      <div style={{ display: "flex", gap: "3mm" }}>
        <table style={{ borderCollapse: "collapse", flex: 1.8, fontSize: "8.5pt", whiteSpace: "nowrap" }}>
          <tbody>
            <tr>
              <td style={{ ...th, width: "8mm" }} rowSpan={4}>利<br />用<br />者</td>
              <td style={label}>被保険者番号</td>
              <td style={cell}>{client?.insured_number ?? ""}</td>
              <td style={label}>年齢</td>
              <td style={{ ...cell, textAlign: "right" }}>{age ?? ""}　歳</td>
              <td style={label}>生年月日</td>
              <td style={cell}>
                <Choice options={["明治", "大正", "昭和"]} selected={birth?.era ?? null} />
                {birth ? `${birth.year}年${birth.month}月${birth.day}日` : "　　年　　月　　日"}
              </td>
              <td style={label}>性別</td>
              <td style={{ ...cell, textAlign: "center" }}><Choice options={["男", "女"]} selected={gender} /></td>
            </tr>
            <tr>
              <td style={label}>被保険者氏名</td>
              <td style={{ ...cell, fontSize: "11pt" }}>{client?.name ?? project.client_name}</td>
              <td style={label}>要介護認定<br /><span style={{ fontSize: "7pt" }}>（該当に○）</span></td>
              <td style={cell} colSpan={6}>
                要支援　<Choice options={CARE_LEVEL_SHIEN} selected={cl.kind === "要支援" ? cl.n : null} />
                　　要介護　<Choice options={CARE_LEVEL_KAIGO} selected={cl.kind === "要介護" ? cl.n : null} />
              </td>
            </tr>
            <tr>
              <td style={label} rowSpan={2}>住所</td>
              <td style={{ ...cell, height: "12mm" }} colSpan={7} rowSpan={2}>
                〒{postal}<br />{client?.address ?? project.client_address ?? ""}
              </td>
            </tr>
            <tr />
          </tbody>
        </table>
        <table style={{ borderCollapse: "collapse", flex: 1 }}>
          <tbody>
            <tr>
              <td style={{ ...th, width: "8mm" }} rowSpan={6}>作<br />成<br />者</td>
              <td style={label}>現地確認日</td>
              <td style={cell}>{warekiLabel(r.site_visit_date)}</td>
              <td style={label}>作成日</td>
              <td style={cell}>{warekiLabel(r.created_date)}</td>
            </tr>
            <tr><td style={label}>所属事業所</td><td style={cell} colSpan={3}>{r.creator_office}</td></tr>
            <tr>
              <td style={label}>資格</td>
              <td style={cell} colSpan={3}>
                <span style={{ fontSize: "7pt" }}>（作成者が介護支援専門員でないとき）</span> {r.creator_qualification}
              </td>
            </tr>
            <tr><td style={label}>氏名</td><td style={cell} colSpan={3}>{r.creator_name}</td></tr>
            <tr><td style={label}>連絡先</td><td style={cell} colSpan={3}>{r.creator_phone}</td></tr>
            <tr><td style={{ ...cell, fontSize: "7pt" }} colSpan={4}>※本人が手書きしない場合は、記名押印してください。</td></tr>
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "2mm" }}>
        <tbody>
          <tr>
            <td style={{ ...th, width: "8mm" }} rowSpan={2}>保<br />険<br />者</td>
            <td style={label}>確認日</td>
            <td style={{ ...cell, width: "45mm" }}>　　年　　月　　日</td>
            <td style={label} rowSpan={2}>評価欄</td>
            <td style={cell} rowSpan={2} />
          </tr>
          <tr><td style={label}>氏名</td><td style={cell} /></tr>
        </tbody>
      </table>
      <div style={{ margin: "2mm 0 1mm" }}>＜総合的状況＞</div>
      <div style={{ display: "flex", gap: "3mm" }}>
        <table style={{ borderCollapse: "collapse", flex: 3 }}>
          <tbody>
            <tr>
              <td style={{ ...th, width: "30mm" }}>利用者の身体状況</td>
              <td style={{ ...cell, ...pre, height: "30mm", verticalAlign: "top" }}>{r.body_status}</td>
            </tr>
            <tr>
              <td style={th}>介護状況</td>
              <td style={{ ...cell, ...pre, height: "22mm", verticalAlign: "top" }}>{r.care_status}</td>
            </tr>
            <tr>
              <td style={th}>住宅改修により、<br />利用者等は日常生活を<br />どう変えたいか</td>
              <td style={{ ...cell, ...pre, height: "34mm", verticalAlign: "top" }}>{r.goal}</td>
            </tr>
          </tbody>
        </table>
        <table style={{ borderCollapse: "collapse", flex: 1, fontSize: "8pt" }}>
          <thead>
            <tr><th style={th} colSpan={3}>福祉用具の利用状況と住宅改修後の想定</th></tr>
            <tr><th style={th} /><th style={{ ...th, width: "12mm" }}>改修前</th><th style={{ ...th, width: "12mm" }}>改修後</th></tr>
          </thead>
          <tbody>
            {toolRows.map((t, i) => (
              <tr key={`${t.name}-${i}`}>
                <td style={{ ...cell, padding: "0.4mm 1.5mm" }}>{t.header ? t.name : t.name.startsWith("・") ? t.name : `●${t.name}`}</td>
                <td style={{ ...cell, textAlign: "center", padding: "0.4mm" }}>{t.header ? "" : box(t.before)}</td>
                <td style={{ ...cell, textAlign: "center", padding: "0.4mm" }}>{t.header ? "" : box(t.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: "2mm", fontSize: "8.5pt" }}>□ 複数の住宅改修の事業者から見積もりを取るよう、利用者に対して説明しました。</div>
    </Sheet>
  );
}

// ─── 理由書 P2 (A4 横) ──────────────────────────────────────────────────────

export function ReasonP2Sheet({ docs }: DocSheetProps) {
  const r = docs.reason;
  const small: CSSProperties = { ...cell, fontSize: "8pt", verticalAlign: "top", padding: "0.8mm 1.2mm" };
  return (
    <Sheet landscape>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: "15pt", letterSpacing: "0.3em" }}>住宅改修が必要な理由書</div>
        <div>（P2）</div>
      </div>
      <div style={{ fontSize: "8pt", margin: "1mm 0" }}>
        ＜P1の「総合的状況」を踏まえて、①改善をしようとしている生活動作②具体的な困難な状況③改修目的と改修の方針④改修項目を具体的に記入してください。＞
      </div>
      <div style={{ display: "flex", gap: "2mm" }}>
        <table style={{ borderCollapse: "collapse", flex: 4.2 }}>
          <colgroup>
            <col style={{ width: "9%" }} /><col style={{ width: "27%" }} /><col style={{ width: "26%" }} /><col style={{ width: "38%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...th, fontSize: "8pt" }}>活動</th>
              <th style={{ ...th, fontSize: "8pt" }}>①改善しようとしている生活動作</th>
              <th style={{ ...th, fontSize: "8pt" }}>②　①の具体的な困難な状況<br />（…なので…で困っている）</th>
              <th style={{ ...th, fontSize: "8pt" }}>③改修目的・期待効果をチェックした上で、改修の方針<br />（…することで…が改善できる）</th>
            </tr>
          </thead>
          <tbody>
            {REASON_ACTIVITIES.map((a) => {
              const v = r.activities[a.key];
              return (
                <tr key={a.key}>
                  <td style={{ ...th, fontSize: "8.5pt" }}>{a.label}</td>
                  <td style={small}>
                    {a.actions.map((x) => (
                      <div key={x}>{box(v.actions.includes(x))} {x}</div>
                    ))}
                    {a.key === "other"
                      ? <div style={pre}>{v.action_other}</div>
                      : <div>{box(!!v.action_other)} その他（{v.action_other || "　　　　　　"}）</div>}
                  </td>
                  <td style={{ ...small, ...pre }}>{v.difficulty}</td>
                  <td style={small}>
                    {REASON_PURPOSES.map((p) => (
                      <div key={p}>{box(v.purposes.includes(p))} {p}</div>
                    ))}
                    <div>{box(!!v.purpose_other)} その他（{v.purpose_other || "　　　　　　"}）</div>
                    {v.policy && <div style={{ ...pre, marginTop: "1mm", borderTop: "1px dotted #000", paddingTop: "0.8mm" }}>{v.policy}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <table style={{ borderCollapse: "collapse", flex: 1, fontSize: "8pt" }}>
          <thead><tr><th style={{ ...th, fontSize: "8pt" }}>④改修項目（改修箇所）</th></tr></thead>
          <tbody>
            {REASON_WORK_ITEMS.map((w) => {
              const places = (r.works[String(w.kind)] ?? []).filter(Boolean);
              return (
                <tr key={w.kind}>
                  <td style={small}>
                    <div>{box(places.length > 0)} {w.label}</div>
                    {(places.length > 0 ? places : ["", ""]).map((p, i) => (
                      <div key={i} style={{ paddingLeft: "3mm" }}>（{p || "　　　　　　　"}）</div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: "2mm", fontSize: "8pt", border: B, padding: "1.5mm" }}>
        <div>理由書の作成者が、居宅サービス計画を作成する介護支援専門員と異なる場合の当該介護支援専門員の調整済同意欄</div>
        <div style={{ display: "flex", gap: "8mm", marginTop: "1mm" }}>
          <span>{r.cm_consent_date ? warekiLabel(r.cm_consent_date) : "　　　年　　月　　日"}</span>
          <span>居宅介護支援事業所名　{r.cm_consent_office}</span>
          <span>介護支援専門員氏名　{r.cm_consent_name}　　印</span>
        </div>
        <div style={{ fontSize: "7pt" }}>※本人が手書きしない場合は、記名押印してください。</div>
      </div>
    </Sheet>
  );
}

// ─── 住宅所有者承諾書 (A4 縦) ───────────────────────────────────────────────

export function ConsentSheet({ docs, project, client, addressee }: DocSheetProps) {
  const o = docs.owner;
  const kinds = Array.from(new Set(docs.estimate.groups.map((g) => g.kind))).sort();
  const places = docs.estimate.groups.map((g) => [g.place, g.part].filter(Boolean).join(" ")).filter(Boolean);
  return (
    <Sheet>
      <div style={{ textAlign: "center", fontSize: "16pt", letterSpacing: "0.3em", margin: "8mm 0 10mm" }}>住宅所有者承諾書</div>
      <div style={{ textAlign: "right" }}>{docs.application.apply_date ? warekiLabel(docs.application.apply_date) : "　　年　　月　　日"}</div>
      <div style={{ fontSize: "12pt", margin: "8mm 0" }}>{addressee}　様</div>
      <div style={{ marginLeft: "70mm", lineHeight: 2.4 }}>
        <div>住宅の所有者</div>
        <div>氏　名　{o.is_self ? "" : o.name}<span style={{ float: "right" }}>印</span></div>
        <div>住　所　{o.is_self ? "" : o.address}</div>
        <div>電話番号　{o.is_self ? "" : o.phone}</div>
      </div>
      <div style={{ margin: "12mm 0 6mm", lineHeight: 1.8 }}>
        介護保険居宅介護（介護予防）住宅改修費支給申請に係る下記の住宅改修について、承諾します。
      </div>
      <div style={{ textAlign: "center", margin: "4mm 0" }}>記</div>
      <div style={{ lineHeight: 2 }}>
        <div>1.住宅の所在地　　{docs.estimate.site || client?.address || project.client_address || ""}</div>
        <div>2.住宅改修の内容</div>
        <div style={{ paddingLeft: "8mm" }}>
          {kinds.map((k) => <div key={k}>（{k}）{RENOVATION_KINDS.find((x) => x.no === k)?.label}</div>)}
          {places.length > 0 && <div style={{ marginTop: "1mm" }}>改修箇所：{places.join("、")}</div>}
        </div>
        <div style={{ marginTop: "4mm" }}>3.被保険者　　{client?.name ?? project.client_name}　（所有者との関係：{o.relation}）</div>
      </div>
    </Sheet>
  );
}

// ─── 領収書・仮領収書 (A4 縦) ───────────────────────────────────────────────

export function ReceiptSheet({ docs, project, client, receiptAmount, provisional }: DocSheetProps & { provisional?: boolean }) {
  const { base, tax } = splitTaxIncluded(receiptAmount);
  const d = toWareki(docs.receipt.date);
  return (
    <Sheet>
      {provisional && (
        <div style={{ display: "flex", gap: "4mm", margin: "6mm 0 6mm", lineHeight: 1.7 }}>
          <div style={{ whiteSpace: "nowrap", fontWeight: "bold" }}>（仮領収書）</div>
          <div>
            介護保険住宅改修申請の際に領収書の原本を要しますので、領収書の原本をお預かりさせていただきます。
            本書面をもって本領収書をお戻しさせていただくまでの領収書とさせていただきますこと、ご了承いただければと存じます。
          </div>
        </div>
      )}
      <div style={{ textAlign: "center", fontSize: "20pt", letterSpacing: "0.6em", margin: provisional ? "4mm 0 8mm" : "16mm 0 10mm" }}>領収書</div>
      <div style={{ fontSize: "14pt", borderBottom: B, width: "110mm", paddingBottom: "1mm" }}>{client?.name ?? project.client_name}　様</div>
      <div style={{ margin: "8mm 0 4mm", display: "flex", alignItems: "baseline", gap: "6mm" }}>
        <span>☆</span>
        <span style={{ fontSize: "20pt", fontWeight: "bold", borderBottom: "2px solid #000", padding: "0 6mm" }}>¥{yenNum(receiptAmount)}－</span>
      </div>
      <div>但　{docs.receipt.note}</div>
      <div style={{ marginTop: "3mm" }}>
        {d ? `${d.era}${d.year}年${d.month}月${d.day}日` : "令和　　年　　月　　日"}　上記正に領収いたしました
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "10mm", gap: "6mm" }}>
        <div style={{ display: "flex", gap: "3mm" }}>
          <div style={{ border: B, width: "22mm", height: "26mm", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8pt" }}>収入<br />印紙</div>
          <table style={{ borderCollapse: "collapse", fontSize: "8.5pt", alignSelf: "flex-start" }}>
            <tbody>
              <tr><td style={cell} colSpan={2}>内訳</td></tr>
              <tr><td style={cell}>10%対象</td><td style={{ ...cell, textAlign: "right" }}>¥{yenNum(base)}</td></tr>
              <tr><td style={cell}>消費税</td><td style={{ ...cell, textAlign: "right" }}>¥{yenNum(tax)}</td></tr>
              {docs.issuer.invoice_number && <tr><td style={cell} colSpan={2}>登録番号 {docs.issuer.invoice_number}</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ width: "85mm" }}>
          <IssuerBlock docs={docs} />
          {docs.issuer.staff_name && <div style={{ marginTop: "2mm" }}>担当　{docs.issuer.staff_name}</div>}
        </div>
      </div>
    </Sheet>
  );
}

// ─── 領収書送付のご案内 (A4 縦) ─────────────────────────────────────────────

export function CoverLetterSheet({ docs, project, client, receiptAmount }: DocSheetProps) {
  const postal = (client as unknown as { postal_code?: string | null } | null)?.postal_code ?? "";
  return (
    <Sheet>
      <div style={{ textAlign: "right" }}>{docs.receipt.date ? warekiLabel(docs.receipt.date) : "令和　　年　　月　　日"}</div>
      <div style={{ marginTop: "4mm", lineHeight: 1.6 }}>
        <div>〒{postal}</div>
        <div>{client?.address ?? project.client_address ?? ""}</div>
        <div style={{ fontSize: "13pt", marginTop: "2mm" }}>{client?.name ?? project.client_name}　様</div>
      </div>
      <div style={{ marginLeft: "100mm", marginTop: "4mm" }}>
        <IssuerBlock docs={docs} />
        {docs.issuer.staff_name && <div>担当：{docs.issuer.staff_name}</div>}
      </div>
      <div style={{ textAlign: "center", fontSize: "16pt", letterSpacing: "0.3em", margin: "12mm 0 10mm" }}>領収書送付のご案内</div>
      <div style={{ lineHeight: 2, padding: "0 6mm" }}>
        <div>拝啓</div>
        <div style={{ textIndent: "1em" }}>平素は格別のご高配を賜り、厚く御礼申し上げます。</div>
        <div style={{ textIndent: "1em" }}>
          この度ご利用いただきました『住宅改修工事』の自己負担分 {yenNum(receiptAmount)} 円の領収書を郵送させていただきます。
          ご査収のほど、よろしくお願い申し上げます。
        </div>
        <div style={{ textIndent: "1em" }}>今後とも変わらぬお引き立てを賜りますよう、よろしくお願い申し上げます。</div>
        <div style={{ textAlign: "right" }}>敬具</div>
        <div style={{ textAlign: "center", marginTop: "8mm" }}>記</div>
        <div style={{ paddingLeft: "20mm" }}>・領収書　1 通</div>
        <div style={{ textAlign: "right" }}>以上</div>
      </div>
    </Sheet>
  );
}

// ─── 写真添付用紙 (A4 横・改修箇所ごとに 1 枚) ──────────────────────────────

function PhotoBox({ label, photo, url }: { label: string; photo: PhotoRef | null; url: string | undefined }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ display: "flex", border: B }}>
        <div style={{ ...th, width: "40%", border: "none", borderRight: B, fontSize: "11pt" }}>{label}</div>
        <div style={{ ...cell, border: "none", flex: 1, textAlign: "center" }}>
          {photo?.taken_date ? warekiLabel(photo.taken_date) : "令和　　年　　月　　日"}
        </div>
      </div>
      <div style={{ border: B, borderTop: "none", height: "128mm", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {photo && url ? (
          // eslint-disable-next-line @next/next/no-img-element -- 署名付き URL の印刷用画像。next/image の最適化を通すと期限切れ URL がキャッシュされる
          <img src={url} alt={label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : photo ? (
          <span style={{ color: "#999", fontSize: "9pt" }}>写真を読み込み中…</span>
        ) : (
          <span style={{ color: "#bbb", fontSize: "9pt" }}>（写真未登録）</span>
        )}
      </div>
    </div>
  );
}

export function PhotoSheet({ docs, project, client, group, photoUrls }: DocSheetProps & { group: EstimateGroup }) {
  const place = [group.place, group.part].filter(Boolean).join("　");
  return (
    <Sheet landscape>
      <div style={{ fontSize: "14pt", letterSpacing: "0.3em", marginBottom: "3mm" }}>写真添付用紙</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5mm 10mm", marginBottom: "4mm", fontSize: "10pt" }}>
        <div>被保険者名　：　<span style={{ fontSize: "11pt" }}>{client?.name ?? project.client_name}</span>　様</div>
        <div>被保険者番号　：　{client?.insured_number ?? ""}</div>
        <div>施工業者名　：　{docs.issuer.company_name}</div>
        <div>対象工事種別　：　{photoWorkLabel(group.kind)}</div>
        <div>工事箇所　 　：　{place}{group.photo_no ? `（写真 ${group.photo_no}）` : ""}</div>
      </div>
      <div style={{ display: "flex", gap: "4mm" }}>
        <PhotoBox label="工事前" photo={group.photos.before} url={group.photos.before ? photoUrls?.[group.photos.before.path] : undefined} />
        <PhotoBox label="工事後" photo={group.photos.after} url={group.photos.after ? photoUrls?.[group.photos.after.path] : undefined} />
      </div>
    </Sheet>
  );
}
