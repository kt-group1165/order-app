"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Package, ChevronRight, Loader2 } from "lucide-react";
import { getTenants, type Tenant } from "@/lib/tenants";

export default function HomePage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTenants()
      .then(setTenants)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl shadow-lg mb-2">
            <Package size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">用具・発注管理</h1>
          <p className="text-sm text-gray-400">チームを選択してください</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={24} className="animate-spin text-emerald-400" />
            </div>
          ) : tenants.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              チームが登録されていません
            </p>
          ) : (
            <ul className="divide-y divide-gray-50">
              {tenants.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => router.push(`/${t.id}`)}
                    className="w-full flex items-center justify-between px-5 py-4 hover:bg-emerald-50 transition-colors active:bg-emerald-100"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-emerald-100 rounded-xl flex items-center justify-center shrink-0">
                        <Package size={18} className="text-emerald-500" />
                      </div>
                      <span className="text-sm font-semibold text-gray-800">{t.name}</span>
                    </div>
                    <ChevronRight size={16} className="text-gray-300" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
