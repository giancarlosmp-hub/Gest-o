import { useEffect, useMemo, useState } from "react";
import api from "../../lib/apiClient";
import type { KnowledgeDocumentCategory } from "@salesforce-pro/shared";

type KnowledgeDocument = {
  id: string;
  title: string;
  category: KnowledgeDocumentCategory;
  sourceType: string;
  sourceName?: string | null;
  content: string;
  summary?: string | null;
  tags: string[];
  isActive: boolean;
  updatedAt: string;
};

const CATEGORY_OPTIONS: Array<{ value: KnowledgeDocumentCategory; label: string }> = [
  { value: "produto", label: "Produto" },
  { value: "mix", label: "Mix" },
  { value: "cultura", label: "Cultura" },
  { value: "argumento_comercial", label: "Argumento comercial" },
  { value: "objeção", label: "Objeção" },
  { value: "manual_tecnico", label: "Manual técnico" },
  { value: "treinamento", label: "Treinamento" },
  { value: "institucional", label: "Institucional" },
  { value: "outro", label: "Outro" }
];

const emptyForm = {
  title: "",
  category: "institucional" as KnowledgeDocumentCategory,
  sourceType: "manual",
  sourceName: "",
  content: "",
  summary: "",
  tagsText: "",
  isActive: true
};

const tagsFromText = (value: string) => value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);

export default function KnowledgeBasePanel() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const response = await api.get<KnowledgeDocument[]>("/knowledge-documents", { params: { q: query || undefined, category: category || undefined, includeInactive: true } });
      setDocuments(response.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadDocuments(); }, []);

  const canSave = useMemo(() => form.title.trim().length >= 3 && form.content.trim().length >= 10, [form.content, form.title]);

  const editDocument = (document: KnowledgeDocument) => {
    setSelected(document);
    setForm({
      title: document.title,
      category: document.category,
      sourceType: document.sourceType,
      sourceName: document.sourceName || "",
      content: document.content,
      summary: document.summary || "",
      tagsText: document.tags.join(", "),
      isActive: document.isActive
    });
  };

  const resetForm = () => {
    setSelected(null);
    setForm(emptyForm);
  };

  const saveDocument = async () => {
    setSaving(true);
    try {
      const payload = { ...form, tags: tagsFromText(form.tagsText), sourceName: form.sourceName || null, summary: form.summary || null };
      const response = selected
        ? await api.put<KnowledgeDocument>(`/knowledge-documents/${selected.id}`, payload)
        : await api.post<KnowledgeDocument>("/knowledge-documents", payload);
      const saved = response.data;
      setDocuments((current) => selected ? current.map((doc) => doc.id === saved.id ? saved : doc) : [saved, ...current]);
      editDocument(saved);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (document: KnowledgeDocument) => {
    const response = await api.patch<KnowledgeDocument>(`/knowledge-documents/${document.id}/archive`, { isActive: !document.isActive });
    const updated = response.data;
    setDocuments((current) => current.map((doc) => doc.id === updated.id ? updated : doc));
    if (selected?.id === updated.id) editDocument(updated);
  };

  return (
    <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Base de Conhecimento IA</h3>
          <p className="mt-1 text-xs text-slate-600">Cadastre conteúdos técnicos e comerciais para consulta futura da IA. PDFs, embeddings e RAG completo ficam preparados para próximas etapas.</p>
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_220px_auto]">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por texto ou tag" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">Todas as categorias</option>
            {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" onClick={loadDocuments} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Buscar</button>
        </div>
        {loading ? <p className="text-sm text-slate-500">Carregando documentos...</p> : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Documento</th><th className="px-3 py-2">Tags</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Ações</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td className="px-3 py-2"><button type="button" onClick={() => editDocument(doc)} className="font-medium text-brand-700 hover:underline">{doc.title}</button><p className="text-xs text-slate-500">{doc.category}</p></td>
                    <td className="px-3 py-2 text-xs text-slate-600">{doc.tags.join(", ") || "—"}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-1 text-xs ${doc.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{doc.isActive ? "Ativo" : "Inativo"}</span></td>
                    <td className="px-3 py-2"><button type="button" onClick={() => toggleActive(doc)} className="text-xs font-medium text-slate-700 hover:text-brand-700">{doc.isActive ? "Desativar" : "Ativar"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between"><h4 className="text-sm font-semibold text-slate-900">{selected ? "Editar documento" : "Novo documento"}</h4><button type="button" onClick={resetForm} className="text-xs font-medium text-brand-700">Novo</button></div>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Título" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as KnowledgeDocumentCategory })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">{CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input value={form.tagsText} onChange={(e) => setForm({ ...form, tagsText: e.target.value })} placeholder="Tags separadas por vírgula" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Conteúdo" rows={10} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Ativo</label>
        <button type="button" disabled={!canSave || saving} onClick={saveDocument} className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Salvando..." : "Salvar documento"}</button>
      </div>
    </div>
  );
}
