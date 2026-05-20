"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Package } from "lucide-react";
import { isValidLoginId } from "@/lib/login_id";
import { ensureDeviceId, detectDeviceLabel } from "@/lib/device_id";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";

  function validateIdentifier(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes("@")) return true; // 実 email
    return isValidLoginId(trimmed);
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!validateIdentifier(identifier)) {
      setError("ログイン ID または メールアドレスの形式が正しくありません");
      return;
    }
    setLoading(true);
    // Phase 11c: device_id cookie を確保 (submit 時に解決すれば effect 不要)
    const deviceId = ensureDeviceId();
    const deviceLabel = detectDeviceLabel();
    if (!deviceId) {
      setError("デバイス識別子の取得に失敗しました。ブラウザの cookie 設定をご確認ください。");
      setLoading(false);
      return;
    }
    let res: Response;
    try {
      res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          device_id: deviceId,
          device_label: deviceLabel,
        }),
      });
    } catch {
      setError("ネットワークエラーが発生しました。接続を確認してください。");
      setLoading(false);
      return;
    }

    let data: { error?: string; message?: string; status?: string; ok?: boolean } = {};
    try {
      data = await res.json();
    } catch {
      // body 無しでも続行
    }

    if (res.status === 200 && data.ok) {
      router.push(nextPath);
      router.refresh();
      return;
    }
    if (res.status === 202) {
      // 新端末 or 承認待ち
      setInfo(
        data.message ??
          "新しい端末からのログインです。管理者の承認をお待ちください。"
      );
      setLoading(false);
      return;
    }
    if (res.status === 401) {
      setError("ログインに失敗しました: 認証情報が正しくありません");
      setLoading(false);
      return;
    }
    if (res.status === 403) {
      setError(data.message ?? "この端末ではログインできません。管理者に連絡してください。");
      setLoading(false);
      return;
    }
    setError(data.message ?? "ログインに失敗しました (" + res.status + ")");
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl shadow-lg mb-2">
            <Package size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">用具・発注管理</h1>
          <p className="text-sm text-gray-400">ログインしてください</p>
        </div>

        <form
          onSubmit={handleLogin}
          className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ログイン ID または メールアドレス
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="username"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="staff001 または name@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="パスワード"
            />
          </div>
          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </p>
          )}
          {info && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-3 py-2">
              {info}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                ログイン中...
              </>
            ) : (
              "ログイン"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
