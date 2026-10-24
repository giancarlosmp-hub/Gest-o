import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { AGENDA_EVENT_TYPE_LABELS, AGENDA_EVENT_TYPE_OPTIONS, type AgendaEventType as SharedAgendaEventType } from "@salesforce-pro/shared";
import { getApiErrorMessage } from "../lib/apiError";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import type { AgendaEvent, AgendaEventType, AgendaStop } from "../models/agenda";
import ClientSearchSelect, { type SearchableClientOption } from "../components/clients/ClientSearchSelect";
import WeeklyCommercialPlan from "../components/planning/WeeklyCommercialPlan";
import AgendaIntelligencePanel from "../components/agenda/AgendaIntelligencePanel";
import {
  brazilDayEnd,
  brazilDayKeyOf,
  brazilDayStart,
  brazilMinutesOfDay,
  brazilMonthKey,
  brazilTodayKey,
  brazilWeekday,
  formatBrazil,
  formatBrazilDay,
  fromBrazilDateTimeInput,
  shiftBrazilDayKey
} from "../lib/brazilDate";
import { agendaEventActions, completeAgendaEventHref, PENDING_WINDOW_DAYS } from "../lib/agendaActivity";
import { NotDoneDialog, RescheduleDialog } from "../components/agenda/AgendaEventDialogs";

type Seller = { id: string; name: string };

type Visualizacao = "daily" | "weekly" | "monthly" | "list";
type PeriodFilter = "today" | "this_week" | "next_7_days" | "next_30_days" | "custom_range";

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
  notes: string;
};

type ClientOption = SearchableClientOption;

type VisitResultForm = {
  status: "realizada" | "nao_realizada";
  summary: string;
};

const typedAgendaEventOptions = AGENDA_EVENT_TYPE_OPTIONS as readonly { id: string; value: SharedAgendaEventType; label: string }[];

// Inclui o rótulo de tipos legados (followup) dos compromissos antigos.
const TYPE_LABEL: Record<SharedAgendaEventType, string> = AGENDA_EVENT_TYPE_LABELS;

const TYPE_COLOR_CLASS: Record<SharedAgendaEventType, string> = {
  reuniao_online: "bg-blue-100 text-blue-800 border-blue-200",
  reuniao_presencial: "bg-green-100 text-green-800 border-green-200",
  roteiro_visita: "bg-emerald-100 text-emerald-800 border-emerald-200",
  followup: "bg-amber-100 text-amber-800 border-amber-200",
  ligacao: "bg-amber-100 text-amber-800 border-amber-200",
  whatsapp: "bg-amber-100 text-amber-800 border-amber-200",
  visita: "bg-green-100 text-green-800 border-green-200",
  proposta: "bg-violet-100 text-violet-800 border-violet-200",
  fechamento: "bg-violet-100 text-violet-800 border-violet-200"
};

const UNIQUE_AGENDA_EVENT_TYPE_OPTIONS = Array.from(
  new Map(typedAgendaEventOptions.map((option) => [option.value, option])).values()
);

// Catálogo único; o roteiro de visita planeja várias visitas de uma vez.
const CREATE_AGENDA_TYPE_OPTIONS = UNIQUE_AGENDA_EVENT_TYPE_OPTIONS.map((option) =>
  option.value === "roteiro_visita" ? { ...option, label: "Roteiro de visita (várias visitas)" } : option
);

const STATUS_LABEL: Record<AgendaEvent["status"], string> = {
  planned: "Planejado",
  completed: "Concluído",
  cancelled: "Cancelado",
  not_done: "Não realizado"
};

const STATUS_COLOR_CLASS: Record<AgendaEvent["status"], string> = {
  planned: "border-sky-200 bg-sky-100 text-sky-700",
  completed: "border-green-200 bg-green-100 text-green-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-700",
  not_done: "border-rose-200 bg-rose-100 text-rose-700"
};

const PERIOD_FILTER_LABEL: Record<PeriodFilter, string> = {
  today: "Hoje",
  this_week: "Esta semana",
  next_7_days: "Próximos 7 dias",
  next_30_days: "Próximos 30 dias",
  custom_range: "Personalizado"
};

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 21;
const HOUR_HEIGHT_PX = 72;

// Período em dias de Brasília (00:00 a 23:59:59.999 de Brasília), qualquer que seja o fuso do aparelho.
type DateRange = {
  start: Date;
  end: Date;
  startKey: string;
  endKey: string;
};

type PositionedAgendaEvent = {
  event: AgendaEvent;
  column: number;
  columns: number;
};

const DAY_MS = 86_400_000;

function rangeFromDayKeys(startKey: string, endKey: string): DateRange {
  return { start: brazilDayStart(startKey), end: brazilDayEnd(endKey), startKey, endKey };
}

