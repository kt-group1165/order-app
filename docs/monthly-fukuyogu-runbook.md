# 福祉用具 (ケアサポ) 毎月の運用手順書

最終更新: 2026-11-13。対象: 介護ショップ ケア・サポート千葉 (事業所番号 1272400050)。
提供月を **M** (例 2026-11) と書く。コマンドはすべて `apps/order-app` で実行する。

> ★ ここに書いた script 名・オプションは 2026-11-13 に grep で実在を確認したものだけ。
> ★ `--execute` (DB 書込み) は **必ず DRY RUN を読んでから、user の承認を得て** 回す。取消は各 script の `--revert <batch_id>`。

---

## 0. 全体の流れ

```
(月中)   提供票 M を出す → 貸与を組み直す (--as-of 今日)        … 月途中の予定の写し。売上帳票などの見込み用
(M+1 月 上旬)
  1. ほのぼのから M の材料を出す (下の表) → Box 経由で手元に置く
  2. 取込 (提供票 → 利用者・認定・負担割合証 → 公費 → 月次情報)
  3. npm run check:month-ready -- --month M --refresh   ← ✓ になるまで 2 に戻る
  4. 伝送を作る (order-app 請求画面)
  5. 伝送後の突合: ほのぼのの KK と比べる
```

---

## 1. ほのぼの (ケアサポ㉘) から出すもの

接続: Chrome リモートデスクトップ「ケアサポ㉘ ほのぼの 共有」(ほのぼの NEXT は Citrix 内)。
Claude が操作するときは Claude in Chrome (user の通常プロファイル) を使う。

| 何を | 中身 | メニュー | ファイル | 置き場所 (`apps/kaigo-app/伝送データ/ケアサポ/福祉用具/`) |
|---|---|---|---|---|
| 提供票 | 入力側。日ごとの印 (予定行と実績行)・日割区分・概算単位数 | 請求 → CSV → 提供票 | `KSG0261.CSV` | `用具貸与期間_20261109/提供票_YYYYMM.csv` |
| 明細書明細付 | 請求の出力 (7131 相当・TAIS 入り)。**答え合わせ専用** | 国保請求 → CSV → 明細書明細付 | `KDS0031.CSV` | `YYYYMM/ほのぼのから/KDS0031_明細書明細付_処理R8-MM.CSV` |
| 介護請求 (明細付) | 商品名入りの請求一覧 (用具の特定の手がかり) | 請求 → CSV → 介護請求(明細付) | `KSG0331.CSV` | `YYYYMM/ほのぼのから/KSG0331_介護請求明細付_処理R8-MM.CSV` |
| 月次情報 | CM 指示単位数 (区分支給限度基準内単位数)・担当居宅 | (出し方は未記録。前回取得者に確認して追記すること) | — | `月次情報/月次情報_YYYYMM.csv` |
| 利用者マスタ | 基本情報・介護保険 (保険と認定)・公費・負担割合証等。**利用登録 有 と 無 の両方** | (出し方は未記録。追記すること) | — | `利用者マスタ_YYYYMMDD/` (有) と `利用者マスタ_全件_YYYYMMDD/` (無)。YYYYMMDD = 出力日 |
| 伝送 | ほのぼのが国保連に送った KK | 伝送 | `KK*.CSV` | `YYYYMM/ほのぼのから/KK*.CSV` |

### 出し方の決まり (実測)

- **処理期間は 1 か月だけ** (例 R8/11〜R8/11。緑の矢印で月送り)。複数月にすると集計が返らない。
- 集計は数十秒〜4 分。「応答なし」になっても **押さずに待つ**。
- 出力先欄は **`\Client\C$\Users\K019\Documents`** に書き換えて出す (C:\ 直下は書込失敗・フォルダボタンは使えない)。
  - 閉じるとき出力先は **保存しない** (元の出力先に戻す。提供票の元は `C:\Users\ktpc01\Desktop`)。
  - 既存ファイルの上書き確認は「はい」。
