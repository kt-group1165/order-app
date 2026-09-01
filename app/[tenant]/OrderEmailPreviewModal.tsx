"use client";
import { useState } from "react";
import { X, Loader2, Send, CheckCircle2, AlertCircle, Printer } from "lucide-react";
import { Order, OrderItem, Equipment, Client, Supplier, Member } from "@/lib/supabase";
import { todayYmd } from "@/lib/date-jst";
import { saveClientDocument } from "@/lib/documents";
import { recordEmailSent } from "@/lib/orders";

// ─── Order Email Preview Modal ───────────────────────────────────────────────

/** 発注内容を構造化（確認画面・メール共用） */
function buildStatusChangeContent(
  emailType: "rental_started" | "terminated" | "cancelled",
  order: Order,
  orderItems: OrderItem[],
  client: Client | undefined,
  equipment: Equipment[],
  isResend: boolean,
  returnDate?: string,
  returnMethod?: string,
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = client?.address ?? "（未設定）";
  const changedItem = orderItems.find((i) => i.status === emailType);
  const targetItems = emailType === "rental_started"
    ? orderItems.filter((i) => i.status !== "cancelled")
    : orderItems.filter((i) => i.status === emailType);
  const itemLines = targetItems.map((i, idx) => {
    const eq = equipment.find((e) => e.product_code === i.product_code);
    return `${idx + 1}. ${eq?.name ?? i.product_code}`;
  });
  const resendMark = isResend ? "（再送）" : "";

  if (emailType === "rental_started") {
    const startDate = changedItem?.rental_start_date ?? null;
    const startDateStr = startDate
      ? new Date(startDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const subject = `【レンタル開始${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 品目 ──", ...itemLines, "", `レンタル開始日：${startDateStr}`].join("\n");
    const emailBody = [
      `【レンタル開始${resendMark}】`, "", "お疲れ様です。",
      "下記の通り、福祉用具のレンタルが開始となりましたのでご連絡いたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 対象品目", ...itemLines.map((l) => `  ${l}`), "",
      `レンタル開始日：${startDateStr}`,
      "────────────────────", "", "よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  } else if (emailType === "terminated") {
    const endDate = returnDate || changedItem?.rental_end_date || null;
    const endDateStr = endDate
      ? new Date(endDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const methodStr = returnMethod || "未定";
    const subject = `【解約・返却${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 返却品目 ──", ...itemLines, "", `解約日：${endDateStr}`, `返却方法：${methodStr}`].join("\n");
    const emailBody = [
      `【解約・返却${resendMark}】`, "", "お疲れ様です。",
      "下記の福祉用具につきまして、解約・返却のご連絡をいたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 返却品目", ...itemLines.map((l) => `  ${l}`), "",
      `解約日　：${endDateStr}`,
      `返却方法：${methodStr}`,
      "────────────────────", "", "お引き取りのほど、よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  } else {
    // cancelled
    const cancelDateStr = returnDate
      ? new Date(returnDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const methodStr = returnMethod || "未定";
    const subject = `【キャンセル・返却${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 返却品目 ──", ...itemLines, "", `返却日：${cancelDateStr}`, `返却方法：${methodStr}`].join("\n");
    const emailBody = [
      `【キャンセル・返却${resendMark}】`, "", "お疲れ様です。",
      "下記の福祉用具につきまして、キャンセル・返却のご連絡をいたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 返却品目", ...itemLines.map((l) => `  ${l}`), "",
      `返却日　：${cancelDateStr}`,
      `返却方法：${methodStr}`,
      "────────────────────", "", "お引き取りのほど、よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  }
}

function buildOrderContent(
  order: Order,
  orderItems: OrderItem[],
  client: Client | undefined,
  equipment: Equipment[],
  members: Member[],
  isResend: boolean,
  suppliers?: Supplier[]
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = order.delivery_address ?? client?.address ?? "（未設定）";
  const activeItems = orderItems.filter((i) => i.status !== "cancelled");
  const itemLines = activeItems.map((i, idx) => {
    const eq = equipment.find((e) => e.product_code === i.product_code);
    const name = eq?.name ?? i.product_code;
    const price = i.rental_price ? `¥${i.rental_price.toLocaleString()}/月` : "";
    const pt = i.payment_type ?? order.payment_type;
    return `${idx + 1}. ${name}${price ? `　${price}` : ""}　[${pt}]`;
  });

  const deliveryDateStr = order.delivery_date
    ? new Date(order.delivery_date).toLocaleDateString("ja-JP", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
      })
    : "未設定";
  const deliveryTimeStr = order.delivery_time ?? "未設定";
  const attendeeNames =
    order.attendee_ids.length > 0
      ? order.attendee_ids.map((id) => members.find((m) => m.id === id)?.name ?? id).join("・")
      : "未定";
  const attendanceStr =
    order.delivery_type === "直納"
      ? order.attendance_required ? `あり（${attendeeNames}）` : "なし"
      : "―";

  const resendMark = isResend ? "（再送）" : "";
  const subject = `【発注依頼${resendMark}】${clientName} 様`;
  const supplierName = suppliers?.find((s) => s.id === order.supplier_id)?.name;

  /** 確認画面用：シンプルな内容のみ */
  const preview = [
    `利用者：${clientName}`,
    `住所：${clientAddress}`,
    "",
    "── 発注品目 ──",
    ...itemLines,
    "",
    "── 配送 ──",
    `方法：${order.delivery_type}`,
    `日時：${deliveryDateStr}　${deliveryTimeStr}`,
    ...(order.delivery_type === "直納" ? [`立ち会い：${attendanceStr}`] : []),
    ...(order.notes ? ["", `備考：${order.notes}`] : []),
  ].join("\n");

  /** メール・印刷用：フォーマルな文言付き */
  const emailBody = [
    ...(supplierName ? [`${supplierName}ご担当者様`, ""] : []),
    `【発注依頼${resendMark}】`,
    "",
    "お疲れ様です。",
    "下記の通り、福祉用具の発注をお願いいたします。",
    "────────────────────",
    `利用者名：${clientName}`,
    `住　　所：${clientAddress}`,
    "",
    "▼ 発注品目",
    ...itemLines.map((l) => `  ${l}`),
    "",
    "▼ 配送情報",
    `配送方法：${order.delivery_type}`,
    `配送予定：${deliveryDateStr}　${deliveryTimeStr}`,
    ...(order.delivery_type === "直納" ? [`立ち会い：${attendanceStr}`] : []),
    "────────────────────",
    ...(order.notes ? ["", "【備考】", order.notes] : []),
    "",
    "ご確認のほど、よろしくお願いいたします。",
  ].join("\n");

  return { subject, preview, emailBody };
}

export default function OrderEmailPreviewModal({
  order,
  orderItems,
  clients,
  equipment,
  suppliers,
  members,
  emailType = "new_order",
  isNewlyCreated,
  tenantId,
  sentAt,
  onClose,
  onBack,
  onDone,
}: {
  order: Order;
  orderItems: OrderItem[];
  clients: Client[];
  equipment: Equipment[];
  suppliers: Supplier[];
  members: Member[];
  emailType?: "new_order" | "rental_started" | "terminated" | "cancelled";
  isNewlyCreated?: boolean;
  tenantId?: string;
  sentAt?: string;
  onClose: () => void;
  onBack?: () => void;
  onDone: () => void;
}) {
  const isResend = (order.email_sent_count ?? 0) > 0;
  const client = clients.find((c) => c.id === order.client_id);
  const today = todayYmd();
  // 解約・キャンセルメール用: 返却日・返却方法
  const terminatedItem = orderItems.find((i) => i.status === "terminated");
  const [returnDate, setReturnDate] = useState(
    emailType === "terminated" ? (terminatedItem?.rental_end_date ?? today) : today
  );
  const [returnMethod, setReturnMethod] = useState("");

  // 卸会社ごとにアイテムをグループ化（new_order のみ）
  const supplierGroups: { supplierId: string | null; supplier: Supplier | undefined; items: OrderItem[] }[] = [];
  if (emailType === "new_order") {
    const activeItems = orderItems.filter((i) => i.status !== "cancelled");
    const groupMap = new Map<string, OrderItem[]>();
    for (const item of activeItems) {
      const key = item.supplier_id ?? order.supplier_id ?? "__none__";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(item);
    }
    for (const [key, items] of groupMap) {
      const supplierId = key === "__none__" ? null : key;
      supplierGroups.push({ supplierId, supplier: suppliers.find((s) => s.id === supplierId), items });
    }
  }

  // 送信状態を卸会社IDごとに管理
  const [sentSet, setSentSet] = useState<Set<string>>(new Set());
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // ステータス変更メール用（単一）
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const sendToSupplier = async (groupKey: string, supplierObj: Supplier | undefined, items: OrderItem[]) => {
    if (!supplierObj?.email) {
      setErrors((prev) => new Map(prev).set(groupKey, "メールアドレスが設定されていません"));
      return;
    }
    setSendingId(groupKey);
    setErrors((prev) => { const n = new Map(prev); n.delete(groupKey); return n; });
    const { subject, emailBody } = buildOrderContent(order, items, client, equipment, members, isResend, suppliers);
    try {
      const res = await fetch("/api/send-order-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: supplierObj.email, subject, body: emailBody }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await recordEmailSent(order.id);
      setSentSet((prev) => new Set(prev).add(groupKey));
      if (tenantId && order.client_id) {
        const emailLabel = supplierObj.name ? `${supplierObj.name}への発注メール` : "発注メール";
        await saveClientDocument({
          tenant_id: tenantId,
          client_id: order.client_id,
          type: "supplier_email",
          title: `${emailLabel}（${subject}）`,
          params: { emailType: "new_order", orderId: order.id, supplierName: supplierObj.name, subject, body: emailBody },
        }).catch((err) => {
          console.warn("saveClientDocument (new_order) failed:", err);
        });
      }
    } catch (e: unknown) {
      setErrors((prev) => new Map(prev).set(groupKey, e instanceof Error ? e.message : "送信に失敗しました"));
    } finally {
      setSendingId(null);
    }
  };

  const sendAll = async () => {
    for (const g of supplierGroups) {
      const key = g.supplierId ?? "__none__";
      if (!sentSet.has(key)) await sendToSupplier(key, g.supplier, g.items);
    }
  };

  // ステータス変更メール送信（単一）
  const { subject: scSubject, preview: scPreview, emailBody: scEmailBody } =
    emailType !== "new_order"
      ? buildStatusChangeContent(emailType, order, orderItems, client, equipment, isResend, returnDate, returnMethod)
      : { subject: "", preview: "", emailBody: "" };

  const handleSendStatusEmail = async () => {
    const supplier = suppliers.find((s) => s.id === order.supplier_id);
    if (!supplier?.email) {
      setError("卸会社のメールアドレスが設定されていません。設定タブで登録してください。");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/send-order-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: supplier.email, subject: scSubject, body: scEmailBody }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await recordEmailSent(order.id);
      setSent(true);
      if (tenantId && order.client_id) {
        const typeLabel = emailType === "rental_started" ? "レンタル開始通知" : "解約・返却通知";
        await saveClientDocument({
          tenant_id: tenantId,
          client_id: order.client_id,
          type: "supplier_email",
          title: `${typeLabel}（${scSubject}）`,
          params: { emailType, orderId: order.id, subject: scSubject, body: scEmailBody },
        }).catch((err) => {
          console.warn("saveClientDocument (status_change) failed:", err);
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handlePrint = () => {
    const groups = emailType === "new_order" ? supplierGroups : null;
    const win = window.open("", "_blank", "width=700,height=800");
    if (!win) return;
    const content = groups
      ? groups.map((g) => {
          const { subject, emailBody } = buildOrderContent(order, g.items, client, equipment, members, isResend, suppliers);
          return `${subject}\n\n${emailBody}`;
        }).join("\n\n" + "─".repeat(40) + "\n\n")
      : `${scSubject}\n\n${scEmailBody}`;
    win.document.write(`<html><head><title>発注書</title>
      <style>body{font-family:sans-serif;padding:32px;white-space:pre-wrap;font-size:14px;line-height:1.7;}</style>
      </head><body>${content}</body></html>`);
    win.document.close();
    win.print();
  };

  const allSent = emailType === "new_order"
    ? supplierGroups.every((g) => sentSet.has(g.supplierId ?? "__none__"))
    : sent;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">
              発注内容確認{isResend && <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">再送</span>}
            </h3>
            {sentAt && (
              <p className="text-xs text-gray-400 mt-0.5">
                送信日時: {new Date(sentAt).toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
          </div>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        {isNewlyCreated && (
          <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-3 flex items-center gap-2 shrink-0">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-emerald-700">発注情報を登録しました</p>
              <p className="text-xs text-emerald-600">卸会社にメールを送信しますか？</p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {emailType === "new_order" ? (
            /* 卸会社ごとにカード表示 */
            supplierGroups.map((g) => {
              const key = g.supplierId ?? "__none__";
              // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
              const { subject, preview } = buildOrderContent(order, g.items, client, equipment, members, isResend, suppliers);
              const isSent = sentSet.has(key);
              const isSending = sendingId === key;
              const err = errors.get(key);
              return (
                <div key={key} className={`border rounded-xl overflow-hidden ${isSent ? "border-emerald-200 bg-emerald-50/30" : "border-gray-200"}`}>
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        {g.supplier?.name ?? "卸会社未設定"}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {g.supplier?.email ?? "メールアドレス未設定"} · {g.items.length}品目
                      </p>
                    </div>
                    {isSent ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <CheckCircle2 size={14} />送信済
                      </span>
                    ) : (
                      <button
                        onClick={() => sendToSupplier(key, g.supplier, g.items)}
                        disabled={isSending || sendingId !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-medium rounded-lg disabled:opacity-40"
                      >
                        {isSending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        送信
                      </button>
                    )}
                  </div>
                  <div className="px-3 py-2">
                    <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">{preview}</pre>
                  </div>
                  {err && (
                    <div className="flex items-center gap-1.5 text-xs text-red-500 bg-red-50 px-3 py-2 border-t border-red-100">
                      <AlertCircle size={12} className="shrink-0" />{err}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            /* ステータス変更メール（単一） */
            <>
              {/* 解約・キャンセル: 返却日・返却方法入力 */}
              {(emailType === "terminated" || emailType === "cancelled") && (
                <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2.5">
                  <p className="text-xs font-semibold text-gray-600">返却情報</p>
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm text-gray-500">返却日</span>
                    <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)}
                      className="w-44 border border-gray-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm text-gray-500">返却方法</span>
                    <select value={returnMethod} onChange={(e) => setReturnMethod(e.target.value)}
                      className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white">
                      <option value="">未選択</option>
                      <option value="直引き">直引き</option>
                      <option value="店引き">店引き</option>
                      <option value="持ち込み">持ち込み</option>
                    </select>
                  </div>
                </div>
              )}
              <div className="bg-gray-50 rounded-xl p-4">
                <pre className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{scPreview}</pre>
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />{error}
                </div>
              )}
              {sent && (
                <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-xl p-3">
                  <CheckCircle2 size={14} />メールを送信しました
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 space-y-2">
          {allSent ? (
            <button onClick={onDone} className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium flex items-center justify-center gap-2">
              <CheckCircle2 size={16} />閉じる
            </button>
          ) : emailType === "new_order" ? (
            <>
              {supplierGroups.length > 1 && (
                <button
                  onClick={sendAll}
                  disabled={sendingId !== null}
                  className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {sendingId !== null ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  全卸会社に一括送信
                </button>
              )}
              <button onClick={handlePrint} className="w-full py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium flex items-center justify-center gap-2">
                <Printer size={16} />印刷（FAX用）
              </button>
              {onBack && <button onClick={onBack} className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors">← 戻る</button>}
            </>
          ) : (
            <>
              <button onClick={handleSendStatusEmail} disabled={sending} className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {isResend ? "再送信する" : "メール送信"}
              </button>
              <button onClick={handlePrint} className="w-full py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium flex items-center justify-center gap-2">
                <Printer size={16} />印刷（FAX用）
              </button>
              {onBack && <button onClick={onBack} className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors">← 戻る</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