function getRangeFromFilter(periodFilter: PeriodFilter, customFrom: string, customTo: string, anchorDate: Date = new Date()): DateRange {
  const todayKey = brazilDayKeyOf(anchorDate);

  if (periodFilter === "today") {
    return rangeFromDayKeys(todayKey, todayKey);
  }

  if (periodFilter === "this_week") {
    const dayOfWeek = brazilWeekday(todayKey);
    const monday = shiftBrazilDayKey(todayKey, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    return rangeFromDayKeys(monday, shiftBrazilDayKey(monday, 6));
  }

  if (periodFilter === "next_7_days") {
    return rangeFromDayKeys(todayKey, shiftBrazilDayKey(todayKey, 6));
  }

  if (periodFilter === "next_30_days") {
    return rangeFromDayKeys(todayKey, shiftBrazilDayKey(todayKey, 29));
  }

  return rangeFromDayKeys(customFrom || todayKey, customTo || todayKey);
}

function formatDateTime(value: string) {
  return formatBrazil(value, { dateStyle: "short", timeStyle: "short" });
}

function formatDateOnly(value: string) {
  return formatBrazil(value, { day: "2-digit", month: "2-digit" });
}

function formatPeriodLabel(range: DateRange, view: Visualizacao) {
  if (range.startKey === range.endKey || view === "daily") {
    return formatBrazilDay(range.startKey, { weekday: "long", day: "2-digit", month: "long" });
  }

  return `${formatBrazilDay(range.startKey, { day: "2-digit", month: "short" })} - ${formatBrazilDay(range.endKey, { day: "2-digit", month: "short" })}`;
}

function isEventOverlappingRange(startsAt: string, endsAt: string, startDate: Date, endDate: Date) {
  const eventStart = new Date(startsAt).getTime();
  const eventEnd = new Date(endsAt).getTime();
  return eventStart <= endDate.getTime() && eventEnd >= startDate.getTime();
}

// Dia de Brasília do compromisso.
const formatDayKey = brazilDayKeyOf;

function getOwnerId(event: AgendaEvent): string {
  return event.ownerId || event.userId || event.sellerId || "";
}

function getStartsAt(event: AgendaEvent): string {
  return event.startsAt || event.startDateTime || new Date().toISOString();
}

function getEndsAt(event: AgendaEvent): string {
  return event.endsAt || event.endDateTime || getStartsAt(event);
}

function formatTime(value: string) {
  return formatBrazil(value, { hour: "2-digit", minute: "2-digit" });
}

function formatHourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function getEventVisualType(event: AgendaEvent) {
  if (event.status === "cancelled" || event.status === "not_done") return "cancelled";
  if (event.status === "completed") return "completed";
  if (new Date(getEndsAt(event)).getTime() < Date.now() && event.status === "planned") return "overdue";
  if (event.type === "roteiro_visita") return "route";
  if (event.type === "followup" || event.type === "ligacao" || event.type === "whatsapp") return "followup";
  if (event.type === "reuniao_online" || event.type === "reuniao_presencial") return "meeting";
  return "visit";
}

function getEventAccentClass(event: AgendaEvent) {
  const visualType = getEventVisualType(event);
  if (visualType === "overdue") return "border-l-4 border-red-500 bg-red-50/70";
  if (visualType === "route") return "border-l-4 border-emerald-500 bg-emerald-50/70";
  if (visualType === "followup") return "border-l-4 border-amber-500 bg-amber-50/70";
  if (visualType === "meeting") return "border-l-4 border-blue-500 bg-blue-50/70";
  if (visualType === "completed") return "border-l-4 border-slate-400 bg-slate-100/80";
  return "border-l-4 border-green-500 bg-green-50/70";
}

function createEmptyDraftStop(): DraftStop {
  return {
    id: String(Date.now() + Math.random()),
    clientId: "",
    city: "",
    notes: ""
  };
}

function getEventMinutesRange(event: AgendaEvent) {
  const startMinutes = brazilMinutesOfDay(getStartsAt(event));
  const endMinutes = Math.max(startMinutes + 30, brazilMinutesOfDay(getEndsAt(event)));
  return { startMinutes, endMinutes };
}

function buildPositionedAgendaEvents(events: AgendaEvent[]): PositionedAgendaEvent[] {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => getEventMinutesRange(a).startMinutes - getEventMinutesRange(b).startMinutes);
  const clusters: AgendaEvent[][] = [];
  let currentCluster: AgendaEvent[] = [];
  let currentClusterEnd = -1;

  sorted.forEach((event) => {
    const { startMinutes, endMinutes } = getEventMinutesRange(event);
    if (!currentCluster.length || startMinutes < currentClusterEnd) {
      currentCluster.push(event);
      currentClusterEnd = Math.max(currentClusterEnd, endMinutes);
      return;
    }
    clusters.push(currentCluster);
    currentCluster = [event];
    currentClusterEnd = endMinutes;
  });

  if (currentCluster.length) clusters.push(currentCluster);

  const positioned: PositionedAgendaEvent[] = [];
  clusters.forEach((cluster) => {
    const inUseByColumn = new Map<number, number>();
    const positionedCluster: Array<{ event: AgendaEvent; column: number }> = [];
    let maxColumn = 0;

    cluster.forEach((event) => {
      const { startMinutes, endMinutes } = getEventMinutesRange(event);
      let column = 0;
      while ((inUseByColumn.get(column) ?? -1) > startMinutes) column += 1;
      inUseByColumn.set(column, endMinutes);
      maxColumn = Math.max(maxColumn, column);
      positionedCluster.push({ event, column });
    });

    const columns = maxColumn + 1;
    positionedCluster.forEach((item) => {
      positioned.push({ event: item.event, column: item.column, columns });
    });
  });

  return positioned;
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
    notDoneReason: item.notDoneReason ? String(item.notDoneReason) : null,
    linkedActivityId: item.linkedActivityId ? String(item.linkedActivityId) : null,
    hasLinkedActivity: Boolean(item.hasLinkedActivity),
    stops: mappedStops
  };
}

