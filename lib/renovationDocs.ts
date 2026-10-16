// 住宅改修の書類 (見積書・理由書・承諾書・支給申請書・領収書・送付状) の入力データと計算。
// 旧 Excel「<利用者>様住改見積.xlsx」(見積書 / 承諾書 / 理由書１・２ / 受注票 / 仮）領収書 / 領収書 / 住改送付状)
// の置換。請求 (保険給付の請求) はシステム外でやる (2026-10-15 user 回答) ので、ここは書類の印字だけを扱う。
//
// 保存先: renovation_projects.documents (jsonb)。案件 1 件 = 1 セットの書類。
// 金額の計算は純関数にして scripts/renovation-estimate-verify.mts で検証する (rule ⑪)。

// ─── 型 ──────────────────────────────────────────────────────────────────────

/** 住宅改修の種類 (見積書 ※1 / 理由書 P2 ④ の 6 区分) */
export const RENOVATION_KINDS = [
  { no: 1, label: "手すりの取付け" },
  { no: 2, label: "段差の解消" },
  { no: 3, label: "滑りの防止及び移動の円滑化等のための床又は通路面の材料の変更" },
  { no: 4, label: "引き戸等への扉の取替え" },
  { no: 5, label: "洋式便器等への便器の取替え" },
  { no: 6, label: "その他住宅改修に付帯して必要となる改修" },
] as const;
export type RenovationKindNo = (typeof RENOVATION_KINDS)[number]["no"];

/** 理由書 P2 ④ の改修項目 (表示名は理由書の様式どおり) */
export const REASON_WORK_ITEMS: { kind: RenovationKindNo; label: string }[] = [
  { kind: 1, label: "手すりの取付け" },
  { kind: 2, label: "段差の解消" },
  { kind: 4, label: "引き戸等への扉の取替え" },
  { kind: 5, label: "便器の取替え" },
  { kind: 3, label: "滑り防止等のための床材の変更" },
  { kind: 6, label: "その他" },
];

export type EstimateLine = {
  /** 名称 (材料費・施工費・諸経費等を分けて書く) */
  name: string;
  /** 商品名・規格・寸法等 */
  spec: string;
  qty: number | null;
  unit: string;
  unit_price: number | null;
  /** 算出根拠 */
  basis: string;
};

/** 写真添付用紙の写真 1 枚 (Storage の renovation-photos バケット内のパス) */
export type PhotoRef = {
  path: string;
  /** 撮影日 (写真添付用紙の日付欄) */
  taken_date: string | null;
};

/** 見積書の 1 ブロック = 1 改修箇所 (末尾に小計が付く)。写真添付用紙も改修箇所ごとに 1 枚 */
export type EstimateGroup = {
  kind: RenovationKindNo;
  /** 写真等番号 (①②…) */
  photo_no: string;
  /** 改修場所 (廊下・玄関・トイレ…) */
  place: string;
  /** 改修部分 (動線・出入口…) */
  part: string;
  lines: EstimateLine[];
  /** 写真添付用紙の 工事前 / 工事後 */
  photos: { before: PhotoRef | null; after: PhotoRef | null };
};

export type Issuer = {
  company_name: string;
  office_name: string;
  postal_code: string;
  address: string;
  tel: string;
  fax: string;
  /** 適格請求書発行事業者の登録番号 (T + 13 桁) */
  invoice_number: string;
  /** 担当者 */
  staff_name: string;
  /** 代表者氏名 (受領委任届・委任状の受任者欄) */
  representative: string;
  /** 受領委任払いの振込先 (受任者 = 自社の口座)。茂原市の受領委任届に印字する */
  bank_name: string;
  bank_branch: string;
  /** 普通 / 当座 / その他 */
  bank_type: string;
  bank_number: string;
  bank_holder_kana: string;
  bank_holder: string;
};

export const REASON_TOOLS = [
  "車いす", "特殊寝台", "床ずれ防止用具", "体位変換器", "手すり", "スロープ", "歩行器",
  "歩行補助つえ", "認知症老人徘徊感知機器", "移動用リフト", "腰掛便座", "特殊尿器",
  "入浴補助用具", "簡易浴槽",
] as const;