- 手元への移し方: リモートの検索に `explorer` → ドキュメント → 出したファイルをコピー →
  サイドバー「本部情報共有用」(Box\ケアサポ(共有)\本部情報共有用) に貼り付け →
  手元 `C:\Users\domen-PC\Box\事業所共有\03_KT\ケアサポ(共有)\本部情報共有用` に約 1 分で同期 → 上の表の置き場所へ名前を変えて置く。
- **月途中の提供票は「予定の写し」**: 実績行も月末まで印が入っている。終了・休止は確定していない。
  確定版は **M の月末を過ぎてから** 出す。

---

## 2. 取込の順番とコマンド

### 2-1. 提供票 → 貸与 (order_items) の組み直し

```bash
# DRY RUN (既定)。用具の引き当て・連結・DB との置き換え・答え合わせ (KDS) を出す
node migrations/rebuild_rentals_from_teikyohyo.mjs --disambiguate-by-billing --skip-users 14400
```

- **月の途中の M を入れるとき**: `--as-of <今日 YYYY-MM-DD>` を付ける。
  - as-of 当日以降の終了予定は継続扱い、as-of より後の開始予定は入れない、as-of より後の休止は書かない。
  - ★ `--as-of` と `--remove-db-only` は併用できない (起動時にエラーで止まる)。
- **M の確定版を入れたら**: `--as-of` を **付けずに** 回し直す (継続扱いにした終了予定がここで終わる)。
- `--skip-users 14400`: 風戸 芳子 (自費 2 台が別コードで既存 → 二重防止)。
- `--disambiguate-by-billing`: 略称が同じで TAIS が複数ある用具を、KDS の TAIS で決める (user 承認済みの例外)。
  KDS がまだ無い月は、前月から月またぎで続く台に限り前月の TAIS を引き継ぐ。
- 提供票に居て DB に居ない利用者がいたら先に:
  `node migrations/create_missing_clients_from_teikyohyo.mjs` (DRY RUN。`--simulate` で作った後の組み直しも模擬)。
- 休止 (月の中で印が切れる日) は `node migrations/seed_order_item_pauses_from_teikyohyo.mjs` (表 order_item_pauses。DRY RUN 既定)。

### 2-2. 利用者・認定・公費 (ほのぼのに合わせる)

```bash
node migrations/sync_fukuyogu_from_honobono.mjs --step=insurance   # 認定 (DRY RUN)
node migrations/sync_fukuyogu_from_honobono.mjs --step=kohi        # 公費 (生保の介護券は月 1 行)
```

- 主なオプション: `--csv <KDS0031>` / `--month YYYY-MM` / `--user-master-dir <dir>` / `--as-of` / `--refresh` (DB を読み直す)。
  user 決定のフラグ一式: `--replace-history --with-assignments --terminate-absent-rentals --attach-billed-shared` (script 冒頭の説明を読んでから)。
- 申請中だった認定をマスタの結果に合わせる: `node migrations/fix_caresapo_certs_from_master.mjs` (`--include-shared` / `--with-end-date` は script 冒頭の注意を読む)。
- 負担割合証: `node migrations/import_benefit_certificates_caresapo.mjs` (`--csv` / `--ins-csv` で CSV を指定できる)。
- ★ **既定の置き場所が `利用者マスタ_20261109` 固定の script がある** (2026-11-13 時点):
  `fix_caresapo_certs_from_master.mjs` / `build_caresapo_rows_from_master.mjs` / `import_cm_units_from_getsuji.mjs` (利用者マスタ) /
  `import_benefit_certificates_caresapo.mjs` (`--csv`・`--ins-csv` で上書き可)。新しい出力日のフォルダを使うときは、オプションで指定するか script の既定を直すこと。

### 2-3. 月次情報 → CM 指示単位数 (fukuyogu_cm_units)

```bash
node migrations/import_cm_units_from_getsuji.mjs --mode A --months M   # DRY RUN (案 A = 全員)
```

