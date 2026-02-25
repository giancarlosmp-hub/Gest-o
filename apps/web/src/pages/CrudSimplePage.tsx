import { FormEvent, useEffect, useState } from "react";
import api from "../lib/apiClient";
import { toast } from "sonner";

export default function CrudSimplePage({ endpoint, title, fields, readOnly = false }: { endpoint: string; title: string; fields: { key: string; label: string; type?: string }[]; readOnly?: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(endpoint);
      setItems(Array.isArray(response.data) ? response.data : []);
    } catch (e: any) {
      setItems([]);
      setError(e.response?.data?.message || "Não foi possível carregar os dados.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [endpoint]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`${endpoint}/${editing}`, form);
      else await api.post(endpoint, form);
      setForm({}); setEditing(null);
      await load();
    } catch (e: any) { toast.error(e.response?.data?.message || "Erro ao salvar"); }
  };

  const onEdit = (item: any) => { setEditing(item.id); setForm(item); };
  const onDelete = async (id: string) => {
    await api.delete(`${endpoint}/${id}`);
    await load();
  };

  return <div className="space-y-4"><h2 className="text-2xl font-bold">{title}</h2>{!readOnly && <form onSubmit={submit} className="bg-white p-4 rounded-xl shadow grid md:grid-cols-3 gap-2">{fields.map((f) => <input key={f.key} required className="border p-2 rounded" type={f.type||"text"} placeholder={f.label} value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: f.type==="number" ? Number(e.target.value) : e.target.value })}/>)}<button className="bg-blue-700 text-white rounded px-3">{editing ? "Atualizar" : "Criar"}</button></form>}<div className="bg-white rounded-xl shadow overflow-auto">{loading ? <div className="p-4 text-slate-500">Carregando...</div> : error ? <div className="p-4 text-red-600">{error}</div> : <table className="w-full text-sm"><thead><tr>{fields.map((f) => <th className="text-left p-2" key={f.key}>{f.label}</th>)}{!readOnly && <th/>}</tr></thead><tbody>{items.map((it) => <tr key={it.id} className="border-t">{fields.map((f) => <td key={f.key} className="p-2">{String(it[f.key] ?? "")}</td>)}{!readOnly && <td className="p-2 space-x-2"><button className="text-blue-700" onClick={() => onEdit(it)}>Editar</button><button className="text-red-600" onClick={() => onDelete(it.id)}>Excluir</button></td>}</tr>)}</tbody></table>}</div></div>;
}
