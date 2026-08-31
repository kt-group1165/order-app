// master_user.ts
// マスターユーザー (= 端末信頼チェックを bypass する特権 account) 判定。
//
// 運用:
//   - Vercel env `MASTER_USER_EMAILS` にカンマ区切りで email を設定
//   - 例: MASTER_USER_EMAILS="domen@kt-group.co.jp,admin@kt-group.co.jp"
//   - そこに含まれる email でログインした場合、trusted_devices チェックを skip して
//     即座に session を発行する (端末承認/失効を無視)
//
// セキュリティ前提:
//   - env は git 管理外、Vercel dashboard 経由でのみ設定
//   - master user は通常の認証 (パスワード/passkey) はパスする必要がある
//   - 端末信頼のみ bypass される (= 不正端末からでも入れる) ので、運用上は
//     開発者本人の email のみ登録する想定

// 2026-08-31 監査での是正:
//   以前は ALWAYS_TRUSTED_EMAILS = ["test@kt-group.co.jp"] をハードコードしており、
//   env ガード無しで本番でも端末承認を bypass できた。ハードコードを廃止し、
//   MASTER_USER_EMAILS (Vercel env) だけを唯一の入口にする。
//   ⚠ test 用アカウントの bypass を続けるなら、Vercel の MASTER_USER_EMAILS に
//     test@kt-group.co.jp を明示的に追加すること (コードに戻さない)。

/** env から master user email list を取得 (lowercase 正規化済) */
export function getMasterUserEmails(): string[] {
  const raw = process.env.MASTER_USER_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** email が master user か判定 (大文字小文字無視) */
export function isMasterUser(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = getMasterUserEmails();
  return list.includes(email.toLowerCase());
}