- ★ 請求は「その月に月次情報 (CM 指示) がある人だけ」出す (ほのぼのと同じ運用。2026-11-11 から)。**全員分を毎月入れないと請求に出ない**。
- 既存の手入力 (取込マーカーの無い行) は上書きしない。上書きするなら `--overwrite-manual`。

---

## 3. 伝送の前の点検

```bash
npm run check:month-ready -- --month M --refresh
```

- ✓ = 揃っている / ✗ = 待つべき (データ待ち・取込漏れ) / ⚠ = 止めないが確認 / － = 参考。最後に「伝送してよい / 待つべき理由」。
- 見るもの: ① 提供票 (月が終わっているか) ② 月次情報の入力人数 ③ 公費 (先月から激減していないか・公費単独 H の欠け)
  ④ 月遅れになる人 (ほのぼの利用者マスタに認定があれば取込漏れ。マスタの出力日が月末より前なら出し直し推奨) ⑤ 負担割合証 ⑥ 日割り表。
- **✗ が消えるまで伝送しない**。2026-11-13 の例: 10 月 = ✓ / 11 月 = ✗ 4 件 (月途中・月次情報 0・公費 90→3 名・更新認定待ち)。
- 金額に効く常設の検査も回す: `npm run check:all` (19 本)。

---

## 4. 伝送を作る

order-app → 請求 → 介護請求 タブ → 月を選んで「CSV出力」(国保連の伝送ファイル。Shift_JIS)。警告 (CM 指示 未入力で除外・公費単独 H なのに公費なし・担当居宅の番号未登録・日割り×入院 など) を読む。

## 5. 伝送後の突合 (ほのぼのの KK と)

```bash
npx tsx scripts/fukuyogu-densou-honobono-diff.mts --kk ../kaigo-app/伝送データ/ケアサポ/福祉用具/YYYYMM/ほのぼのから/KK<…>.CSV --month M --refresh
```

- `--out <json>` で詳細、`--db-cache <json>` で DB の控え、`--benefit-from-csv` / `--pauses-from-notes` / `--no-pauses` は見込みの比較用。
- 貸与の答え合わせ (KDS) は 2-1 の DRY RUN の最後にも出る (「当方だけ」の多くは月遅れ・認定なし・CM 指示 0)。

---

## 6. 落とし穴 (実際に踏んだもの)

- **CRD に `\` と `$` はキーで送れない** (`\` → `]`、Shift が効かない)。手元で `Set-Clipboard -Value '…'` →
  一度別のタブを操作してから CRD のタブに戻る (CRD がクリップボードを同期) → リモートで右クリック → 貼り付け。
- **Claude in Chrome は全セッションで 1 ブラウザしか使えない**。他のセッションと同時に使うと「Tab is not in Claude's tab group」になる。使う前に一報して順番を譲る。
- **ほのぼのの「認定状況 = 申請中」は 更新申請中の印**。その期間も ほのぼのは請求している。当方の 認定済み を申請中に下げない
  (規則: `lib/insurance/certStatus.ts`・検査 `npm run check:cert-status`)。
- **月途中の提供票は予定の写し** (上の 1)。月途中で組んだ貸与は、確定版で `--as-of` 無しで回し直す。
- **ほのぼのは月次情報 (CM 給付管理) にその月の行がある人だけ請求する**。月次情報が未取込だと当方は全員を実績で組んでしまう。
- **公費 (生保の介護券) は月 1 行**。その月の行が無いと公費が付かない (公費単独 H の人は請求画面で警告)。
- **同じ利用者でも、事業所によって認定・負担割合証の行が違う** (事業所別保険)。請求はケアサポの行だけを見る
  (`lib/insurance/office-scope-rules.ts` rowsForOffice)。検査も同じ範囲で数える。
- 提供票・月次情報の **氏名には括弧書き (例 「(奈良)」) が付く** ことがある。照合は利用者番号・被保険者番号で。
- 生年月日・被保番が他事業所と違う人は 介護側へ連絡 (勝手に書き換えない)。