/** 理由書 P2 の活動ごとの生活動作 (様式の並び順どおり。「その他」は自由記入) */
export const REASON_ACTIVITIES = [
  {
    key: "excretion", label: "排泄",
    actions: ["トイレまでの移動", "トイレ出入口の出入（扉の開閉を含む）", "便器からの立ち座り（移乗を含む）", "衣服の着脱", "排泄時の姿勢保持", "後始末"],
  },
  {
    key: "bathing", label: "入浴",
    actions: ["浴室までの移動", "衣服の着脱", "浴室出入口の出入（扉の開閉を含む）", "浴室内での移動（立ち座りを含む）", "洗い場での姿勢保持（洗体・洗髪を含む）", "浴槽の出入（立ち座りを含む）", "浴槽内での姿勢保持"],
  },
  {
    key: "going_out", label: "外出",
    actions: ["出入口までの屋内移動", "上がりかまちの昇降", "車いす等、装具の着脱", "履物の着脱", "出入口の出入（扉の開閉を含む）", "出入口から敷地外までの屋外移動"],
  },
  { key: "other", label: "その他の活動", actions: [] as string[] },
] as const;
export type ReasonActivityKey = (typeof REASON_ACTIVITIES)[number]["key"];

export const REASON_PURPOSES = [
  "できなかったことをできるようにする",
  "転倒等の防止、安全の確保",
  "動作の容易性の確保",
  "利用者の精神的負担や不安の軽減",
  "介護者の負担の軽減",
] as const;

export type ReasonActivity = {
  /** チェックした生活動作 (REASON_ACTIVITIES[].actions の文字列) */
  actions: string[];
  /** 生活動作「その他」の記入 (その他の活動はここに書く) */
  action_other: string;
  /** ② 具体的な困難な状況 */
  difficulty: string;
  /** ③ チェックした改修目的 (REASON_PURPOSES の文字列) */
  purposes: string[];
  purpose_other: string;
  /** ③ 改修の方針 */
  policy: string;
};

export type RenovationDocs = {
  version: 1;
  issuer: Issuer;
  estimate: {
    issue_date: string | null;
    title: string;
    site: string;
    payment_terms: string;
    validity: string;
    start_date: string | null;
    /** 諸経費率 (工事費用計に掛ける。0.1 = 10%) */
    overhead_rate: number;
    tax_rate: number;
    groups: EstimateGroup[];
  };
  owner: {
    /** 住宅の所有者が本人 */
    is_self: boolean;
    name: string;
    relation: string;
    address: string;
    phone: string;
  };
  reason: {
    site_visit_date: string | null;
    created_date: string | null;
    creator_office: string;
    /** 資格 (作成者が介護支援専門員でないとき) */
    creator_qualification: string;
    creator_name: string;
    creator_phone: string;
    body_status: string;
    care_status: string;
    goal: string;
    /** 福祉用具の利用状況 (改修前 / 改修後) */
    tools: Record<string, { before: boolean; after: boolean }>;
    /** その他の福祉用具 (自由記入 3 行) */
    tools_other: { name: string; before: boolean; after: boolean }[];
    activities: Record<ReasonActivityKey, ReasonActivity>;
    /** ④ 改修項目ごとの改修箇所 (最大 6 行) */
    works: Record<string, string[]>;
    /** ケアマネの調整済同意 (理由書の作成者がケアプランの CM と異なるとき) */
    cm_consent_office: string;
    cm_consent_name: string;
    cm_consent_date: string | null;
  };
  application: {
    /** 事前申請 (着工前) / 事後申請 (完成後)。千葉市以外は同じ用紙を両方で使い、事前は日付・費用欄を空けて出す */
    phase: "pre" | "post";
    /** 償還払い / 受領委任払い (受領委任は委任文と受任者欄が付く) */
    payment: "shoukan" | "juryo";
    /** 着工日・完成日 (事後申請の実績。事前申請の着工予定日は estimate.start_date) */
    started_date: string | null;
    completed_date: string | null;
    /** 改修予定費用から変わった理由 (袖ケ浦市の様式のみ) */
    change_reason: string;
    /** 以前の住宅改修の履歴 (種類・時期・費用等。市原市の事前協議願) */
    previous_history: string;
    apply_date: string | null;
    /** 宛先 (「市原市長」「千葉市中央区長」等)。空なら住所から自動 */
    addressee: string;
    /** 提出代行者として事業所を印字する */
    proxy: boolean;
  };
  receipt: {
    /** 領収額。null = 見込額 (estimateCopay) を使う */
    amount: number | null;
    date: string | null;
    /** 但し書き */
    note: string;
  };
};

