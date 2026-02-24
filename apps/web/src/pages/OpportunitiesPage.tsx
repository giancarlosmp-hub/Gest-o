import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";

type Opportunity = {
  id: string;
  title: string;
  value: number;
  stage: Stage;
  proposalDate: string;
  followUpDate: string;
  expectedCloseDate: string;
  lastContactAt?: string | null;
  probability?: number | null;
  notes?: string | null;
  clientId: string;
  ownerSellerId: string;
  client?: { id: string; name: string };
  ownerSeller?: { id: string; name: string };
};

type Client = { id: string; name: string };

type Filters = {
  stage: string;
  ownerSellerId: string;
  clientId: string;
  from: string;
  to: string;
  overdue: boolean;
  dueSoon: boolean;
};

const stages: Stage[] = ["prospeccao", "negociacao", "proposta", "ganho", "perdido"];

const stageLabel: Record<Stage, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido",
};

const emptyForm = {
  title: "",
  value: 0,
  stage: "prospeccao" as Stage,
  proposalDate: "",
  followUpDate: "",
  expectedCloseDate: "",
  lastContactAt: "",
  probability: "",
  notes: "",
  clientId: "",
  ownerSellerId: "",
};

function toDateInput(value?: string | null) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

export default function OpportunitiesPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Opportunity[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<any>(emptyForm);
  const [filters, setFilters] = useState<Filters>({ stage: "", ownerSellerId: "", clientId: "", from: "", to: "", overdue: false, dueSoon: false });

  const load = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (typeof value === "boolean") {
        if (value) params.set(key, "true");
        return;
      }
      if (value) params.set(key, value);
    });

    const [oppRes, clientsRes] = await Promise.all([
      api.get(`/opportunities${params.toString() ? `?${params}` : ""}`),
      api.get("/clients"),
    ]);
    setItems(oppRes.data);
    setClients(clientsRes.data);
  };

  useEffect(() => {
    load().catch(() => toast.error("Erro ao carregar oportunidades"));
  }, [filters]);

  const sellers = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => {
      if (item.ownerSeller?.id && item.ownerSeller?.name) map.set(item.ownerSeller.id, item.ownerSeller.name);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [items]);

  const stageTotals = useMemo(() => {
    return stages.reduce((acc, stage) => {
      acc[stage] = items.filter((item) => item.stage === stage).reduce((sum, item) => sum + Number(item.value || 0), 0);
      return acc;
    }, {} as Record<Stage, number>);
  }, [items]);

  const totalValue = useMemo(() => items.reduce((sum, item) => sum + Number(item.value || 0), 0), [items]);
  const weightedValue = useMemo(() => items.reduce((sum, item) => sum + (Number(item.value || 0) * Number(item.probability || 0)) / 100, 0), [items]);

  const getStatus = (item: Opportunity) => {
    if (["ganho", "perdido"].includes(item.stage)) return null;
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const followUp = new Date(item.followUpDate);
    const followUpStart = new Date(followUp.getFullYear(), followUp.getMonth(), followUp.getDate());
    if (followUpStart < todayStart) return "overdue";

    const limit = new Date(todayStart);
    limit.setDate(limit.getDate() + 3);
    if (followUpStart >= todayStart && followUpStart <= limit) return "dueSoon";
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const payload = {
      ...form,
      value: Number(form.value),
      probability: form.probability === "" ? undefined : Number(form.probability),
      lastContactAt: form.lastContactAt || undefined,
      notes: form.notes || undefined,
      ownerSellerId: form.ownerSellerId || undefined,
    };

    try {
      if (editing) {
        await api.put(`/opportunities/${editing}`, payload);
      } else {
        await api.post("/opportunities", payload);
      }
      setForm(emptyForm);
      setEditing(null);
      await load();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Erro ao salvar oportunidade");
    }
  };

  const onEdit = (item: Opportunity) => {
    setEditing(item.id);
    setForm({
      ...item,
      proposalDate: toDateInput(item.proposalDate),
      followUpDate: toDateInput(item.followUpDate),
      expectedCloseDate: toDateInput(item.expectedCloseDate),
      lastContactAt: toDateInput(item.lastContactAt),
      probability: item.probability ?? "",
      notes: item.notes ?? "",
    });
  };

  const onDelete = async (id: string) => {
    await api.delete(`/opportunities/${id}`);
    await load();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Oportunidades</h2>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        <Card title="Total" value={formatCurrencyBRL(totalValue)} />
        <Card title="Ponderado" value={formatCurrencyBRL(weightedValue)} />
        {stages.map((stage) => (
          <Card key={stage} title={`Total ${stageLabel[stage]}`} value={formatCurrencyBRL(stageTotals[stage])} />
        ))}
      </div>

      <div className="rounded-xl bg-white p-4 shadow">
        <h3 className="mb-3 font-semibold">Filtros</h3>
        <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-4">
          <select className="border rounded p-2" value={filters.stage} onChange={(e) => setFilters((prev) => ({ ...prev, stage: e.target.value }))}>
            <option value="">Todos estágios</option>
            {stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
          </select>
          <select className="border rounded p-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
            <option value="">Todos vendedores</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
          <select className="border rounded p-2" value={filters.clientId} onChange={(e) => setFilters((prev) => ({ ...prev, clientId: e.target.value }))}>
            <option value="">Todos clientes</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
          <input type="date" className="border rounded p-2" value={filters.from} onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))} />
          <input type="date" className="border rounded p-2" value={filters.to} onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((prev) => ({ ...prev, overdue: e.target.checked }))} />Atrasadas</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.dueSoon} onChange={(e) => setFilters((prev) => ({ ...prev, dueSoon: e.target.checked }))} />Vence em breve</label>
          <button className="rounded bg-slate-200 px-3" onClick={() => setFilters({ stage: "", ownerSellerId: "", clientId: "", from: "", to: "", overdue: false, dueSoon: false })}>Limpar filtros</button>
        </div>
      </div>

      <form onSubmit={submit} className="rounded-xl bg-white p-4 shadow grid gap-2 md:grid-cols-3">
        <input required className="border p-2 rounded" placeholder="Título" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input required type="number" className="border p-2 rounded" placeholder="Valor" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <select required className="border p-2 rounded" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}</select>
        <input required type="date" className="border p-2 rounded" value={form.proposalDate} onChange={(e) => setForm({ ...form, proposalDate: e.target.value })} />
        <input required type="date" className="border p-2 rounded" value={form.followUpDate} onChange={(e) => setForm({ ...form, followUpDate: e.target.value })} />
        <input required type="date" className="border p-2 rounded" value={form.expectedCloseDate} onChange={(e) => setForm({ ...form, expectedCloseDate: e.target.value })} />
        <input type="date" className="border p-2 rounded" value={form.lastContactAt} onChange={(e) => setForm({ ...form, lastContactAt: e.target.value })} />
        <input type="number" min={0} max={100} className="border p-2 rounded" placeholder="Probabilidade %" value={form.probability} onChange={(e) => setForm({ ...form, probability: e.target.value })} />
        <select required className="border p-2 rounded" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
          <option value="">Selecione cliente</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
        {user?.role !== "vendedor" && (
          <select className="border p-2 rounded" value={form.ownerSellerId} onChange={(e) => setForm({ ...form, ownerSellerId: e.target.value })}>
            <option value="">Vendedor automático</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        )}
        <textarea className="border p-2 rounded md:col-span-3" placeholder="Notas" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <button className="rounded bg-blue-700 text-white px-3 py-2 md:col-span-3">{editing ? "Atualizar" : "Criar"}</button>
      </form>

      <div className="rounded-xl bg-white shadow overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="p-2">Título</th><th className="p-2">Cliente</th><th className="p-2">Vendedor</th><th className="p-2">Estágio</th><th className="p-2">Valor</th><th className="p-2">Prob.</th><th className="p-2">Entrada</th><th className="p-2">Retorno</th><th className="p-2">Status</th><th className="p-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const status = getStatus(item);
              return (
                <tr key={item.id} className={`border-t ${status === "overdue" ? "bg-red-50" : ""}`}>
                  <td className="p-2">{item.title}</td>
                  <td className="p-2">{item.client?.name || item.clientId}</td>
                  <td className="p-2">{item.ownerSeller?.name || item.ownerSellerId}</td>
                  <td className="p-2">{stageLabel[item.stage]}</td>
                  <td className="p-2">{formatCurrencyBRL(item.value)}</td>
                  <td className="p-2">{item.probability ?? "-"}%</td>
                  <td className="p-2">{formatDateBR(item.proposalDate)}</td>
                  <td className="p-2">{formatDateBR(item.followUpDate)}</td>
                  <td className="p-2">
                    {status === "overdue" ? <Badge className="bg-red-100 text-red-700">Atrasado</Badge> : null}
                    {status === "dueSoon" ? <Badge className="bg-orange-100 text-orange-700">Vence em breve</Badge> : null}
                  </td>
                  <td className="p-2 space-x-2">
                    <button className="text-blue-700" onClick={() => onEdit(item)}>Editar</button>
                    <button className="text-red-600" onClick={() => onDelete(item.id)}>Excluir</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">{title}</div><div className="font-bold text-slate-900">{value}</div></div>;
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}>{children}</span>;
}
