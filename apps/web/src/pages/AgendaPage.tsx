import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { AGENDA_EVENT_TYPE_OPTIONS, type AgendaEventType as SharedAgendaEventType } from "@salesforce-pro/shared";
import { ACTIVITY_TYPE_OPTIONS, type ActivityTypeKey } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";
import type { AgendaEvent, AgendaEventType, AgendaStop } from "../models/agenda";

type Seller = { id: string; name: string };
type AgendaSummary = { reunioes: number; roteiros: number; followUps: number; vencidos: number };

type Visualizacao = "diaria" | "semanal";
type PeriodFilter = "hoje" | "esta_semana" | "proximos_7_dias" | "personalizado";

type CreateAgendaForm = {
  title: string;
  type: AgendaEventType;
  startDateTime: string;
  endDateTime: string;
  sellerId: string;
  notes: string;
};

type DraftStop = {
  id: string;
  clientId: string;
  city: string;
  plannedTime: string;
  notes: string;
};

type ActivityForm = {
  type: ActivityTypeKey;
  notes: string;
  dueDate: string;
  clientId: string;
};

type ClientOption = { id: string; name: string };

type FollowUpForm = {
  type: "followup";
  dueDate: string;
  notes: string;
  clientId: string;
  opportunityId: string;
};

type QuickOpportunityForm = {
  title: string;
  value: string;
  stage: "prospeccao" | "negociacao" | "proposta";
  followUpDate: string;
};


type VisitResultForm = {
  status: "realizada" | "nao_realizada";
  reason: "cliente_ausente" | "chuva" | "estrada" | "reagendar" | "outro";
  summary: string;
  nextStep: "criar_followup" | "criar_oportunidade" | "reagendar";
  nextStepDate: string;
};

const VISIT_REASON_LABEL: Record<VisitResultForm["reason"], string> = {
  cliente_ausente: "Cliente ausente",
  chuva: "Chuva",
  estrada: "Estrada",
  reagendar: "Reagendar",
  outro: "Outro"
};

const NEXT_STEP_LABEL: Record<VisitResultForm["nextStep"], string> = {
  criar_followup: "Criar follow-up",
  criar_oportunidade: "Criar oportunidade",
  reagendar: "Reagendar"
};

const initialActivityForm: ActivityForm = {
  type: "reuniao",
  notes: "",
  dueDate: "",
  clientId: ""
};

const TYPE_LABEL: Record<SharedAgendaEventType, string> = AGENDA_EVENT_TYPE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {} as Record<SharedAgendaEventType, string>);

const TYPE_COLOR_CLASS: Record<SharedAgendaEventType, string> = {
  reuniao_online: "bg-blue-100 text-blue-800 border-blue-200",
  reuniao_presencial: "bg-green-100 text-green-800 border-green-200",
  roteiro_visita: "bg-emerald-100 text-emerald-800 border-emerald-200",
  followup: "bg-amber-100 text-amber-800 border-amber-200"
};

const normalizeAgendaEventType = (type: AgendaEventType): SharedAgendaEventType => type;

const STATUS_LABEL: Record<AgendaEvent["status"], string> = {
  agendado: "Agendado",
  realizado: "Realizado",
  cancelado: "Agendado",
  vencido: "Vencido"
};

const STATUS_COLOR_CLASS: Record<AgendaEvent["status"], string> = {
  agendado: "border-sky-200 bg-sky-100 text-sky-700",
  realizado: "border-green-200 bg-green-100 text-green-700",
  cancelado: "border-slate-200 bg-slate-100 text-slate-700",
  vencido: "border-rose-200 bg-rose-100 text-rose-700"
};

const PERIOD_FILTER_LABEL: Record<PeriodFilter, string> = {
  hoje: "Hoje",
  esta_semana: "Esta semana",
  proximos_7_dias: "Próximos 7 dias",
  personalizado: "Personalizado"
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function getRangeFromFilter(periodFilter: PeriodFilter, customFrom: string, customTo: string) {
  const today = new Date();
  const dayStart = startOfDay(today);

  if (periodFilter === "hoje") {
    return { from: startOfDay(today), to: endOfDay(today) };
  }

  if (periodFilter === "esta_semana") {
    const weekStart = startOfDay(today);
    const dayOfWeek = weekStart.getDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    weekStart.setDate(weekStart.getDate() + diffToMonday);
    const weekEnd = endOfDay(new Date(weekStart));
    weekEnd.setDate(weekEnd.getDate() + 6);
    return { from: weekStart, to: weekEnd };
  }

  if (periodFilter === "proximos_7_dias") {
    const next7Days = endOfDay(new Date(dayStart));
    next7Days.setDate(next7Days.getDate() + 7);
    return { from: dayStart, to: next7Days };
  }

  const from = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)) : dayStart;
  const to = customTo ? endOfDay(new Date(`${customTo}T00:00:00`)) : endOfDay(dayStart);
  return { from, to };
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatDateOnly(value: string) {
  return new Date(value).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit"
  });
}

function isEventWithinRange(eventDateTime: string, startDate: Date, endDate: Date) {
  const eventDate = new Date(eventDateTime);
  return eventDate.getTime() >= startDate.getTime() && eventDate.getTime() <= endDate.getTime();
}


function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

type StopGeolocationPayload = {
  lat?: number;
  lng?: number;
  accuracy?: number;
  timestamp?: string;
};

function getCurrentPositionOptional(timeoutMs = 5000): Promise<StopGeolocationPayload> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({});
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: new Date(position.timestamp).toISOString()
        });
      },
      () => resolve({}),
      { timeout: timeoutMs, maximumAge: 0, enableHighAccuracy: true }
    );
  });
}

function getInitialEvents(): AgendaEvent[] {
  const now = new Date();
  return [
    {
      id: "event-1",
      userId: "seller-1",
      clientId: "client-1",
      opportunityId: "opp-1",
      title: "Kickoff técnico",
      description: "Alinhar cronograma de implantação e responsáveis.",
      type: "reuniao_online",
      startDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0).toISOString(),
      endDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0).toISOString(),
      status: "agendado"
    }
  ];
}

