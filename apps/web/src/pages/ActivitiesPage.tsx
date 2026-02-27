import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { ACTIVITY_TYPE_OPTIONS, toLabel } from "../constants/activityTypes";

type Client = { id: string; name: string };
type Opportunity = { id: string; title: string; clientId: string };
type Seller = { id: string; name: string; role?: string };
type Activity = {
  id: string;
  type: string;
  notes: string;
  dueDate: string;
  done: boolean;
  ownerSellerId: string;
  ownerSeller?: { id: string; name: string };
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

type ActivityFilters = {
  q: string;
  type: string;
  done: "" | "false" | "true";
  month: string;
  clientId: string;
  sellerId: string;
};

const initialForm = { type: "ligacao", notes: "", dueDate: "", clientId: "", opportunityId: "", ownerSellerId: "" };
const initialFilters: ActivityFilters = { q: "", type: "", done: "", month: "", clientId: "", sellerId: "" };

export default function ActivitiesPage() {
  const { user } = useAuth();
  const isSeller = user?.role === "vendedor";
  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";

  const [activities, setActivities] = useState<Activity[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [form, setForm] = useState(initialForm);
  const [clientSearch, setClientSearch] = useState("");
  const [opportunitySearch, setOpportunitySearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filters, setFilters] = useState<ActivityFilters>(initialFilters);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const filteredClients = useMemo(() => {
    const search = clientSearch.trim().toLowerCase();
    if (!search) return clients;
    return clients.filter((item) => item.name.toLowerCase().includes(search));
  }, [clients, clientSearch]);

  const opportunitiesByClient = useMemo(
    () => (form.clientId ? opportunities.filter((item) => item.clientId === form.clientId) : []),
    [opportunities, form.clientId]
  );

  const filteredOpportunities = useMemo(() => {
    const search = opportunitySearch.trim().toLowerCase();
    if (!search) return opportunitiesByClient;
    return opportunitiesByClient.filter((item) => item.title.toLowerCase().includes(search));
  }, [opportunitiesByClient, opportunitySearch]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(filters.q.trim());
    }, 400);

    return () => clearTimeout(timeout);
  }, [filters.q]);

  const loadLookups = async () => {
    try {
      const requests: Promise<any>[] = [api.get("/clients"), api.get("/opportunities")];
      if (canChooseSeller) requests.push(api.get("/users"));
      const [clientsRes, opportunitiesRes, usersRes] = await Promise.all(requests);

      const clientsPayload = Array.isArray(clientsRes.data?.items) ? clientsRes.data.items : clientsRes.data;
      setClients(Array.isArray(clientsPayload) ? clientsPayload.map((item: any) => ({ id: String(item.id), name: String(item.name) })) : []);
      setOpportunities(
        Array.isArray(opportunitiesRes.data)
          ? opportunitiesRes.data.map((item: any) => ({ id: String(item.id), title: String(item.title || ""), clientId: String(item.clientId || "") }))
          : []
      );

      if (canChooseSeller) {
        const users = Array.isArray(usersRes?.data) ? usersRes.data : [];
        setSellers(users.filter((item: any) => item?.role === "vendedor").map((item: any) => ({ id: String(item.id), name: String(item.name), role: String(item.role) })));
      } else if (user?.id && user?.name) {
        setSellers([{ id: user.id, name: user.name }]);
      } else {
        setSellers([]);
      }
    } catch {
      toast.error("Não foi possível carregar listas auxiliares.");
    }
  };

  const loadActivities = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filters.type) params.set("type", filters.type);
      if (filters.done) params.set("done", filters.done);
      if (filters.month) params.set("month", filters.month);
      if (filters.clientId) params.set("clientId", filters.clientId);
      if (canChooseSeller && filters.sellerId) params.set("sellerId", filters.sellerId);

      const response = await api.get(`/activities${params.toString() ? `?${params.toString()}` : ""}`);
      setActivities(Array.isArray(response.data) ? response.data : []);
    } catch {
      setActivities([]);
      toast.error("Não foi possível carregar as atividades.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLookups();
  }, [canChooseSeller]);

  useEffect(() => {
    void loadActivities();
  }, [debouncedSearch, filters.type, filters.done, filters.month, filters.clientId, filters.sellerId, canChooseSeller]);

  const clearFilters = () => {
    setFilters(initialFilters);
    setDebouncedSearch("");
  };

  const openCreateModal = () => {
    setForm({ ...initialForm, ownerSellerId: isSeller && user?.id ? user.id : "" });
    setClientSearch("");
    setOpportunitySearch("");
    setIsModalOpen(true);
  };

  const closeCreateModal = () => {
    setIsModalOpen(false);
    setForm(initialForm);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.clientId || !form.notes.trim() || !form.dueDate) {
      toast.error("Preencha cliente, notas e vencimento.");
      return;
    }

    setSaving(true);
    try {
      await api.post("/activities", {
        type: form.type,
        notes: form.notes.trim(),
        dueDate: new Date(form.dueDate).toISOString(),
        clientId: form.clientId,
        opportunityId: form.opportunityId || undefined,
        ownerSellerId: isSeller && user?.id ? user.id : form.ownerSellerId || undefined
      });
      toast.success("Atividade criada com sucesso.");
      closeCreateModal();
      await loadActivities();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Não foi possível criar a atividade.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Atividades</h2>
        <button type="button" onClick={openCreateModal} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">
          Nova atividade
        </button>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="md:col-span-2 xl:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Busca</label>
            <input
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="Buscar por nota, cliente, oportunidade…"
              value={filters.q}
              onChange={(event) => setFilters((previous) => ({ ...previous, q: event.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Tipo</label>
            <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.type} onChange={(event) => setFilters((previous) => ({ ...previous, type: event.target.value }))}>
              <option value="">Todos</option>
              {ACTIVITY_TYPE_OPTIONS.map((activityType) => (
                <option key={activityType.value} value={activityType.value}>
                  {activityType.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Status</label>
            <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.done} onChange={(event) => setFilters((previous) => ({ ...previous, done: event.target.value as ActivityFilters["done"] }))}>
              <option value="">Todas</option>
              <option value="false">Pendentes</option>
              <option value="true">Concluídas</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Mês</label>
            <input
              type="month"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={filters.month}
              onChange={(event) => setFilters((previous) => ({ ...previous, month: event.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Cliente</label>
            <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.clientId} onChange={(event) => setFilters((previous) => ({ ...previous, clientId: event.target.value }))}>
              <option value="">Todos</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>

          {canChooseSeller ? (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Vendedor</label>
              <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.sellerId} onChange={(event) => setFilters((previous) => ({ ...previous, sellerId: event.target.value }))}>
                <option value="">Todos</option>
                {sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex justify-end">
          <button type="button" onClick={clearFilters} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Limpar filtros
          </button>
        </div>
      </section>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-4 text-slate-500">Carregando...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-left text-brand-800">
                <th className="p-2">Tipo</th>
                <th className="p-2">Cliente</th>
                <th className="p-2">Oportunidade</th>
                <th className="p-2">Vencimento</th>
                <th className="p-2">Concluída</th>
                <th className="p-2">Notas</th>
                <th className="p-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <td className="p-2">{toLabel(item.type)}</td>
                  <td className="p-2">{item.opportunity?.client?.name || "—"}</td>
                  <td className="p-2">{item.opportunity?.title || "—"}</td>
                  <td className="p-2">{new Date(item.dueDate).toLocaleDateString("pt-BR")}</td>
                  <td className="p-2">{item.done ? "Sim" : "Não"}</td>
                  <td className="p-2">{item.notes}</td>
                  <td className="p-2">
                    <button
                      type="button"
                      className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700"
                      disabled={removingId === item.id}
                      onClick={async () => {
                        if (!window.confirm("Tem certeza que deseja excluir esta atividade?")) return;
                        setRemovingId(item.id);
                        try {
                          await api.delete(`/activities/${item.id}`);
                          await loadActivities();
                        } finally {
                          setRemovingId(null);
                        }
                      }}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-xl font-semibold">Nova atividade</h3>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-sm">Tipo</label>
                  <select className="w-full rounded-lg border border-slate-300 p-2" value={form.type} onChange={(event) => setForm((previous) => ({ ...previous, type: event.target.value }))}>
                    {ACTIVITY_TYPE_OPTIONS.map((activityType) => (
                      <option key={activityType.value} value={activityType.value}>
                        {activityType.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm">Vencimento</label>
                  <input type="date" required className="w-full rounded-lg border border-slate-300 p-2" value={form.dueDate} onChange={(event) => setForm((previous) => ({ ...previous, dueDate: event.target.value }))} />
                </div>
                {!isSeller ? (
                  <div className="md:col-span-2">
                    <label className="text-sm">Vendedor responsável</label>
                    <select required className="w-full rounded-lg border border-slate-300 p-2" value={form.ownerSellerId} onChange={(event) => setForm((previous) => ({ ...previous, ownerSellerId: event.target.value }))}>
                      <option value="">Selecione o vendedor</option>
                      {sellers.map((seller) => (
                        <option key={seller.id} value={seller.id}>
                          {seller.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="md:col-span-2">
                  <label className="text-sm">Buscar cliente por nome</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Digite para filtrar clientes" />
                  <select
                    required
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2"
                    value={form.clientId}
                    onChange={(event) => {
                      setForm((previous) => ({ ...previous, clientId: event.target.value, opportunityId: "" }));
                      setOpportunitySearch("");
                    }}
                  >
                    <option value="">Selecione o cliente</option>
                    {filteredClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-sm">Buscar oportunidade por título (opcional)</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2" value={opportunitySearch} disabled={!form.clientId} onChange={(event) => setOpportunitySearch(event.target.value)} placeholder="Digite para filtrar oportunidades" />
                  <select className="mt-1 w-full rounded-lg border border-slate-300 p-2" value={form.opportunityId} onChange={(event) => setForm((previous) => ({ ...previous, opportunityId: event.target.value }))}>
                    <option value="">Sem oportunidade vinculada</option>
                    {filteredOpportunities.map((opportunity) => (
                      <option key={opportunity.id} value={opportunity.id}>
                        {opportunity.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-sm">Notas</label>
                  <textarea required className="min-h-24 w-full rounded-lg border border-slate-300 p-2" value={form.notes} onChange={(event) => setForm((previous) => ({ ...previous, notes: event.target.value }))} />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button type="button" onClick={closeCreateModal} className="rounded-lg border border-slate-300 px-4 py-2">
                  Cancelar
                </button>
                <button type="submit" disabled={saving} className="rounded-lg bg-brand-700 px-4 py-2 text-white">
                  {saving ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
