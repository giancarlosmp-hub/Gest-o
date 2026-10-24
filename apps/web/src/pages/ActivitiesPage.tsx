import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { ACTIVITY_CATALOG_OPTIONS, ACTIVITY_TYPE_OPTIONS, isActivityCatalogType, toLabel } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import ClientSelect from "../components/ClientSelect";
import ClientSearchSelect, { type SearchableClientOption } from "../components/clients/ClientSearchSelect";
import QuickCreateClientSection from "../components/clients/QuickCreateClientSection";
import { brazilDateTime, brazilDayKeyOf, brazilMonthKey, brazilTimeKey, brazilTodayKey, formatBrazil, shiftBrazilDayKey } from "../lib/brazilDate";
import { AGENDA_EVENT_TYPE_LABELS, AGENDA_EVENT_TYPE_OPTIONS, type AgendaEventType } from "@salesforce-pro/shared";
import {
  activityDateTimeDefaults,
  activityFormError,
  activityTypeForAgendaType,
  agendaEventActions,
  completeAgendaEventHref,
  needsNextStepDecision,
  NEXT_STEP_DEFAULT_DURATION,
  NEXT_STEP_REQUIRED_MESSAGE,
  nextStepPayload,
  type NextStepMode
} from "../lib/agendaActivity";
import { NotDoneDialog, RescheduleDialog } from "../components/agenda/AgendaEventDialogs";
import {
  clearVisitDraft,
  hasVisitDraftContent,
  loadVisitDraft,
  saveVisitDraft,
  VISIT_DRAFT_CHANGE_EVENT,
  VISIT_DRAFT_RESUME_PARAM,
  type VisitDraft
} from "../lib/visitDraft";

// Próximo passo vira compromisso na Agenda (catálogo único, sem roteiro).
const NEXT_STEP_TYPE_OPTIONS = AGENDA_EVENT_TYPE_OPTIONS.filter((option) => option.value !== "roteiro_visita");

type Opportunity = { id: string; title: string; clientId: string; stage: string };

