import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";

type CrudSimplePageProps = {
  endpoint: string;
  title: string;
  fields: { key: string; label: string; type?: string }[];
  readOnly?: boolean;
  detailsPath?: string;
};

export default function CrudSimplePage({ endpoint, title, fields, readOnly = false, detailsPath }: CrudSimplePageProps) {
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
      setForm({});
      setEditing(null);
      await load();
    } catch (e: any) {
      toast.error(e.response?.data?.message || "Erro ao salvar");
    }
  };

  const onEdit = (item: any) => {
    setEditing(item.id);
    setForm(item);
  };

  const onDelete = async (id: string) => {
    await api.delete(`${endpoint}/${id}`);
    await load();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">{title}</h2>

      {!readOnly && (
        <form onSubmit={submit} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3">
          {fields.map((f) => (
            <input
              key={f.key}
              required
              className="rounded-lg border p-2"
              type={f.type || "text"}
              placeholder={f.label}
              value={form[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value })}
            />
          ))}
          <button className="rounded-lg bg-brand-700 px-3 py-2 font-medium text-white hover:bg-brand-800">{editing ? "Atualizar" : "Criar"}</button>
        </form>
      )}

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? <div className="p-4 text-slate-500">Carregando...</div> : null}
        {error ? <div className="p-4 text-amber-600">{error}</div> : null}
        {!loading && !error ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-brand-800">
                {fields.map((f) => (
                  <th className="p-2 text-left" key={f.key}>{f.label}</th>
                ))}
                {detailsPath ? <th className="p-2 text-left">Detalhes</th> : null}
                {!readOnly ? <th className="p-2 text-left" /> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-slate-100">
                  {fields.map((f) => <td key={f.key} className="p-2 text-slate-700">{String(it[f.key] ?? "")}</td>)}
                  {detailsPath ? <td className="p-2"><Link className="font-medium text-brand-700 hover:text-brand-800" to={`${detailsPath}/${it.id}`}>Abrir</Link></td> : null}
                  {!readOnly ? (
                    <td className="space-x-3 p-2">
                      <button className="font-medium text-brand-700" onClick={() => onEdit(it)}>Editar</button>
                      <button className="font-medium text-amber-700" onClick={() => onDelete(it.id)}>Excluir</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
