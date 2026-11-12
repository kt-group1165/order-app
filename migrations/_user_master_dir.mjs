/**
 * ほのぼの福祉用具の利用者マスタの置き場所を決める (2026-11-13)。
 *
 *   kaigo-app/伝送データ/ケアサポ/福祉用具/
 *     利用者マスタ_YYYYMMDD/        利用登録 = 有 (介護保険_全件_保険と認定.CSV / 負担割合証等_全件.CSV / 公費_全件.CSV / 基本情報_…)
 *     利用者マスタ_全件_YYYYMMDD/   利用登録 = 無 (介護保険_利用登録無_全件_保険と認定.CSV / …)
 *
 * 既定 = それぞれ YYYYMMDD が最新のフォルダ (固定の日付は使わない)。選んだフォルダ名はログに出す。
 * 上書き: --user-master-dir <dir> (有) / --user-master-dir-off <dir> (無)。
 *
 *   const um = resolveUserMasterDirs(FUKUYOGU, argv);
 *   um.on / um.off      … フォルダの絶対パス (無ければ null)
 *   um.onDate / um.offDate … YYYYMMDD (指定した dir の名前から取れなければ null)
 *   um.file(dir, prefix) … dir の中で prefix で始まる .csv (例 "介護保険_") のパス (無ければ null)
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const optOf = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };

/** base の中で re に当たるフォルダのうち 日付 (1 番目のキャプチャ) が最新のもの */
function latestDir(base, re) {
  if (!existsSync(base)) return null;
  const hits = readdirSync(base).map((d) => ({ d, m: re.exec(d) })).filter((x) => x.m).sort((a, b) => a.m[1].localeCompare(b.m[1]));
  return hits.length ? join(base, hits[hits.length - 1].d) : null;
}
const dateOf = (dir) => (dir ? /(\d{8})$/.exec(basename(dir))?.[1] ?? null : null);

export function resolveUserMasterDirs(base, argv = [], { log = true } = {}) {
  const onArg = optOf(argv, "--user-master-dir");
  const offArg = optOf(argv, "--user-master-dir-off");
  const on = onArg ? resolve(onArg) : latestDir(base, /^利用者マスタ_(\d{8})$/);
  const off = offArg ? resolve(offArg) : latestDir(base, /^利用者マスタ_全件_(\d{8})$/);
  const r = {
    on, off, onDate: dateOf(on), offDate: dateOf(off),
    file: (dir, prefix) => {
      if (!dir || !existsSync(dir)) return null;
      const f = readdirSync(dir).find((x) => x.startsWith(prefix) && /\.csv$/i.test(x));
      return f ? join(dir, f) : null;
    },
  };
  if (log) {
    console.log(`利用者マスタ: 登録有 = ${on ? basename(on) : "★ 無い"}${onArg ? " (--user-master-dir)" : " (最新を自動で選んだ)"}`
      + ` / 登録無 = ${off ? basename(off) : "★ 無い"}${offArg ? " (--user-master-dir-off)" : " (最新を自動で選んだ)"}`);
    if (r.onDate && r.offDate && r.onDate !== r.offDate) console.log(`  ⚠ 登録有 (${r.onDate}) と 登録無 (${r.offDate}) の出力日が違う`);
  }
  return r;
}