// Compromisso pendente (GET /agenda/pending): passado e ainda agendado.
type PendingAgendaEvent = {
  id: string;
  ownerId: string;
  type: AgendaEventType;
  title: string;
  startsAt: string;
  endsAt: string;
  status: "planned";
  notes?: string | null;
  clientId?: string | null;
  opportunityId?: string | null;
  city?: string | null;
};
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
  // Dia (YYYY-MM-DD) e horário (HH:MM) de Brasília em que a atividade foi feita.
  dueDate: "",
  time: "",
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
  nextStepMode: "" as NextStepMode,
  nextStepType: "",
  nextStepDay: "",
  nextStepTime: "",
  nextStepDuration: NEXT_STEP_DEFAULT_DURATION,
  noNextStepReason: ""
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
  const [editActivity, setEditActivity] = useState<Activity | null>(null);
  const [filters, setFilters] = useState<ActivityFilters>(initialFilters);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [executionForm, setExecutionForm] = useState({ result: "", observations: "", duration: "" });
  const [editForm, setEditForm] = useState({ type: "ligacao", notes: "", dueDate: "", duration: "" });
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [visitCheckIn, setVisitCheckIn] = useState<VisitCheckIn | null>(null);
  // Visita em andamento: só a sessão do formulário que criou ou restaurou o rascunho grava nele, para uma Nova
  // atividade aberta com outro rascunho ativo não sobrescrevê-lo.
  const [canWriteVisitDraft, setCanWriteVisitDraft] = useState(false);
  const [hasVisitDraft, setHasVisitDraft] = useState(false);
  const [capturingLocation, setCapturingLocation] = useState(false);
  const [pendingEvents, setPendingEvents] = useState<PendingAgendaEvent[]>([]);
  const [pendingOlderCount, setPendingOlderCount] = useState<number | null>(null);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [rescheduleTarget, setRescheduleTarget] = useState<PendingAgendaEvent | null>(null);
  const [notDoneTarget, setNotDoneTarget] = useState<PendingAgendaEvent | null>(null);

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
          ? opportunitiesRes.data.map((item: any) => ({ id: String(item.id), title: String(item.title || ""), clientId: String(item.clientId || ""), stage: String(item.stage || "") }))
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
                fantasyName: item?.fantasyName ? String(item.fantasyName) : null,
                code: item?.code ? String(item.code) : null,
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

  // Pendências: compromissos passados ainda agendados dos últimos 30 dias. Gerente e diretor recebem também o
  // contador dos mais antigos; o filtro de vendedor da lista vale aqui.
  const loadPending = async () => {
    setPendingLoading(true);
    try {
      const response = await api.get("/agenda/pending", { params: canChooseSeller && filters.sellerId ? { sellerId: filters.sellerId } : {} });
      setPendingEvents(Array.isArray(response.data?.items) ? response.data.items : []);
      setPendingOlderCount(typeof response.data?.olderCount === "number" ? response.data.olderCount : null);
    } catch (error) {
      setPendingEvents([]);
      setPendingOlderCount(null);
      toast.error(getApiErrorMessage(error, "Não foi possível carregar as pendências."));
    } finally {
      setPendingLoading(false);
    }
  };

  const refreshAfterMutation = async () => {
    await Promise.all([loadActivities(), loadPending()]);
    triggerDashboardRefresh({ month: brazilMonthKey() });
  };

  useEffect(() => {
    void loadLookups();
  }, [canChooseSeller]);

  useEffect(() => {
    void loadActivities();
  }, [debouncedSearch, filters.type, filters.done, filters.month, filters.clientId, filters.sellerId, filters.overdueOnly, canChooseSeller]);

  useEffect(() => {
    void loadPending();
  }, [filters.sellerId, canChooseSeller]);

  const restoreVisitDraft = (draft: VisitDraft) => {
    setForm({
      ...initialForm,
      type: draft.type,
      dueDate: draft.dueDate,
      time: draft.time || activityDateTimeDefaults(draft.dueDate).time,
      clientId: draft.clientId,
      opportunityId: draft.opportunityId,
      agendaEventId: draft.agendaEventId,
      ownerSellerId: draft.ownerSellerId || (isSeller && user?.id ? user.id : ""),
      city: draft.city,
      notes: draft.notes,
      observations: draft.observations,
      result: draft.result
    });
    setVisitCheckIn(draft.checkIn);
    setOpportunitySearch("");
    setCanWriteVisitDraft(true);
    setIsModalOpen(true);
  };

  useEffect(() => {
    const refresh = () => setHasVisitDraft(Boolean(loadVisitDraft(user?.id)));
    refresh();
    window.addEventListener(VISIT_DRAFT_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(VISIT_DRAFT_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [user?.id]);

  // "Continuar" do aviso de visita em andamento.
  useEffect(() => {
    if (searchParams.get(VISIT_DRAFT_RESUME_PARAM) !== "1") return;
    const draft = loadVisitDraft(user?.id);
    if (draft) restoreVisitDraft(draft);
    else toast.info("A visita em andamento expirou ou foi descartada.");
    const params = new URLSearchParams(searchParams);
    params.delete(VISIT_DRAFT_RESUME_PARAM);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams, user?.id]);

  // Grava o rascunho da visita a cada mudança, depois do check-in ou de algo preenchido.
  useEffect(() => {
    if (!isModalOpen || !canWriteVisitDraft || form.type !== "visita") return;
    const draft = {
      type: form.type,
      dueDate: form.dueDate,
      time: form.time,
      clientId: form.clientId,
      opportunityId: form.opportunityId,
      agendaEventId: form.agendaEventId,
      ownerSellerId: form.ownerSellerId,
      city: form.city,
      notes: form.notes,
      observations: form.observations,
      result: form.result,
      checkIn: visitCheckIn
    };
    if (hasVisitDraftContent(draft)) saveVisitDraft(user?.id, draft);
  }, [isModalOpen, canWriteVisitDraft, form, visitCheckIn, user?.id]);

  useEffect(() => {
    const openFromAgenda = searchParams.get("open") === "create";
    if (!openFromAgenda) return;

    // O botão "Visita" com uma visita em andamento continua o rascunho em vez de começar outra.
    const activeDraft = loadVisitDraft(user?.id);
    if (searchParams.get("type") === "visita" && activeDraft) {
      restoreVisitDraft(activeDraft);
      const params = new URLSearchParams(searchParams);
      for (const key of ["open", "date", "type", "clientId", "opportunityId", "agendaEventId", "ownerSellerId", "notes", "title", "city", "executed"]) params.delete(key);
      setSearchParams(params, { replace: true });
      return;
    }
    setCanWriteVisitDraft(!activeDraft);

    const date = searchParams.get("date") || "";
    const type = searchParams.get("type") || "ligacao";
    const clientId = searchParams.get("clientId") || "";
    const opportunityId = searchParams.get("opportunityId") || "";
    const agendaEventId = searchParams.get("agendaEventId") || "";
    const ownerSellerId = searchParams.get("ownerSellerId") || "";
    const notes = searchParams.get("notes") || "";
    const title = searchParams.get("title") || "";
    const city = searchParams.get("city") || "";
    // Data e hora preenchidas (Agenda, Planejamento, barra rápida) em Brasília, nunca depois de agora.
    const prefilled = activityDateTimeDefaults(date);

    setForm((current) => ({
      ...current,
      // Tipo fora do catálogo (followup do Planejamento, legados) entra como o equivalente do catálogo.
      type: activityTypeForAgendaType(type),
      dueDate: prefilled.day,
      time: prefilled.time,
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
    params.delete("executed");
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams, user?.id]);

  const clearFilters = () => {
    setFilters(initialFilters);
    setDebouncedSearch("");
  };

  const openCreateModal = () => {
    const now = activityDateTimeDefaults();
    setForm({ ...initialForm, dueDate: now.day, time: now.time, ownerSellerId: isSeller && user?.id ? user.id : "" });
    setOpportunitySearch("");
    setVisitCheckIn(null);
    setCanWriteVisitDraft(!loadVisitDraft(user?.id));
    setIsModalOpen(true);
  };

  // Fechar sem salvar mantém o rascunho: a visita continua em andamento.
  const closeCreateModal = () => {
    setIsModalOpen(false);
    setForm(initialForm);
    setOpportunitySearch("");
    setVisitCheckIn(null);
    setCanWriteVisitDraft(false);
  };

  const discardVisitDraft = () => {
    clearVisitDraft(user?.id);
    closeCreateModal();
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

  const selectExistingClient = (client: {
    id: string;
    name: string;
    fantasyName?: string | null;
    code?: string | null;
    city?: string | null;
    state?: string | null;
    cnpj?: string | null;
  }) => {
    const clientOption = {
      id: client.id,
      name: client.name,
      fantasyName: client.fantasyName,
      code: client.code,
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

  // Oportunidade aberta (não ganha nem perdida) pede o próximo passo ou o motivo de não haver um.
  const selectedOpportunity = opportunities.find((item) => item.id === form.opportunityId);
  const opportunityOpen = Boolean(selectedOpportunity && selectedOpportunity.stage !== "ganho" && selectedOpportunity.stage !== "perdido");
  const nextStepForm = {
    mode: form.nextStepMode,
    type: form.nextStepType,
    day: form.nextStepDay,
    time: form.nextStepTime,
    durationMinutes: form.nextStepDuration,
    reason: form.noNextStepReason
  };
  const showNextStepWarning = needsNextStepDecision(nextStepForm, opportunityOpen);
  // Registro aberto pelo "Concluir" de um compromisso: cliente e oportunidade são os do compromisso.
  const isLinkedToAgendaEvent = Boolean(form.agendaEventId);

  const chooseNextStepMode = (mode: NextStepMode) => {
    setForm((previous) => ({
      ...previous,
      nextStepMode: mode,
      // Sugestão: amanhã às 9h; o vendedor ajusta.
      nextStepDay: mode === "schedule" && !previous.nextStepDay ? shiftBrazilDayKey(brazilTodayKey(), 1) : previous.nextStepDay,
      nextStepTime: mode === "schedule" && !previous.nextStepTime ? "09:00" : previous.nextStepTime
    }));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!isLinkedToAgendaEvent && !form.clientId) || (canChooseSeller && !isLinkedToAgendaEvent && !form.ownerSellerId)) {
      toast.error(canChooseSeller ? "Preencha vendedor e cliente." : "Preencha o cliente.");
      return;
    }
    const formError = activityFormError({ day: form.dueDate, time: form.time, summary: form.observations, opportunityOpen, nextStep: nextStepForm });
    if (formError) {
      toast.error(formError);
      return;
    }
    if (form.type === "visita" && !visitCheckIn) {
      toast.warning("Você ainda não capturou a localização desta visita");
    }

    setSaving(true);
    try {
      // A data e a hora escolhidas (Brasília) são gravadas como o momento da atividade.
      const activityAt = brazilDateTime(form.dueDate, form.time).toISOString();
      const payload: any = {
        type: form.type,
        notes: form.notes.trim() || undefined,
        description: form.observations.trim(),
        dueDate: activityAt,
        date: activityAt,
        duration: form.duration ? Number(form.duration) : undefined,
        city: form.city || undefined,
        crop: form.crop.trim() || undefined,
        areaEstimated: form.areaEstimated ? Number(form.areaEstimated) : undefined,
        product: form.product.trim() || undefined,
        checkInAt: form.type === "visita" ? visitCheckIn?.checkInAt : undefined,
        checkInLat: form.type === "visita" ? visitCheckIn?.checkInLat : undefined,
        checkInLng: form.type === "visita" ? visitCheckIn?.checkInLng : undefined,
        checkInAccuracy: form.type === "visita" ? visitCheckIn?.checkInAccuracy : undefined
      };

      if (form.result.trim().length > 0) {
        payload.result = form.result.trim();
      }
      if (form.nextStepMode === "schedule") {
        payload.nextStep = nextStepPayload(nextStepForm);
      } else if (form.nextStepMode === "none" && form.noNextStepReason.trim()) {
        payload.noNextStepReason = form.noNextStepReason.trim();
      }

      if (isLinkedToAgendaEvent) {
        // "Concluir": cria a atividade com cliente, oportunidade e vendedor do compromisso e o marca como realizado.
        await api.post(`/agenda/events/${form.agendaEventId}/complete`, payload);
      } else {
        await api.post("/activities", {
          ...payload,
          done: true,
          clientId: form.clientId,
          opportunityId: form.opportunityId || undefined,
          ownerSellerId: isSeller && user?.id ? user.id : form.ownerSellerId || undefined
        });
      }
      if (form.type === "visita" && canWriteVisitDraft) clearVisitDraft(user?.id);
      toast.success(isLinkedToAgendaEvent ? "Atividade registrada e compromisso concluído." : "Atividade registrada.");
      if (payload.nextStep) toast.success("Próximo passo agendado na Agenda.");
      closeCreateModal();
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível registrar a atividade."));
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
    if (!executionForm.observations.trim()) {
      toast.error("Preencha o resumo da visita para concluir.");
      return;
    }
    setSavingAction(true);
    try {
      const payload: any = {
        done: true,
        date: new Date().toISOString(),
        description: executionForm.observations.trim()
      };

      if (executionForm.result?.trim()) {
        payload.result = executionForm.result.trim();
      }

      if (executionForm.duration) {
        payload.duration = Number(executionForm.duration);
      }

      await api.put(`/activities/${executionActivity.id}`, payload);
      toast.success("Atividade concluída.");
      setExecutionActivity(null);
      await refreshAfterMutation();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível concluir a atividade."));
    } finally {
      setSavingAction(false);
    }
  };

  const openEditModal = (activity: Activity) => {
    setEditActivity(activity);
    setEditForm({
      type: activity.type,
      notes: activity.notes,
      dueDate: brazilDayKeyOf(activity.dueDate),
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
        // Muda o dia (Brasília) e mantém o horário.
        dueDate: brazilDateTime(editForm.dueDate, brazilTimeKey(editActivity.dueDate)).toISOString(),
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
          <p className="text-sm text-slate-500">Histórico do que foi feito. Para planejar, use o próximo passo ou a Agenda.</p>
        </div>
        <button type="button" onClick={openCreateModal} className="w-full rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 sm:w-auto">
          Nova atividade
        </button>
      </div>

      <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm" aria-labelledby="pending-title">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 id="pending-title" className="text-base font-semibold text-slate-900">Pendências</h3>
            <p className="text-sm text-slate-500">Compromissos dos últimos 30 dias que já passaram e ainda não foram concluídos.</p>
          </div>
          {pendingOlderCount ? (
            <Link to="/agenda?pendentes=antigos" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100">
              {pendingOlderCount === 1 ? "1 compromisso antigo sem conclusão" : `${pendingOlderCount} compromissos antigos sem conclusão`}
            </Link>
          ) : null}
        </div>
        {pendingLoading ? (
          <p className="mt-3 text-sm text-slate-500">Carregando...</p>
        ) : !pendingEvents.length ? (
          <p className="mt-3 text-sm text-slate-500">Nenhuma pendência. Tudo em dia.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {pendingEvents.map((item) => {
              const actions = agendaEventActions(item, user?.role);
              const clientName = item.clientId ? clients.find((client) => client.id === item.clientId)?.name || "Cliente" : "Sem cliente";
              const sellerName = canChooseSeller ? sellers.find((seller) => seller.id === item.ownerId)?.name : null;
              return (
                <li key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-500">
                      {AGENDA_EVENT_TYPE_LABELS[item.type] || item.type} • {formatBrazil(item.startsAt, { dateStyle: "short", timeStyle: "short" })} • {clientName}
                      {sellerName ? ` • ${sellerName}` : ""}
                    </p>
                  </div>
                  <div className="grid shrink-0 grid-cols-3 gap-2 sm:flex">
                    {actions.complete ? (
                      <button type="button" className="rounded-md border border-green-300 px-3 py-2 text-xs font-semibold text-green-700 hover:bg-green-50" onClick={() => setSearchParams(new URLSearchParams(completeAgendaEventHref(item).split("?")[1]))}>
                        Concluir
                      </button>
                    ) : (
                      <Link to="/agenda" className="rounded-md border border-emerald-300 px-3 py-2 text-center text-xs font-semibold text-emerald-700 hover:bg-emerald-50" title="O roteiro é concluído pelas paradas">
                        Ver roteiro
                      </Link>
                    )}
                    {actions.reschedule ? (
                      <button type="button" className="rounded-md border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50" onClick={() => setRescheduleTarget(item)}>
                        Reagendar
                      </button>
                    ) : null}
                    {actions.notDone ? (
                      <button type="button" className="rounded-md border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50" onClick={() => setNotDoneTarget(item)}>
                        Não realizado
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
                        <p className="mt-1 text-xs text-slate-500">{toLabel(item.type)} • {formatBrazil(item.date || item.dueDate, { dateStyle: "short", timeStyle: "short" })}</p>
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
                      {/* Atividade é o que já foi feito: sem reagendar nem duplicar. Pendente só existe em registro antigo. */}
                      {status === "agendado" ? (
                        <>
                          <button type="button" className="rounded-md border border-brand-200 px-3 py-2 text-center text-xs font-medium text-brand-700" onClick={() => openExecutionModal(item)}>Concluir</button>
                          <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700" onClick={() => openEditModal(item)}>Editar</button>
                          {canChooseSeller ? <button type="button" className="rounded-md border border-rose-200 px-3 py-2 text-center text-xs font-medium text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button> : null}
                        </>
                      ) : null}
                      {status === "vencido" ? (
                        <>
                          <button type="button" className="rounded-md border border-brand-200 px-3 py-2 text-center text-xs font-medium text-brand-700" onClick={() => openExecutionModal(item)}>Concluir</button>
                          {canChooseSeller ? <button type="button" className="rounded-md border border-rose-200 px-3 py-2 text-center text-xs font-medium text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button> : null}
                        </>
                      ) : null}
                      {status === "realizado" ? (
                        <>
                          <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-700" onClick={() => setSelectedActivity(item)}>Visualizar</button>
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
                    <th className="p-2">Data</th>
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
                        <td className="p-2">{formatBrazil(item.date || item.dueDate, { dateStyle: "short", timeStyle: "short" })}</td>
                        <td className="p-2">
                          {item.type === "visita" && item.checkInAt ? <span className="mr-2 rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700">Check-in realizado</span> : null}
                          <span className={`rounded-full border px-2 py-1 text-xs font-medium ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
                        </td>
                        <td className="p-2">{item.notes}</td>
                        <td className="p-2">
                          <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                            {status === "agendado" ? (
                              <>
                                <button type="button" className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700" onClick={() => openExecutionModal(item)}>Concluir</button>
                                <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => openEditModal(item)}>Editar</button>
                                {canChooseSeller ? <button type="button" className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button> : null}
                              </>
                            ) : null}
                            {status === "vencido" ? (
                              <>
                                <button type="button" className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700" onClick={() => openExecutionModal(item)}>Concluir</button>
                                {canChooseSeller ? <button type="button" className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={removingId === item.id} onClick={() => void deleteActivity(item.id)}>Excluir</button> : null}
                              </>
                            ) : null}
                            {status === "realizado" ? (
                              <>
                                <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setSelectedActivity(item)}>Visualizar</button>
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
              <p><strong>Data:</strong> {formatBrazil(selectedActivity.date || selectedActivity.dueDate, { dateStyle: "short", timeStyle: "short" })}</p>
              <p><strong>Vendedor:</strong> {selectedActivity.ownerSeller?.name || "—"}</p>
              <p><strong>Check-in:</strong> {selectedActivity.checkInAt ? formatBrazil(selectedActivity.checkInAt, { dateStyle: "short", timeStyle: "short" }) : "—"}</p>
              <p><strong>Precisão GPS:</strong> {selectedActivity.checkInAccuracy != null ? `${Math.round(selectedActivity.checkInAccuracy)} m` : "—"}</p>
              <p className="md:col-span-2"><strong>Notas:</strong> {selectedActivity.notes || "—"}</p>
              <p className="md:col-span-2"><strong>Resumo:</strong> {selectedActivity.description || "—"}</p>
              <p className="md:col-span-2"><strong>Resultado:</strong> {selectedActivity.result || "—"}</p>
            </div>
          </div>
        </div>
      ) : null}

      {executionActivity ? (
        <div className="mobile-modal-shell" onClick={() => setExecutionActivity(null)}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold">Concluir atividade</h3>
              <button type="button" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-500" onClick={() => setExecutionActivity(null)}>✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={executeActivity}>
              <div className="mobile-modal-body space-y-3">
              <div>
                <label className="text-sm font-semibold text-slate-900">Resumo do que foi feito (obrigatório)</label>
                <textarea
                  required
                  className="min-h-24 w-full min-w-0 rounded-lg border-2 border-brand-200 bg-brand-50 p-2 focus:border-brand-500 focus:outline-none"
                  value={executionForm.observations}
                  onChange={(event) => setExecutionForm((previous) => ({ ...previous, observations: event.target.value }))}
                  placeholder="Ex: cliente interessado, pediu proposta"
                />
              </div>
              <div>
                <label className="text-sm">Resultado (opcional)</label>
                <input className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={executionForm.result} onChange={(event) => setExecutionForm((previous) => ({ ...previous, result: event.target.value }))} />
              </div>
              <div>
                <label className="text-sm">Duração real (minutos) (opcional)</label>
                <input type="number" min={0} className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={executionForm.duration} onChange={(event) => setExecutionForm((previous) => ({ ...previous, duration: event.target.value }))} />
              </div>
              </div>
              <div className="mobile-modal-footer">
                <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2" onClick={() => setExecutionActivity(null)}>Cancelar</button>
                <button type="submit" disabled={savingAction} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-white">{savingAction ? "Salvando..." : "Concluir"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {rescheduleTarget ? (
        <RescheduleDialog
          event={rescheduleTarget}
          onClose={() => setRescheduleTarget(null)}
          onDone={() => {
            setRescheduleTarget(null);
            void loadPending();
          }}
        />
      ) : null}

      {notDoneTarget ? (
        <NotDoneDialog
          event={notDoneTarget}
          onClose={() => setNotDoneTarget(null)}
          onDone={() => {
            setNotDoneTarget(null);
            void loadPending();
          }}
        />
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
                  {/* Tipo legado do registro antigo continua na lista para não ser trocado sem querer. */}
                  {isActivityCatalogType(editForm.type) ? null : <option value={editForm.type}>{toLabel(editForm.type)}</option>}
                  {ACTIVITY_CATALOG_OPTIONS.map((activityType) => (
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
                  <label className="text-sm">Data</label>
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
                <p className="text-sm text-slate-500">Registre o que foi feito. O próximo passo vira compromisso na Agenda.</p>
                {hasVisitDraft && canWriteVisitDraft ? (
                  <button type="button" className="mt-2 rounded-md border border-rose-200 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50" onClick={discardVisitDraft}>
                    Descartar visita em andamento
                  </button>
                ) : null}
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
                      <p>Horário: {visitCheckIn ? formatBrazil(visitCheckIn.checkInAt, { hour: "2-digit", minute: "2-digit" }) : "—"}</p>
                      <p>Precisão do GPS: {visitCheckIn?.checkInAccuracy != null ? `${Math.round(visitCheckIn.checkInAccuracy)} m` : "—"}</p>
                    </div>
                  </section>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="text-sm" htmlFor="activity-type">Tipo</label>
                  <select
                    id="activity-type"
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
                    {ACTIVITY_CATALOG_OPTIONS.map((activityType) => (
                      <option key={activityType.value} value={activityType.value}>
                        {activityType.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm" htmlFor="activity-day">Data</label>
                  <input id="activity-day" type="date" required max={brazilTodayKey()} className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.dueDate} onChange={(event) => setForm((previous) => ({ ...previous, dueDate: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm" htmlFor="activity-time">Horário (Brasília)</label>
                  <input id="activity-time" type="time" required className="w-full min-w-0 rounded-lg border border-slate-300 p-2" value={form.time} onChange={(event) => setForm((previous) => ({ ...previous, time: event.target.value }))} />
                </div>
                <p className="-mt-1 text-xs text-slate-500 md:col-span-2">Quando foi feito. Pode ser hoje ou um dia anterior, nunca no futuro.</p>
                {isLinkedToAgendaEvent ? (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 md:col-span-2">
                    <p className="font-semibold">Registro do compromisso da Agenda</p>
                    <p className="mt-1">Cliente: {clients.find((client) => client.id === form.clientId)?.name || (form.clientId ? "Cliente do compromisso" : "Sem cliente")}</p>
                    <p>Oportunidade: {selectedOpportunity?.title || (form.opportunityId ? "Oportunidade do compromisso" : "Sem oportunidade")}</p>
                    <p className="mt-1 text-xs text-green-800">Ao salvar, o compromisso fica concluído.</p>
                  </div>
                ) : (
                  <>
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
                  </>
                )}
                <div className="md:col-span-2">
                  <label className="text-sm font-semibold text-slate-900" htmlFor="activity-summary">Resumo do que foi feito (obrigatório)</label>
                  <textarea
                    id="activity-summary"
                    required
                    className="min-h-24 w-full rounded-lg border-2 border-brand-200 bg-brand-50 p-2 focus:border-brand-500 focus:outline-none"
                    value={form.observations}
                    onChange={(event) => setForm((previous) => ({ ...previous, observations: event.target.value }))}
                    placeholder={"Ex: cliente interessado, pediu proposta\nEx: não vai plantar agora\nEx: fechamos pedido de 50 ha"}
                  />
                </div>
                <div>
                  <label className="text-sm" htmlFor="activity-result">Resultado (opcional)</label>
                  <input id="activity-result" className="w-full rounded-lg border border-slate-300 p-2" value={form.result} onChange={(event) => setForm((previous) => ({ ...previous, result: event.target.value }))} />
                </div>
                <div>
                  <label className="text-sm">Duração em minutos (opcional)</label>
                  <input type="number" min={0} className="w-full rounded-lg border border-slate-300 p-2" value={form.duration} onChange={(event) => setForm((previous) => ({ ...previous, duration: event.target.value }))} />
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
                  <label className="text-sm">Notas (opcional)</label>
                  <textarea className="min-h-24 w-full rounded-lg border border-slate-300 p-2" value={form.notes} onChange={(event) => setForm((previous) => ({ ...previous, notes: event.target.value }))} />
                </div>
                <fieldset className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-3 md:col-span-2" aria-labelledby="next-step-title">
                  <div>
                    <legend id="next-step-title" className="text-sm font-semibold text-sky-900">Próximo passo</legend>
                    <p className="text-xs text-sky-800">O próximo passo vira compromisso na Agenda.{opportunityOpen ? " Obrigatório para oportunidade aberta." : ""}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Próximo passo">
                    {[
                      { mode: "schedule" as const, label: "Agendar próximo passo" },
                      { mode: "none" as const, label: "Sem próximo passo" }
                    ].map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        role="radio"
                        aria-checked={form.nextStepMode === option.mode}
                        onClick={() => chooseNextStepMode(option.mode)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium ${form.nextStepMode === option.mode ? "border-sky-600 bg-sky-600 text-white" : "border-sky-200 bg-white text-sky-900 hover:bg-sky-100"}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {form.nextStepMode === "schedule" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="text-sm" htmlFor="next-step-type">Tipo</label>
                        <select id="next-step-type" required className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={form.nextStepType} onChange={(event) => setForm((previous) => ({ ...previous, nextStepType: event.target.value }))}>
                          <option value="">Selecione</option>
                          {NEXT_STEP_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-sm" htmlFor="next-step-day">Dia</label>
                        <input id="next-step-day" type="date" required min={brazilTodayKey()} className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={form.nextStepDay} onChange={(event) => setForm((previous) => ({ ...previous, nextStepDay: event.target.value }))} />
                      </div>
                      <div>
                        <label className="text-sm" htmlFor="next-step-time">Horário (Brasília)</label>
                        <input id="next-step-time" type="time" required className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={form.nextStepTime} onChange={(event) => setForm((previous) => ({ ...previous, nextStepTime: event.target.value }))} />
                      </div>
                      <div>
                        <label className="text-sm" htmlFor="next-step-duration">Duração (min)</label>
                        <input id="next-step-duration" type="number" min={1} required className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={form.nextStepDuration} onChange={(event) => setForm((previous) => ({ ...previous, nextStepDuration: event.target.value }))} />
                      </div>
                    </div>
                  ) : null}
                  {form.nextStepMode === "none" ? (
                    <div>
                      <label className="text-sm" htmlFor="no-next-step-reason">Por que não há próximo passo?{opportunityOpen ? " (obrigatório)" : " (opcional)"}</label>
                      <textarea id="no-next-step-reason" required={opportunityOpen} className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={form.noNextStepReason} onChange={(event) => setForm((previous) => ({ ...previous, noNextStepReason: event.target.value }))} placeholder="Ex.: cliente só decide na próxima safra" />
                    </div>
                  ) : null}
                  {showNextStepWarning ? (
                    <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">{NEXT_STEP_REQUIRED_MESSAGE}</p>
                  ) : null}
                </fieldset>
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