// ─── 既定値 ──────────────────────────────────────────────────────────────────

export function emptyLine(): EstimateLine {
  return { name: "", spec: "", qty: null, unit: "", unit_price: null, basis: "" };
}

export function emptyGroup(kind: RenovationKindNo = 1, photoNo = ""): EstimateGroup {
  return { kind, photo_no: photoNo, place: "", part: "", lines: [emptyLine()], photos: { before: null, after: null } };
}

function emptyActivity(): ReasonActivity {
  return { actions: [], action_other: "", difficulty: "", purposes: [], purpose_other: "", policy: "" };
}

export function emptyIssuer(): Issuer {
  return {
    company_name: "", office_name: "", postal_code: "", address: "", tel: "", fax: "", invoice_number: "", staff_name: "",
    representative: "", bank_name: "", bank_branch: "", bank_type: "普通", bank_number: "", bank_holder_kana: "", bank_holder: "",
  };
}

export function defaultDocs(init: { clientAddress?: string | null; issuer?: Partial<Issuer> } = {}): RenovationDocs {
  return {
    version: 1,
    issuer: { ...emptyIssuer(), ...init.issuer },
    estimate: {
      issue_date: null,
      title: "住宅改修工事",
      site: init.clientAddress ?? "",
      payment_terms: "完成後現金",
      validity: "次回御見積まで",
      start_date: null,
      overhead_rate: 0.1,
      tax_rate: 0.1,
      groups: [emptyGroup(1, "①")],
    },
    owner: { is_self: true, name: "", relation: "", address: "", phone: "" },
    reason: {
      site_visit_date: null,
      created_date: null,
      creator_office: "",
      creator_qualification: "",
      creator_name: "",
      creator_phone: "",
      body_status: "",
      care_status: "",
      goal: "",
      tools: {},
      tools_other: [
        { name: "", before: false, after: false },
        { name: "", before: false, after: false },
        { name: "", before: false, after: false },
      ],
      activities: { excretion: emptyActivity(), bathing: emptyActivity(), going_out: emptyActivity(), other: emptyActivity() },
      works: {},
      cm_consent_office: "",
      cm_consent_name: "",
      cm_consent_date: null,
    },
    application: { phase: "pre", payment: "juryo", started_date: null, completed_date: null, change_reason: "", previous_history: "", apply_date: null, addressee: "", proxy: true },
    receipt: { amount: null, date: null, note: "住宅改修工事代金として" },
  };
}

/** DB から読んだ jsonb を既定値で補完する (列追加前の案件・古い版のデータでも落ちないように) */
export function normalizeDocs(raw: unknown, init: Parameters<typeof defaultDocs>[0] = {}): RenovationDocs {
  const base = defaultDocs(init);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<RenovationDocs>;
  return {
    version: 1,
    issuer: { ...base.issuer, ...(r.issuer ?? {}) },
    estimate: {
      ...base.estimate,
      ...(r.estimate ?? {}),
      groups: Array.isArray(r.estimate?.groups) && r.estimate.groups.length > 0
        ? r.estimate.groups.map((g) => ({
          ...emptyGroup(),
          ...g,
          lines: Array.isArray(g.lines) ? g.lines.map((l) => ({ ...emptyLine(), ...l })) : [emptyLine()],
          photos: { before: g.photos?.before ?? null, after: g.photos?.after ?? null },
        }))
        : base.estimate.groups,
    },
    owner: { ...base.owner, ...(r.owner ?? {}) },
    reason: {
      ...base.reason,
      ...(r.reason ?? {}),
      tools: { ...(r.reason?.tools ?? {}) },
      tools_other: Array.isArray(r.reason?.tools_other) && r.reason.tools_other.length > 0 ? r.reason.tools_other : base.reason.tools_other,
      activities: {
        excretion: { ...emptyActivity(), ...(r.reason?.activities?.excretion ?? {}) },
        bathing: { ...emptyActivity(), ...(r.reason?.activities?.bathing ?? {}) },
        going_out: { ...emptyActivity(), ...(r.reason?.activities?.going_out ?? {}) },
        other: { ...emptyActivity(), ...(r.reason?.activities?.other ?? {}) },
      },
      works: { ...(r.reason?.works ?? {}) },
    },
    application: { ...base.application, ...(r.application ?? {}) },
    receipt: { ...base.receipt, ...(r.receipt ?? {}) },
  };
}