export default function AgendaPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activityClients, setActivityClients] = useState<ClientOption[]>([]);
  const loadedClientIdsRef = useRef<Set<string>>(new Set());
  const [rescheduleTarget, setRescheduleTarget] = useState<AgendaEvent | null>(null);
  const [notDoneTarget, setNotDoneTarget] = useState<AgendaEvent | null>(null);

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
  const [expandedRouteEventId, setExpandedRouteEventId] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<AgendaEvent | null>(null);
  const [selectedMonthDayKey, setSelectedMonthDayKey] = useState("");
  const highlightedEventRef = useRef<HTMLElement | null>(null);
  const inFlightRef = useRef<Map<string, Promise<any>>>(new Map());
  const [executionEventId, setExecutionEventId] = useState("");
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [activeStopId, setActiveStopId] = useState("");
  const [isExecutionSubmitting, setIsExecutionSubmitting] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [isMoreFiltersOpen, setIsMoreFiltersOpen] = useState(false);
  const [periodAnchorDate, setPeriodAnchorDate] = useState(() => new Date());
  const [visitResultForm, setVisitResultForm] = useState<VisitResultForm>({
    status: "realizada",
    summary: ""
  });

  const dateRange = useMemo(
    () => getRangeFromFilter(periodFilter, customFrom, customTo, periodAnchorDate),
    [periodFilter, customFrom, customTo, periodAnchorDate]
  );

  const eventsQuery = useMemo(() => {
    const params: Record<string, string> = {
      from: dateRange.startKey,
      to: dateRange.endKey
    };

    if (user?.role === "vendedor" && user.id) {
      params.ownerId = user.id;
    } else if (canFilterBySeller && selectedSellerId) {
      params.ownerId = selectedSellerId;
    }

    return params;
  }, [dateRange, canFilterBySeller, selectedSellerId, user?.id, user?.role]);

  const eventsQueryKey = useMemo(() => JSON.stringify(eventsQuery), [eventsQuery]);
  const agendaIntelligenceDate = dateRange.startKey;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setIsMobile(mediaQuery.matches);
      setIsFiltersOpen((current) => (mediaQuery.matches ? false : current));
    };
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

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
        fantasyName: item?.fantasyName ? String(item.fantasyName) : null,
        code: item?.code ? String(item.code) : null,
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
    if (searchParams.get("pendentes") !== "antigos") return;
    const windowStartKey = shiftBrazilDayKey(brazilTodayKey(), -PENDING_WINDOW_DAYS);
    setView("list");
    setPeriodFilter("custom_range");
    setCustomFrom(shiftBrazilDayKey(windowStartKey, -365));
    setCustomTo(shiftBrazilDayKey(windowStartKey, -1));
    setOverdueOnly(true);
    setIsMoreFiltersOpen(true);
  }, [searchParams]);

  useEffect(() => {
    // Links antigos do "Iniciar roteiro" (?execute=1) abrem a tela "Executar roteiro".
    if (searchParams.get("execute") === "1") {
      const eventId = searchParams.get("eventId");
      navigate(eventId ? `/agenda/roteiro/${eventId}` : "/agenda/roteiro", { replace: true });
    }
  }, [searchParams, navigate]);

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
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, dayEvents]) => ({
        day,
        label: formatBrazilDay(day, { weekday: "long", day: "2-digit", month: "2-digit" }),
        events: dayEvents.sort((a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime())
      }));
  }, [filteredEvents]);

  const timelineHours = useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, index) => DAY_START_HOUR + index),
    []
  );

  const selectedDayEvents = useMemo(() => {
    const selectedDayKey = dateRange.startKey;
    return filteredEvents.filter((event) => formatDayKey(getStartsAt(event)) === selectedDayKey);
  }, [filteredEvents, dateRange]);

  const positionedSelectedDayEvents = useMemo(() => buildPositionedAgendaEvents(selectedDayEvents), [selectedDayEvents]);

  const weeklyCalendarDays = useMemo(() => {
    const dayOfWeek = brazilWeekday(dateRange.startKey);
    const monday = shiftBrazilDayKey(dateRange.startKey, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);

    return Array.from({ length: 7 }).map((_, index) => {
      const key = shiftBrazilDayKey(monday, index);
      return {
        key,
        events: filteredEvents.filter((event) => formatDayKey(getStartsAt(event)) === key)
      };
    });
  }, [dateRange, filteredEvents]);

  const weeklyCalendarDaysWithLayout = useMemo(
    () => weeklyCalendarDays.map((day) => ({ ...day, positionedEvents: buildPositionedAgendaEvents(day.events) })),
    [weeklyCalendarDays]
  );

  const monthlyCalendarDays = useMemo(() => {
    const monthKey = brazilDayKeyOf(periodAnchorDate).slice(0, 7);
    const monthStartKey = `${monthKey}-01`;
    const [year, month] = monthKey.split("-").map(Number);
    const monthEndKey = `${monthKey}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
    const gridStartKey = shiftBrazilDayKey(monthStartKey, -brazilWeekday(monthStartKey));
    const gridEndKey = shiftBrazilDayKey(monthEndKey, 6 - brazilWeekday(monthEndKey));

    const days: Array<{ key: string; isCurrentMonth: boolean; events: AgendaEvent[] }> = [];
    for (let key = gridStartKey; key <= gridEndKey; key = shiftBrazilDayKey(key, 1)) {
      days.push({
        key,
        isCurrentMonth: key.startsWith(monthKey),
        events: filteredEvents.filter((event) => formatDayKey(getStartsAt(event)) === key)
      });
    }
    return days;
  }, [periodAnchorDate, filteredEvents]);

  const selectedMonthDayEvents = useMemo(() => {
    if (!selectedMonthDayKey) return [] as AgendaEvent[];
    return filteredEvents.filter((event) => formatDayKey(getStartsAt(event)) === selectedMonthDayKey);
  }, [selectedMonthDayKey, filteredEvents]);

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
            fantasyName: item?.fantasyName ? String(item.fantasyName) : null,
            code: item?.code ? String(item.code) : null,
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
      setVisitResultForm({
        status: "realizada",
        summary: ""
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

    setIsExecutionSubmitting(true);
    try {
      const payload = {
        status: visitResultForm.status,
        summary: visitResultForm.summary
      };
      const response = await api.patch(`/agenda-events/${activeStopId}/result`, payload);
      updateStopState(activeStopId, response.data);
      closeResultModal();
      setEventsRefreshToken((current) => current + 1);
      toast.success("Visita registrada com sucesso");
      triggerDashboardRefresh({ month: brazilMonthKey() });
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar o resultado."));
    } finally {
      setIsExecutionSubmitting(false);
    }
  };

  const closeResultModal = () => {
    setIsResultModalOpen(false);
    setActiveStopId("");
    setVisitResultForm({
      status: "realizada",
      summary: ""
    });
  };

  // Só reabre (gerente/diretor): concluir passa pela atividade vinculada.
  const onReopen = async (agendaEvent: AgendaEvent) => {
    const nextStatus = "planned" as const;
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
    setSelectedEvent(null);
    toast.success("Compromisso reaberto.");
  };

  const onDeleteAgendaEvent = async (agendaEvent: AgendaEvent) => {
    const shouldDelete = window.confirm(`Excluir o compromisso "${agendaEvent.title}"?`);
    if (!shouldDelete) return;

    try {
      await api.delete(`/events/${agendaEvent.id}`);
      setEvents((current) => current.filter((item) => item.id !== agendaEvent.id));
      setEventsRefreshToken((current) => current + 1);
      setSelectedEvent(null);
      toast.success("Compromisso excluído.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível excluir o compromisso."));
    }
  };

  // "Concluir" abre a Nova atividade preenchida e vinculada; salvar conclui o compromisso.
  const openActivityModal = (agendaEvent: AgendaEvent) => {
    if (agendaEvent.hasLinkedActivity || agendaEvent.linkedActivityId) {
      toast.info("Este compromisso já possui atividade vinculada.");
      navigate("/atividades");
      return;
    }
    navigate(completeAgendaEventHref({ ...agendaEvent, startsAt: getStartsAt(agendaEvent), ownerId: getOwnerId(agendaEvent), notes: agendaEvent.notes || agendaEvent.description }));
  };

  // Depois de reagendar ou marcar não realizado: fecha os detalhes e recarrega o período.
  const onEventChanged = () => {
    setRescheduleTarget(null);
    setNotDoneTarget(null);
    setSelectedEvent(null);
    setEventsRefreshToken((current) => current + 1);
  };

  const openCreate = (initialType: AgendaEventType = "reuniao_online") => {
    const isRouteMode = initialType === "roteiro_visita";
    setCreateForm({
      title: isRouteMode ? "Roteiro do dia" : "",
      type: initialType,
      startDateTime: "",
      endDateTime: "",
      sellerId: user?.role === "vendedor" ? user.id : selectedSellerId,
      clientId: "",
      notes: ""
    });
    setDraftStops(isRouteMode ? [createEmptyDraftStop()] : []);

    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    setDraftStops([]);
  };

  const updateDraftStop = (stopId: string, patch: Partial<DraftStop>) => {
    setDraftStops((current) => current.map((stop) => (stop.id === stopId ? { ...stop, ...patch } : stop)));
  };

  const handleCreateTypeChange = (nextType: AgendaEventType) => {
    setCreateForm((current) => ({ ...current, type: nextType }));
    if (nextType === "roteiro_visita") {
      setDraftStops((current) => (current.length ? current : [createEmptyDraftStop()]));
      return;
    }
    setDraftStops([]);
  };

  const moveDraftStop = (index: number, direction: -1 | 1) => {
    setDraftStops((current) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  };

  const removeDraftStop = (stopId: string) => {
    setDraftStops((current) => (current.length === 1 ? current : current.filter((stop) => stop.id !== stopId)));
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

    const isRoute = createForm.type === "roteiro_visita";
    // Datas e horários do formulário são de Brasília, qualquer que seja o fuso do aparelho.
    const startDateTimeIso = isRoute ? brazilDayStart(createForm.startDateTime).toISOString() : fromBrazilDateTimeInput(createForm.startDateTime).toISOString();
    const endDateTimeIso = isRoute ? brazilDayEnd(createForm.endDateTime).toISOString() : fromBrazilDateTimeInput(createForm.endDateTime).toISOString();

    if (new Date(startDateTimeIso).getTime() >= new Date(endDateTimeIso).getTime()) {
      toast.error("A data de fim deve ser maior que a data de início.");
      return;
    }

    if (!isRoute && !createForm.clientId) {
      toast.error("Selecione um cliente");
      return;
    }

    if (isRoute) {
      if (!draftStops.length) {
        toast.error("Adicione ao menos uma parada no roteiro.");
        return;
      }

      const hasInvalidStop = draftStops.some((stop) => !stop.clientId);
      if (hasInvalidStop) {
        toast.error("Selecione um cliente para cada parada.");
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
        startDateTime: startDateTimeIso,
        endDateTime: endDateTimeIso,
        ...(createForm.clientId ? { clientId: createForm.clientId } : {}),
        ...(isRoute
          ? {
              stops: draftStops.map((stop) => ({
                clientId: stop.clientId || undefined,
                city: clientById.get(stop.clientId)?.city?.trim() || undefined,
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
                city: matchedResponseStop?.city || selectedClient?.city || stop.city.trim() || null,
                notes: matchedResponseStop?.notes || stop.notes.trim() || undefined
              };
            })
          : response.data?.stops
      });
      const range = getRangeFromFilter(periodFilter, customFrom, customTo, periodAnchorDate);
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

  const periodLabel = useMemo(() => formatPeriodLabel(dateRange, view), [dateRange, view]);

  const navigatePeriod = (direction: -1 | 1) => {
    setPeriodAnchorDate((current) => {
      const days = periodFilter === "today" || view === "daily" ? 1 : periodFilter === "next_30_days" || view === "monthly" ? 30 : 7;
      return new Date(current.getTime() + direction * days * DAY_MS);
    });
  };

  const goToToday = () => {
    setPeriodAnchorDate(new Date());
    setPeriodFilter("today");
    if (view !== "daily") setView("daily");
  };

  const openAgendaDetails = (event: AgendaEvent) => {
    setSelectedEvent(event);
  };

  const selectedEventActions = selectedEvent ? agendaEventActions(selectedEvent, user?.role) : null;

  return (
    <section className="flex min-h-[calc(100dvh-9rem)] flex-col gap-3 overflow-hidden">
      <header className="shrink-0 flex flex-col gap-2 rounded-xl border bg-white p-2.5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Agenda operacional</p>
          <h2 className="text-lg font-semibold text-slate-900">Calendário de compromissos e roteiros</h2>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <button type="button" onClick={() => openCreate("reuniao_online")} className="w-full rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white sm:w-auto">
            Nova agenda
          </button>
          <button type="button" onClick={() => openCreate("roteiro_visita")} className="w-full rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 sm:w-auto">
            Criar roteiro
          </button>
        </div>
      </header>

      <WeeklyCommercialPlan sellerId={selectedSellerId || undefined} />
      <AgendaIntelligencePanel date={agendaIntelligenceDate} sellerId={selectedSellerId || undefined} />

      <div className="shrink-0 space-y-2.5 rounded-xl border bg-white p-2.5 shadow-sm sm:space-y-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold capitalize text-slate-800">{periodLabel}</p>
          <button
            type="button"
            onClick={() => setIsFiltersOpen((current) => !current)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-700"
          >
            Filtros
          </button>
        </div>

        {isFiltersOpen ? (
        <div className="flex flex-wrap items-center gap-2">
            <>
              <select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="today">Hoje</option>
                <option value="this_week">Esta semana</option>
                <option value="next_7_days">7 dias</option>
                <option value="next_30_days">30 dias</option>
                <option value="custom_range">Personalizado</option>
              </select>

              {canFilterBySeller ? (
                <select value={selectedSellerId} onChange={(event) => setSelectedSellerId(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <option value="">{user?.role === "diretor" ? "Todos vendedores" : "Todo time"}</option>
                  {sellers.map((seller) => (
                    <option key={seller.id} value={seller.id}>
                      {seller.name}
                    </option>
                  ))}
                </select>
              ) : null}

              <button type="button" onClick={() => setIsMoreFiltersOpen((current) => !current)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700">
                Mais filtros
              </button>
            </>
        </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
          <button type="button" onClick={() => navigatePeriod(-1)} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm">Anterior</button>
          <button type="button" onClick={goToToday} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium">Hoje</button>
          <button type="button" onClick={() => navigatePeriod(1)} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm">Próximo</button>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto">
          {[
            { id: "daily", label: "Dia" },
            { id: "weekly", label: "Semana" },
            { id: "monthly", label: "Mês" },
            { id: "list", label: "Lista" }
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setView(option.id as Visualizacao)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${view === option.id ? "bg-brand-700 text-white" : "border border-slate-200 text-slate-700"}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {isMoreFiltersOpen ? (
          <div className="grid gap-2 border-t border-slate-100 pt-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} />
              Somente vencidos
            </label>
            {isMobile ? (
              <button type="button" onClick={() => setIsFiltersOpen(false)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                Recolher filtros
              </button>
            ) : null}
          </div>
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

      {/* Lista de eventos */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-white shadow-sm">
        {isEventsLoading ? (
          <p className="p-6 text-center text-sm text-slate-500">Carregando agenda...</p>
        ) : !filteredEvents.length ? (
          <p className="p-6 text-center text-sm text-slate-500">Nenhum evento encontrado.</p>
        ) : view === "daily" ? (
          <div className="h-full overflow-auto p-3 sm:p-4">
            <div className="grid min-w-[340px] grid-cols-[64px_1fr]">
              <div className="relative border-r border-slate-200 bg-slate-50">
                {timelineHours.map((hour, index) => (
                  <div key={hour} className="absolute left-0 right-0 border-t border-slate-200/70" style={{ top: `${index * HOUR_HEIGHT_PX}px`, height: `${HOUR_HEIGHT_PX}px` }}>
                    <p className="absolute -top-2 right-2 bg-slate-50 px-1 text-[11px] font-medium text-slate-500">{formatHourLabel(hour)}</p>
                  </div>
                ))}
              </div>
              <div className="relative rounded-r-lg border border-l-0 border-slate-200 bg-white" style={{ height: `${timelineHours.length * HOUR_HEIGHT_PX}px` }}>
                {timelineHours.map((hour, index) => (
                  <div key={hour} className="absolute inset-x-0 border-t border-slate-100" style={{ top: `${index * HOUR_HEIGHT_PX}px`, height: `${HOUR_HEIGHT_PX}px` }}>
                    <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-slate-100" />
                  </div>
                ))}
                {positionedSelectedDayEvents.map(({ event, column, columns }) => {
                  const startsAtMinutes = brazilMinutesOfDay(getStartsAt(event));
                  const endsAtMinutes = brazilMinutesOfDay(getEndsAt(event));
                  const minMinutes = DAY_START_HOUR * 60;
                  const maxMinutes = DAY_END_HOUR * 60;
                  const clampedStart = Math.max(minMinutes, Math.min(startsAtMinutes, maxMinutes));
                  const clampedEnd = Math.max(clampedStart + 30, Math.min(endsAtMinutes, maxMinutes + 60));
                  const top = ((clampedStart - minMinutes) / 60) * HOUR_HEIGHT_PX;
                  const height = Math.max(54, ((clampedEnd - clampedStart) / 60) * HOUR_HEIGHT_PX - 4);
                  const isCompleted = event.status === "completed";
                  const isRoute = event.type === "roteiro_visita";
                  const stopsDone = event.stops?.filter((stop) => stop.resultStatus === "realizada").length || 0;
                  const cardGapPx = 6;
                  const width = `calc(${100 / columns}% - ${cardGapPx}px)`;
                  const left = `calc(${(100 / columns) * column}% + 3px)`;
                  return (
                    <article
                      key={event.id}
                      ref={(node) => {
                        if (event.id === highlightedEventId) highlightedEventRef.current = node;
                      }}
                      className={`absolute rounded-xl border px-2 py-1.5 shadow-sm transition hover:shadow-md ${getEventAccentClass(event)} ${isCompleted ? "opacity-65" : ""}`}
                      style={{ top: `${top}px`, height: `${height}px`, width, left }}
                      onClick={() => openAgendaDetails(event)}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <p className="truncate text-[11px] font-semibold leading-tight text-slate-900">{event.title}</p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                      </div>
                      <p className="truncate text-[10px] text-slate-700">{formatTime(getStartsAt(event))} - {formatTime(getEndsAt(event))}</p>
                      <p className="truncate text-[10px] text-slate-500">{event.clientId ? clientById.get(event.clientId)?.name || "Cliente" : "Sem cliente"} · {sellers.find((seller) => seller.id === getOwnerId(event))?.name || "Vendedor"}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TYPE_COLOR_CLASS[event.type]}`}>{TYPE_LABEL[event.type]}</span>
                        {isCompleted ? <span className="text-[11px] text-slate-500">✓ concluído</span> : null}
                      </div>
                      {isRoute ? (
                        <div className="mt-1 rounded-md border border-emerald-200/70 bg-white/70 p-1">
                          <p className="text-[10px] text-emerald-700">Paradas: {event.stops?.length || 0} · Status: {STATUS_LABEL[event.status]}</p>
                          <button
                            type="button"
                            className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
                            onClick={(eventClick) => {
                              eventClick.stopPropagation();
                              setExpandedRouteEventId((current) => (current === event.id ? "" : event.id));
                            }}
                          >
                            {expandedRouteEventId === event.id ? "Ocultar paradas" : "Ver paradas"}
                          </button>
                          {expandedRouteEventId === event.id ? (
                            <div className="mt-1 space-y-1 rounded-lg bg-white/90 p-1">
                              <p className="text-[10px] font-semibold text-emerald-700">{event.stops?.length || 0} paradas · {stopsDone} concluídas</p>
                              {event.stops?.slice(0, 3).map((stop) => (
                                <p key={stop.id} className="truncate text-[10px] text-slate-600">• {stop.clientName || "Cliente"} · {stop.city || "Cidade"} · {stop.notes || "Sem observação"}</p>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {!selectedDayEvents.length ? (
                  <p className="absolute inset-x-0 top-20 text-center text-sm text-slate-400">Nenhum compromisso neste dia.</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : view === "weekly" ? (
          <div className="h-full overflow-auto p-2 sm:p-4">
            <div className="min-h-full min-w-[980px] rounded-xl border border-slate-200 bg-white">
              <div className="sticky top-0 z-10 grid grid-cols-[72px_repeat(7,minmax(140px,1fr))] border-b bg-white">
                <div />
                {weeklyCalendarDaysWithLayout.map((day) => (
                  <div key={day.key} className={`border-l px-2 py-2 text-xs font-semibold ${brazilTodayKey() === day.key ? "bg-brand-100 text-brand-800 ring-1 ring-inset ring-brand-200" : "text-slate-600"}`}>
                    {formatBrazilDay(day.key, { weekday: "short", day: "2-digit", month: "2-digit" })}
                  </div>
                ))}
              </div>
              <div className="relative grid grid-cols-[72px_repeat(7,minmax(140px,1fr))]" style={{ height: `${timelineHours.length * HOUR_HEIGHT_PX}px` }}>
                <div className="relative border-r bg-slate-50">
                  {timelineHours.map((hour, index) => (
                    <div key={hour} className="absolute inset-x-0 border-t border-slate-200/70" style={{ top: `${index * HOUR_HEIGHT_PX}px` }}>
                      <p className="absolute -top-2 right-2 bg-slate-50 px-1 text-[11px] text-slate-500">{formatHourLabel(hour)}</p>
                    </div>
                  ))}
                </div>
                {weeklyCalendarDaysWithLayout.map((day) => (
                  <div key={day.key} className="relative border-l">
                    {timelineHours.map((hour, index) => (
                      <div key={`${day.key}-${hour}`} className="absolute inset-x-0 border-t border-slate-100" style={{ top: `${index * HOUR_HEIGHT_PX}px` }} />
                    ))}
                    {day.positionedEvents.map(({ event, column, columns }) => {
                      const startMinutes = brazilMinutesOfDay(getStartsAt(event));
                      const endMinutes = brazilMinutesOfDay(getEndsAt(event));
                      const top = ((startMinutes - DAY_START_HOUR * 60) / 60) * HOUR_HEIGHT_PX;
                      const height = Math.max(44, (((endMinutes - startMinutes) / 60) * HOUR_HEIGHT_PX) - 4);
                      const width = `calc(${100 / columns}% - 6px)`;
                      const left = `calc(${(100 / columns) * column}% + 3px)`;
                      return (
                        <button key={event.id} type="button" className={`absolute rounded-lg border px-1.5 py-1 text-left text-[11px] shadow-sm ${getEventAccentClass(event)}`} style={{ top: `${Math.max(0, top)}px`, height: `${height}px`, width, left }} onClick={() => openAgendaDetails(event)}>
                          <p className="truncate font-semibold leading-tight text-slate-800">{event.title}</p>
                          <p className="text-[10px] text-slate-500">{formatTime(getStartsAt(event))} - {formatTime(getEndsAt(event))}</p>
                          <p className="truncate text-[10px] text-slate-500">{sellers.find((seller) => seller.id === getOwnerId(event))?.name || "Vendedor"}</p>
                          {event.type === "roteiro_visita" ? <p className="text-[10px] font-semibold text-emerald-700">{event.stops?.length || 0} paradas · {STATUS_LABEL[event.status]}</p> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : view === "monthly" ? (
          <div className="flex h-full flex-col bg-slate-50 p-3 text-xs sm:p-4">
            <div className="grid grid-cols-7 gap-1.5 pb-1.5">
              {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((weekday) => (
                <p key={weekday} className="px-1 pb-1 text-center font-semibold text-slate-500">{weekday}</p>
              ))}
            </div>
            <div
              className="grid flex-1 grid-cols-7 gap-1.5"
              style={{ gridTemplateRows: `repeat(${Math.ceil(monthlyCalendarDays.length / 7)}, minmax(0, 1fr))` }}
            >
              {monthlyCalendarDays.map((day) => {
                const isToday = day.key === brazilTodayKey();
                return (
                <button key={day.key} type="button" onClick={() => setSelectedMonthDayKey(day.key)} className={`h-full min-h-[104px] overflow-hidden rounded-xl border p-1.5 text-left shadow-sm transition hover:shadow ${day.isCurrentMonth ? "bg-white" : "bg-slate-100 text-slate-400"} ${isToday ? "border-brand-300 ring-2 ring-brand-100" : "border-slate-200"}`}>
                  <p className={`text-[11px] font-semibold ${isToday ? "text-brand-800" : ""}`}>{Number(day.key.slice(8, 10))}</p>
                  <div className="mt-1 space-y-1">
                    {day.events.slice(0, 2).map((event) => (
                      <p key={event.id} className={`truncate rounded-md border px-1.5 py-0.5 text-[10px] ${TYPE_COLOR_CLASS[event.type]}`}>{formatTime(getStartsAt(event))} {event.title}{event.type === "roteiro_visita" ? ` · ${event.stops?.length || 0} paradas` : ""}</p>
                    ))}
                    {day.events.length > 2 ? <p className="text-[10px] font-semibold text-slate-500">+ {day.events.length - 2} mais</p> : null}
                  </div>
                </button>
              );})}
            </div>
          </div>
        ) : (
          <div className="h-full space-y-4 overflow-auto p-3 sm:p-4">
            {groupedEventsByDay.map((group) => (
              <div key={group.day} className="overflow-hidden rounded-lg border border-slate-200">
                <p className="bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-600">{group.label}</p>
                <div className="divide-y">
                  {group.events.map((event) => {
                    return (
                      <button
                        key={event.id}
                        type="button"
                        ref={(node) => {
                          if (event.id === highlightedEventId) highlightedEventRef.current = node;
                        }}
                        className="flex w-full flex-col gap-2 p-3 text-left transition hover:bg-slate-50 active:bg-slate-100 sm:p-4"
                        onClick={() => openAgendaDetails(event)}
                      >
                        <p className="text-xs font-semibold text-slate-600">{formatDateTime(getStartsAt(event))}</p>
                        <p className="font-medium text-slate-900">{event.title}</p>
                        <p className="text-xs text-slate-500">
                          {event.clientId ? clientById.get(event.clientId)?.name || "Cliente vinculado" : "Sem cliente"} · {sellers.find((seller) => seller.id === getOwnerId(event))?.name || "Vendedor"}
                        </p>
                        {event.type === "roteiro_visita" ? <p className="text-xs font-medium text-emerald-700">Paradas: {event.stops?.length || 0} · {STATUS_LABEL[event.status]} · Ver paradas nos detalhes</p> : null}
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[event.type]}`}>{TYPE_LABEL[event.type]}</span>
                          <span className={`rounded-full border px-2 py-1 ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedMonthDayKey ? (
        <aside className={`fixed inset-y-0 right-0 z-40 w-full max-w-sm border-l border-slate-200 bg-white shadow-2xl ${isMobile ? "bottom-0 top-auto h-[72vh] max-w-none rounded-t-2xl border-t border-l-0" : ""}`}>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Agenda do dia {formatBrazilDay(selectedMonthDayKey, { dateStyle: "short" })}</h3>
            <button type="button" className="text-sm text-slate-500" onClick={() => setSelectedMonthDayKey("")}>Fechar</button>
          </div>
          <div className="max-h-[calc(100%-56px)] space-y-2 overflow-y-auto p-3">
            {selectedMonthDayEvents.length ? selectedMonthDayEvents.map((event) => (
              <button key={event.id} type="button" className={`w-full rounded-lg border p-2 text-left ${getEventAccentClass(event)}`} onClick={() => openAgendaDetails(event)}>
                <p className="text-sm font-semibold text-slate-900">{event.title}</p>
                <p className="text-xs text-slate-600">{formatDateTime(getStartsAt(event))}</p>
                {event.type === "roteiro_visita" ? <p className="text-xs font-medium text-emerald-700">{event.stops?.length || 0} paradas · {STATUS_LABEL[event.status]} · Ver paradas</p> : null}
              </button>
            )) : <p className="text-sm text-slate-500">Nenhum evento neste dia.</p>}
          </div>
        </aside>
      ) : null}

      {selectedEvent ? (
        <aside className={`fixed inset-y-0 right-0 z-50 w-full max-w-md border-l border-slate-200 bg-white shadow-2xl ${isMobile ? "bottom-0 top-auto h-[86vh] max-w-none rounded-t-2xl border-t border-l-0" : ""}`}>
          <div className="flex items-start justify-between border-b px-4 py-3">
            <div>
              {isMobile ? <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-slate-200" /> : null}
              <h3 className="text-base font-semibold text-slate-900">{selectedEvent.title}</h3>
              <p className="text-xs text-slate-500">{formatDateTime(getStartsAt(selectedEvent))} - {formatTime(getEndsAt(selectedEvent))}</p>
            </div>
            <button type="button" className="text-sm text-slate-500" onClick={() => setSelectedEvent(null)}>Fechar</button>
          </div>
          <div className="space-y-3 overflow-y-auto bg-slate-50 p-4 pb-28">
            <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Dados do compromisso</p>
              <p className="text-sm text-slate-700"><strong>Tipo:</strong> {TYPE_LABEL[selectedEvent.type]}</p>
              <p className="text-sm text-slate-700"><strong>Status:</strong> {STATUS_LABEL[selectedEvent.status]}</p>
              {selectedEvent.status === "not_done" && selectedEvent.notDoneReason ? <p className="text-sm text-slate-700"><strong>Motivo:</strong> {selectedEvent.notDoneReason}</p> : null}
              <p className="text-sm text-slate-700"><strong>Observações:</strong> {selectedEvent.notes || "Sem observações."}</p>
            </section>

            <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cliente</p>
              <p className="text-sm text-slate-700"><strong>Cliente:</strong> {selectedEvent.clientId ? clientById.get(selectedEvent.clientId)?.name || "Cliente vinculado" : "Não informado"}</p>
              <p className="text-sm text-slate-700"><strong>Vendedor:</strong> {sellers.find((seller) => seller.id === getOwnerId(selectedEvent))?.name || "Vendedor"}</p>
            </section>

            <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ações rápidas</p>
              <div className="grid grid-cols-2 gap-2">
                {/* Concluir registra a atividade vinculada; o roteiro é concluído pelas paradas. Reabrir e Excluir são de gerente/diretor. */}
                {selectedEventActions?.complete ? <button type="button" className="rounded-lg border border-green-300 px-3 py-2 text-xs font-semibold text-green-700" onClick={() => openActivityModal(selectedEvent)}>Concluir</button> : null}
                {selectedEventActions?.reschedule ? <button type="button" className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-700" onClick={() => setRescheduleTarget(selectedEvent)}>Reagendar</button> : null}
                {selectedEventActions?.notDone ? <button type="button" className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-700" onClick={() => setNotDoneTarget(selectedEvent)}>Não realizado</button> : null}
                {selectedEventActions?.reopen ? <button type="button" className="rounded-lg border border-sky-300 px-3 py-2 text-xs font-semibold text-sky-700" onClick={() => void onReopen(selectedEvent)}>Reabrir</button> : null}
                {selectedEventActions?.remove ? <button type="button" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700" onClick={() => void onDeleteAgendaEvent(selectedEvent)}>Excluir</button> : null}
                {selectedEvent.type === "roteiro_visita" ? <Link to={`/agenda/roteiro/${selectedEvent.id}`} className="rounded-lg border border-emerald-300 px-3 py-2 text-center text-xs font-semibold text-emerald-700">Iniciar rota</Link> : null}
                {selectedEvent.clientId ? <Link to={`/clientes/${selectedEvent.clientId}`} className="rounded-lg border border-brand-300 px-3 py-2 text-center text-xs font-semibold text-brand-700">Cliente 360</Link> : null}
              </div>
            </section>

            {selectedEvent.type === "roteiro_visita" ? (
              <section className="space-y-3 rounded-xl border border-emerald-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Paradas do roteiro</p>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{selectedEvent.stops?.length || 0} paradas</span>
                </div>
                {selectedEvent.stops?.length ? selectedEvent.stops.map((stop) => (
                  <article key={stop.id} className="space-y-1 rounded-lg border border-emerald-100 bg-emerald-50/40 p-2">
                    <p className="text-xs font-semibold text-slate-800">{getStopClientDisplayName(stop)} · {getStopCityDisplayName(stop)}</p>
                    <p className="text-xs text-slate-600">{stop.notes || "Sem observação da parada."}</p>
                    <p className="text-[11px] font-medium text-slate-500">
                      Status: {stop.resultStatus === "realizada" ? "Realizada" : stop.resultStatus === "nao_realizada" ? "Não realizada" : "Pendente"}
                    </p>
                  </article>
                )) : <p className="text-xs text-slate-500">Sem paradas cadastradas.</p>}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Link to={`/agenda/roteiro/${selectedEvent.id}`} className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-center text-xs font-semibold text-emerald-700">Iniciar rota</Link>
                  <button type="button" disabled className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">Registrar visita</button>
                  <button type="button" disabled className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">Abrir cliente 360</button>
                </div>
              </section>
            ) : null}

            {selectedEvent.clientId ? (
              <a
                href={`https://wa.me/?text=${encodeURIComponent(`Olá! Sobre o compromisso ${selectedEvent.title}`)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700"
              >
                Abrir WhatsApp
              </a>
            ) : null}
          </div>
        </aside>
      ) : null}

      {isMobile ? (
        <button type="button" onClick={() => openCreate("reuniao_online")} className="fixed bottom-5 right-4 z-40 rounded-full bg-brand-700 px-4 py-3 text-sm font-semibold text-white shadow-lg">
          + Nova agenda
        </button>
      ) : null}

      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 p-0 sm:items-center sm:p-4" onClick={closeCreate}>
          <div className="flex h-[90dvh] w-full max-w-xl flex-col overflow-hidden bg-white shadow-xl sm:my-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Nova agenda</h3>
                <p className="text-sm text-slate-500">Planeje um compromisso ou um roteiro com várias visitas.</p>
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
                  <select
                    value={createForm.type}
                    onChange={(event) => handleCreateTypeChange(event.target.value as AgendaEventType)}
                    className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    {CREATE_AGENDA_TYPE_OPTIONS.map((option) => (
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
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">{createForm.type === "roteiro_visita" ? "Início" : "Início (Brasília)"}</label>
                  <input
                    type={createForm.type === "roteiro_visita" ? "date" : "datetime-local"}
                    value={createForm.startDateTime}
                    onChange={(event) => setCreateForm((current) => ({ ...current, startDateTime: event.target.value }))}
                    className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">{createForm.type === "roteiro_visita" ? "Fim" : "Fim (Brasília)"}</label>
                  <input
                    type={createForm.type === "roteiro_visita" ? "date" : "datetime-local"}
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
                  <p className="text-xs text-emerald-700">Paradas são obrigatórias no roteiro e usam a cidade do cadastro do cliente.</p>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-emerald-800">Paradas</p>
                    <button type="button" className="rounded border border-emerald-300 px-2 py-1 text-xs" onClick={() => setDraftStops((current) => [...current, createEmptyDraftStop()])}>Adicionar parada</button>
                  </div>
                  {draftStops.map((stop, index) => (
                    <div key={stop.id} className="grid gap-3 rounded bg-white p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                      <div className="space-y-3">
                        <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Cliente</label>
                        <ClientSearchSelect
                          clients={activityClients}
                          value={stop.clientId}
                          onChange={(clientId) => updateDraftStop(stop.id, { clientId, city: clientById.get(clientId)?.city || "" })}
                          placeholder="Pesquisar por razão social, fantasia, código, cidade, UF ou CNPJ"
                          emptyLabel="Nenhum cliente encontrado."
                          maxListHeightClassName="max-h-40"
                        />
                        <label className="block space-y-1">
                          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Cidade</span>
                          <input
                            value={stop.city || "Não informada"}
                            readOnly
                            className="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">Observação da parada</span>
                          <textarea
                            value={stop.notes}
                            onChange={(event) => updateDraftStop(stop.id, { notes: event.target.value })}
                            placeholder="Adicionar observação"
                            className="min-h-20 w-full rounded border border-slate-200 px-3 py-2 text-sm"
                          />
                        </label>
                      </div>
                      <div className="flex items-center justify-end gap-1 md:self-start">
                        <button type="button" className="rounded border px-2 text-xs" disabled={index === 0} onClick={() => moveDraftStop(index, -1)}>↑</button>
                        <button type="button" className="rounded border px-2 text-xs" disabled={index === draftStops.length - 1} onClick={() => moveDraftStop(index, 1)}>↓</button>
                        <button type="button" className="rounded border border-rose-200 px-2 text-xs text-rose-700" disabled={draftStops.length === 1} onClick={() => removeDraftStop(stop.id)}>✕</button>
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
                  {isSubmitting ? "Salvando..." : createForm.type === "roteiro_visita" ? "Salvar roteiro" : "Salvar agenda"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isResultModalOpen ? (
        <div className="mobile-modal-shell" onClick={closeResultModal}>
          <div className="mobile-modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Resultado da visita</h3>
                <p className="text-sm text-slate-500">Informe o resultado e, se quiser, adicione uma observação.</p>
              </div>
              <button
                type="button"
                onClick={closeResultModal}
                className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50"
              >
                ✕
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSaveVisitResult}>
              <div className="mobile-modal-body space-y-4">
                <fieldset className="space-y-2">
                  <legend className="mb-1 block text-xs font-medium uppercase text-slate-500">Resultado</legend>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="radio"
                      name="visit-result-status"
                      value="realizada"
                      checked={visitResultForm.status === "realizada"}
                      onChange={(event) =>
                        setVisitResultForm((current) => ({
                          ...current,
                          status: event.target.value as VisitResultForm["status"]
                        }))
                      }
                    />
                    Realizada
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="radio"
                      name="visit-result-status"
                      value="nao_realizada"
                      checked={visitResultForm.status === "nao_realizada"}
                      onChange={(event) =>
                        setVisitResultForm((current) => ({
                          ...current,
                          status: event.target.value as VisitResultForm["status"]
                        }))
                      }
                    />
                    Não realizada
                  </label>
                </fieldset>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Observação (opcional)</label>
                  <textarea
                    value={visitResultForm.summary}
                    onChange={(event) => setVisitResultForm((current) => ({ ...current, summary: event.target.value }))}
                    placeholder="Escreva uma observação rápida"
                    className="min-h-20 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="mobile-modal-footer">
                <button type="submit" disabled={isExecutionSubmitting} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {isExecutionSubmitting ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {rescheduleTarget ? <RescheduleDialog event={rescheduleTarget} onClose={() => setRescheduleTarget(null)} onDone={onEventChanged} /> : null}
      {notDoneTarget ? <NotDoneDialog event={notDoneTarget} onClose={() => setNotDoneTarget(null)} onDone={onEventChanged} /> : null}
    </section>
  );
}
