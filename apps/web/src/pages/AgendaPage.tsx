import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
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

const initialActivityForm: ActivityForm = {
  type: "reuniao",
  notes: "",
  dueDate: "",
  clientId: ""
};

const TYPE_LABEL: Record<AgendaEventType, string> = {
  reuniao_online: "Reunião online",
  reuniao_presencial: "Reunião presencial",
  roteiro_visita: "Roteiro de visita",
  follow_up: "Follow-up",
  followup: "Follow-up"
};

const TYPE_COLOR_CLASS: Record<AgendaEventType, string> = {
  reuniao_online: "bg-blue-100 text-blue-800 border-blue-200",
  reuniao_presencial: "bg-green-100 text-green-800 border-green-200",
  roteiro_visita: "bg-emerald-100 text-emerald-800 border-emerald-200",
  follow_up: "bg-amber-100 text-amber-800 border-amber-200",
  followup: "bg-amber-100 text-amber-800 border-amber-200"
};

const STATUS_LABEL: Record<AgendaEvent["status"], string> = {
  agendado: "Agendado",
  realizado: "Realizado",
  cancelado: "Cancelado",
  vencido: "Vencido"
};

const STATUS_COLOR_CLASS: Record<AgendaEvent["status"], string> = {
  agendado: "border-sky-200 bg-sky-100 text-sky-700",
  realizado: "border-green-200 bg-green-100 text-green-700",
  cancelado: "border-slate-200 bg-slate-100 text-slate-700",
  vencido: "border-rose-200 bg-rose-100 text-rose-700"
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

function isPast(event: AgendaEvent) {
  return (
    event.status === "agendado" &&
    new Date(event.endDateTime).getTime() < Date.now()
  );
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
  const [searchParams] = useSearchParams();
  const canFilterBySeller = user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("diaria");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("hoje");
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [events, setEvents] = useState<AgendaEvent[]>(() => getInitialEvents());
  const [isEventsLoading, setIsEventsLoading] = useState(false);
  const [summary, setSummary] = useState<AgendaSummary>({ reunioes: 0, roteiros: 0, followUps: 0, vencidos: 0 });

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);
  const [isActivitySubmitting, setIsActivitySubmitting] = useState(false);
  const [activityClients, setActivityClients] = useState<ClientOption[]>([]);
  const [activityForm, setActivityForm] = useState<ActivityForm>(initialActivityForm);
  const [activityEvent, setActivityEvent] = useState<AgendaEvent | null>(null);

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
  const lastFetchKeyRef = useRef("");
  const inFlightRef = useRef<Map<string, Promise<any>>>(new Map());

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
    let active = true;
    const abortController = new AbortController();

    const loadAgendaEvents = async () => {
      setIsEventsLoading(true);
      try {
        const range = getRangeFromFilter(periodFilter, customFrom, customTo);
        const params: Record<string, string> = {
          from: range.from.toISOString().slice(0, 10),
          to: range.to.toISOString().slice(0, 10)
        };

        if (canFilterBySeller && selectedSellerId) params.sellerId = selectedSellerId;

        const fetchKey = JSON.stringify(params);
        if (lastFetchKeyRef.current === fetchKey) {
          setIsEventsLoading(false);
          return;
        }

        lastFetchKeyRef.current = fetchKey;
        let request = inFlightRef.current.get(fetchKey);
        if (!request) {
          request = api.get("/agenda/events", { params, signal: abortController.signal });
          inFlightRef.current.set(fetchKey, request);
        }

        const response = await request;
        inFlightRef.current.delete(fetchKey);
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
            type: item.type === "followup" ? "followup" : ((item.type as AgendaEventType) || "follow_up"),
            startDateTime: new Date(item.startDateTime).toISOString(),
            endDateTime: new Date(item.endDateTime).toISOString(),
            status: (item.status as AgendaEvent["status"]) || "agendado",
            city: item.city ? String(item.city) : undefined,
            notes: item.notes ? String(item.notes) : null,
            stops: Array.isArray(item.stops) ? item.stops : []
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
  }, [canFilterBySeller, selectedSellerId, periodFilter, customFrom, customTo]);

  const sellerById = useMemo(() => Object.fromEntries(sellers.map((seller) => [seller.id, seller.name])), [sellers]);

  const filteredEvents = useMemo(() => {
    const byRole = events.filter((event) => {
      if (user?.role === "vendedor") return event.userId === user.id;
      if (canFilterBySeller && selectedSellerId) return event.userId === selectedSellerId;
      return true;
    });

    return byRole.sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
  }, [events, user?.role, user?.id, canFilterBySeller, selectedSellerId]);

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

  const onSetAsDone = async (agendaEvent: AgendaEvent) => {
    try {
      await api.patch(`/agenda/${agendaEvent.id}`, { status: "realizado" });
    } catch {
      try {
        await api.patch(`/agenda/${agendaEvent.id}/status`, { status: "realizado" });
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
              status: "realizado"
            }
          : item
      )
    );
    toast.success("Agenda marcada como realizada.");
  };

  const onCreateFollowUpFromEvent = async (agendaEvent: AgendaEvent) => {
    const start = new Date(agendaEvent.endDateTime);
    const end = new Date(start.getTime() + 30 * 60000);
    try {
      const response = await api.post("/agenda/events", {
        title: `Follow-up: ${agendaEvent.title}`,
        type: "followup",
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        sellerId: agendaEvent.userId,
        clientId: agendaEvent.clientId,
        notes: `Criado a partir do evento ${agendaEvent.title}`
      });
      const created = response.data;
      setEvents((current) => [...current, { ...agendaEvent, ...created, id: created.id, title: created.title }]);
      toast.success("Follow-up criado com sucesso.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível criar follow-up."));
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
        type: agendaEvent.type === "follow_up" ? "followup" : agendaEvent.type,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        sellerId: agendaEvent.userId,
        clientId: agendaEvent.clientId,
        notes: agendaEvent.notes || agendaEvent.description
      });
      const created = response.data;
      setEvents((current) => [...current, { ...agendaEvent, ...created, id: created.id, title: created.title }]);
      toast.success("Evento duplicado para o dia seguinte.");
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

  const refreshEvents = (newEvent: AgendaEvent) => {
    setEvents((current) =>
      [...current, newEvent].sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime())
    );
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

      refreshEvents(mapCreatedAgendaEvent(response.data));
      closeCreate();
      toast.success("Agenda criada com sucesso.");
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

      {/* Lista de eventos */}
      <div className="rounded-xl border bg-white shadow-sm">
        {isEventsLoading ? (
          <p className="p-6 text-center text-sm text-slate-500">Carregando agenda...</p>
        ) : !filteredEvents.length ? (
          <p className="p-6 text-center text-sm text-slate-500">Nenhum evento encontrado.</p>
        ) : (
          <div className="divide-y">
            {filteredEvents.map((event) => {
              const overdue = isPast(event);
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
                      <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[event.type]}`}>{TYPE_LABEL[event.type]}</span>
                      {overdue ? <span className="rounded-full border border-rose-200 bg-rose-100 px-2 py-1 text-rose-800">Vencido</span> : null}
                      <span className={`rounded-full border px-2 py-1 ${STATUS_COLOR_CLASS[event.status]}`}>{STATUS_LABEL[event.status]}</span>
                      <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-700">
                        {sellerById[event.userId] || "Vendedor"}
                      </span>
                      {isHighlighted ? (
                        <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-amber-700">Próximo compromisso</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {event.status === "agendado" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-green-300 px-3 py-1 text-sm font-medium text-green-700 hover:bg-green-50"
                        onClick={() => void onSetAsDone(event)}
                      >
                        Marcar realizado
                      </button>
                    ) : null}

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
                      <Link to={`/clientes/${event.clientId}`} className="text-sm font-medium text-brand-700 underline">
                        Abrir cliente
                      </Link>
                    ) : null}
                    <button type="button" className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={() => void onCreateFollowUpFromEvent(event)}>
                      Criar follow-up
                    </button>
                    <button type="button" className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={() => void onDuplicateForNextDay(event)}>
                      Duplicar +1 dia
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
                    {Object.entries(TYPE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
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
