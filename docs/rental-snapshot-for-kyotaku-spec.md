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
- ほのぼの福祉用具は 全件 ケアサポの番号 (1272400050) で請求している。order-app で 誉田の注文を 誉田の事業所 (1270502097) で伝送すると、ほのぼのと請求の番号が変わる。★ **今後どちらの番号で請求するかは決まっていない (要 user 判断)**
- → 居宅に渡すときは 両方を持たせる: 「貸した事業所」(orders.office_id) と「請求の事業所番号」(その月に その事業所の貸与を伝送する番号)。後者は いま order-app に列が無いので、決まるまでは 事業所ごとの設定 (例 offices に 請求用の番号) か、伝送の実績から取る必要がある

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
| その月の単位数 (order-app で計算した値) と 計算の内訳 (全額 / 半額 / 日割り / 上書き) | 日割り・上書きは規則 B の外。kaigo-app が計算し直すと食い違う。★ 月ごとの値を渡すのが安全 (「1 か月あたり単位数」だけだと 半額の月を kaigo-app が再計算することになる) |
| 実際に貸した事業所 と 請求の事業所番号 (① の ★) | 利用票の サービス事業者欄に どちらを書くか |
| 種目 (equipment_master.category) | サービスコードを決める材料 (fukuyoguServiceCode) |
| 単位数の元の月額 (円) と その出どころ (事業所の価格 / 共通 / マスタ) | 価格を事業所ごとに持つようにしたので、どの価格で計算したかを残す |
| snapshot の時刻 | ④ |

利用者の鍵: order-app と kaigo-app は `clients` を共有しているので `client_id` でよい (同じ人が 2 client に分かれていないかは別途。今日 001220 の二重登録を 5 組見つけた)。

---

## ④ 「いつの時点の貸与で利用票を作ったか」の残し方

- payroll の snapshot pull と同じ型 (取込ボタン + 取込時刻) で足りる。ただし次を足す:
  - 取込ごとに 1 件の「取込」(取込時刻・対象月・事業所・取り込んだ明細数・取り込んだ人)。利用票は どの取込から作ったかを持つ
  - 明細ごとに order-app 側の `order_items.updated_at` (と 休止・上書きの最終更新) を一緒に写す → ⑤ で「取込のあとに用具側が直したか」を判定できる
- ⚠ `order_items.updated_at` は 休止 (`order_item_pauses`)・日割り (`order_item_proration`)・上書き (`billing_unit_overrides`)・価格の改定 (`equipment_price_history`) の変更では 動かない (別の表)。「用具側が直したか」は これらの表の更新時刻も見ないと漏れる

---

## ⑤ 食い違いが出たとき

- 利用票を確定したあとに order-app 側が貸与を直した場合 (開始日・終了日・休止・数量・価格・上書き):
  - kaigo-app は 黙って取り直さない (確定した利用票の金額が変わるため)
  - 「取込後に用具側で変わった明細」を検出する: 取込時に写した値 と 今の order-app の値 を 明細 (order_item_id) ごとに比べる
  - 見せ方 (memory `feedback_show_mismatch_duplicated_fields`): 食い違う欄を色分け・両方の値を並べる・「用具側に合わせる」ボタン (利用票を直す) ・件数を数える検査 (check:*) で 0 でなくなったら落ちる
  - 居宅への知らせ方は 未確定。候補: 利用票の画面に件数のバッジ / 月次の検査の出力 / 用具側で直した人が 居宅に知らせる運用。★ どれにするかは user 判断
- 逆向き (居宅が利用票を直した) は 用具側には返さない (正は order-app)

---

## 未確認・決まっていないこと

1. 請求の事業所番号を 実際に貸した事業所にするか、今のほのぼのと同じく ケアサポに寄せるか (① の ★)
2. 入院を snapshot に入れるか、その場で読むか (② の注意 1)
3. 特価 (`order_items.tokka_group` / `tokka_bill_product_code` = セットの親の TAIS で束ねて請求) は BillingTab の請求計算では使われていない (grep で 0 件)。束ねて請求する運用が今あるかは 未確認
4. 知らせ方 (⑤)
