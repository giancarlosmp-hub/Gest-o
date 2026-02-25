import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";

const initialForm = { name: "", city: "", state: "", region: "", potentialHa: 0, farmSizeHa: 0, ownerSellerId: "" };

export default function ClientsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<any>(initialForm);
  const [editing, setEditing] = useState<string | null>(null);

  const load = () => api.get("/clients").then((r) => setItems(r.data));

  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const payload = { ...form, ownerSellerId: form.ownerSellerId || undefined };
      if (editing) await api.put(`/clients/${editing}`, payload);
      else await api.post("/clients", payload);
      setForm(initialForm);
      setEditing(null);
      load();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Erro ao salvar cliente");
    }
  };

  const onEdit = (item: any) => {
    setEditing(item.id);
    setForm(item);
  };

  const onDelete = async (id: string) => {
    await api.delete(`/clients/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Clientes</h2>
      <form onSubmit={submit} className="bg-white p-4 rounded-xl shadow grid md:grid-cols-4 gap-2">
        <input required className="border p-2 rounded" placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input required className="border p-2 rounded" placeholder="Cidade" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <input required className="border p-2 rounded" placeholder="UF" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        <input required className="border p-2 rounded" placeholder="Região" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
        <input className="border p-2 rounded" type="number" placeholder="Potencial (ha)" value={form.potentialHa ?? 0} onChange={(e) => setForm({ ...form, potentialHa: Number(e.target.value) })} />
        <input className="border p-2 rounded" type="number" placeholder="Área total (ha)" value={form.farmSizeHa ?? 0} onChange={(e) => setForm({ ...form, farmSizeHa: Number(e.target.value) })} />
        <input className="border p-2 rounded" placeholder="ID vendedor (opcional)" value={form.ownerSellerId ?? ""} onChange={(e) => setForm({ ...form, ownerSellerId: e.target.value })} />
        <button className="bg-blue-700 text-white rounded px-3">{editing ? "Atualizar" : "Criar"}</button>
      </form>

      <div className="bg-white rounded-xl shadow overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-2">Nome</th>
              <th className="text-left p-2">Cidade</th>
              <th className="text-left p-2">UF</th>
              <th className="text-left p-2">Região</th>
              <th className="text-left p-2">Potencial</th>
              <th className="text-left p-2">Área total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-t">
                <td className="p-2">{it.name}</td>
                <td className="p-2">{it.city}</td>
                <td className="p-2">{it.state}</td>
                <td className="p-2">{it.region}</td>
                <td className="p-2">{it.potentialHa ?? "-"}</td>
                <td className="p-2">{it.farmSizeHa ?? "-"}</td>
                <td className="p-2 space-x-3 text-right">
                  <Link to={`/clientes/${it.id}`} className="text-emerald-700">Detalhes</Link>
                  <button className="text-blue-700" onClick={() => onEdit(it)}>Editar</button>
                  <button className="text-red-600" onClick={() => onDelete(it.id)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