// ─── 見積の計算 ──────────────────────────────────────────────────────────────

export type EstimateTotals = {
  /** 行ごとの金額 (切り捨て)。数量・単価のどちらかが空なら null */
  lineAmounts: (number | null)[][];
  groupSubtotals: number[];
  /** 工事費用計 = 小計の合計 */
  workTotal: number;
  /** 諸経費 = floor(工事費用計 × 諸経費率) */
  overhead: number;
  /** 合計 = 工事費用計 + 諸経費 */
  subtotal: number;
  /** 消費税 = floor(合計 × 税率) */
  tax: number;
  /** 総合計 (税込) */
  grandTotal: number;
};

/**
 * 見積の金額。旧 Excel の式を移した:
 *   金額 = ROUNDDOWN(数量 × 単価, 0) / 小計 = SUM / 工事費用計 = 小計の合計
 *   諸経費 = 工事費用計 × 10% / 合計 = 工事費用計 + 諸経費 / 総合計 = 合計 + 消費税
 * ⚠ 旧 Excel は消費税が手入力だった (横山様 2026-07: 36,652 円に対し 3,653 円 = 正しくは 3,665 円)。
 *   ここでは floor(合計 × 税率) で計算する。諸経費も 1 円未満は切り捨てる。
 */
export function computeEstimate(est: Pick<RenovationDocs["estimate"], "groups" | "overhead_rate" | "tax_rate">): EstimateTotals {
  const lineAmounts = est.groups.map((g) =>
    g.lines.map((l) => (l.qty === null || l.unit_price === null ? null : Math.floor(round6(l.qty * l.unit_price)))),
  );
  const groupSubtotals = lineAmounts.map((ls) => ls.reduce<number>((s, v) => s + (v ?? 0), 0));
  const workTotal = groupSubtotals.reduce((s, v) => s + v, 0);
  const overhead = Math.floor(round6(workTotal * est.overhead_rate));
  const subtotal = workTotal + overhead;
  const tax = Math.floor(round6(subtotal * est.tax_rate));
  return { lineAmounts, groupSubtotals, workTotal, overhead, subtotal, tax, grandTotal: subtotal + tax };
}

/** 0.9 × 4400 = 3960.0000000000005 のような浮動小数の誤差で floor が 1 ずれるのを防ぐ */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** 住宅改修費の支給限度基準額 (税込 20 万円) */
export const RENOVATION_LIMIT = 200_000;

/**
 * 自己負担額の見込み (領収書の既定値)。
 *   保険給付 = floor(min(総合計, 20万円) × 給付率) / 自己負担 = 総合計 − 保険給付
 *   自費・負担割合不明は総合計の全額。
 * ⚠ 端数の扱いは市町村で違うことがあるので、画面では「見込み」として出し、手で直せるようにする。
 *   同じ利用者が過去に住宅改修を使っていると限度額の残りが減るが、それはここでは見ない。
 */
export function estimateCopay(grandTotal: number, copayRate: "1割" | "2割" | "3割" | "自費" | null): number {
  const benefitRate = copayRate === "1割" ? 0.9 : copayRate === "2割" ? 0.8 : copayRate === "3割" ? 0.7 : 0;
  const benefit = Math.floor(round6(Math.min(grandTotal, RENOVATION_LIMIT) * benefitRate));
  return grandTotal - benefit;
}

