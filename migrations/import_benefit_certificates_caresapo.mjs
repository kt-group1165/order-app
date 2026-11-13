/**
 * ほのぼの福祉用具 (ケアサポ) の「負担割合証等」CSV → client_benefit_certificates (期間ごとの負担割合証)。
 * 2026-11-09 FY-H (user 合意: 負担割合は履歴で持つ)。
 *
 *   node migrations/import_benefit_certificates_caresapo.mjs                         # DRY RUN (既定)
 *   node migrations/import_benefit_certificates_caresapo.mjs --execute
 *   node migrations/import_benefit_certificates_caresapo.mjs --revert <batch_id> [--execute]
 *     [--user-master-dir <dir>] [--csv <負担割合証等.CSV>] [--ins-csv <介護保険.CSV>] [--out <明細.json>]
 *
 * 前提: migrations/client_benefit_certificates.sql (ルート) を適用済み。未適用でも DRY RUN は回る。
 * 事業所: 全行 office_id = ケアサポ (1bfc0d57…) / office_source = 'import_record'
 *   (ケアサポ自身のほのぼの福祉用具のデータの取込。DESIGN_INSURANCE_PER_OFFICE.md §5.3 と同じ考え方。複写ではない)
 * ★ 認定行 (client_insurance_records) / clients は書き換えない。
 * ★ 保険者名 → 番号は 同じ回の 介護保険_全件_保険と認定.CSV で変換 (scripts/_benefit-cert-csv.mts)。
 * 取込エンジン: scripts/_benefit-cert-import.mts (kaigo-app の全社取込と共用)。
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (!process.env.BENEFIT_CERT_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, BENEFIT_CERT_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const { runBenefitCertImport } = await import("../scripts/_benefit-cert-import.mjs");
const { resolveUserMasterDirs } = await import("./_user_master_dir.mjs");
const { resolveFukuyoguOffice, describeFukuyoguOffice } = await import("./_fukuyogu_office.mjs");

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
// 既定 = 利用者マスタ_YYYYMMDD (登録有) のうち日付が最新のフォルダ。--user-master-dir で上書き (--csv / --ins-csv はファイル単位の上書き)
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const UM = resolveUserMasterDirs(FO.dir, argv);
if (!UM.on) throw new Error("★ 利用者マスタ_YYYYMMDD が無い");
const DIR = UM.on;
const DATE = UM.onDate ?? "日付不明";
const CARESAPO_OFFICE_ID = FO.officeId; // 名前は従来のまま (中身は選んだ事業所。既定 ケアサポ)

await runBenefitCertImport({
  label: `${FO.area} (ほのぼの福祉用具 ${DATE.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")})`,
  scriptRel: "apps/order-app/migrations/import_benefit_certificates_caresapo.mjs",
  sourceSystem: "honobono-fukuyogu",
  // 事業所 + 出力日ごと (ケアサポ 20261109 の回は従来と同じ文字列)。戻す・再実行はこのマーカーで行を探すので 事業所を必ず入れる
  marker: `[benefit-cert ${FO.area} ${DATE}]`,
  futanCsv: resolve(opt("--csv") ?? join(DIR, "負担割合証等_全件.CSV")),
  kaigoInsCsvs: [resolve(opt("--ins-csv") ?? join(DIR, "介護保険_全件_保険と認定.CSV"))],
  decideOffices: async (_sb, clientIds) =>
    new Map(clientIds.map((id) => [id, { officeId: CARESAPO_OFFICE_ID, officeSource: "import_record" }])),
  argv,
});
