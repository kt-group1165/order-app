"use client";

// 複数タブ(Equipment/Settings 等)から使われる小さな汎用UI部品。
import { ChevronLeft } from "lucide-react";
import type { CareOffice } from "@/lib/careOffices";

// 戻る付きヘッダ
export function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0 flex items-center gap-3">
      <button onClick={onBack} className="text-gray-400 hover:text-gray-600">
        <ChevronLeft size={20} />
      </button>
      <h2 className="font-semibold text-gray-800">{title}</h2>
    </div>
  );
}

// 居宅マスタ編集 form の汎用 row
export function CareOfficeFormRow({
  label, field, placeholder, form, setForm,
}: {
  label: string;
  field: keyof CareOffice;
  placeholder?: string;
  form: Partial<CareOffice>;
  setForm: React.Dispatch<React.SetStateAction<Partial<CareOffice>>>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
      <input
        value={(form[field] as string) ?? ""}
        onChange={e => setForm(prev => ({ ...prev, [field]: e.target.value }))}
        placeholder={placeholder}
        className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
      />
    </div>
  );
}
