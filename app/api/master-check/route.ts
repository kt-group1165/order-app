import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMasterUser } from "@/lib/master_user";

// ログイン中ユーザーが master user (MASTER_USER_EMAILS) かを返す。
// スタッフ管理画面 (出勤簿タブ内) の表示可否判定に使う。
export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    return NextResponse.json({ is_master: false });
  }
  return NextResponse.json({ is_master: isMasterUser(data.user.email) });
}
