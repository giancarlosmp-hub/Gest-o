import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { ACTIVITY_TYPE_OPTIONS, toLabel } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import ClientSelect from "../components/ClientSelect";
import ClientSearchSelect, { type SearchableClientOption } from "../components/clients/ClientSearchSelect";
import QuickCreateClientSection from "../components/clients/QuickCreateClientSection";

type Opportunity = { id: string; title: string; clientId: string };
type Seller = { id: string; name: string; role?: string };
type ClientOption = SearchableClientOption;

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
  checkInAt?: string | null;
  checkInLat?: number | null;
  checkInLng?: number | null;
  checkInAccuracy?: number | null;
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

type VisitCheckIn = {
  checkInAt: string;
  checkInLat: number;
  checkInLng: number;
  checkInAccuracy?: number | null;
};


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
  const [clients, setClients] = useState<ClientOption[]>([]);
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
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [visitCheckIn, setVisitCheckIn] = useState<VisitCheckIn | null>(null);
  const [capturingLocation, setCapturingLocation] = useState(false);

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
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

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
      const requests: Promise<any>[] = [api.get("/opportunities"), api.get("/clients")];
      if (canChooseSeller) requests.push(api.get("/users"));
      const [opportunitiesRes, clientsRes, usersRes] = await Promise.all(requests);

      setOpportunities(
        Array.isArray(opportunitiesRes.data)
          ? opportunitiesRes.data.map((item: any) => ({ id: String(item.id), title: String(item.title || ""), clientId: String(item.clientId || "") }))
          : []
      );

      const rawClients = Array.isArray(clientsRes.data?.items) ? clientsRes.data.items : clientsRes.data;
      setClients(
        Array.isArray(rawClients)
          ? rawClients
              .filter((item: any) => item?.id && item?.name)
              .map((item: any) => ({
                id: String(item.id),
                name: String(item.name),
                city: item?.city ? String(item.city) : null,
                state: item?.state ? String(item.state) : null,
                cnpj: item?.cnpj ? String(item.cnpj) : null
              }))
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
    setVisitCheckIn(null);
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
    setVisitCheckIn(null);
    setIsModalOpen(true);
  };

  const closeCreateModal = () => {
    setIsModalOpen(false);
    setForm(initialForm);
    setOpportunitySearch("");
    setVisitCheckIn(null);
  };

  const captureVisitCheckIn = async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("Geolocalização não suportada neste dispositivo.");
      return;
    }

    setCapturingLocation(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });
      });

      const payload: VisitCheckIn = {
        checkInAt: new Date(position.timestamp || Date.now()).toISOString(),
        checkInLat: position.coords.latitude,
        checkInLng: position.coords.longitude,
        checkInAccuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null
      };

      setVisitCheckIn(payload);
      toast.success("Localização registrada com sucesso");
    } catch (error) {
      const code = (error as GeolocationPositionError | undefined)?.code;
      if (code === 1) {
        toast.error("Permissão de localização negada.");
      } else if (code === 2) {
        toast.error("Não foi possível obter sua localização.");
      } else if (code === 3) {
        toast.error("Tempo esgotado ao capturar localização.");
      } else {
        toast.error("Falha ao capturar localização.");
      }
    } finally {
      setCapturingLocation(false);
    }
  };

  const selectExistingClient = (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }) => {
    const clientOption = {
      id: client.id,
      name: client.name,
      city: client.city,
      state: client.state,
      cnpj: client.cnpj
    };

    setClients((current) => {
      const withoutDuplicate = current.filter((item) => item.id !== clientOption.id);
      return [...withoutDuplicate, clientOption].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    });

    setForm((current) => ({ ...current, clientId: clientOption.id, opportunityId: "" }));
    setOpportunitySearch("");
    return clientOption;
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
    if (form.type === "visita" && !visitCheckIn) {
      toast.warning("Você ainda não capturou a localização desta visita");
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
        checkInAt: form.type === "visita" ? visitCheckIn?.checkInAt : undefined,
        checkInLat: form.type === "visita" ? visitCheckIn?.checkInLat : undefined,
        checkInLng: form.type === "visita" ? visitCheckIn?.checkInLng : undefined,
        checkInAccuracy: form.type === "visita" ? visitCheckIn?.checkInAccuracy : undefined,
        clientId: form.clientId,
        opportunityId: form.opportunityId || undefined,
        agendaEventId: form.agendaEventId || undefined,
        ownerSellerId: isSeller && user?.id ? user.id : form.ownerSellerId || undefined
      });
      toast.success("Atividade criada");
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
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-slate-900">Atividades</h2>
          <p className="text-sm text-slate-500">Acompanhe pendências e registre execuções com mais conforto no mobile.</p>
        </div>
        <button type="button" onClick={openCreateModal} className="w-full rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 sm:w-auto">
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
          <button type="button" onClick={clearFilters} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:w-auto">
            Limpar filtros
          </button>
        </div>
      </section>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-4 text-slate-500">Carregando...</div>
        ) : !activities.length ? (
          <div className="p-8 text-center text-slate-500">Nenhuma atividade encontrada para os filtros atuais.</div>
        ) : (
          <>
            <div className="space-y-3 p-3 md:hidden">
              {activities.map((item) => {
                const status = item.status || (item.done ? "realizado" : "agendado");
                return (
                  <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">{item.opportunity?.client?.name || item.client?.name || "Cliente não informado"}</p>
                        <p className="mt-1 text-xs text-slate-500">{toLabel(item.type)} • {new Date(item.dueDate).toLocaleDateString("pt-BR")}</p>
                        {item.type === "visita" && item.checkInAt ? <p className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Check-in realizado</p> : null}
                      </div>
                      <span className={`rounded-full border px-2 py-1 text-center text-xs font-medium leading-5 ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
                    </div>

                    <dl className="mt-3 space-y-2 text-sm text-slate-700">
                      <div>
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Oportunidade</dt>
                        <dd className="break-words text-slate-800">{item.opportunity?.title || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Notas</dt>
                        <dd className="break-words text-slate-800">{item.notes || "—"}</dd>
                      </div>
                    </dl>

                    <div className="mobile-action-stack mt-4" onClick={(event) => event.stopPropagation()}>
                      {status === "agendado" ? (
                        <>
                          <button type="button" className="rounded-md border border-brand-200 px-3 py-2 text-center text-xs font-medium text-brand-700" onClick={() => openExecutionModal(item)}>Executar</button>
                          <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700" onClick={() => openEditModal(item)}>Editar</button>
                          <button type="button" className="rounded-md border border-rose-200 px-3 py-2 text-center text-xs font-medium text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button>
                        </>
                      ) : null}
                      {status === "vencido" ? (
                        <>
                          <button type="button" className="rounded-md border border-brand-200 px-3 py-2 text-center text-xs font-medium text-brand-700" onClick={() => openExecutionModal(item)}>Executar</button>
                          <button type="button" className="rounded-md border border-amber-200 px-3 py-2 text-center text-xs font-medium text-amber-700" onClick={() => openRescheduleModal(item)}>Reagendar</button>
                          <button type="button" className="rounded-md border border-rose-200 px-3 py-2 text-center text-xs font-medium text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button>
                        </>
                      ) : null}
                      {status === "realizado" ? (
                        <>
                          <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700" onClick={() => setSelectedActivity(item)}>Visualizar</button>
                          <button type="button" className="rounded-md border border-emerald-200 px-3 py-2 text-center text-xs font-medium text-emerald-700" onClick={() => openDuplicateModal(item)}>Duplicar</button>
                        </>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="hidden w-full overflow-x-auto md:block">
              <table className="min-w-[720px] w-full text-sm">
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
                          {item.type === "visita" && item.checkInAt ? <span className="mr-2 rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700">Check-in realizado</span> : null}
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
            </div>
          </>
        )}
      </div>

      {selectedActivity ? (
        <div className="mobile-modal-shell" onClick={() => setSelectedActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Detalhes da atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setSelectedActivity(null)}>✕</button>
            </div>
            <div className="mobile-modal-body grid gap-3 md:grid-cols-2">
              <p><strong>Tipo:</strong> {toLabel(selectedActivity.type)}</p>
              <p><strong>Status:</strong> {STATUS_LABEL[selectedActivity.status || (selectedActivity.done ? "realizado" : "agendado")]}</p>
              <p><strong>Cliente:</strong> {selectedActivity.opportunity?.client?.name || selectedActivity.client?.name || "—"}</p>
              <p><strong>Oportunidade:</strong> {selectedActivity.opportunity?.title || "—"}</p>
              <p><strong>Vencimento:</strong> {new Date(selectedActivity.dueDate).toLocaleString("pt-BR")}</p>
              <p><strong>Executada em:</strong> {selectedActivity.date ? new Date(selectedActivity.date).toLocaleString("pt-BR") : "—"}</p>
              <p><strong>Check-in:</strong> {selectedActivity.checkInAt ? new Date(selectedActivity.checkInAt).toLocaleString("pt-BR") : "—"}</p>
              <p><strong>Precisão GPS:</strong> {selectedActivity.checkInAccuracy != null ? `${Math.round(selectedActivity.checkInAccuracy)} m` : "—"}</p>
              <p className="md:col-span-2"><strong>Notas:</strong> {selectedActivity.notes || "—"}</p>
              <p className="md:col-span-2"><strong>Resultado:</strong> {selectedActivity.result || "—"}</p>
              <p className="md:col-span-2"><strong>Observações:</strong> {selectedActivity.description || "—"}</p>
            </div>
          </div>
        </div>
      ) : null}

      {executionActivity ? (
        <div className="mobile-modal-shell" onClick={() => setExecutionActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Executar atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setExecutionActivity(null)}>✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={executeActivity}>
              <div className="mobile-modal-body space-y-3">
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
              </div>
              <div className="mobile-modal-footer">
                <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2" onClick={() => setExecutionActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">{savingAction ? "Salvando..." : "Concluir execução"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {rescheduleActivity ? (
        <div className="mobile-modal-shell" onClick={() => setRescheduleActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Reagendar atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setRescheduleActivity(null)}>✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={reschedule}>
              <div className="mobile-modal-body space-y-3">
              <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} />
              </div>
              <div className="mobile-modal-footer">
                <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2" onClick={() => setRescheduleActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {duplicateActivity ? (
        <div className="mobile-modal-shell" onClick={() => setDuplicateActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Duplicar atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setDuplicateActivity(null)}>✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={duplicate}>
              <div className="mobile-modal-body space-y-3">
              <label className="text-sm">Nova data de vencimento</label>
              <input type="date" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={duplicateDate} onChange={(event) => setDuplicateDate(event.target.value)} />
              </div>
              <div className="mobile-modal-footer">
                <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2" onClick={() => setDuplicateActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">Duplicar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editActivity ? (
        <div className="mobile-modal-shell" onClick={() => setEditActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Editar atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setEditActivity(null)}>✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={edit}>
              <div className="mobile-modal-body space-y-3">
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
              </div>
              <div className="mobile-modal-footer">
                <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2" onClick={() => setEditActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="mobile-modal-shell" onClick={closeCreateModal}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-xl font-semibold">Nova atividade</h3>
                <p className="text-sm text-slate-500">Registre uma próxima ação com cliente e mantenha o funil atualizado.</p>
              </div>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500 hover:bg-slate-50" onClick={closeCreateModal} aria-label="Fechar modal">
                ✕
              </button>
            </div>
            <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
              <div className="mobile-modal-body">
                {isMobile && form.type === "visita" ? (
                  <section className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-emerald-900">Check-in da visita</h4>
                        <p className="text-xs text-emerald-700">Capture sua localização para registrar o check-in no momento da visita.</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-medium ${visitCheckIn ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                        {visitCheckIn ? "Check-in realizado" : "Check-in pendente"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void captureVisitCheckIn()}
                      disabled={capturingLocation}
                      className="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {capturingLocation ? "Capturando localização..." : "Capturar localização"}
                    </button>
                    <div className="mt-3 space-y-1 text-xs text-emerald-800">
                      <p>Status: {visitCheckIn ? "Check-in realizado" : "Aguardando captura"}</p>
                      <p>Horário: {visitCheckIn ? new Date(visitCheckIn.checkInAt).toLocaleTimeString("pt-BR") : "—"}</p>
                      <p>Precisão do GPS: {visitCheckIn?.checkInAccuracy != null ? `${Math.round(visitCheckIn.checkInAccuracy)} m` : "—"}</p>
                    </div>
                  </section>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-sm">Tipo</label>
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 p-2"
                    value={form.type}
                    onChange={(event) => {
                      const nextType = event.target.value;
                      setForm((previous) => ({ ...previous, type: nextType }));
                      if (nextType !== "visita") {
                        setVisitCheckIn(null);
                      }
                    }}
                  >
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
                <div className="md:col-span-2 space-y-2">
                  <label className="text-sm">Cliente</label>
                  <ClientSearchSelect
                    clients={clients}
                    value={form.clientId}
                    onChange={(clientId) => {
                      setForm((previous) => ({ ...previous, clientId, opportunityId: "" }));
                      setOpportunitySearch("");
                    }}
                    required
                    emptyLabel="Nenhum cliente encontrado."
                    className="w-full min-w-0 rounded-lg border border-slate-300 p-2 text-sm"
                  />
                  <div className="mt-2">
                    <QuickCreateClientSection
                      open={isModalOpen}
                      fieldClassName="w-full min-w-0 rounded-lg border border-slate-300 p-2 text-sm"
                      ownerSellerId={isSeller && user?.id ? user.id : form.ownerSellerId || undefined}
                      requireOwnerSeller={canChooseSeller}
                      requireRegion={false}
                      onClientCreated={(client) => {
                        selectExistingClient(client);
                      }}
                      onSelectExisting={(client) => {
                        selectExistingClient(client);
                      }}
                    />
                  </div>
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
              </div>
              <div className="mobile-modal-footer">
                <button type="button" onClick={closeCreateModal} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2">
                  Cancelar
                </button>
                <button type="submit" disabled={saving} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">
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
