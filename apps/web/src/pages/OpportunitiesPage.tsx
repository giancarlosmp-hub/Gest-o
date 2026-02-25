import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type ViewMode = "lista" | "pipeline";

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

const stageAccent: Record<Stage, string> = {
  prospeccao: "from-sky-500 to-cyan-500",
  negociacao: "from-indigo-500 to-blue-500",
  proposta: "from-violet-500 to-fuchsia-500",
  ganho: "from-emerald-500 to-green-500",
  perdido: "from-slate-500 to-slate-600",
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
  const [viewMode, setViewMode] = useState<ViewMode>("lista");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null);
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

  const opportunitiesByStage = useMemo(() => {
    return stages.reduce((acc, stage) => {
      acc[stage] = items.filter((item) => item.stage === stage);
      return acc;
    }, {} as Record<Stage, Opportunity[]>);
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
    limit.setDate(limit.getDate() + 2);
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

  const moveToStage = async (item: Opportunity, nextStage: Stage) => {
    if (item.stage === nextStage) return;
    const previousItems = items;
    const updatedItems = items.map((current) => current.id === item.id ? { ...current, stage: nextStage } : current);

    setItems(updatedItems);
    try {
      await api.put(`/opportunities/${item.id}`, {
        title: item.title,
        value: Number(item.value),
        stage: nextStage,
        proposalDate: toDateInput(item.proposalDate),
        followUpDate: toDateInput(item.followUpDate),
        expectedCloseDate: toDateInput(item.expectedCloseDate),
        lastContactAt: toDateInput(item.lastContactAt) || undefined,
        probability: item.probability ?? undefined,
        notes: item.notes || undefined,
        clientId: item.clientId,
        ownerSellerId: item.ownerSellerId || undefined,
      });
      toast.success(`Oportunidade movida para ${stageLabel[nextStage]}`);
    } catch {
      setItems(previousItems);
      toast.error("Não foi possível mover a oportunidade");
    }
  };

  return (
    <div className="space-y-5 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-900">Oportunidades</h2>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setViewMode("lista")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${viewMode === "lista" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            Modo Lista
          </button>
          <button
            type="button"
            onClick={() => setViewMode("pipeline")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${viewMode === "pipeline" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            Modo Pipeline
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        <Card title="Total" value={formatCurrencyBRL(totalValue)} />
        <Card title="Ponderado" value={formatCurrencyBRL(weightedValue)} />
        {stages.map((stage) => (
          <Card key={stage} title={`Total ${stageLabel[stage]}`} value={formatCurrencyBRL(stageTotals[stage])} />
        ))}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold text-slate-900">Filtros</h3>
        <div className="grid gap-2 md:grid-cols-4 lg:grid-cols-6">
          <select className="rounded-lg border border-slate-200 p-2" value={filters.stage} onChange={(e) => setFilters((prev) => ({ ...prev, stage: e.target.value }))}>
            <option value="">Todos estágios</option>
            {stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
          </select>
          <select className="rounded-lg border border-slate-200 p-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
            <option value="">Todos vendedores</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
          <select className="rounded-lg border border-slate-200 p-2" value={filters.clientId} onChange={(e) => setFilters((prev) => ({ ...prev, clientId: e.target.value }))}>
            <option value="">Todos clientes</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
          <input type="date" className="rounded-lg border border-slate-200 p-2" value={filters.from} onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))} />
          <input type="date" className="rounded-lg border border-slate-200 p-2" value={filters.to} onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))} />
          <button type="button" className="rounded-lg bg-slate-100 px-3 font-medium text-slate-700 hover:bg-slate-200" onClick={() => setFilters({ stage: "", ownerSellerId: "", clientId: "", from: "", to: "", overdue: false, dueSoon: false })}>Limpar filtros</button>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((prev) => ({ ...prev, overdue: e.target.checked }))} />Atrasadas
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={filters.dueSoon} onChange={(e) => setFilters((prev) => ({ ...prev, dueSoon: e.target.checked }))} />Vence em até 2 dias
          </label>
        </div>
      </div>

      <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3">
        <input required className="rounded-lg border border-slate-200 p-2" placeholder="Título" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input required type="number" className="rounded-lg border border-slate-200 p-2" placeholder="Valor" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <select required className="rounded-lg border border-slate-200 p-2" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}</select>
        <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.proposalDate} onChange={(e) => setForm({ ...form, proposalDate: e.target.value })} />
        <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.followUpDate} onChange={(e) => setForm({ ...form, followUpDate: e.target.value })} />
        <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.expectedCloseDate} onChange={(e) => setForm({ ...form, expectedCloseDate: e.target.value })} />
        <input type="date" className="rounded-lg border border-slate-200 p-2" value={form.lastContactAt} onChange={(e) => setForm({ ...form, lastContactAt: e.target.value })} />
        <input type="number" min={0} max={100} className="rounded-lg border border-slate-200 p-2" placeholder="Probabilidade %" value={form.probability} onChange={(e) => setForm({ ...form, probability: e.target.value })} />
        <select required className="rounded-lg border border-slate-200 p-2" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
          <option value="">Selecione cliente</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
        {user?.role !== "vendedor" && (
          <select className="rounded-lg border border-slate-200 p-2" value={form.ownerSellerId} onChange={(e) => setForm({ ...form, ownerSellerId: e.target.value })}>
            <option value="">Vendedor automático</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        )}
        <textarea className="rounded-lg border border-slate-200 p-2 md:col-span-3" placeholder="Notas" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-white md:col-span-3">{editing ? "Atualizar" : "Criar"}</button>
      </form>

      {viewMode === "lista" ? (
        <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-600">
                <th className="p-2">Título</th><th className="p-2">Cliente</th><th className="p-2">Vendedor</th><th className="p-2">Estágio</th><th className="p-2">Valor</th><th className="p-2">Prob.</th><th className="p-2">Entrada</th><th className="p-2">Retorno</th><th className="p-2">Status</th><th className="p-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const status = getStatus(item);
                return (
                  <tr key={item.id} className={`border-t border-slate-100 ${status === "overdue" ? "bg-red-50/90" : status === "dueSoon" ? "bg-yellow-50/90" : ""}`}>
                    <td className="p-2 font-medium text-slate-800">{item.title}</td>
                    <td className="p-2">{item.client?.name || item.clientId}</td>
                    <td className="p-2">{item.ownerSeller?.name || item.ownerSellerId}</td>
                    <td className="p-2">{stageLabel[item.stage]}</td>
                    <td className="p-2">{formatCurrencyBRL(item.value)}</td>
                    <td className="p-2">{item.probability ?? "-"}%</td>
                    <td className="p-2">{formatDateBR(item.proposalDate)}</td>
                    <td className="p-2">{formatDateBR(item.followUpDate)}</td>
                    <td className="p-2">
                      {status === "overdue" ? <Badge className="bg-red-100 text-red-700">Vencida</Badge> : null}
                      {status === "dueSoon" ? <Badge className="bg-yellow-100 text-yellow-700">Vence em até 2 dias</Badge> : null}
                    </td>
                    <td className="space-x-2 p-2">
                      <button type="button" className="text-blue-700" onClick={() => onEdit(item)}>Editar</button>
                      <button type="button" className="text-red-600" onClick={() => onDelete(item.id)}>Excluir</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[1100px] grid-cols-5 gap-4">
            {stages.map((stage) => (
              <section
                key={stage}
                className={`rounded-2xl border bg-white p-3 shadow-sm transition ${dragOverStage === stage ? "border-slate-400" : "border-slate-200"}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOverStage(stage);
                }}
                onDragLeave={() => setDragOverStage((prev) => (prev === stage ? null : prev))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOverStage(null);
                  const droppedId = event.dataTransfer.getData("text/opportunity-id");
                  const droppedItem = items.find((item) => item.id === droppedId);
                  if (droppedItem) {
                    moveToStage(droppedItem, stage);
                  }
                }}
              >
                <div className={`mb-3 rounded-xl bg-gradient-to-r ${stageAccent[stage]} px-3 py-2 text-white`}>
                  <div className="text-sm font-semibold">{stageLabel[stage]}</div>
                  <div className="text-xs opacity-90">{opportunitiesByStage[stage].length} oportunidade(s)</div>
                  <div className="mt-1 text-sm font-bold">{formatCurrencyBRL(stageTotals[stage])}</div>
                </div>

                <div className="space-y-2">
                  {opportunitiesByStage[stage].map((item) => {
                    const status = getStatus(item);
                    return (
                      <article
                        key={item.id}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/opportunity-id", item.id);
                          setDraggingId(item.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDragOverStage(null);
                        }}
                        className={`cursor-grab rounded-xl border p-3 shadow-sm transition active:cursor-grabbing ${draggingId === item.id ? "opacity-70" : ""} ${status === "overdue" ? "border-red-200 bg-red-50" : status === "dueSoon" ? "border-yellow-200 bg-yellow-50" : "border-slate-200 bg-white"}`}
                      >
                        <div className="mb-2 text-sm font-semibold text-slate-800">{item.title}</div>
                        <div className="space-y-1 text-xs text-slate-600">
                          <p>Cliente: {item.client?.name || item.clientId}</p>
                          <p>Valor: <span className="font-semibold text-slate-800">{formatCurrencyBRL(item.value)}</span></p>
                          <p>Retorno: {formatDateBR(item.followUpDate)}</p>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {status === "overdue" ? <Badge className="bg-red-100 text-red-700">Vencida</Badge> : null}
                          {status === "dueSoon" ? <Badge className="bg-yellow-100 text-yellow-700">Vence em até 2 dias</Badge> : null}
                        </div>
                        <div className="mt-3 flex gap-3 text-xs">
                          <button type="button" className="text-blue-700" onClick={() => onEdit(item)}>Editar</button>
                          <button type="button" className="text-red-600" onClick={() => onDelete(item.id)}>Excluir</button>
                        </div>
                      </article>
                    );
                  })}
                  {!opportunitiesByStage[stage].length ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">Arraste oportunidades para este estágio</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-slate-500">{title}</div>
      <div className="font-bold text-slate-900">{value}</div>
    </div>
  );
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}>{children}</span>;
}