/** 税込額を 10% 対象額と消費税に分ける (領収書の内訳)。税額 = floor(税込 × 10 / 110) */
export function splitTaxIncluded(amount: number, taxRate = 0.1): { base: number; tax: number } {
  const tax = Math.floor(round6((amount * taxRate) / (1 + taxRate)));
  return { base: amount - tax, tax };
}

// ─── 表示用ユーティリティ ────────────────────────────────────────────────────

const ERAS = [
  { name: "令和", start: "2019-05-01", offset: 2018 },
  { name: "平成", start: "1989-01-08", offset: 1988 },
  { name: "昭和", start: "1926-12-25", offset: 1925 },
  { name: "大正", start: "1912-07-30", offset: 1911 },
  { name: "明治", start: "1868-01-25", offset: 1867 },
] as const;

/** "YYYY-MM-DD" → { era: "令和", year: 8, month: 7, day: 6 }。範囲外・不正は null */
export function toWareki(ymd: string | null | undefined): { era: string; year: number; month: number; day: number } | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return null;
  const d = ymd.slice(0, 10);
  const era = ERAS.find((e) => d >= e.start);
  if (!era) return null;
  const [y, m, dd] = d.split("-").map(Number);
  return { era: era.name, year: y - era.offset, month: m, day: dd };
}

/** "令和8年7月6日"。null は空文字 */
export function warekiLabel(ymd: string | null | undefined): string {
  const w = toWareki(ymd);
  if (!w) return "";
  return `${w.era}${w.year === 1 ? "元" : w.year}年${w.month}月${w.day}日`;
}

/** 満年齢 (基準日時点)。生年月日が無ければ null */
export function ageAt(birth: string | null | undefined, at: string): number | null {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const [by, bm, bd] = birth.slice(0, 10).split("-").map(Number);
  const [ay, am, ad] = at.slice(0, 10).split("-").map(Number);
  return ay - by - (am < bm || (am === bm && ad < bd) ? 1 : 0);
}

/**
 * 住所から市区町村を取り出す。「千葉県」「○○郡」は外す。千葉市は区まで返す。
 *   "千葉県市原市姉崎1-2" → { city: "市原市", ward: null }
 *   "千葉市中央区千葉港1"  → { city: "千葉市", ward: "中央区" }
 *   "長生郡長南町"         → { city: "長南町", ward: null }
 */
export function cityOf(address: string | null | undefined): { city: string; ward: string | null } | null {
  if (!address) return null;
  const a = address.replace(/\s/g, "").replace(/^(千葉県)/, "").replace(/^[^都道府県]{2,3}[都道府県]/, "");
  const m = /^(?:.+?郡)?(.+?[市町村])(.+?区)?/.exec(a);
  if (!m) return null;
  const city = m[1];
  // 千葉県の政令市は千葉市だけ。区は千葉市のときだけ拾う (他市の地名に「区」が入っても拾わない)
  const ward = city === "千葉市" && m[2] && /^[^0-9０-９丁目番地-]{1,4}区$/.test(m[2]) ? m[2] : null;
  return { city, ward };
}

/** 支給申請書・承諾書の宛先。千葉市は区長、ほかは市町村長 */
export function defaultAddressee(address: string | null | undefined): string {
  const c = cityOf(address);
  if (!c) return "";
  if (c.city === "千葉市") return c.ward ? `千葉市${c.ward}長` : "千葉市　　区長";
  return `${c.city}長`;
}

/** 写真添付用紙の「対象工事種別」(旧 Excel の表記: 手すりの取り付け工事（１）) */
export function photoWorkLabel(kind: RenovationKindNo): string {
  const label: Record<RenovationKindNo, string> = {
    1: "手すりの取り付け工事", 2: "段差の解消工事", 3: "床材の変更工事",
    4: "引き戸等への扉の取替え工事", 5: "便器の取替え工事", 6: "付帯工事",
  };
  return `${label[kind]}　（${kind}）`;
}

/** 円表示 (¥ なし・3 桁区切り) */
export function yenNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : Math.round(v).toLocaleString("ja-JP");
}
