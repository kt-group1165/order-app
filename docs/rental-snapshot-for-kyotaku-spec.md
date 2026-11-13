# 自社の福祉用具貸与を 居宅 (kaigo-app) に渡す仕様 — 案 (2026-11-13)

> ★ 仕様だけ。実装はしない (user 合意前)。
> 前提 (2026-11-13 user と ★居宅版チェック の合意): 他社の貸与 (約 4,900 行) は人が入れる。自社 5 事業所の貸与は
> **order-app を正とし、kaigo-app が snapshot pull する** (JOIN で直接見ない。利用票を確定したあとに用具側が直すと、金額が黙って変わるため)。
> 書いた根拠は order-app のコード (2026-11-13 時点の master) と DB の写し (_dump_schema 9/30)。推測で書いたところは「未確認」と書く。

---

## ① order-app が持っている「貸与」の正 (表と列)

| 何 | 表.列 | 中身 |
|---|---|---|
| 貸与 1 台 | `order_items` (1 行 = 1 明細。数量 `quantity` で複数台) | |
| 用具 | `order_items.product_code` → `equipment_master` (`tais_code`・`name`・`category` = 種目) | TAIS は用具マスタ側。明細には持たない |
| 状態 | `order_items.status` | 貸与として数えるのは `rental_started` / `terminated` だけ。`cancelled_at` があれば外す |
| 開始日・終了日 | `order_items.rental_start_date` / `rental_end_date` | 終了日 null = 継続中。日付は両端含む |
| 中止 (休止) 期間 | `order_item_pauses` (`order_item_id`・`pause_from`・`pause_to`・`reason`・`source` = teikyohyo / manual) | 明細ごと。両端含む |
| 入院 | `client_hospitalizations` (`admission_date`・`discharge_date`) | ★ 利用者ごと (全用具)・kaigo-app と共有の表。退院日 null = 月末まで |
| 数量 | `order_items.quantity` (integer・既定 1) | 単位数 = 1 台の単位 × 数量 |
| 支払区分 | `order_items.payment_type` → 無ければ `orders.payment_type` | 介護 / 自費 / 特価自費。★ 明細の値が優先 (発注が介護でも明細が自費のものが 596 台あった) |
| 月額 (円) | ★ **明細には持たない**。`lib/equipment.ts getPriceForMonth` で その月の月初時点の価格を引く: その事業所の価格履歴 (`equipment_price_history.office_id`・SQL 未適用) → 共通の価格履歴 → `equipment_master.rental_price` | `order_items.rental_price` は請求の計算に使われていない (帳票の表示用) |
| その月の単位数 | ★ **保存していない。毎回計算する** (`lib/half-month-units.ts rentalMonthUnits`)。例外: `billing_unit_overrides` (`client_id`・`month`・`order_item_id`・`units_override`) があれば その値 (1 台あたり) | 1 か月の単位 = round(月額 ÷ 10) |
| 日割りの指定 | `order_item_proration` (`order_item_id`・`month`・`mode` = 'daily') | 行が無い月 = 半月按分 (既定) |
| 実際に貸した事業所 | `orders.office_id` (注文の事業所) | 下の ★ 事業所番号 を参照 |

→ **「1 か月あたりの単価 (円)」で持ち、「その月の実額 (単位)」は持たない** (請求・伝送・画面のたびに 上の材料から計算する)。
保存されている「その月の単位」は `billing_unit_overrides` の上書きだけ。

### ★ 事業所番号: 「実際に貸した事業所」と「請求の事業所番号」は別
- 実際に貸した事業所 = `orders.office_id` (ケアサポ / 誉田 / 高品 / 花見川 / 茂原 の offices.id)
- 伝送 (国保連) の事業所番号 = **伝送を作るときに画面で選んでいる事業所の `offices.business_number`** (BillingTab `generateTransferData`)。明細や注文には持っていない
- ✅ **決着 (2026-11-13): 請求の事業所番号 = 実際に貸した事業所 (orders.office_id) の番号。**
  根拠 (★居宅版チェック が居宅 15 拠点の給付管理票 KY 8222・提供 202606 を全数集計): 提供事業所番号は ケアサポ 271 行 / 誉田 207 / リンクス 130 / 高品 122 / 花見川 30 (自社 5 事業所で 760 行)。
  居宅は 実際に貸した事業所で給付管理票を出しているので、用具側を全部ケアサポの番号で請求すると 給付管理票と明細書の番号が食い違って返戻になる。
  (「ほのぼの福祉用具は全件ケアサポ番号で請求」は誤り。手元にケアサポのファイルしか無かっただけ)