export default function AgendaPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canFilterBySeller = user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("diaria");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("hoje");
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [events, setEvents] = useState<AgendaEvent[]>(() => getInitialEvents());
  const [isEventsLoading, setIsEventsLoading] = useState(false);
  const [eventsRefreshToken, setEventsRefreshToken] = useState(0);
  const [summary, setSummary] = useState<AgendaSummary>({ reunioes: 0, roteiros: 0, followUps: 0, vencidos: 0 });

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);
  const [isActivitySubmitting, setIsActivitySubmitting] = useState(false);
  const [activityClients, setActivityClients] = useState<ClientOption[]>([]);
  const [activityForm, setActivityForm] = useState<ActivityForm>(initialActivityForm);
  const [activityEvent, setActivityEvent] = useState<AgendaEvent | null>(null);
  const [isFollowUpModalOpen, setIsFollowUpModalOpen] = useState(false);
  const [isFollowUpSubmitting, setIsFollowUpSubmitting] = useState(false);
  const [followUpSourceEvent, setFollowUpSourceEvent] = useState<AgendaEvent | null>(null);
  const [followUpForm, setFollowUpForm] = useState<FollowUpForm>({
    type: "followup",
    dueDate: "",
    notes: "",
    clientId: "",
    opportunityId: ""
  });
  const [isQuickOpportunityModalOpen, setIsQuickOpportunityModalOpen] = useState(false);
  const [isQuickOpportunitySubmitting, setIsQuickOpportunitySubmitting] = useState(false);
  const [quickOpportunityAgendaEventId, setQuickOpportunityAgendaEventId] = useState("");
  const [quickOpportunityForm, setQuickOpportunityForm] = useState<QuickOpportunityForm>({
    title: "",
    value: "10000",
    stage: "negociacao",
    followUpDate: ""
  });

  const [isRescheduleOpen, setIsRescheduleOpen] = useState(false);
  const [isRescheduleSubmitting, setIsRescheduleSubmitting] = useState(false);
  const [rescheduleEvent, setRescheduleEvent] = useState<AgendaEvent | null>(null);
  const [rescheduleStartDateTime, setRescheduleStartDateTime] = useState("");
  const [rescheduleEndDateTime, setRescheduleEndDateTime] = useState("");

  const [isSellersLoading, setIsSellersLoading] = useState(false);
  const [sellerOptions, setSellerOptions] = useState<Seller[]>([]);

  const [createForm, setCreateForm] = useState<CreateAgendaForm>({
    title: "",
    type: "reuniao_online",
    startDateTime: "",
    endDateTime: "",
    sellerId: "",
    notes: ""
  });
  const [draftStops, setDraftStops] = useState<DraftStop[]>([]);
  const [highlightedEventId, setHighlightedEventId] = useState<string>("");
  const highlightedEventRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef<Map<string, Promise<any>>>(new Map());
  const [executionEventId, setExecutionEventId] = useState("");
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [activeStopId, setActiveStopId] = useState("");
  const [isExecutionSubmitting, setIsExecutionSubmitting] = useState(false);
  const [visitResultForm, setVisitResultForm] = useState<VisitResultForm>({
    status: "realizada",
    reason: "cliente_ausente",
    summary: "",
    nextStep: "criar_followup",
    nextStepDate: ""
  });

  const eventsQuery = useMemo(() => {
    const range = getRangeFromFilter(periodFilter, customFrom, customTo);
    const params: Record<string, string> = {
      from: range.from.toISOString().slice(0, 10),
      to: range.to.toISOString().slice(0, 10)
    };

    if (user?.role === "vendedor" && user.id) {
      params.ownerId = user.id;
    } else if (canFilterBySeller && selectedSellerId) {
      params.ownerId = selectedSellerId;
    }

    return params;
  }, [periodFilter, customFrom, customTo, canFilterBySeller, selectedSellerId, user?.id, user?.role]);

  const eventsQueryKey = useMemo(() => JSON.stringify(eventsQuery), [eventsQuery]);

  const sellers = useMemo<Seller[]>(() => {
    if (!canFilterBySeller && user?.id && user?.name) {
      return [{ id: user.id, name: user.name }];
    }
    return sellerOptions;
  }, [canFilterBySeller, sellerOptions, user?.id, user?.name]);

  useEffect(() => {
    let active = true;

    const loadSellers = async () => {
      if (!canFilterBySeller) {
        setSellerOptions([]);
        return;
      }

      setIsSellersLoading(true);
      try {
        const response = await api.get("/users");
        if (!active) return;

        const loadedSellers = (response.data || [])
          .filter((item: any) => item?.role === "vendedor" && item?.id && item?.name)
          .map((item: any) => ({ id: String(item.id), name: String(item.name) }));

        setSellerOptions(loadedSellers);
      } catch {
        if (!active) return;
        toast.error("Não foi possível carregar vendedores agora.");
      } finally {
        if (active) setIsSellersLoading(false);
      }
    };

    loadSellers();

    return () => {
      active = false;
    };
  }, [canFilterBySeller]);

  useEffect(() => {
    let active = true;
    const loadClients = async () => {
      if (activityClients.length) return;
      try {
        const response = await api.get("/clients");
        if (!active) return;
        const payload = Array.isArray(response.data?.items) ? response.data.items : response.data;
        const mappedClients = Array.isArray(payload)
          ? payload.filter((item: any) => item?.id && item?.name).map((item: any) => ({ id: String(item.id), name: String(item.name) }))
          : [];
        setActivityClients(mappedClients);
      } catch {
        // silencioso: fluxo principal da agenda não depende desta lista
      }
    };

    void loadClients();
    return () => {
      active = false;
    };
  }, [activityClients.length]);

  useEffect(() => {
    const shouldHighlightNext = searchParams.get("highlight") === "next";
    if (!shouldHighlightNext) return;

    const nextView = searchParams.get("view");
    if (nextView === "hoje") {
      setPeriodFilter("hoje");
      setView("diaria");
    }

    const sellerId = searchParams.get("sellerId");
    if (sellerId && canFilterBySeller) {
      setSelectedSellerId(sellerId);
    }
  }, [canFilterBySeller, searchParams]);


  useEffect(() => {
    if (searchParams.get("execute") === "1") {
      setExecutionEventId(searchParams.get("eventId") || "AUTO");
    }
  }, [searchParams]);

  useEffect(() => {
    let active = true;
    const abortController = new AbortController();

    const loadAgendaEvents = async () => {
      setIsEventsLoading(true);
      try {
        let request = inFlightRef.current.get(eventsQueryKey);
        if (!request) {
          request = api.get("/agenda/events", { params: eventsQuery, signal: abortController.signal });
          inFlightRef.current.set(eventsQueryKey, request);
        }

        const response = await request;
        inFlightRef.current.delete(eventsQueryKey);
        if (!active) return;

        const payload = Array.isArray(response.data?.items) ? response.data.items : Array.isArray(response.data) ? response.data : [];
        const mappedEvents = payload
          .filter((item: any) => item?.id && item?.startDateTime && item?.endDateTime)
          .map((item: any): AgendaEvent => ({
            id: String(item.id),
            userId: String(item.userId || item.ownerSellerId || item.sellerId || ""),
            sellerId: String(item.sellerId || item.userId || ""),
            clientId: item.clientId ? String(item.clientId) : undefined,
            title: String(item.title || "Sem título"),
            description: String(item.notes || "Compromisso da agenda."),
            type: (item.type as AgendaEventType) || "followup",
            startDateTime: new Date(item.startDateTime).toISOString(),
            endDateTime: new Date(item.endDateTime).toISOString(),
            status: (item.status as AgendaEvent["status"]) || "agendado",
            isOverdue: Boolean(item.isOverdue),
            city: item.city ? String(item.city) : undefined,
            notes: item.notes ? String(item.notes) : null,
            stops: Array.isArray(item.stops) ? item.stops.map((stop: any) => ({
            ...stop,
            checkInAt: stop.checkInAt ?? stop.arrivedAt ?? null,
            checkOutAt: stop.checkOutAt ?? stop.completedAt ?? null
          })) : []
          }))
          .filter((item: AgendaEvent) => item.userId);

        setEvents(mappedEvents);
        setSummary(response.data?.summary || { reunioes: 0, roteiros: 0, followUps: 0, vencidos: 0 });
      } catch (error: any) {
        if (!active || error?.name === "CanceledError" || error?.code === "ERR_CANCELED") return;
        const status = error?.response?.status ?? "sem_status";
        const message = error?.response?.data?.message || error?.message || "erro desconhecido";
        if (import.meta.env.DEV) {
          console.error("Falha ao carregar agenda", {
            url: error?.config?.url,
            params: error?.config?.params,
            status,
            message
          });
        }
        toast.error(`Falha ao carregar agenda: ${status} - ${message}`);
      } finally {
        if (active) setIsEventsLoading(false);
      }
    };

    const timer = window.setTimeout(() => {
      void loadAgendaEvents();
    }, 350);

    return () => {
      active = false;
      abortController.abort();
      window.clearTimeout(timer);
    };
  }, [eventsQuery, eventsQueryKey, eventsRefreshToken]);

  const sellerById = useMemo(() => Object.fromEntries(sellers.map((seller) => [seller.id, seller.name])), [sellers]);

  const filteredEvents = useMemo(() => {
    const byRole = events.filter((event) => {
      if (user?.role === "vendedor") return event.userId === user.id;
      if (canFilterBySeller && selectedSellerId) return event.userId === selectedSellerId;
      return true;
    });

    const byOverdue = overdueOnly ? byRole.filter((event) => event.status === "vencido") : byRole;

    return byOverdue.sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
  }, [events, user?.role, user?.id, canFilterBySeller, selectedSellerId, overdueOnly]);

  useEffect(() => {
    const shouldHighlightNext = searchParams.get("highlight") === "next";
    if (!shouldHighlightNext || !filteredEvents.length) {
      return;
    }

    const now = Date.now();
    const nextEvent =
      filteredEvents.find((event) => event.status !== "realizado" && new Date(event.endDateTime).getTime() >= now) ??
      filteredEvents.find((event) => event.status !== "realizado");

    setHighlightedEventId(nextEvent?.id || "");
  }, [filteredEvents, searchParams]);

  useEffect(() => {
    if (!highlightedEventRef.current || !highlightedEventId) return;

    highlightedEventRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedEventId]);

  const routeEvents = useMemo(() => filteredEvents.filter((event) => event.type === "roteiro_visita" && event.stops?.length), [filteredEvents]);
  const executionEvent = useMemo(() => {
    if (!routeEvents.length) return null;
    if (executionEventId && executionEventId !== "AUTO") {
      return routeEvents.find((event) => event.id === executionEventId) || routeEvents[0];
    }
    return routeEvents[0];
  }, [executionEventId, routeEvents]);

  const executionStops = executionEvent?.stops || [];
  const completedStops = executionStops.filter((stop) => stop.checkOutAt).length;
  const nextStop = executionStops.find((stop) => !stop.checkOutAt) || null;
  const lateMinutes = nextStop?.plannedTime ? Math.max(0, Math.floor((Date.now() - new Date(nextStop.plannedTime).getTime()) / 60000)) : 0;

  const updateStopState = (stopId: string, patch: Partial<AgendaStop>) => {
    setEvents((current) =>
      current.map((item) => ({
        ...item,
        stops: item.stops?.map((stop) => (stop.id === stopId ? { ...stop, ...patch } : stop))
      }))
    );
  };

  const onCheckInStop = async (stopId: string) => {
    setIsExecutionSubmitting(true);
    try {
      const geolocation = await getCurrentPositionOptional(5000);
      const response = await api.patch(`/agenda-events/${stopId}/check-in`, geolocation);
      updateStopState(stopId, {
        checkInAt: response.data?.checkInAt || new Date().toISOString(),
        checkInLat: response.data?.checkInLat ?? null,
        checkInLng: response.data?.checkInLng ?? null,
        checkInAccuracy: response.data?.checkInAccuracy ?? null
      });
      toast.success("Parada iniciada.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível iniciar a parada."));
    } finally {
      setIsExecutionSubmitting(false);
    }
  };

  const onCheckOutStop = async (stopId: string) => {
    setIsExecutionSubmitting(true);
    try {
      const geolocation = await getCurrentPositionOptional(5000);
      const response = await api.patch(`/agenda-events/${stopId}/check-out`, geolocation);
      updateStopState(stopId, {
        checkOutAt: response.data?.checkOutAt || new Date().toISOString(),
        checkOutLat: response.data?.checkOutLat ?? null,
        checkOutLng: response.data?.checkOutLng ?? null,
        checkOutAccuracy: response.data?.checkOutAccuracy ?? null
      });
      setActiveStopId(stopId);
      setIsResultModalOpen(true);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível finalizar a parada."));
    } finally {
      setIsExecutionSubmitting(false);
    }
  };

  const onSaveVisitResult = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeStopId) return;
    if (visitResultForm.status === "nao_realizada" && !visitResultForm.reason) {
      toast.error("Selecione o motivo da não realização.");
      return;
    }

    setIsExecutionSubmitting(true);
    try {
      const payload = {
        status: visitResultForm.status,
        reason: visitResultForm.status === "nao_realizada" ? visitResultForm.reason : undefined,
        summary: visitResultForm.summary,
        nextStep: visitResultForm.nextStep,
        nextStepDate: visitResultForm.nextStepDate ? new Date(visitResultForm.nextStepDate).toISOString() : undefined
      };
      const response = await api.patch(`/agenda-events/${activeStopId}/result`, payload);
      updateStopState(activeStopId, response.data);
      const activeStop = executionStops.find((stop) => stop.id === activeStopId);
      setIsResultModalOpen(false);
      setActiveStopId("");
      toast.success("Resultado da visita salvo.");

      if (visitResultForm.nextStep === "criar_followup" && executionEvent) {
        const nextStepDate = visitResultForm.nextStepDate ? new Date(visitResultForm.nextStepDate) : new Date(Date.now() + 2 * 86400000);
        await api.post("/activities", {
          type: "followup",
          dueDate: nextStepDate.toISOString(),
          notes: `Follow-up da visita: ${activeStop?.clientName || executionEvent.title} — ${visitResultForm.summary || "Sem resumo informado"}`,
          clientId: activeStop?.clientId || executionEvent.clientId,
          opportunityId: executionEvent.opportunityId || undefined,
          ownerSellerId: executionEvent.userId
        });
        toast.success("Follow-up criado na lista de atividades.");
      }

      if (visitResultForm.nextStep === "criar_oportunidade" && executionEvent) {
        openQuickOpportunityModal(executionEvent, activeStop?.clientName);
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar o resultado."));
    } finally {
      setIsExecutionSubmitting(false);
    }
  };

  const closeExecutionMode = async () => {
    const params = new URLSearchParams(searchParams);
    params.delete("execute");
    params.delete("eventId");
    setSearchParams(params);
    setExecutionEventId("");
    try {
      const response = await api.get("/agenda/events", { params: eventsQuery });
      const payload = Array.isArray(response.data?.items) ? response.data.items : [];
      setEvents(
        payload.map((item: any) => ({
          id: String(item.id),
          userId: String(item.userId || item.ownerSellerId || item.sellerId || ""),
          sellerId: String(item.sellerId || item.userId || ""),
          clientId: item.clientId ? String(item.clientId) : undefined,
          title: String(item.title || "Sem título"),
          description: String(item.notes || "Compromisso da agenda."),
          type: (item.type as AgendaEventType) || "followup",
          startDateTime: new Date(item.startDateTime).toISOString(),
          endDateTime: new Date(item.endDateTime).toISOString(),
          status: (item.status as AgendaEvent["status"]) || "agendado",
          isOverdue: Boolean(item.isOverdue),
          city: item.city ? String(item.city) : undefined,
          notes: item.notes ? String(item.notes) : null,
          stops: Array.isArray(item.stops) ? item.stops.map((stop: any) => ({
            ...stop,
            checkInAt: stop.checkInAt ?? stop.arrivedAt ?? null,
            checkOutAt: stop.checkOutAt ?? stop.completedAt ?? null
          })) : []
        }))
      );
    } catch {
      // já existe carga automática com debounce
    }
  };

  const onSetAsDone = async (agendaEvent: AgendaEvent) => {
    const nextStatus = agendaEvent.status === "realizado" ? "agendado" : "realizado";
    try {
      await api.patch(`/agenda/${agendaEvent.id}`, { status: nextStatus });
    } catch {
      try {
        await api.patch(`/agenda/${agendaEvent.id}/status`, { status: nextStatus });
      } catch {
        toast.error("Não foi possível atualizar o status no momento.");
        return;
      }
    }

    setEvents((current) =>
      current.map((item) =>
        item.id === agendaEvent.id
          ? {
              ...item,
              status: nextStatus
            }
          : item
      )
    );
    toast.success(nextStatus === "realizado" ? "Agenda marcada como realizada." : "Agenda reaberta com sucesso.");
  };

  const openFollowUpModal = (agendaEvent: AgendaEvent) => {
    const dueDate = new Date(agendaEvent.endDateTime);
    dueDate.setDate(dueDate.getDate() + 2);
    setFollowUpSourceEvent(agendaEvent);
    setFollowUpForm({
      type: "followup",
      dueDate: toDateTimeInputValue(dueDate.toISOString()),
      notes: `Follow-up do evento: ${agendaEvent.title}`,
      clientId: agendaEvent.clientId || "",
      opportunityId: agendaEvent.opportunityId || ""
    });
    setIsFollowUpModalOpen(true);
  };

  const closeFollowUpModal = () => {
    setIsFollowUpModalOpen(false);
    setFollowUpSourceEvent(null);
  };

  const onSubmitFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!followUpSourceEvent || !followUpForm.dueDate) {
      toast.error("Defina a data do follow-up.");
      return;
    }

    const start = new Date(followUpForm.dueDate);
    const end = new Date(start.getTime() + 30 * 60000);

    setIsFollowUpSubmitting(true);
    try {
      const response = await api.post("/agenda/events", {
        title: `Follow-up: ${followUpSourceEvent.title}`,
        type: followUpForm.type,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        sellerId: followUpSourceEvent.userId,
        clientId: followUpForm.clientId || undefined,
        opportunityId: followUpForm.opportunityId || undefined,
        notes: followUpForm.notes
      });
      const created = response.data;
      setEvents((current) =>
        [...current, { ...followUpSourceEvent, ...created, id: created.id, title: created.title }].sort(
          (a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
        )
      );
      toast.success(response.data?.message || "Follow-up criado com sucesso.");
      closeFollowUpModal();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível criar follow-up."));
    } finally {
      setIsFollowUpSubmitting(false);
    }
  };

  const openQuickOpportunityModal = (agendaEvent: AgendaEvent, stopClientName?: string | null) => {
    const due = new Date();
    due.setDate(due.getDate() + 2);
    const clientLabel = stopClientName || agendaEvent.title;
    setQuickOpportunityAgendaEventId(agendaEvent.id);
    setQuickOpportunityForm({
      title: `Negociação pós-visita — ${clientLabel}`,
      value: "10000",
      stage: "negociacao",
      followUpDate: due.toISOString().slice(0, 10)
    });
    setIsQuickOpportunityModalOpen(true);
  };

  const onSubmitQuickOpportunity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!executionEvent?.clientId || !quickOpportunityForm.title.trim() || !quickOpportunityForm.followUpDate) {
      toast.error("Preencha os dados mínimos da oportunidade.");
      return;
    }

    setIsQuickOpportunitySubmitting(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const opportunityResponse = await api.post("/opportunities", {
        title: quickOpportunityForm.title.trim(),
        value: Number(quickOpportunityForm.value || "0"),
        stage: quickOpportunityForm.stage,
        proposalDate: today,
        followUpDate: quickOpportunityForm.followUpDate,
        expectedCloseDate: quickOpportunityForm.followUpDate,
        probability: quickOpportunityForm.stage === "prospeccao" ? 20 : quickOpportunityForm.stage === "negociacao" ? 40 : 70,
        clientId: executionEvent.clientId,
        ownerSellerId: executionEvent.userId
      });

      const opportunityId = String(opportunityResponse.data?.id || "");
      if (quickOpportunityAgendaEventId && opportunityId) {
        await api.patch(`/agenda/${quickOpportunityAgendaEventId}`, { opportunityId });
        setEvents((current) =>
          current.map((item) => (item.id === quickOpportunityAgendaEventId ? { ...item, opportunityId } : item))
        );
      }

      toast.success("Oportunidade criada e vinculada ao roteiro.");
      setIsQuickOpportunityModalOpen(false);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível criar oportunidade."));
    } finally {
      setIsQuickOpportunitySubmitting(false);
    }
  };

  const onDuplicateForNextDay = async (agendaEvent: AgendaEvent) => {
    const start = new Date(agendaEvent.startDateTime);
    const end = new Date(agendaEvent.endDateTime);
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);

    try {
      const response = await api.post("/agenda/events", {
        title: `${agendaEvent.title} (cópia)`,
        type: agendaEvent.type,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        sellerId: agendaEvent.userId,
        clientId: agendaEvent.clientId,
        notes: agendaEvent.notes || agendaEvent.description
      });
      const created = response.data;
      setEvents((current) =>
        [...current, { ...agendaEvent, ...created, id: created.id, title: created.title }].sort(
          (a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
        )
      );
      toast.success(response.data?.message || "Evento duplicado para o dia seguinte.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível duplicar evento."));
    }
  };

  const toDateTimeInputValue = (value: string) => {
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };

  const getSuggestedActivityType = (agendaType: AgendaEventType): ActivityTypeKey => {
    if (agendaType === "roteiro_visita") return "visita_tecnica";
    return "reuniao";
  };

  const openActivityModal = async (agendaEvent: AgendaEvent) => {
    setActivityEvent(agendaEvent);
    setActivityForm({
      type: getSuggestedActivityType(agendaEvent.type),
      notes: `Registro de Visita/Reunião — ${agendaEvent.title}`,
      dueDate: toDateTimeInputValue(agendaEvent.endDateTime),
      clientId: agendaEvent.clientId || ""
    });
    setIsActivityModalOpen(true);

    if (activityClients.length) return;

    try {
      const response = await api.get("/clients");
      const payload = Array.isArray(response.data?.items) ? response.data.items : response.data;
      const mappedClients = Array.isArray(payload)
        ? payload
            .filter((item: any) => item?.id && item?.name)
            .map((item: any) => ({ id: String(item.id), name: String(item.name) }))
        : [];
      setActivityClients(mappedClients);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível carregar clientes para registrar atividade."));
    }
  };

  const closeActivityModal = () => {
    setIsActivityModalOpen(false);
    setActivityEvent(null);
    setActivityForm(initialActivityForm);
  };

  const onSubmitActivity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!activityForm.clientId || !activityForm.notes.trim() || !activityForm.dueDate) {
      toast.error("Selecione cliente, notas e vencimento para registrar a atividade.");
      return;
    }

    setIsActivitySubmitting(true);
    try {
      await api.post("/activities", {
        type: activityForm.type,
        notes: activityForm.notes.trim(),
        dueDate: new Date(activityForm.dueDate).toISOString(),
        clientId: activityForm.clientId,
        ownerSellerId: activityEvent?.userId || (user?.role === "vendedor" ? user.id : selectedSellerId || undefined)
      });
      toast.success("Atividade registrada com sucesso.");
      closeActivityModal();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível registrar atividade."));
    } finally {
      setIsActivitySubmitting(false);
    }
  };

  const openRescheduleModal = (agendaEvent: AgendaEvent) => {
    setRescheduleEvent(agendaEvent);
    setRescheduleStartDateTime(toDateTimeInputValue(agendaEvent.startDateTime));
    setRescheduleEndDateTime(toDateTimeInputValue(agendaEvent.endDateTime));
    setIsRescheduleOpen(true);
  };

  const closeRescheduleModal = () => {
    setIsRescheduleOpen(false);
    setRescheduleEvent(null);
    setRescheduleStartDateTime("");
    setRescheduleEndDateTime("");
  };

  const onSubmitReschedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rescheduleEvent || !rescheduleStartDateTime || !rescheduleEndDateTime) {
      toast.error("Preencha início e fim para reagendar.");
      return;
    }

    if (new Date(rescheduleStartDateTime).getTime() >= new Date(rescheduleEndDateTime).getTime()) {
      toast.error("A data de fim deve ser maior que a data de início.");
      return;
    }

    setIsRescheduleSubmitting(true);
    try {
      await api.patch(`/agenda/${rescheduleEvent.id}`, {
        startDateTime: new Date(rescheduleStartDateTime).toISOString(),
        endDateTime: new Date(rescheduleEndDateTime).toISOString()
      });

      setEvents((current) =>
        current.map((item) =>
          item.id === rescheduleEvent.id
            ? {
                ...item,
                startDateTime: new Date(rescheduleStartDateTime).toISOString(),
                endDateTime: new Date(rescheduleEndDateTime).toISOString()
              }
            : item
        )
      );
      toast.success("Compromisso reagendado com sucesso.");
      closeRescheduleModal();
    } catch {
      toast.error("Não foi possível reagendar este compromisso.");
    } finally {
      setIsRescheduleSubmitting(false);
    }
  };

  const openCreate = () => {
    setCreateForm({
      title: "",
      type: "reuniao_online",
      startDateTime: "",
      endDateTime: "",
      sellerId: user?.role === "vendedor" ? user.id : selectedSellerId,
      notes: ""
    });
    setDraftStops([]);

    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    setDraftStops([]);
  };

  const resolveAgendaOwnerId = () => {
    if (user?.role === "vendedor") return user.id;
    return createForm.sellerId || user?.id || "";
  };

  const mapCreatedAgendaEvent = (data: any): AgendaEvent => {
    return {
      id: String(data?.id || `event-${Date.now()}`),
      userId: String(data?.userId || data?.ownerSellerId || resolveAgendaOwnerId()),
      title: String(data?.title || createForm.title.trim()),
      description: String(data?.description || "Compromisso criado manualmente."),
      type: (data?.type as AgendaEventType) || createForm.type,
      startDateTime: new Date(data?.startDateTime || createForm.startDateTime).toISOString(),
      endDateTime: new Date(data?.endDateTime || createForm.endDateTime).toISOString(),
      status: (data?.status as AgendaEvent["status"]) || "agendado"
    };
  };

  const onCreateAgenda = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!createForm.title.trim() || !createForm.startDateTime || !createForm.endDateTime) {
      toast.error("Preencha título, início e fim da agenda.");
      return;
    }

    if (new Date(createForm.startDateTime).getTime() >= new Date(createForm.endDateTime).getTime()) {
      toast.error("A data de fim deve ser maior que a data de início.");
      return;
    }

    const ownerId = resolveAgendaOwnerId();
    if (!ownerId) {
      toast.error("Selecione um vendedor para criar a agenda.");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: Record<string, string> = {
        title: createForm.title.trim(),
        type: createForm.type,
        startDateTime: new Date(createForm.startDateTime).toISOString(),
        endDateTime: new Date(createForm.endDateTime).toISOString()
      };

      // Proteção: vendedor sempre cria no próprio ID.
      // Gerente/diretor podem escolher sellerId no modal.
      if (user?.role === "vendedor") {
        payload.ownerSellerId = user.id;
      } else if (createForm.sellerId) {
        payload.ownerSellerId = createForm.sellerId;
      }

      const response = await api.post("/agenda/events", { ...payload, notes: createForm.notes.trim() || undefined });

      if (createForm.type === "roteiro_visita" && draftStops.length) {
        for (const stop of draftStops) {
          await api.post(`/agenda/events/${response.data.id}/stops`, {
            clientId: stop.clientId || undefined,
            city: stop.city || undefined,
            plannedTime: stop.plannedTime ? new Date(stop.plannedTime).toISOString() : undefined,
            notes: stop.notes || undefined
          });
        }
      }

      const createdEvent = mapCreatedAgendaEvent(response.data);
      const range = getRangeFromFilter(periodFilter, customFrom, customTo);
      const createdEventInSelectedRange = isEventWithinRange(createdEvent.startDateTime, range.from, range.to);

      if (createdEventInSelectedRange) {
        setEventsRefreshToken((current) => current + 1);
        toast.success("Agenda criada com sucesso.");
      } else {
        const createdDate = formatDateOnly(createdEvent.startDateTime);
        toast(
          `Evento criado para ${createdDate}. Seu filtro está em “${PERIOD_FILTER_LABEL[periodFilter]}”. Trocar para “Próximos 7 dias”?`,
          {
            action: {
              label: "Trocar filtro",
              onClick: () => setPeriodFilter("proximos_7_dias")
            }
          }
        );
      }

      closeCreate();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Erro ao criar agenda.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex justify-between rounded-xl border bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-xl font-semibold">Agenda</h2>
          <p className="text-sm text-slate-600">Roteiro de visitas / compromissos</p>
        </div>

        <button type="button" onClick={openCreate} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white">
          Nova agenda
        </button>
      </header>

      <div className="grid gap-3 rounded-xl border bg-white p-4 shadow-sm md:grid-cols-3">
        <label className="text-sm font-medium text-slate-700">
          Visualização
          <select value={view} onChange={(event) => setView(event.target.value as Visualizacao)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="diaria">Diária</option>
            <option value="semanal">Semanal</option>
          </select>
        </label>

        <label className="text-sm font-medium text-slate-700">
          Período
          <select
            value={periodFilter}
            onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="hoje">Hoje</option>
            <option value="esta_semana">Esta semana</option>
            <option value="proximos_7_dias">Próximos 7 dias</option>
            <option value="personalizado">Personalizado</option>
          </select>
        </label>

        <label className="text-sm font-medium text-slate-700">
          <span className="block">Status</span>
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700">
            <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} />
            Somente vencidos
          </div>
        </label>

        {canFilterBySeller ? (
          <label className="text-sm font-medium text-slate-700">
            Vendedor
            <select
              value={selectedSellerId}
              onChange={(event) => setSelectedSellerId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>
                  {seller.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {periodFilter === "personalizado" ? (
        <div className="grid gap-3 rounded-xl border bg-white p-4 shadow-sm md:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">De
            <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm font-medium text-slate-700">Até
            <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </label>
        </div>
      ) : null}

      <div className="rounded-xl border bg-white p-4 text-sm text-slate-700 shadow-sm">
        <span className="font-semibold">Reuniões:</span> {summary.reunioes} | <span className="font-semibold">Roteiros:</span> {summary.roteiros} | <span className="font-semibold">Follow-ups:</span> {summary.followUps} | <span className="font-semibold">Vencidos:</span> {summary.vencidos}
      </div>

      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Roteiro de Visitas (dia)</h3>
            <p className="text-sm text-slate-500">Planeje múltiplas paradas e acompanhe execução no dia.</p>
          </div>
          <button type="button" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white" onClick={() => {
            openCreate();
            setCreateForm((current) => ({ ...current, type: "roteiro_visita", title: "Roteiro do dia" }));
          }}>
            Criar roteiro
          </button>
        </div>
      </div>

      {searchParams.get("execute") === "1" && executionEvent ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-emerald-900">Modo execução · {executionEvent.title}</h3>
              <p className="text-sm text-emerald-800">{completedStops} de {executionStops.length} paradas concluídas.</p>
            </div>
            <button type="button" className="rounded-md border border-emerald-300 px-3 py-1.5 text-sm font-medium text-emerald-800" onClick={() => void closeExecutionMode()}>
              Sair da execução
            </button>
          </div>

          <div className="mb-3 h-2 rounded-full bg-emerald-100">
            <div className="h-2 rounded-full bg-emerald-600" style={{ width: `${executionStops.length ? (completedStops / executionStops.length) * 100 : 0}%` }} />
          </div>

          {nextStop ? (
            <p className="mb-3 text-sm text-emerald-900">
              Próxima parada: #{nextStop.order} {nextStop.clientName || "Cliente"}
              {nextStop.plannedTime ? ` · ${new Date(nextStop.plannedTime).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : ""}
              {lateMinutes > 0 ? ` · atraso de ${lateMinutes} min` : ""}
            </p>
          ) : (
            <p className="mb-3 text-sm font-semibold text-emerald-900">Roteiro concluído.</p>
          )}

          <div className="space-y-2">
            {executionStops.map((stop) => (
              <div key={stop.id} className="rounded-lg border border-emerald-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">#{stop.order} {stop.clientName || "Cliente"} {stop.city ? `• ${stop.city}` : ""}</p>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={Boolean(stop.checkInAt) || isExecutionSubmitting} onClick={() => void onCheckInStop(stop.id)} className="rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 disabled:opacity-50">Iniciar parada</button>
                    <button type="button" disabled={!stop.checkInAt || Boolean(stop.checkOutAt) || isExecutionSubmitting} onClick={() => void onCheckOutStop(stop.id)} className="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 disabled:opacity-50">Finalizar parada</button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  <span className="inline-flex items-center gap-1">
                    {stop.checkInAt ? `Check-in ${formatTime(stop.checkInAt)}` : "Check-in pendente"}
                    {stop.checkInLat != null && stop.checkInLng != null ? <span title="Local registrado">📍</span> : null}
                  </span>{" "}
                  ·{" "}
                  <span className="inline-flex items-center gap-1">
                    {stop.checkOutAt ? `Check-out ${formatTime(stop.checkOutAt)}` : "Check-out pendente"}
                    {stop.checkOutLat != null && stop.checkOutLng != null ? <span title="Local registrado">📍</span> : null}
                  </span>
                </p>
                {stop.resultStatus ? <p className="mt-1 text-xs text-slate-600">Resultado: {stop.resultStatus === "realizada" ? "Realizada" : "Não realizada"}</p> : null}
              </div>
            ))}
          </div>

          {executionStops.length > 0 && completedStops === executionStops.length ? (
            <button
              type="button"
              className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
              onClick={() => {
                const realizadas = executionStops.filter((stop) => stop.resultStatus === "realizada").length;
                const naoRealizadas = executionStops.filter((stop) => stop.resultStatus === "nao_realizada").length;
                const pendencias = executionStops.length - (realizadas + naoRealizadas);
                toast.success(`Resumo do dia: ${executionStops.length} paradas, ${realizadas} realizadas, ${naoRealizadas} não realizadas e ${pendencias} pendências.`);
              }}
            >
              Encerrar roteiro do dia
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Lista de eventos */}
      <div className="rounded-xl border bg-white shadow-sm">
        {isEventsLoading ? (
          <p className="p-6 text-center text-sm text-slate-500">Carregando agenda...</p>
        ) : !filteredEvents.length ? (
          <p className="p-6 text-center text-sm text-slate-500">Nenhum evento encontrado.</p>
        ) : (
          <div className="divide-y">
            {filteredEvents.map((event) => {
              const isHighlighted = event.id === highlightedEventId;
              return (
                <div
                  key={event.id}
                  ref={isHighlighted ? highlightedEventRef : null}
                  className={`flex items-center justify-between gap-3 p-4 ${isHighlighted ? "bg-amber-50" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{event.title}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(event.startDateTime)}</p>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium">
                      <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[normalizeAgendaEventType(event.type)]}`}>{TYPE_LABEL[normalizeAgendaEventType(event.type)]}</span>
                      <span className={`rounded-full border px-2 py-1 ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                      <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-700">
                        {sellerById[event.userId] || "Vendedor"}
                      </span>
                      {isHighlighted ? (
                        <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-amber-700">Próximo compromisso</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      title={event.status === "realizado" ? "Reabrir compromisso" : "Marcar como realizado"}
                      aria-label={event.status === "realizado" ? "Reabrir compromisso" : "Marcar como realizado"}
                      className="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
                      onClick={() => void onSetAsDone(event)}
                    >
                      ✓
                    </button>

                    {isHighlighted ? (
                      <>
                        <button
                          type="button"
                          className="rounded-lg border border-brand-300 px-3 py-1 text-sm font-medium text-brand-700 hover:bg-brand-50"
                          onClick={() => void openActivityModal(event)}
                        >
                          Registrar atividade
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
                          onClick={() => openRescheduleModal(event)}
                        >
                          Reagendar
                        </button>
                      </>
                    ) : null}

                    {event.type === "roteiro_visita" && event.stops?.length ? (<div className="mt-2 text-xs text-slate-600">{event.stops.map((stop) => (<div key={stop.id}>#{stop.order} {stop.clientName || "Cliente"} {stop.city ? `• ${stop.city}` : ""}</div>))}</div>) : null}
                    {event.clientId ? (
                      <Link
                        to={`/clientes/${event.clientId}`}
                        title="Abrir cliente 360"
                        aria-label="Abrir cliente 360"
                        className="rounded-md border border-brand-300 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                      >
                        Cliente
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      title="Criar follow-up"
                      aria-label="Criar follow-up"
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => openFollowUpModal(event)}
                    >
                      F-up
                    </button>
                    <button
                      type="button"
                      title="Duplicar para amanhã"
                      aria-label="Duplicar para amanhã"
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => void onDuplicateForNextDay(event)}
                    >
                      +1d
                    </button>
                    {event.type === "roteiro_visita" && event.stops?.length ? (
                      <button
                        type="button"
                        className="rounded-md border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                        onClick={() => {
                          setExecutionEventId(event.id);
                          const params = new URLSearchParams(searchParams);
                          params.set("execute", "1");
                          params.set("eventId", event.id);
                          setSearchParams(params);
                        }}
                      >
                        Iniciar roteiro
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isResultModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setIsResultModalOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900">Resultado da visita</h3>
            <form className="mt-4 space-y-3" onSubmit={onSaveVisitResult}>
              <label className="block text-sm font-medium text-slate-700">Status
                <select value={visitResultForm.status} onChange={(event) => setVisitResultForm((current) => ({ ...current, status: event.target.value as VisitResultForm["status"] }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <option value="realizada">Realizada</option>
                  <option value="nao_realizada">Não realizada</option>
                </select>
              </label>
              {visitResultForm.status === "nao_realizada" ? (
                <label className="block text-sm font-medium text-slate-700">Motivo
                  <select value={visitResultForm.reason} onChange={(event) => setVisitResultForm((current) => ({ ...current, reason: event.target.value as VisitResultForm["reason"] }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    {Object.entries(VISIT_REASON_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              ) : null}
              <label className="block text-sm font-medium text-slate-700">Resumo
                <input value={visitResultForm.summary} onChange={(event) => setVisitResultForm((current) => ({ ...current, summary: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Próximo passo
                <select value={visitResultForm.nextStep} onChange={(event) => setVisitResultForm((current) => ({ ...current, nextStep: event.target.value as VisitResultForm["nextStep"] }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  {Object.entries(NEXT_STEP_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">Data do próximo passo
                <input type="datetime-local" value={visitResultForm.nextStepDate} onChange={(event) => setVisitResultForm((current) => ({ ...current, nextStepDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={() => setIsResultModalOpen(false)}>Cancelar</button>
                <button type="submit" className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white">Salvar resultado</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Modal criação */}
      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeCreate}>
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Nova agenda</h3>
                <p className="text-sm text-slate-500">Informe os dados básicos para criar um compromisso.</p>
              </div>
              <button type="button" onClick={closeCreate} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                ✕
              </button>
            </div>

            <form className="space-y-3" onSubmit={onCreateAgenda}>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Título</label>
                <input
                  value={createForm.title}
                  onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Ex.: Reunião de planejamento"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Tipo</label>
                  <select
                    value={createForm.type}
                    onChange={(event) => setCreateForm((current) => ({ ...current, type: event.target.value as AgendaEventType }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    {AGENDA_EVENT_TYPE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {canFilterBySeller ? (
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vendedor</label>
                    <select
                      value={createForm.sellerId}
                      onChange={(event) => setCreateForm((current) => ({ ...current, sellerId: event.target.value }))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      {isSellersLoading ? <option value="">Carregando vendedores…</option> : <option value="">Padrão do sistema</option>}
                      {!isSellersLoading
                        ? sellers.map((seller) => (
                            <option key={seller.id} value={seller.id}>
                              {seller.name}
                            </option>
                          ))
                        : null}
                    </select>
                  </div>
                ) : (
                  <input type="hidden" value={user?.id || ""} readOnly />
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Início</label>
                  <input
                    type="datetime-local"
                    value={createForm.startDateTime}
                    onChange={(event) => setCreateForm((current) => ({ ...current, startDateTime: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Fim</label>
                  <input
                    type="datetime-local"
                    value={createForm.endDateTime}
                    onChange={(event) => setCreateForm((current) => ({ ...current, endDateTime: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>


              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Observações</label>
                <textarea
                  value={createForm.notes}
                  onChange={(event) => setCreateForm((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              {createForm.type === "roteiro_visita" ? (
                <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-emerald-800">Paradas</p>
                    <button type="button" className="rounded border border-emerald-300 px-2 py-1 text-xs" onClick={() => setDraftStops((current) => [...current, { id: String(Date.now()+Math.random()), clientId: "", city: "", plannedTime: "", notes: "" }])}>Adicionar parada</button>
                  </div>
                  {draftStops.map((stop, index) => (
                    <div key={stop.id} className="grid gap-2 rounded bg-white p-2 md:grid-cols-4">
                      <select value={stop.clientId} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, clientId: event.target.value } : item))} className="rounded border px-2 py-1 text-xs">
                        <option value="">Cliente</option>
                        {activityClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                      </select>
                      <input value={stop.city} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, city: event.target.value } : item))} placeholder="Cidade" className="rounded border px-2 py-1 text-xs" />
                      <input type="datetime-local" value={stop.plannedTime} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, plannedTime: event.target.value } : item))} className="rounded border px-2 py-1 text-xs" />
                      <div className="flex gap-1">
                        <button type="button" className="rounded border px-2 text-xs" disabled={index===0} onClick={() => setDraftStops((current) => { const next=[...current]; [next[index-1],next[index]]=[next[index],next[index-1]]; return next; })}>↑</button>
                        <button type="button" className="rounded border px-2 text-xs" disabled={index===draftStops.length-1} onClick={() => setDraftStops((current) => { const next=[...current]; [next[index+1],next[index]]=[next[index],next[index+1]]; return next; })}>↓</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeCreate} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting ? "Salvando..." : "Salvar agenda"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isFollowUpModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeFollowUpModal}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Criar follow-up</h3>
                <p className="text-sm text-slate-500">Dados pré-preenchidos a partir do evento selecionado.</p>
              </div>
              <button type="button" onClick={closeFollowUpModal} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">✕</button>
            </div>

            <form className="space-y-3" onSubmit={onSubmitFollowUp}>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Tipo</label>
                <input value="Follow-up" readOnly className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vencimento</label>
                <input
                  type="datetime-local"
                  value={followUpForm.dueDate}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, dueDate: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Cliente</label>
                <select
                  value={followUpForm.clientId}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, clientId: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="">Selecione...</option>
                  {activityClients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Oportunidade (opcional)</label>
                <input
                  value={followUpForm.opportunityId}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, opportunityId: event.target.value }))}
                  placeholder="ID da oportunidade"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Notas</label>
                <textarea
                  value={followUpForm.notes}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeFollowUpModal} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
                <button type="submit" disabled={isFollowUpSubmitting} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {isFollowUpSubmitting ? "Criando..." : "Criar follow-up"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isQuickOpportunityModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setIsQuickOpportunityModalOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900">Criar oportunidade pós-visita</h3>
            <p className="mt-1 text-sm text-slate-500">Pré-preenchida para salvar em poucos segundos.</p>
            <form className="mt-4 space-y-3" onSubmit={onSubmitQuickOpportunity}>
              <label className="block text-sm font-medium text-slate-700">Título
                <input value={quickOpportunityForm.title} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, title: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="block text-sm font-medium text-slate-700">Valor
                  <input inputMode="decimal" value={quickOpportunityForm.value} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, value: event.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "") }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
                <label className="block text-sm font-medium text-slate-700">Etapa
                  <select value={quickOpportunityForm.stage} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, stage: event.target.value as QuickOpportunityForm["stage"] }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <option value="prospeccao">Prospecção</option>
                    <option value="negociacao">Negociação</option>
                    <option value="proposta">Proposta</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-slate-700">Follow-up
                  <input type="date" value={quickOpportunityForm.followUpDate} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, followUpDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsQuickOpportunityModalOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
                <button type="submit" disabled={isQuickOpportunitySubmitting} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {isQuickOpportunitySubmitting ? "Salvando..." : "Salvar oportunidade"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isActivityModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeActivityModal}>
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Registrar atividade</h3>
                <p className="text-sm text-slate-500">Cliente e tipo sugeridos a partir do próximo compromisso.</p>
              </div>
              <button type="button" onClick={closeActivityModal} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                ✕
              </button>
            </div>

            <form className="space-y-3" onSubmit={onSubmitActivity}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Tipo</label>
                  <select
                    value={activityForm.type}
                    onChange={(event) => setActivityForm((current) => ({ ...current, type: event.target.value as ActivityTypeKey }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    {ACTIVITY_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vencimento</label>
                  <input
                    type="datetime-local"
                    value={activityForm.dueDate}
                    onChange={(event) => setActivityForm((current) => ({ ...current, dueDate: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Cliente</label>
                <select
                  value={activityForm.clientId}
                  onChange={(event) => setActivityForm((current) => ({ ...current, clientId: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="">Selecione...</option>
                  {activityClients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Notas</label>
                <textarea
                  value={activityForm.notes}
                  onChange={(event) => setActivityForm((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeActivityModal} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isActivitySubmitting}
                  className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isActivitySubmitting ? "Salvando..." : "Salvar atividade"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isRescheduleOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeRescheduleModal}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Reagendar compromisso</h3>
                <p className="text-sm text-slate-500">Ajuste início e fim do evento selecionado.</p>
              </div>
              <button type="button" onClick={closeRescheduleModal} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                ✕
              </button>
            </div>

            <form className="space-y-3" onSubmit={onSubmitReschedule}>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Início</label>
                <input
                  type="datetime-local"
                  value={rescheduleStartDateTime}
                  onChange={(event) => setRescheduleStartDateTime(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Fim</label>
                <input
                  type="datetime-local"
                  value={rescheduleEndDateTime}
                  onChange={(event) => setRescheduleEndDateTime(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeRescheduleModal} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isRescheduleSubmitting}
                  className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isRescheduleSubmitting ? "Salvando..." : "Salvar reagendamento"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
