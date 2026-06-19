"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronRight, Loader2, Package } from "lucide-react";
import { getOffices, type Office } from "@/lib/offices";

// Phase 8: order-app も office-centric 化。
//   - kt-group の福祉用具 office を直接 picker に出す → /kt-group?office=<id>
//   - 「全事業所まとめて」もオプションで提供 → /kt-group (?office 無し)
//   - 旧 slug `/care-chiba` は /[tenant]/page.tsx の useEffect で /kt-group?office=1bfc0d57 に redirect
const KT_GROUP_TENANT = "kt-group";

export default function HomePage() {
  const router = useRouter();
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOffices(KT_GROUP_TENANT)
      .then(setOffices)
      .catch((err) => {
        console.warn("getOffices failed:", err);
      })
      .finally(() => setLoading(false));
  }, []);

  function goToOffice(officeId: string) {
    router.push(`/${KT_GROUP_TENANT}?office=${officeId}`);
  }

  function goToAllOffices() {
    router.push(`/${KT_GROUP_TENANT}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl shadow-lg mb-2">
            <Package size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">用具・発注管理</h1>
          <p className="text-sm text-gray-400">事業所を選択してください</p>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 flex justify-center py-10">
            <Loader2 size={24} className="animate-spin text-emerald-400" />
          </div>
        ) : offices.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 py-10">
            <p className="text-sm text-gray-400 text-center">
              福祉用具事業所が登録されていません。<br />
              管理者にお問い合わせください。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 福祉用具事業所セクション */}
            <Section title="事業所" icon={<Building2 size={12} className="text-emerald-500" />}>
              {offices.map((o) => (
                <Row
                  key={o.id}
                  label={o.name}
                  sublabel={o.service_type ?? undefined}
                  onClick={() => goToOffice(o.id)}
                />
              ))}
            </Section>

            {/* 全事業所ビュー (option) */}
            <Section title="その他" icon={<Package size={12} className="text-indigo-500" />}>
              <Row
                label="全事業所まとめて"
                sublabel="kt-group 配下の全 office"
                onClick={goToAllOffices}
                indigo
              />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 mb-1.5">
        {icon}
        <h2 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
          {title}
        </h2>
      </div>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <ul className="divide-y divide-gray-50">{children}</ul>
      </div>
    </div>
  );
}

function Row({
  label,
  sublabel,
  onClick,
  indigo = false,
}: {
  label: string;
  sublabel?: string;
  onClick: () => void;
  indigo?: boolean;
}) {
  const iconBg = indigo ? "bg-indigo-100" : "bg-emerald-100";
  const iconColor = indigo ? "text-indigo-500" : "text-emerald-500";
  const hoverBg = indigo ? "hover:bg-indigo-50 active:bg-indigo-100" : "hover:bg-emerald-50 active:bg-emerald-100";
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full flex items-center justify-between px-5 py-3.5 transition-colors ${hoverBg}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 ${iconBg} rounded-xl flex items-center justify-center shrink-0`}>
            <Package size={18} className={iconColor} />
          </div>
          <div className="text-left min-w-0">
            <p className="text-sm font-semibold text-gray-800 truncate">{label}</p>
            {sublabel && <p className="text-[10px] text-gray-400 truncate">{sublabel}</p>}
          </div>
        </div>
        <ChevronRight size={16} className="text-gray-300 shrink-0" />
      </button>
    </li>
  );
}