- → 居宅に渡す事業所は orders.office_id の 1 つでよい (貸した事業所 = 請求の事業所)。今の伝送作成で直すところは ⑥

---

## ② 半月按分の規則

- order-app (請求・伝送・利用請求・帳票すべて `rentalMonthUnits`):
  - その月の「貸与日」= 開始日〜終了日に入り、休止 (`order_item_pauses`) と入院 (`client_hospitalizations`) のどれにも入らない日
  - 1〜15 日 と 16 日〜末日 の **両方に貸与日があれば 全額**、片方だけなら 半額 (round)、どちらも無ければ 0 (= 規則 B)
  - `order_item_proration` で 'daily' の月だけ 日割り (貸与日数 ÷ 月の日数)
- 居宅の利用票 (規則 A・印から判定) を 規則 B に寄せられるか:
  - 寄せられる。規則 B に要る材料 (開始日・終了日・休止期間・入院) は ①のとおり order-app にそろっていて、snapshot に入れれば kaigo-app 側で同じ関数で計算できる
  - ただし注意 2 つ:
    1. 入院は 利用者ごとの共有の表 (`client_hospitalizations`)。kaigo-app から見ても同じ表なので、snapshot に入れるか その場で読むかを決める必要がある (snapshot に入れないと、入院を後から入れたとき 用具の単位が黙って変わる)
    2. 日割りの指定 (`order_item_proration`) と 単位の上書き (`billing_unit_overrides`) は 規則 B の外。これがある明細は「その月の単位」を order-app で計算した値で渡す方が安全 (下の ③)
  - 寄せられない理由は 今のところ見つかっていない。95.6% が規則 A で一致しているのは、多くの月が 全額 (月をまたいで継続) だからで、差が出るのは 月途中の開始・終了・休止のある月

---

## ③ kaigo-app が受け取る形

提案の (利用者, 事業所, サービスコード, TAIS, 商品名, 1 か月あたり単位数, 開始日, 終了日) では **足りない**。足すもの:

| 足すもの | 理由 |
|---|---|
| order_item_id (order-app の明細 id) | 食い違いを 明細単位で突き合わせる鍵。これが無いと ⑤ ができない |
| 数量 | 1 明細で 2 台のことがある |
| 支払区分 (介護 / 自費 / 特価自費) | 利用票に載るのは介護だけ。自費を混ぜない |
| 休止期間の一覧 | 規則 B の計算に要る |
| その月の単位数 (order-app で計算した値) と ★ 計算の内訳 (全額 / 半額 (前半だけ・後半だけ) / 日割り (貸与日数) / 上書き) | 日割り・上書きは規則 B の外。kaigo-app が計算し直すと食い違う。★ 月ごとの値を渡すのが安全。★ 内訳は必須 (無いと居宅で「なぜこの単位数か」を説明できない。2026-11-13 ★居宅版チェック と合意) |
| 貸した事業所 (orders.office_id) と その事業所番号 | 利用票のサービス事業者欄 = 請求の事業所番号 (① の ★ で 同じものに決着) |
| 種目 (equipment_master.category) | サービスコードを決める材料 (fukuyoguServiceCode) |
| 単位数の元の月額 (円) と その出どころ (事業所の価格 / 共通 / マスタ) | 価格を事業所ごとに持つようにしたので、どの価格で計算したかを残す |
| snapshot の時刻 | ④ |

利用者の鍵: order-app と kaigo-app は `clients` を共有しているので `client_id` でよい (同じ人が 2 client に分かれていないかは別途。今日 001220 の二重登録を 5 組見つけた)。

---

## ④ 「いつの時点の貸与で利用票を作ったか」の残し方

- payroll の snapshot pull と同じ型 (取込ボタン + 取込時刻) で足りる。ただし次を足す:
  - 取込ごとに 1 件の「取込」(取込時刻・対象月・事業所・取り込んだ明細数・取り込んだ人)。利用票は どの取込から作ったかを持つ
  - 明細ごとに ③ の値そのもの (日付・休止・数量・支払区分・その月の単位数と内訳・月額とその出どころ) を控える
- ⚠ `order_items.updated_at` は 休止 (`order_item_pauses`)・日割り (`order_item_proration`)・上書き (`billing_unit_overrides`)・価格の改定 (`equipment_price_history`) の変更では 動かない (別の表)。
  → ★ 「用具側が直したか」は 更新時刻に頼らない。**取込時に渡した値 と 今 order-app で計算した値 を 直接比べる** (2026-11-13 ★居宅版チェック の指摘で確定)。
    値を控えておけば、どの表が動いたかを追わなくて済み、新しい表が増えても漏れない

---

