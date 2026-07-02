import { supabase } from "./supabase";

// 帳票文面テンプレート (document_templates)
// tenant × doc_type ごとに sections JSONB = { section_key: 差し替え文面 } を保持。
// 未登録キーはコード内の既定文 (lib/contractTemplateSections.ts 等) を使う。

export type DocTemplateSections = Record<string, string>;

export async function getDocTemplate(
  tenantId: string,
  docType: string
): Promise<DocTemplateSections> {
  const { data, error } = await supabase
    .from("document_templates")
    .select("sections")
    .eq("tenant_id", tenantId)
    .eq("doc_type", docType)
    .maybeSingle();
  if (error) throw error;
  return (data?.sections as DocTemplateSections | null) ?? {};
}

export async function saveDocTemplate(
  tenantId: string,
  docType: string,
  sections: DocTemplateSections
): Promise<void> {
  const { error } = await supabase
    .from("document_templates")
    .upsert(
      { tenant_id: tenantId, doc_type: docType, sections, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,doc_type" }
    );
  if (error) throw error;
}
