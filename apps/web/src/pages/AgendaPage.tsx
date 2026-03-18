import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { AGENDA_EVENT_TYPE_OPTIONS, type AgendaEventType as SharedAgendaEventType } from "@salesforce-pro/shared";
import { ACTIVITY_TYPE_OPTIONS, type ActivityTypeKey } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import type { AgendaEvent, AgendaEventType, AgendaStop } from "../models/agenda";
import ClientSearchSelect, { type SearchableClientOption } from "../components/clients/ClientSearchSelect";

type Seller = { id: string; name: string };
type AgendaSummary = { meetings: number; routes: number; followups: number; overdue: number };

type Visualizacao = "daily" | "weekly" | "monthly" | "list";
type PeriodFilter = "today" | "this_week" | "next_7_days" | "next_30_days" | "custom_range";
type CreateModalMode = "agenda" | "roteiro";

type CreateAgendaForm = {
  title: string;
  type: AgendaEventType;
  startDateTime: string;
  endDateTime: string;
  sellerId: string;
  clientId: string;
  notes: string;
};

type DraftStop = {
  id: string;
  clientId: string;
  city: string;
  plannedTime: string;
  notes: string;
};

type ClientOption = SearchableClientOption;

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

const typedAgendaEventOptions = AGENDA_EVENT_TYPE_OPTIONS as readonly { id: string; value: SharedAgendaEventType; label: string }[];

