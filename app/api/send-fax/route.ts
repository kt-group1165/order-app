import { NextRequest, NextResponse } from "next/server";

// eFax REST API を使用してFAX送信
// 環境変数: EFAX_API_KEY, EFAX_ACCOUNT_ID, EFAX_FROM_NUMBER

export async function POST(req: NextRequest) {
  const { toFaxNumber, pdfBase64, subject } = await req.json();

  const apiKey = process.env.EFAX_API_KEY;
  const accountId = process.env.EFAX_ACCOUNT_ID;
  const fromNumber = process.env.EFAX_FROM_NUMBER;

  if (!apiKey || !accountId || !fromNumber) {
    return NextResponse.json(
      { success: false, error: "eFax API設定が不完全です（環境変数を確認してください）" },
      { status: 500 }
    );
  }

  // FAX番号の正規化（ハイフン除去、日本→国際番号変換）
  const normalizedTo = toFaxNumber
    .replace(/-/g, "")
    .replace(/^0/, "81"); // 0XX → 81XX

  try {
    // eFax REST API v1
    const response = await fetch("https://api.efax.com/v1/faxes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: accountId,
        fax_number: fromNumber,
        recipients: [{ fax_number: normalizedTo }],
        subject: subject ?? "貸与報告書",
        content: [
          {
            name: "report.pdf",
            type: "application/pdf",
            data: pdfBase64,
          },
        ],
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: result.message ?? "FAX送信に失敗しました" },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true, messageId: result.id });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