## ⑤ 食い違いが出たとき

- 利用票を確定したあとに order-app 側が貸与を直した場合 (開始日・終了日・休止・数量・価格・上書き):
  - kaigo-app は 黙って取り直さない (確定した利用票の金額が変わるため)
  - 「取込後に用具側で変わった明細」を検出する: 取込時に写した値 と 今の order-app の値 を 明細 (order_item_id) ごとに比べる
  - 見せ方 (memory `feedback_show_mismatch_duplicated_fields`): 食い違う欄を色分け・両方の値を並べる・「用具側に合わせる」ボタン (利用票を直す) ・件数を数える検査 (check:*) で 0 でなくなったら落ちる
  - 居宅への知らせ方は 未確定。候補: 利用票の画面に件数のバッジ / 月次の検査の出力 / 用具側で直した人が 居宅に知らせる運用。★ どれにするかは user 判断
- 逆向き (居宅が利用票を直した) は 用具側には返さない (正は order-app)

---

## ⑥ 請求の事業所番号を orders.office_id にするとき、今の伝送作成で直すところ (洗い出しだけ・実装はまだ)

今の作り (BillingTab): 伝送の事業所番号 = 画面で選んでいる事業所 (`currentOfficeId`) の `offices.business_number`。明細は `clientGroups` で選んでいる事業所の注文に絞る。
→ 事業所を選んで伝送すれば、その事業所の注文だけが その事業所の番号で出る (= 既に「貸した事業所の番号」になる)。直すのは 次の穴:

| # | 場所 | 今 | 直すこと |
|---|---|---|---|
| 1 | `clientGroups` (BillingTab 702〜)・月次情報 (237)・売上帳票 (2467・2573) | `if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;` → ★ **orders.office_id が NULL の注文は どの事業所の伝送にも入る** | NULL の注文は 伝送から外して警告 (どの事業所の番号で出すか決まらない)。今の控え (11/13) では orders 1,621 件すべて ケアサポで NULL は 0 件 |
| 2 | 伝送の作成 (`generateTransferData` 1053・再請求 `generateRebillTransferData` 1470・第6表実績 `generateCareplanJissekiCsv` 1314) | 事業所を選んでいない (全事業所) とき テナントの番号 (`tenantInfo.business_number`) で 全事業所の明細を 1 本にまとめて出す | 事業所を選んでいないときは 伝送を作らない (止めて「事業所を選んでください」)。または 事業所ごとに分けて複数ファイルを出す |
| 3 | 遅延フラグ `billing_late_flags` (client_id, month) | 事業所を持たない | 同じ人が同じ月に 2 事業所から借りていると、片方の月遅れがもう片方にも効く。office_id を足すか、明細 (注文) 単位にする |
| 4 | 単位の上書き `billing_unit_overrides` | 明細 (order_item_id) ごと | 変更不要 (明細は 1 つの注文 = 1 つの事業所に属する) |
| 5 | 認定・公費・負担割合証 (insurance_scope) | ケアサポは per_office (認定・公費は office_id = ケアサポの行) | 誉田 等を per_office にするなら その事業所の行が要る (build_caresapo_rows / import_benefit_certificates を --area で回す)。shared のままなら共有の行 |
| 6 | CM 単位数・公費の月途中の扱い (`getCmUnits`・`getKohiMonthModes`) | 既に `currentOfficeId` で事業所ごと | 変更不要 |
| 7 | 事業所の設定 | `offices.business_number` が空なら 伝送を止める (既にある) | 誉田・高品・花見川・茂原 の business_number が入っているかを 伝送の前に確認 |
| 8 | 価格 | `getPriceForMonth` に 注文の事業所を渡す (2e3cc87) | 変更不要 (事業所の価格の行は SQL 適用後) |
| 9 | 検査 | `check:kk-honobono`・`check:fukuyogu-densou` は ケアサポ (1272400050) の KK/KDS だけを期待値にしている | 誉田・高品・花見川・リンクスの KDS0031 を ほのぼのから出してもらい、事業所ごとの期待値を足す (★居宅版チェック 確認: 4 事業所名義の請求は存在する) |

## 未確認・決まっていないこと

1. ~~請求の事業所番号をどちらにするか~~ → 決着: 実際に貸した事業所 (① の ★・⑥)
2. 入院を snapshot に入れるか、その場で読むか (② の注意 1)
3. 特価 (`order_items.tokka_group` / `tokka_bill_product_code` = セットの親の TAIS で束ねて請求) は BillingTab の請求計算では使われていない (grep で 0 件)。束ねて請求する運用が今あるかは 未確認
4. 知らせ方 (⑤)