const TYPE_LABEL: Record<SharedAgendaEventType, string> = typedAgendaEventOptions.reduce<Record<SharedAgendaEventType, string>>((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {} as Record<SharedAgendaEventType, string>);

const TYPE_COLOR_CLASS: Record<SharedAgendaEventType, string> = {
  reuniao_online: "bg-blue-100 text-blue-800 border-blue-200",
  reuniao_presencial: "bg-green-100 text-green-800 border-green-200",
  roteiro_visita: "bg-emerald-100 text-emerald-800 border-emerald-200",
  followup: "bg-amber-100 text-amber-800 border-amber-200"
};

const UNIQUE_AGENDA_EVENT_TYPE_OPTIONS = Array.from(
  new Map(typedAgendaEventOptions.map((option) => [option.value, option])).values()
);

const CREATE_AGENDA_TYPE_OPTIONS = UNIQUE_AGENDA_EVENT_TYPE_OPTIONS.filter((option) => option.value !== "roteiro_visita");

const normalizeAgendaEventType = (type: AgendaEventType): SharedAgendaEventType => type;

const STATUS_LABEL: Record<AgendaEvent["status"], string> = {
  planned: "Planejado",
  completed: "Concluído",
  cancelled: "Cancelado"
};

const STATUS_COLOR_CLASS: Record<AgendaEvent["status"], string> = {
  planned: "border-sky-200 bg-sky-100 text-sky-700",
  completed: "border-green-200 bg-green-100 text-green-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-700"
};

const PERIOD_FILTER_LABEL: Record<PeriodFilter, string> = {
  today: "Hoje",
  this_week: "Esta semana",
  next_7_days: "Próximos 7 dias",
  next_30_days: "Próximos 30 dias",
  custom_range: "Personalizado"
};

type DateRange = {
  start: Date;
  end: Date;
};

function normalizeEventType(type: string | undefined): string {
  return String(type || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isFollowUpEvent(event: AgendaEvent) {
  const normalizedType = normalizeEventType(event.type);
  return normalizedType === "follow_up" || normalizedType === "followup";
}

function calculateAgendaSummary(events: AgendaEvent[]): AgendaSummary {
  const now = Date.now();

  return events.reduce<AgendaSummary>(
    (acc, event) => {
      if (event.status !== "planned") return acc;

      const normalizedType = normalizeEventType(event.type);
      if (normalizedType === "reuniao_online" || normalizedType === "reuniao_presencial") acc.meetings += 1;
      if (normalizedType === "roteiro_visita") acc.routes += 1;
      if (isFollowUpEvent(event)) acc.followups += 1;

      if (new Date(getEndsAt(event)).getTime() < now) acc.overdue += 1;
      return acc;
    },
    { meetings: 0, routes: 0, followups: 0, overdue: 0 }
  );
}

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

function getRangeFromFilter(periodFilter: PeriodFilter, customFrom: string, customTo: string): DateRange {
  const today = new Date();
  const dayStart = startOfDay(today);

  if (periodFilter === "today") {
    return { start: startOfDay(today), end: endOfDay(today) };
  }

  if (periodFilter === "this_week") {
    const weekStart = startOfDay(today);
    const dayOfWeek = weekStart.getDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    weekStart.setDate(weekStart.getDate() + diffToMonday);
    const weekEnd = endOfDay(new Date(weekStart));
    weekEnd.setDate(weekEnd.getDate() + 6);
    return { start: weekStart, end: weekEnd };
  }

  if (periodFilter === "next_7_days") {
    const next7Days = endOfDay(new Date(dayStart));
    next7Days.setDate(next7Days.getDate() + 6);
    return { start: dayStart, end: next7Days };
  }

  if (periodFilter === "next_30_days") {
    const next30Days = endOfDay(new Date(dayStart));
    next30Days.setDate(next30Days.getDate() + 29);
    return { start: dayStart, end: next30Days };
  }

  const from = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)) : dayStart;
  const to = customTo ? endOfDay(new Date(`${customTo}T00:00:00`)) : endOfDay(dayStart);
  return { start: from, end: to };
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

function isEventOverlappingRange(startsAt: string, endsAt: string, startDate: Date, endDate: Date) {
  const eventStart = new Date(startsAt).getTime();
  const eventEnd = new Date(endsAt).getTime();
  return eventStart <= endDate.getTime() && eventEnd >= startDate.getTime();
}

function formatDayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}



function getOwnerId(event: AgendaEvent): string {
  return event.ownerId || event.userId || event.sellerId || "";
}

function getStartsAt(event: AgendaEvent): string {
  return event.startsAt || event.startDateTime || new Date().toISOString();
}

function getEndsAt(event: AgendaEvent): string {
  return event.endsAt || event.endDateTime || getStartsAt(event);
}

function formatLocalDateParam(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatStopPlannedTime(value: AgendaStop["plannedTime"]) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function isGenericClientPlaceholder(value?: string | null) {
  const normalized = (value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return normalized === "cliente" || normalized === "cliente vinculado";
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


function mapApiAgendaEvent(item: any): AgendaEvent {
  const mappedStops = Array.isArray(item.stops)
    ? item.stops.map((stop: any, index: number) => ({
        ...stop,
        id: String(stop?.id || `stop-${item.id}-${index}`),
        order: Number(stop?.order || index + 1),
        clientId: stop?.clientId ? String(stop.clientId) : null,
        clientName: stop?.clientName || stop?.client?.name || null,
        city: stop?.city || stop?.client?.city || null,
        checkInAt: stop.checkInAt ?? stop.arrivedAt ?? null,
        checkOutAt: stop.checkOutAt ?? stop.completedAt ?? null
      }))
    : [];

  return {
    id: String(item.id),
    ownerId: String(item.ownerId || item.userId || item.ownerSellerId || item.sellerId || ""),
    userId: String(item.ownerId || item.userId || item.ownerSellerId || item.sellerId || ""),
    sellerId: String(item.ownerId || item.sellerId || item.userId || ""),
    clientId: item.clientId ? String(item.clientId) : undefined,
    opportunityId: item.opportunityId ? String(item.opportunityId) : undefined,
    title: String(item.title || "Sem título"),
    type: (item.type as AgendaEventType) || "followup",
    startsAt: new Date(item.startsAt || item.startDateTime).toISOString(),
    endsAt: new Date(item.endsAt || item.endDateTime).toISOString(),
    status: (item.status as AgendaEvent["status"]) || "planned",
    isOverdue: Boolean(item.isOverdue),
    city: item.city ? String(item.city) : mappedStops.find((stop: AgendaStop) => stop.city?.trim())?.city || undefined,
    notes: item.notes ? String(item.notes) : null,
    linkedActivityId: item.linkedActivityId ? String(item.linkedActivityId) : null,
    hasLinkedActivity: Boolean(item.hasLinkedActivity),
    stops: mappedStops
  };
}

export default function AgendaPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canFilterBySeller = user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("daily");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("today");
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [events, setEvents] = useState<AgendaEvent[]>([]);
  const [isEventsLoading, setIsEventsLoading] = useState(false);
  const [eventsRefreshToken, setEventsRefreshToken] = useState(0);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createModalMode, setCreateModalMode] = useState<CreateModalMode>("agenda");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activityClients, setActivityClients] = useState<ClientOption[]>([]);
  const loadedClientIdsRef = useRef<Set<string>>(new Set());
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
    clientId: "",
    notes: ""
  });
  const [draftStops, setDraftStops] = useState<DraftStop[]>([]);
  const [highlightedEventId, setHighlightedEventId] = useState<string>("");
  const [expandedRouteEventId, setExpandedRouteEventId] = useState<string>("");
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

  const dateRange = useMemo(() => getRangeFromFilter(periodFilter, customFrom, customTo), [periodFilter, customFrom, customTo]);

  const eventsQuery = useMemo(() => {
    const params: Record<string, string> = {
      from: formatLocalDateParam(dateRange.start),
      to: formatLocalDateParam(dateRange.end)
    };

    if (user?.role === "vendedor" && user.id) {
      params.ownerId = user.id;
    } else if (canFilterBySeller && selectedSellerId) {
      params.ownerId = selectedSellerId;
    }

    return params;
  }, [dateRange, canFilterBySeller, selectedSellerId, user?.id, user?.role]);

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

    const mergeClients = (clients: ClientOption[]) => {
      if (!clients.length) return;
      setActivityClients((current) => {
        const next = new Map(current.map((client) => [client.id, client]));
        clients.forEach((client) => {
          next.set(client.id, { ...next.get(client.id), ...client });
          loadedClientIdsRef.current.add(client.id);
        });
        return Array.from(next.values()).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      });
    };

    const mapClientOption = (item: any): ClientOption | null => {
      if (!item?.id || !item?.name) return null;
      return {
        id: String(item.id),
        name: String(item.name),
        city: item?.city ? String(item.city) : null,
        state: item?.state ? String(item.state) : null,
        cnpj: item?.cnpj ? String(item.cnpj) : null
      };
    };

    const loadClients = async () => {
      if (activityClients.length) return;
      try {
        const response = await api.get("/clients");
        if (!active) return;
        const payload = Array.isArray(response.data?.items) ? response.data.items : response.data;
        const mappedClients = Array.isArray(payload) ? payload.map(mapClientOption).filter(Boolean) as ClientOption[] : [];
        mergeClients(mappedClients);
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
    if (nextView === "today") {
      setPeriodFilter("today");
      setView("daily");
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
        if (!active) return;

        const payload = Array.isArray(response.data?.items) ? response.data.items : Array.isArray(response.data) ? response.data : [];
        const mappedEvents = payload
          .filter((item: any) => item?.id && (item?.startsAt || item?.startDateTime) && (item?.endsAt || item?.endDateTime))
          .map((item: any) => mapApiAgendaEvent(item))
          .filter((item: AgendaEvent) => Boolean(getOwnerId(item)));

        setEvents(mappedEvents);
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
        inFlightRef.current.delete(eventsQueryKey);
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
      if (user?.role === "vendedor") return getOwnerId(event) === user.id;
      if (canFilterBySeller && selectedSellerId) return getOwnerId(event) === selectedSellerId;
      return true;
    });

    const byPeriod = byRole.filter((event) => isEventOverlappingRange(getStartsAt(event), getEndsAt(event), dateRange.start, dateRange.end));
    const byOverdue = overdueOnly
      ? byPeriod.filter((event) => event.status === "planned" && new Date(getEndsAt(event)).getTime() < Date.now())
      : byPeriod;

    return byOverdue.sort((a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime());
  }, [events, user?.role, user?.id, canFilterBySeller, selectedSellerId, overdueOnly, dateRange]);

  const groupedEventsByDay = useMemo(() => {
    const grouped = new Map<string, AgendaEvent[]>();
    filteredEvents.forEach((event) => {
      const key = formatDayKey(getStartsAt(event));
      const current = grouped.get(key) || [];
      current.push(event);
      grouped.set(key, current);
    });

    return Array.from(grouped.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([day, dayEvents]) => ({
        day,
        label: new Date(`${day}T00:00:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" }),
        events: dayEvents.sort((a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime())
      }));
  }, [filteredEvents]);

  const summary = useMemo(() => calculateAgendaSummary(filteredEvents), [filteredEvents]);

  const roleScopedEvents = useMemo(() => {
    return events.filter((event) => {
      if (user?.role === "vendedor") return getOwnerId(event) === user.id;
      if (canFilterBySeller && selectedSellerId) return getOwnerId(event) === selectedSellerId;
      return true;
    });
  }, [events, user?.role, user?.id, canFilterBySeller, selectedSellerId]);

  const weeklyRoutePlans = useMemo(() => {
    const weekRange = getRangeFromFilter("this_week", customFrom, customTo);
    const grouped = new Map<string, { dayLabel: string; city: string; visits: number }>();

    roleScopedEvents
      .filter((event) => event.type === "roteiro_visita" && event.status === "planned")
      .filter((event) => isEventWithinRange(getStartsAt(event), weekRange.start, weekRange.end))
      .forEach((event) => {
        const date = new Date(getStartsAt(event));
        const dayLabel = date.toLocaleDateString("pt-BR", { weekday: "long" });
        const city = event.city || "Sem cidade";
        const key = `${formatDayKey(getStartsAt(event))}::${city}`;
        const current = grouped.get(key);
        const visits = event.stops?.length || 1;
        if (current) {
          current.visits += visits;
        } else {
          grouped.set(key, { dayLabel, city, visits });
        }
      });

    return Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, value]) => value);
  }, [roleScopedEvents, customFrom, customTo]);

  const clientById = useMemo(() => new Map(activityClients.map((client) => [client.id, client])), [activityClients]);

  useEffect(() => {
    const missingClientIds = Array.from(
      new Set(
        events.flatMap((event) => [
          event.clientId,
          ...(event.stops?.map((stop) => stop.clientId || "") || [])
        ])
      )
    )
      .filter((clientId): clientId is string => typeof clientId === "string" && clientId.trim().length > 0)
      .filter((clientId) => !clientById.has(clientId) && !loadedClientIdsRef.current.has(clientId));

    if (!missingClientIds.length) return;

    let active = true;

    const loadMissingClients = async () => {
      try {
        const responses = await Promise.allSettled(missingClientIds.map((clientId) => api.get(`/clients/${clientId}`)));
        if (!active) return;

        const nextClients = responses
          .map((response) => (response.status === "fulfilled" ? response.value.data : null))
          .filter((item: any) => item?.id && item?.name)
          .map((item: any) => ({
            id: String(item.id),
            name: String(item.name),
            city: item?.city ? String(item.city) : null,
            state: item?.state ? String(item.state) : null,
            cnpj: item?.cnpj ? String(item.cnpj) : null
          }));

        if (!nextClients.length) {
          missingClientIds.forEach((clientId) => loadedClientIdsRef.current.add(clientId));
          return;
        }

        setActivityClients((current) => {
          const merged = new Map(current.map((client) => [client.id, client]));
          nextClients.forEach((client) => {
            merged.set(client.id, { ...merged.get(client.id), ...client });
            loadedClientIdsRef.current.add(client.id);
          });
          return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
        });
      } catch {
        missingClientIds.forEach((clientId) => loadedClientIdsRef.current.add(clientId));
      }
    };

    void loadMissingClients();

    return () => {
      active = false;
    };
  }, [clientById, events]);

  const getStopClientDisplayName = (stop: AgendaStop) => {
    const explicitName = stop.clientName?.trim();
    if (explicitName && !isGenericClientPlaceholder(explicitName)) return explicitName;

    if (stop.clientId) {
      const linkedClientName = clientById.get(String(stop.clientId))?.name?.trim();
      if (linkedClientName) return linkedClientName;
      return "Cliente vinculado";
    }

    return "Cliente";
  };

  const getStopCityDisplayName = (stop: AgendaStop) => {
    const explicitCity = stop.city?.trim();
    if (explicitCity) return explicitCity;

    if (stop.clientId) {
      const linkedClientCity = clientById.get(String(stop.clientId))?.city?.trim();
      if (linkedClientCity) return linkedClientCity;
    }

    return "Não informada";
  };

  useEffect(() => {
    const shouldHighlightNext = searchParams.get("highlight") === "next";
    if (!shouldHighlightNext || !filteredEvents.length) {
      return;
    }

    const now = Date.now();
    const nextEvent =
      filteredEvents.find((event) => event.status === "planned" && new Date(getEndsAt(event)).getTime() >= now) ??
      filteredEvents.find((event) => event.status === "planned");

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
  const nextStopOrder = nextStop?.order ?? null;
  const nextStopPlannedTime = nextStop?.plannedTime;
  const nextStopClientDisplayName = nextStop ? getStopClientDisplayName(nextStop) : null;
  const nextStopPlannedTimeLabel = formatStopPlannedTime(nextStopPlannedTime);
  const lateMinutes = nextStopPlannedTime ? Math.max(0, Math.floor((Date.now() - new Date(nextStopPlannedTime).getTime()) / 60000)) : 0;

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
        triggerDashboardRefresh({ month: new Date().toISOString().slice(0, 7) });
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
      setEvents(payload.map((item: any) => mapApiAgendaEvent(item)).filter((item: AgendaEvent) => Boolean(getOwnerId(item))));
    } catch {
      // já existe carga automática com debounce
    }
  };

  const onSetAsDone = async (agendaEvent: AgendaEvent) => {
    const nextStatus = agendaEvent.status === "completed" ? "planned" : "completed";
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
    setEventsRefreshToken((current) => current + 1);
    toast.success(nextStatus === "completed" ? "Agenda marcada como concluída." : "Agenda reaberta com sucesso.");
  };

  const openFollowUpModal = (agendaEvent: AgendaEvent) => {
    const dueDate = new Date(getEndsAt(agendaEvent));
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
          (a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime()
        )
      );
      setEventsRefreshToken((current) => current + 1);
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
    const start = new Date(getStartsAt(agendaEvent));
    const end = new Date(getEndsAt(agendaEvent));
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
          (a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime()
        )
      );
      setEventsRefreshToken((current) => current + 1);
      toast.success(response.data?.message || "Evento duplicado para o dia seguinte.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível duplicar evento."));
    }
  };

  const onDeleteAgendaEvent = async (agendaEvent: AgendaEvent) => {
    const shouldDelete = window.confirm(`Excluir a agenda "${agendaEvent.title}"?`);
    if (!shouldDelete) return;

    try {
      await api.delete(`/events/${agendaEvent.id}`);
      setEvents((current) => current.filter((item) => item.id !== agendaEvent.id));
      setEventsRefreshToken((current) => current + 1);
      toast.success("Agenda excluída com sucesso.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível excluir a agenda."));
    }
  };

  const toDateTimeInputValue = (value: string) => {
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };

  const getSuggestedActivityType = (agendaType: AgendaEventType): ActivityTypeKey => {
    if (agendaType === "reuniao_online" || agendaType === "reuniao_presencial") return "reuniao";
    if (agendaType === "roteiro_visita") return "visita";
    if (agendaType === "followup") return "followup";
    return "reuniao";
  };

  const openActivityModal = async (agendaEvent: AgendaEvent) => {
    if (agendaEvent.hasLinkedActivity || agendaEvent.linkedActivityId) {
      toast.info("Este compromisso já possui atividade vinculada.");
      navigate("/atividades");
      return;
    }

    const params = new URLSearchParams();
    params.set("open", "create");
    params.set("date", getEndsAt(agendaEvent));
    params.set("type", getSuggestedActivityType(agendaEvent.type));
    params.set("ownerSellerId", getOwnerId(agendaEvent));
    params.set("notes", agendaEvent.notes || agendaEvent.description || agendaEvent.title);
    params.set("title", agendaEvent.title);
    if (agendaEvent.clientId) params.set("clientId", agendaEvent.clientId);
    if (agendaEvent.opportunityId) params.set("opportunityId", agendaEvent.opportunityId);
    if (agendaEvent.city) params.set("city", agendaEvent.city);
    if (agendaEvent.id) params.set("agendaEventId", agendaEvent.id);
    navigate(`/atividades?${params.toString()}`);
  };

  const openRescheduleModal = (agendaEvent: AgendaEvent) => {
    setRescheduleEvent(agendaEvent);
    setRescheduleStartDateTime(toDateTimeInputValue(getStartsAt(agendaEvent)));
    setRescheduleEndDateTime(toDateTimeInputValue(getEndsAt(agendaEvent)));
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
                startsAt: new Date(rescheduleStartDateTime).toISOString(),
                endsAt: new Date(rescheduleEndDateTime).toISOString()
              }
            : item
        )
      );
      setEventsRefreshToken((current) => current + 1);
      toast.success("Compromisso reagendado com sucesso.");
      closeRescheduleModal();
    } catch {
      toast.error("Não foi possível reagendar este compromisso.");
    } finally {
      setIsRescheduleSubmitting(false);
    }
  };

  const openCreate = (mode: CreateModalMode = "agenda") => {
    const isRouteMode = mode === "roteiro";
    setCreateModalMode(mode);
    setCreateForm({
      title: isRouteMode ? "Roteiro do dia" : "",
      type: isRouteMode ? "roteiro_visita" : "reuniao_online",
      startDateTime: "",
      endDateTime: "",
      sellerId: user?.role === "vendedor" ? user.id : selectedSellerId,
      clientId: "",
      notes: ""
    });
    setDraftStops(isRouteMode ? [{ id: String(Date.now()), clientId: "", city: "", plannedTime: "", notes: "" }] : []);

    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    setCreateModalMode("agenda");
    setDraftStops([]);
  };

  const resolveAgendaOwnerId = () => {
    if (user?.role === "vendedor") return user.id;
    return createForm.sellerId || user?.id || "";
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

    if (createForm.type !== "roteiro_visita" && !createForm.clientId) {
      toast.error("Selecione um cliente");
      return;
    }

    if (createForm.type === "roteiro_visita") {
      if (!draftStops.length) {
        toast.error("Adicione ao menos uma parada no roteiro.");
        return;
      }

      const hasInvalidStop = draftStops.some((stop) => !stop.clientId && !stop.city.trim());
      if (hasInvalidStop) {
        toast.error("Cada parada deve ter cliente ou cidade informada.");
        return;
      }
    }

    const ownerId = resolveAgendaOwnerId();
    if (!ownerId) {
      toast.error("Selecione um vendedor para criar a agenda.");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: Record<string, any> = {
        title: createForm.title.trim(),
        type: createForm.type,
        startDateTime: new Date(createForm.startDateTime).toISOString(),
        endDateTime: new Date(createForm.endDateTime).toISOString(),
        ...(createForm.clientId ? { clientId: createForm.clientId } : {}),
        ...(createForm.type === "roteiro_visita"
          ? {
              stops: draftStops.map((stop) => ({
                clientId: stop.clientId || undefined,
                city: stop.city.trim() || undefined,
                plannedTime: stop.plannedTime ? new Date(stop.plannedTime).toISOString() : undefined,
                notes: stop.notes.trim() || undefined
              }))
            }
          : {})
      };

      // Proteção: vendedor sempre cria no próprio ID.
      // Gerente/diretor podem escolher sellerId no modal.
      if (user?.role === "vendedor") {
        payload.ownerSellerId = user.id;
      } else if (createForm.sellerId) {
        payload.ownerSellerId = createForm.sellerId;
      }

      const response = await api.post("/agenda/events", { ...payload, notes: createForm.notes.trim() || undefined });

      const responseStops = Array.isArray(response.data?.stops) ? response.data.stops : [];
      const createdEvent = mapApiAgendaEvent({
        ...response.data,
        clientId: response.data?.clientId || createForm.clientId || undefined,
        stops: createForm.type === "roteiro_visita"
          ? draftStops.map((stop, index) => {
              const matchedResponseStop = responseStops[index] || {};
              const selectedClient = stop.clientId ? clientById.get(stop.clientId) : null;
              return {
                ...matchedResponseStop,
                id: matchedResponseStop?.id || stop.id,
                order: matchedResponseStop?.order || index + 1,
                clientId: matchedResponseStop?.clientId || stop.clientId || undefined,
                clientName: matchedResponseStop?.clientName || selectedClient?.name || null,
                city: matchedResponseStop?.city || stop.city.trim() || selectedClient?.city || null,
                plannedTime: matchedResponseStop?.plannedTime || (stop.plannedTime ? new Date(stop.plannedTime).toISOString() : undefined),
                notes: matchedResponseStop?.notes || stop.notes.trim() || undefined
              };
            })
          : response.data?.stops
      });
      const range = getRangeFromFilter(periodFilter, customFrom, customTo);
      const createdEventInSelectedRange = isEventOverlappingRange(getStartsAt(createdEvent), getEndsAt(createdEvent), range.start, range.end);

      setEventsRefreshToken((current) => current + 1);

      if (createdEventInSelectedRange) {
        setEvents((current) => [...current, createdEvent].sort((a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime()));
        toast.success(createForm.type === "roteiro_visita" ? "Roteiro criado com sucesso." : "Compromisso criado com sucesso.");
      } else {
        const createdDate = formatDateOnly(getStartsAt(createdEvent));
        toast(
          `${createForm.type === "roteiro_visita" ? "Roteiro" : "Compromisso"} criado com sucesso, mas está fora do período exibido (${createdDate}). Seu filtro está em “${PERIOD_FILTER_LABEL[periodFilter]}”. Trocar para “Próximos 7 dias”?`,
          {
            action: {
              label: "Trocar filtro",
              onClick: () => setPeriodFilter("next_7_days")
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

        <button type="button" onClick={() => openCreate("agenda")} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white">
          Nova agenda
        </button>
      </header>

      <div className="grid gap-3 rounded-xl border bg-white p-4 shadow-sm md:grid-cols-3">
        <label className="text-sm font-medium text-slate-700">
          Visualização
          <select value={view} onChange={(event) => setView(event.target.value as Visualizacao)} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="daily">Diária</option>
            <option value="weekly">Semanal</option>
            <option value="monthly">Mensal</option>
            <option value="list">Lista</option>
          </select>
        </label>

        <label className="text-sm font-medium text-slate-700">
          Período
          <select
            value={periodFilter}
            onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)}
            className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="today">Hoje</option>
            <option value="this_week">Esta semana</option>
            <option value="next_7_days">Próximos 7 dias</option>
            <option value="next_30_days">Próximos 30 dias</option>
            <option value="custom_range">Personalizado</option>
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
              className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">{user?.role === "diretor" ? "Todos" : "Time"}</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>
                  {seller.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {periodFilter === "custom_range" ? (
        <div className="grid gap-3 rounded-xl border bg-white p-4 shadow-sm md:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">De
            <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm font-medium text-slate-700">Até
            <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </label>
        </div>
      ) : null}

      <div className="rounded-xl border bg-white p-4 text-sm text-slate-700 shadow-sm">
        <span className="font-semibold">Reuniões:</span> {summary.meetings} | <span className="font-semibold">Roteiros:</span> {summary.routes} | <span className="font-semibold">Follow-ups:</span> {summary.followups} | <span className="font-semibold">Atrasados:</span> {summary.overdue}
      </div>


      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold text-slate-900">Roteiro da Semana</h3>
        <div className="mt-3 space-y-2 text-sm text-slate-700">
          {!weeklyRoutePlans.length ? (
            <p className="text-slate-500">Nenhum roteiro planejado para esta semana.</p>
          ) : (
            weeklyRoutePlans.map((item, index) => (
              <div key={`${item.dayLabel}-${item.city}-${index}`} className="rounded-lg border border-slate-200 p-3">
                <p className="font-medium text-slate-900">{item.dayLabel} – {item.city}</p>
                <p className="text-slate-600">{item.visits} visitas</p>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Roteiro de Visitas (dia)</h3>
            <p className="text-sm text-slate-500">Planeje múltiplas paradas e acompanhe execução no dia.</p>
          </div>
          <button type="button" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white" onClick={() => openCreate("roteiro")}>
            Criar roteiro
          </button>
        </div>
      </div>

      {false && searchParams.get("execute") === "1" && executionEvent ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-emerald-900">Modo execução · {executionEvent?.title}</h3>
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
              Próxima parada: #{nextStopOrder} {nextStopClientDisplayName}
              {nextStopPlannedTimeLabel ? ` · ${nextStopPlannedTimeLabel}` : ""}
              {lateMinutes > 0 ? ` · atraso de ${lateMinutes} min` : ""}
            </p>
          ) : (
            <p className="mb-3 text-sm font-semibold text-emerald-900">Roteiro concluído.</p>
          )}

          <div className="space-y-2">
            {executionStops.map((stop) => (
              <div key={stop.id} className="rounded-lg border border-emerald-200 bg-white p-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Parada #{stop.order}</p>
                  <p className="text-sm font-semibold text-slate-900">{getStopClientDisplayName(stop)}</p>
                  <p className="text-xs text-slate-600">Cidade: {getStopCityDisplayName(stop)}</p>
                  <p className="text-xs text-slate-600">
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
                  {stop.notes ? <p className="text-xs text-slate-600">Observação: {stop.notes}</p> : null}
                  {stop.resultStatus ? <p className="text-xs text-slate-600">Resultado: {stop.resultStatus === "realizada" ? "Realizada" : "Não realizada"}</p> : null}
                </div>
                <div className="mobile-action-stack mt-3">
                  <button type="button" disabled={Boolean(stop.checkInAt) || isExecutionSubmitting} onClick={() => void onCheckInStop(stop.id)} className="rounded-md border border-blue-300 px-2 py-2 text-xs font-medium text-blue-700 disabled:opacity-50">Iniciar parada</button>
                  <button type="button" disabled={!stop.checkInAt || Boolean(stop.checkOutAt) || isExecutionSubmitting} onClick={() => void onCheckOutStop(stop.id)} className="rounded-md border border-green-300 px-2 py-2 text-xs font-medium text-green-700 disabled:opacity-50">Finalizar parada</button>
                </div>
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
        ) : view === "monthly" ? (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {groupedEventsByDay.map((group) => (
              <div key={group.day} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-semibold uppercase text-slate-600">{group.label}</p>
                <div className="space-y-2">
                  {group.events.map((event) => (
                    <div key={event.id} className="rounded-md border border-slate-200 bg-white p-2">
                      <p className="truncate text-sm font-medium text-slate-900">{event.title}</p>
                      <p className="text-xs text-slate-500">{formatTime(getStartsAt(event))} • {TYPE_LABEL[event.type]}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : view === "list" ? (
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
                    <p className="text-xs text-slate-500">{formatDateTime(getStartsAt(event))}</p>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium">
                      <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[normalizeAgendaEventType(event.type)]}`}>{TYPE_LABEL[normalizeAgendaEventType(event.type)]}</span>
                      {event.type === "roteiro_visita" ? <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-emerald-800">Roteiro</span> : null}
                      <span className={`rounded-full border px-2 py-1 ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                      <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-700">
                        {sellerById[getOwnerId(event)] || "Vendedor"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {groupedEventsByDay.map((group) => (
              <div key={group.day} className="overflow-hidden rounded-lg border border-slate-200">
                <p className="bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-600">{group.label}</p>
                <div className="divide-y">
                  {group.events.map((event) => {
                    const isHighlighted = event.id === highlightedEventId;
                    return (
                      <Fragment key={event.id}>
                      <div
                        ref={isHighlighted ? highlightedEventRef : null}
                        className={`flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between ${isHighlighted ? "bg-amber-50" : ""}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-medium text-slate-900">{event.title}</p>
                          <p className="mt-1 text-xs text-slate-500">{formatDateTime(getStartsAt(event))}</p>

                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium">
                            <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[event.type]}`}>{TYPE_LABEL[event.type]}</span>
                            {event.type === "roteiro_visita" ? <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-emerald-800">Roteiro</span> : null}
                            <span className={`rounded-full border px-2 py-1 ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                            <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-700">
                              {sellerById[getOwnerId(event)] || "Vendedor"}
                            </span>
                            {isHighlighted ? (
                              <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-amber-700">Próximo compromisso</span>
                            ) : null}
                          </div>
                        </div>

                        <div className="mobile-action-stack w-full shrink-0 md:w-auto md:justify-end">
                          {event.type === "roteiro_visita" ? (
                            <button
                              type="button"
                              className="rounded-md border border-emerald-300 px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                              onClick={() => setExpandedRouteEventId((current) => (current === event.id ? "" : event.id))}
                            >
                              {expandedRouteEventId === event.id ? "Ocultar paradas" : "Ver paradas"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title={event.status === "completed" ? "Reabrir compromisso" : "Concluir compromisso"}
                            aria-label={event.status === "completed" ? "Reabrir compromisso" : "Concluir compromisso"}
                            className="rounded-md border border-green-300 px-3 py-2 text-xs font-medium text-green-700 hover:bg-green-50"
                            onClick={() => void onSetAsDone(event)}
                          >
                            {event.status === "completed" ? "Reabrir compromisso" : "Concluir compromisso"}
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-rose-300 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50"
                            onClick={() => void onDeleteAgendaEvent(event)}
                          >
                            Excluir
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-brand-300 px-3 py-2 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={Boolean(event.hasLinkedActivity || event.linkedActivityId)}
                            onClick={() => void openActivityModal(event)}
                          >
                            {event.hasLinkedActivity || event.linkedActivityId ? "Ver atividade" : "Registrar atividade"}
                          </button>

                          {event.clientId ? (
                            <Link
                              to={`/clientes/${event.clientId}`}
                              title="Abrir cliente 360"
                              aria-label="Abrir cliente 360"
                              className="rounded-md border border-brand-300 px-3 py-2 text-center text-xs font-medium text-brand-700 hover:bg-brand-50"
                            >
                              Cliente
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      {event.type === "roteiro_visita" && expandedRouteEventId === event.id ? (
                        <div className="border-t border-emerald-100 bg-emerald-50 px-4 py-3">
                          {!event.stops?.length ? (
                            <p className="text-xs text-emerald-700">Sem paradas cadastradas.</p>
                          ) : (
                            <ul className="space-y-2">
                              {event.stops.map((stop) => (
                                <li key={stop.id} className="rounded-lg border border-emerald-200 bg-white p-3">
                                  <div className="space-y-1 text-sm text-slate-800">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Parada #{stop.order}</p>
                                    <p className="font-semibold text-slate-900">{getStopClientDisplayName(stop)}</p>
                                    <p className="text-xs text-slate-600">Cidade: {getStopCityDisplayName(stop)}</p>
                                    <p className="text-xs text-slate-600">Observação: {stop.notes || "Sem observação"}</p>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 p-0 sm:items-center sm:p-4" onClick={closeCreate}>
          <div className="flex h-[100dvh] w-full max-w-xl flex-col overflow-hidden bg-white shadow-xl sm:my-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{createModalMode === "roteiro" ? "Roteiro de visita" : "Nova agenda"}</h3>
                <p className="text-sm text-slate-500">{createModalMode === "roteiro" ? "Planeje paradas por cliente/cidade para execução do vendedor." : "Informe os dados básicos para criar um compromisso."}</p>
              </div>
              <button type="button" onClick={closeCreate} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                ✕
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onCreateAgenda}>
              <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4 pb-24 sm:px-6 sm:pb-6">
                <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Título</label>
                <input
                  value={createForm.title}
                  onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))}
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Ex.: Reunião de planejamento"
                />
                </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Tipo</label>
                  {createModalMode === "roteiro" ? (
                    <input value="Roteiro de visita" readOnly className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" />
                  ) : (
                    <select
                      value={createForm.type}
                      onChange={(event) => setCreateForm((current) => ({ ...current, type: event.target.value as AgendaEventType }))}
                      className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      {CREATE_AGENDA_TYPE_OPTIONS.map((option) => (
                        <option key={option.id} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {canFilterBySeller ? (
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vendedor</label>
                    <select
                      value={createForm.sellerId}
                      onChange={(event) => setCreateForm((current) => ({ ...current, sellerId: event.target.value }))}
                      className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
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
                    className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Fim</label>
                  <input
                    type="datetime-local"
                    value={createForm.endDateTime}
                    onChange={(event) => setCreateForm((current) => ({ ...current, endDateTime: event.target.value }))}
                    className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              {createForm.type !== "roteiro_visita" ? (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Cliente</label>
                  <ClientSearchSelect
                    clients={activityClients}
                    value={createForm.clientId}
                    onChange={(clientId) =>
                      setCreateForm((current) => ({
                        ...current,
                        clientId
                      }))
                    }
                    required
                    emptyLabel="Nenhum cliente encontrado."
                  />
                </div>
              ) : null}


              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Observações</label>
                <textarea
                  value={createForm.notes}
                  onChange={(event) => setCreateForm((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-20 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              {createForm.type === "roteiro_visita" ? (
                <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-xs text-emerald-700">Paradas são obrigatórias no roteiro.</p>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-emerald-800">Paradas</p>
                    <button type="button" className="rounded border border-emerald-300 px-2 py-1 text-xs" onClick={() => setDraftStops((current) => [...current, { id: String(Date.now()+Math.random()), clientId: "", city: "", plannedTime: "", notes: "" }])}>Adicionar parada</button>
                  </div>
                  {draftStops.map((stop, index) => (
                    <div key={stop.id} className="grid gap-2 rounded bg-white p-3 md:grid-cols-5">
                      <div className="space-y-1 md:col-span-2">
                        <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Cliente</label>
                        <ClientSearchSelect
                          clients={activityClients}
                          value={stop.clientId}
                          onChange={(clientId) =>
                            setDraftStops((current) =>
                              current.map((item) => {
                                if (item.id !== stop.id) return item;
                                const selectedClient = clientById.get(clientId);
                                return {
                                  ...item,
                                  clientId,
                                  city: item.city || selectedClient?.city || ""
                                };
                              })
                            )
                          }
                          placeholder="Pesquisar por nome, cidade, UF ou CNPJ"
                          emptyLabel="Nenhum cliente encontrado."
                          maxListHeightClassName="max-h-40"
                        />
                      </div>
                      <label className="space-y-1">
                        <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Cidade</span>
                        <input value={stop.city} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, city: event.target.value } : item))} placeholder="Cidade" className="w-full rounded border px-2 py-2 text-sm" />
                      </label>
                      <label className="space-y-1">
                        <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Horário</span>
                        <input type="datetime-local" value={stop.plannedTime} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, plannedTime: event.target.value } : item))} className="w-full rounded border px-2 py-2 text-sm" />
                      </label>
                      <label className="space-y-1">
                        <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Observações</span>
                        <input value={stop.notes} onChange={(event) => setDraftStops((current) => current.map((item) => item.id === stop.id ? { ...item, notes: event.target.value } : item))} placeholder="Observações" className="w-full rounded border px-2 py-2 text-sm" />
                      </label>
                      <div className="flex items-end justify-end gap-1">
                        <button type="button" className="rounded border px-2 text-xs" disabled={index===0} onClick={() => setDraftStops((current) => { const next=[...current]; [next[index-1],next[index]]=[next[index],next[index-1]]; return next; })}>↑</button>
                        <button type="button" className="rounded border px-2 text-xs" disabled={index===draftStops.length-1} onClick={() => setDraftStops((current) => { const next=[...current]; [next[index+1],next[index]]=[next[index],next[index+1]]; return next; })}>↓</button>
                        <button type="button" className="rounded border border-rose-200 px-2 text-xs text-rose-700" disabled={draftStops.length===1} onClick={() => setDraftStops((current) => current.filter((item) => item.id !== stop.id))}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              </div>

              <div className="mobile-action-stack sticky bottom-0 shrink-0 justify-end border-t border-slate-100 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] sm:px-6">
                <button type="button" onClick={closeCreate} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting ? "Salvando..." : createModalMode === "roteiro" ? "Salvar roteiro" : "Salvar agenda"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isFollowUpModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeFollowUpModal}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(e) => e.stopPropagation()}>
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
                <input value="Follow-up" readOnly className="w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vencimento</label>
                <input
                  type="datetime-local"
                  value={followUpForm.dueDate}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, dueDate: event.target.value }))}
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Cliente</label>
                <ClientSearchSelect
                  clients={activityClients}
                  value={followUpForm.clientId}
                  onChange={(clientId) =>
                    setFollowUpForm((current) => ({
                      ...current,
                      clientId
                    }))
                  }
                  required
                  emptyLabel="Nenhum cliente encontrado."
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Oportunidade (opcional)</label>
                <input
                  value={followUpForm.opportunityId}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, opportunityId: event.target.value }))}
                  placeholder="ID da oportunidade"
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Notas</label>
                <textarea
                  value={followUpForm.notes}
                  onChange={(event) => setFollowUpForm((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-20 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="mobile-action-stack justify-end pt-2">
                <button type="button" onClick={closeFollowUpModal} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
                <button type="submit" disabled={isFollowUpSubmitting} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {isFollowUpSubmitting ? "Criando..." : "Criar follow-up"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isQuickOpportunityModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setIsQuickOpportunityModalOpen(false)}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900">Criar oportunidade pós-visita</h3>
            <p className="mt-1 text-sm text-slate-500">Pré-preenchida para salvar em poucos segundos.</p>
            <form className="mt-4 space-y-3" onSubmit={onSubmitQuickOpportunity}>
              <label className="block text-sm font-medium text-slate-700">Título
                <input value={quickOpportunityForm.title} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, title: event.target.value }))} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <label className="block text-sm font-medium text-slate-700">Valor
                  <input inputMode="decimal" value={quickOpportunityForm.value} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, value: event.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "") }))} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
                <label className="block text-sm font-medium text-slate-700">Etapa
                  <select value={quickOpportunityForm.stage} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, stage: event.target.value as QuickOpportunityForm["stage"] }))} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <option value="prospeccao">Prospecção</option>
                    <option value="negociacao">Negociação</option>
                    <option value="proposta">Proposta</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-slate-700">Follow-up
                  <input type="date" value={quickOpportunityForm.followUpDate} onChange={(event) => setQuickOpportunityForm((current) => ({ ...current, followUpDate: event.target.value }))} className="mt-1 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </div>
              <div className="mobile-action-stack justify-end pt-2">
                <button type="button" onClick={() => setIsQuickOpportunityModalOpen(false)} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
                <button type="submit" disabled={isQuickOpportunitySubmitting} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {isQuickOpportunitySubmitting ? "Salvando..." : "Salvar oportunidade"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isRescheduleOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeRescheduleModal}>
          <div className="bg-white w-full max-w-lg rounded-lg shadow max-h-[90vh] overflow-y-auto px-4 py-4 md:px-6" onClick={(e) => e.stopPropagation()}>
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
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Fim</label>
                <input
                  type="datetime-local"
                  value={rescheduleEndDateTime}
                  onChange={(event) => setRescheduleEndDateTime(event.target.value)}
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="mobile-action-stack justify-end pt-2">
                <button type="button" onClick={closeRescheduleModal} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isRescheduleSubmitting}
                  className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70"
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
