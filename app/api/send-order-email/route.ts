import { Resend } from "resend";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    const { to, subject, body } = await req.json();

    if (!to || !to.trim()) {
      return NextResponse.json(
        { error: "送信先メールアドレスが設定されていません" },
        { status: 400 }
      );
    }

    const { error } = await resend.emails.send({
      from: "発注システム <onboarding@resend.dev>",
      to: to.trim(),
      subject,
      text: body,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: "送信エラーが発生しました" }, { status: 500 });
  }
}
