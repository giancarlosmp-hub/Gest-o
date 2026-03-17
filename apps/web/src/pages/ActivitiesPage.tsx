import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { ACTIVITY_TYPE_OPTIONS, toLabel } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import ClientSelect from "../components/ClientSelect";

type Opportunity = { id: string; title: string; clientId: string };
type Seller = { id: string; name: string; role?: string };
type ActivityStatus = "agendado" | "vencido" | "realizado";

type Activity = {
  id: string;
  type: string;
  notes: string;
  description?: string | null;
  result?: string | null;
  dueDate: string;
  date?: string | null;
  duration?: number | null;
  city?: string | null;
  crop?: string | null;
  areaEstimated?: number | null;
  product?: string | null;
  agendaEventId?: string | null;
  done: boolean;
  status?: ActivityStatus;
  isOverdue?: boolean;
  ownerSellerId: string;
  ownerSeller?: { id: string; name: string };
  client?: { id: string; name: string } | null;
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

type ActivityFilters = {
  q: string;
  type: string;
  done: "" | "false" | "true";
  month: string;
  clientId: string;
  sellerId: string;
  overdueOnly: boolean;
};

const initialForm = {
  type: "ligacao",
  notes: "",
  observations: "",
  dueDate: "",
  city: "",
  clientId: "",
  opportunityId: "",
  agendaEventId: "",
  ownerSellerId: "",
  result: "",
  duration: "",
  crop: "",
  areaEstimated: "",
  product: "",
  executed: false
};
const initialFilters: ActivityFilters = { q: "", type: "", done: "", month: "", clientId: "", sellerId: "", overdueOnly: false };

const STATUS_LABEL: Record<ActivityStatus, string> = {
  agendado: "Agendado",
  vencido: "Vencido",
  realizado: "Concluído"
};

const STATUS_CLASS: Record<ActivityStatus, string> = {
  agendado: "border-sky-200 bg-sky-100 text-sky-700",
  vencido: "border-rose-200 bg-rose-100 text-rose-700",
  realizado: "border-emerald-200 bg-emerald-100 text-emerald-700"
};

export default function ActivitiesPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSeller = user?.role === "vendedor";
  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";

  const [activities, setActivities] = useState<Activity[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [form, setForm] = useState(initialForm);
  const [opportunitySearch, setOpportunitySearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);
  const [executionActivity, setExecutionActivity] = useState<Activity | null>(null);
  const [rescheduleActivity, setRescheduleActivity] = useState<Activity | null>(null);
  const [duplicateActivity, setDuplicateActivity] = useState<Activity | null>(null);
  const [editActivity, setEditActivity] = useState<Activity | null>(null);
  const [filters, setFilters] = useState<ActivityFilters>(initialFilters);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [executionForm, setExecutionForm] = useState({ result: "", observations: "", duration: "" });
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [duplicateDate, setDuplicateDate] = useState("");
  const [editForm, setEditForm] = useState({ type: "ligacao", notes: "", dueDate: "", duration: "" });

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

  useEffect(() => {
    if (!isModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCreateModal();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isModalOpen]);

  const loadLookups = async () => {
    try {
      const requests: Promise<any>[] = [api.get("/opportunities")];
      if (canChooseSeller) requests.push(api.get("/users"));
      const [opportunitiesRes, usersRes] = await Promise.all(requests);

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
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível carregar listas auxiliares."));
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
      if (filters.overdueOnly) params.set("overdueOnly", "true");

      const response = await api.get(`/activities${params.toString() ? `?${params.toString()}` : ""}`);
      setActivities(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      setActivities([]);
      toast.error(getApiErrorMessage(error, "Não foi possível carregar as atividades."));
    } finally {
      setLoading(false);
    }
  };

  const refreshAfterMutation = async () => {
    await loadActivities();
    triggerDashboardRefresh({ month: new Date().toISOString().slice(0, 7) });
  };

  useEffect(() => {
    void loadLookups();
  }, [canChooseSeller]);

  useEffect(() => {
    void loadActivities();
  }, [debouncedSearch, filters.type, filters.done, filters.month, filters.clientId, filters.sellerId, filters.overdueOnly, canChooseSeller]);

  useEffect(() => {
    const openFromAgenda = searchParams.get("open") === "create";
    if (!openFromAgenda) return;

    const date = searchParams.get("date") || "";
    const type = searchParams.get("type") || "ligacao";
    const clientId = searchParams.get("clientId") || "";
    const opportunityId = searchParams.get("opportunityId") || "";
    const agendaEventId = searchParams.get("agendaEventId") || "";
    const ownerSellerId = searchParams.get("ownerSellerId") || "";
    const notes = searchParams.get("notes") || "";
    const title = searchParams.get("title") || "";
    const city = searchParams.get("city") || "";

    setForm((current) => ({
      ...current,
      type: ACTIVITY_TYPE_OPTIONS.some((option) => option.value === type) ? type : current.type,
      dueDate: date ? new Date(date).toISOString().slice(0, 10) : current.dueDate,
      clientId,
      opportunityId,
      agendaEventId,
      ownerSellerId: ownerSellerId || current.ownerSellerId,
      notes: notes || title || current.notes,
      city: city || current.city
    }));
    setIsModalOpen(true);

    const params = new URLSearchParams(searchParams);
    params.delete("open");
    params.delete("date");
    params.delete("type");
    params.delete("clientId");
    params.delete("opportunityId");
    params.delete("agendaEventId");
    params.delete("ownerSellerId");
    params.delete("notes");
    params.delete("title");
    params.delete("city");
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const clearFilters = () => {
    setFilters(initialFilters);
    setDebouncedSearch("");
  };

  const openCreateModal = () => {
    setForm({ ...initialForm, ownerSellerId: isSeller && user?.id ? user.id : "" });
    setOpportunitySearch("");
    setIsModalOpen(true);
  };

  const closeCreateModal = () => {
    setIsModalOpen(false);
    setForm(initialForm);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const requiresExecutionFields = form.executed;
    if (!form.clientId || !form.notes.trim() || !form.dueDate || (canChooseSeller && !form.ownerSellerId)) {
      toast.error(canChooseSeller ? "Preencha vendedor, cliente, notas e vencimento." : "Preencha cliente, notas e vencimento.");
      return;
    }
    if (requiresExecutionFields && (!form.result.trim() || !form.observations.trim() || !form.duration)) {
      toast.error("Para atividades já realizadas, preencha resultado, observações e duração.");
      return;
    }

    setSaving(true);
    try {
      await api.post("/activities", {
        type: form.type,
        notes: form.notes.trim(),
        description: requiresExecutionFields ? form.observations.trim() : form.notes.trim(),
        result: requiresExecutionFields ? form.result.trim() : undefined,
        dueDate: new Date(form.dueDate).toISOString(),
        date: requiresExecutionFields ? new Date().toISOString() : new Date(form.dueDate).toISOString(),
        duration: requiresExecutionFields ? Number(form.duration) : undefined,
        done: requiresExecutionFields,
        city: form.city || undefined,
        crop: form.crop.trim() || undefined,
        areaEstimated: form.areaEstimated ? Number(form.areaEstimated) : undefined,
        product: form.product.trim() || undefined,
        clientId: form.clientId,
        opportunityId: form.opportunityId || undefined,
        agendaEventId: form.agendaEventId || undefined,
        ownerSellerId: isSeller && user?.id ? user.id : form.ownerSellerId || undefined
      });
      toast.success(form.agendaEventId ? "Atividade registrada com sucesso" : "Atividade criada com sucesso.");
      if (form.agendaEventId) {
        toast.success("Compromisso concluído automaticamente");
      }
      closeCreateModal();
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível criar a atividade."));
    } finally {
      setSaving(false);
    }
  };

  const deleteActivity = async (id: string) => {
    if (!window.confirm("Tem certeza que deseja excluir esta atividade?")) return;
    setRemovingId(id);
    try {
      await api.delete(`/activities/${id}`);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível excluir a atividade."));
    } finally {
      setRemovingId(null);
    }
  };

  const openExecutionModal = (activity: Activity) => {
    setExecutionActivity(activity);
    setExecutionForm({ result: activity.result || "", observations: activity.description || "", duration: activity.duration ? String(activity.duration) : "" });
  };

  const executeActivity = async (event: FormEvent) => {
    event.preventDefault();
    if (!executionActivity) return;
    setSavingAction(true);
    try {
      await api.put(`/activities/${executionActivity.id}`, {
        done: true,
        date: new Date().toISOString(),
        result: executionForm.result.trim() || null,
        description: executionForm.observations.trim() || null,
        duration: executionForm.duration ? Number(executionForm.duration) : null
      });
      toast.success("Atividade executada com sucesso.");
      setExecutionActivity(null);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível executar a atividade."));
    } finally {
      setSavingAction(false);
    }
  };

  const openRescheduleModal = (activity: Activity) => {
    setRescheduleActivity(activity);
    setRescheduleDate(new Date(activity.dueDate).toISOString().slice(0, 10));
  };

  const reschedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!rescheduleActivity || !rescheduleDate) return;
    setSavingAction(true);
    try {
      await api.put(`/activities/${rescheduleActivity.id}`, {
        dueDate: new Date(rescheduleDate).toISOString()
      });
      toast.success("Atividade reagendada.");
      setRescheduleActivity(null);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível reagendar a atividade."));
    } finally {
      setSavingAction(false);
    }
  };

  const openDuplicateModal = (activity: Activity) => {
    setDuplicateActivity(activity);
    setDuplicateDate("");
  };

  const duplicate = async (event: FormEvent) => {
    event.preventDefault();
    if (!duplicateActivity || !duplicateDate) return;
    setSavingAction(true);
    try {
      await api.post("/activities", {
        type: duplicateActivity.type,
        notes: duplicateActivity.notes,
        description: duplicateActivity.description || duplicateActivity.notes,
        dueDate: new Date(duplicateDate).toISOString(),
        date: new Date(duplicateDate).toISOString(),
        duration: duplicateActivity.duration || undefined,
        city: duplicateActivity.city || undefined,
        crop: duplicateActivity.crop || undefined,
        areaEstimated: duplicateActivity.areaEstimated || undefined,
        product: duplicateActivity.product || undefined,
        clientId: duplicateActivity.client?.id || duplicateActivity.opportunity?.client?.id,
        opportunityId: duplicateActivity.opportunity?.id || undefined,
        ownerSellerId: duplicateActivity.ownerSellerId
      });
      toast.success("Atividade duplicada com sucesso.");
      setDuplicateActivity(null);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível duplicar a atividade."));
    } finally {
      setSavingAction(false);
    }
  };

  const openEditModal = (activity: Activity) => {
    setEditActivity(activity);
    setEditForm({
      type: activity.type,
      notes: activity.notes,
      dueDate: new Date(activity.dueDate).toISOString().slice(0, 10),
      duration: activity.duration ? String(activity.duration) : ""
    });
  };

  const edit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editActivity) return;
    setSavingAction(true);
    try {
      await api.put(`/activities/${editActivity.id}`, {
        type: editForm.type,
        notes: editForm.notes.trim(),
        dueDate: new Date(editForm.dueDate).toISOString(),
        duration: editForm.duration ? Number(editForm.duration) : null
      });
      toast.success("Atividade atualizada com sucesso.");
      setEditActivity(null);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível atualizar a atividade."));
    } finally {
      setSavingAction(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Atividades</h2>
        <button type="button" onClick={openCreateModal} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">
          Nova atividade
        </button>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <div className="md:col-span-2 xl:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Busca</label>
            <input
              className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="Buscar por nota, cliente, oportunidade…"
              value={filters.q}
              onChange={(event) => setFilters((previous) => ({ ...previous, q: event.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Tipo</label>
            <select className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.type} onChange={(event) => setFilters((previous) => ({ ...previous, type: event.target.value }))}>
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
            <select className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.done} onChange={(event) => setFilters((previous) => ({ ...previous, done: event.target.value as ActivityFilters["done"] }))}>
              <option value="">Todas</option>
              <option value="false">Pendentes</option>
              <option value="true">Concluídas</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Mês</label>
            <input
              type="month"
              className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={filters.month}
              onChange={(event) => setFilters((previous) => ({ ...previous, month: event.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Cliente</label>
            <ClientSelect
              value={filters.clientId}
              onChange={(client) => setFilters((previous) => ({ ...previous, clientId: client?.id || "" }))}
            />
          </div>

          <div className="flex items-end">
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <input type="checkbox" checked={filters.overdueOnly} onChange={(event) => setFilters((previous) => ({ ...previous, overdueOnly: event.target.checked }))} />
              Somente vencidos
            </label>
          </div>

          {canChooseSeller ? (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Vendedor</label>
              <select className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" value={filters.sellerId} onChange={(event) => setFilters((previous) => ({ ...previous, sellerId: event.target.value }))}>
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

      <div className="w-full overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-4 text-slate-500">Carregando...</div>
        ) : !activities.length ? (
          <div className="p-8 text-center text-slate-500">Nenhuma atividade encontrada para os filtros atuais.</div>
        ) : (
          <table className="min-w-[600px] w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-left text-brand-800">
                <th className="p-2">Tipo</th>
                <th className="p-2">Cliente</th>
                <th className="p-2">Oportunidade</th>
                <th className="p-2">Vencimento</th>
                <th className="p-2">Status</th>
                <th className="p-2">Notas</th>
                <th className="p-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((item) => {
                const status = item.status || (item.done ? "realizado" : "agendado");
                return (
                  <tr key={item.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setSelectedActivity(item)}>
                    <td className="p-2">{toLabel(item.type)}</td>
                    <td className="p-2">{item.opportunity?.client?.name || item.client?.name || "—"}</td>
                    <td className="p-2">{item.opportunity?.title || "—"}</td>
                    <td className="p-2">{new Date(item.dueDate).toLocaleDateString("pt-BR")}</td>
                    <td className="p-2">
                      <span className={`rounded-full border px-2 py-1 text-xs font-medium ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
                    </td>
                    <td className="p-2">{item.notes}</td>
                    <td className="p-2">
                      <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                        {status === "agendado" ? (
                          <>
                            <button type="button" className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700" onClick={() => openExecutionModal(item)}>Executar</button>
                            <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => openEditModal(item)}>Editar</button>
                            <button type="button" className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button>
                          </>
                        ) : null}
                        {status === "vencido" ? (
                          <>
                            <button type="button" className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700" onClick={() => openExecutionModal(item)}>Executar</button>
                            <button type="button" className="rounded-md border border-amber-200 px-2 py-1 text-xs text-amber-700" onClick={() => openRescheduleModal(item)}>Reagendar</button>
                            <button type="button" className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button>
                          </>
                        ) : null}
                        {status === "realizado" ? (
                          <>
                            <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setSelectedActivity(item)}>Visualizar</button>
                            <button type="button" className="rounded-md border border-emerald-200 px-2 py-1 text-xs text-emerald-700" onClick={() => openDuplicateModal(item)}>Duplicar</button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedActivity ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelectedActivity(null)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xl font-semibold">Detalhes da atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setSelectedActivity(null)}>✕</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <p><strong>Tipo:</strong> {toLabel(selectedActivity.type)}</p>
              <p><strong>Status:</strong> {STATUS_LABEL[selectedActivity.status || (selectedActivity.done ? "realizado" : "agendado")]}</p>
              <p><strong>Cliente:</strong> {selectedActivity.opportunity?.client?.name || selectedActivity.client?.name || "—"}</p>
              <p><strong>Oportunidade:</strong> {selectedActivity.opportunity?.title || "—"}</p>
              <p><strong>Vencimento:</strong> {new Date(selectedActivity.dueDate).toLocaleString("pt-BR")}</p>
              <p><strong>Executada em:</strong> {selectedActivity.date ? new Date(selectedActivity.date).toLocaleString("pt-BR") : "—"}</p>
              <p className="md:col-span-2"><strong>Notas:</strong> {selectedActivity.notes || "—"}</p>
              <p className="md:col-span-2"><strong>Resultado:</strong> {selectedActivity.result || "—"}</p>
              <p className="md:col-span-2"><strong>Observações:</strong> {selectedActivity.description || "—"}</p>
            </div>
          </div>
        </div>
      ) : null}

      {executionActivity ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setExecutionActivity(null)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-xl font-semibold">Executar atividade</h3>
            <form className="space-y-3" onSubmit={executeActivity}>
              <div>
                <label className="text-sm">Resultado</label>
                <input className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={executionForm.result} onChange={(event) => setExecutionForm((previous) => ({ ...previous, result: event.target.value }))} />
              </div>
              <div>
                <label className="text-sm">Observações</label>
                <textarea className="min-h-20 w-full min-w-0 rounded-lg border border-slate-300 p-2" value={executionForm.observations} onChange={(event) => setExecutionForm((previous) => ({ ...previous, observations: event.target.value }))} />
              </div>
              <div>
                <label className="text-sm">Duração real (minutos)</label>
                <input type="number" min={0} className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={executionForm.duration} onChange={(event) => setExecutionForm((previous) => ({ ...previous, duration: event.target.value }))} />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-lg border border-slate-300 px-4 py-2" onClick={() => setExecutionActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="rounded-lg bg-brand-700 px-4 py-2 text-white">{savingAction ? "Salvando..." : "Concluir execução"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {rescheduleActivity ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setRescheduleActivity(null)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-xl font-semibold">Reagendar atividade</h3>
            <form className="space-y-3" onSubmit={reschedule}>
              <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} />
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-lg border border-slate-300 px-4 py-2" onClick={() => setRescheduleActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="rounded-lg bg-brand-700 px-4 py-2 text-white">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {duplicateActivity ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setDuplicateActivity(null)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-xl font-semibold">Duplicar atividade</h3>
            <form className="space-y-3" onSubmit={duplicate}>
              <label className="text-sm">Nova data de vencimento</label>
              <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={duplicateDate} onChange={(event) => setDuplicateDate(event.target.value)} />
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-lg border border-slate-300 px-4 py-2" onClick={() => setDuplicateActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="rounded-lg bg-brand-700 px-4 py-2 text-white">Duplicar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editActivity ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEditActivity(null)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-xl font-semibold">Editar atividade</h3>
            <form className="space-y-3" onSubmit={edit}>
              <div>
                <label className="text-sm">Tipo</label>
                <select className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={editForm.type} onChange={(event) => setEditForm((previous) => ({ ...previous, type: event.target.value }))}>
                  {ACTIVITY_TYPE_OPTIONS.map((activityType) => (
                    <option key={activityType.value} value={activityType.value}>{activityType.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm">Notas</label>
                <textarea required className="min-h-20 w-full min-w-0 rounded-lg border border-slate-300 p-2" value={editForm.notes} onChange={(event) => setEditForm((previous) => ({ ...previous, notes: event.target.value }))} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm">Vencimento</label>
                  <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={editForm.dueDate} onChange={(event) => setEditForm((previous) => ({ ...previous, dueDate: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm">Duração (min)</label>
                  <input type="number" min={0} className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={editForm.duration} onChange={(event) => setEditForm((previous) => ({ ...previous, duration: event.target.value }))} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-lg border border-slate-300 px-4 py-2" onClick={() => setEditActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="rounded-lg bg-brand-700 px-4 py-2 text-white">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeCreateModal}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold">Nova atividade</h3>
                <p className="text-sm text-slate-500">Registre uma próxima ação com cliente e mantenha o funil atualizado.</p>
              </div>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500 hover:bg-slate-50" onClick={closeCreateModal} aria-label="Fechar modal">
                ✕
              </button>
            </div>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-sm">Tipo</label>
                  <select className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.type} onChange={(event) => setForm((previous) => ({ ...previous, type: event.target.value }))}>
                    {ACTIVITY_TYPE_OPTIONS.map((activityType) => (
                      <option key={activityType.value} value={activityType.value}>
                        {activityType.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm">Vencimento</label>
                  <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.dueDate} onChange={(event) => setForm((previous) => ({ ...previous, dueDate: event.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.executed}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          executed: event.target.checked,
                          ...(event.target.checked ? {} : { result: "", observations: "", duration: "" })
                        }))
                      }
                    />
                    Atividade já realizada
                  </label>
                </div>
                {canChooseSeller ? (
                  <div className="md:col-span-2">
                    <label className="text-sm">Vendedor responsável</label>
                    <select required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.ownerSellerId} onChange={(event) => setForm((previous) => ({ ...previous, ownerSellerId: event.target.value }))}>
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
                  <label className="text-sm">Cliente</label>
                  <ClientSelect
                    value={form.clientId}
                    onChange={(client) => {
                      setForm((previous) => ({ ...previous, clientId: client?.id || "", opportunityId: "" }));
                      setOpportunitySearch("");
                    }}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="text-sm">Buscar oportunidade por título (opcional)</label>
                  <input className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={opportunitySearch} disabled={!form.clientId} onChange={(event) => setOpportunitySearch(event.target.value)} placeholder="Digite para filtrar oportunidades" />
                  <select className="mt-1 w-full rounded-lg border border-slate-300 p-2" value={form.opportunityId} onChange={(event) => setForm((previous) => ({ ...previous, opportunityId: event.target.value }))}>
                    <option value="">Sem oportunidade vinculada</option>
                    {filteredOpportunities.map((opportunity) => (
                      <option key={opportunity.id} value={opportunity.id}>
                        {opportunity.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm">Resultado {form.executed ? "" : "(opcional)"}</label>
                  <input required={form.executed} disabled={!form.executed} className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-100" value={form.result} onChange={(event) => setForm((previous) => ({ ...previous, result: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm">Duração em minutos {form.executed ? "" : "(opcional)"}</label>
                  <input type="number" min={0} required={form.executed} disabled={!form.executed} className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-100" value={form.duration} onChange={(event) => setForm((previous) => ({ ...previous, duration: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm">Cultura (opcional)</label>
                  <input className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.crop} onChange={(event) => setForm((previous) => ({ ...previous, crop: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm">Área estimada (opcional)</label>
                  <input type="number" step="0.01" min={0} className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.areaEstimated} onChange={(event) => setForm((previous) => ({ ...previous, areaEstimated: event.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <label className="text-sm">Produto (opcional)</label>
                  <input className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.product} onChange={(event) => setForm((previous) => ({ ...previous, product: event.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <label className="text-sm">Observações {form.executed ? "" : "(opcional)"}</label>
                  <textarea
                    required={form.executed}
                    disabled={!form.executed}
                    className="min-h-24 w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-100"
                    value={form.observations}
                    onChange={(event) => setForm((previous) => ({ ...previous, observations: event.target.value }))}
                  />
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
