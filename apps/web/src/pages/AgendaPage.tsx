import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import type { AgendaEvent, AgendaEventType } from "../models/agenda";

type Seller = { id: string; name: string };
type Client = { id: string; name: string };
type Opportunity = { id: string; title: string };

type Visualizacao = "diaria" | "semanal";
type PeriodFilter = "hoje" | "esta_semana" | "proximos_7_dias";
type CreateAgendaForm = {
  title: string;
  type: AgendaEventType;
  startDateTime: string;
  endDateTime: string;
  sellerId: string;
};

const TYPE_LABEL: Record<AgendaEventType, string> = {
  reuniao_online: "Reunião online",
  reuniao_presencial: "Reunião presencial",
  roteiro_visita: "Roteiro de visita",
  follow_up: "Follow-up"
};

const TYPE_COLOR_CLASS: Record<AgendaEventType, string> = {
  reuniao_online: "bg-blue-100 text-blue-800 border-blue-200",
  reuniao_presencial: "bg-green-100 text-green-800 border-green-200",
  roteiro_visita: "bg-emerald-100 text-emerald-800 border-emerald-200",
  follow_up: "bg-amber-100 text-amber-800 border-amber-200"
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

function startOfWeek(date: Date) {
  const next = startOfDay(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
}

function endOfWeek(date: Date) {
  const next = endOfDay(startOfWeek(date));
  next.setDate(next.getDate() + 6);
  return next;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function formatHour(value: string) {
  return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function isPast(event: AgendaEvent) {
  return event.status === "agendado" && new Date(event.endDateTime).getTime() < Date.now();
}

function getInitialEvents(): AgendaEvent[] {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const inFiveDays = new Date(now);
  inFiveDays.setDate(now.getDate() + 5);

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
    },
    {
      id: "event-2",
      userId: "seller-2",
      clientId: "client-2",
      title: "Visita presencial - talhão 7",
      description: "Avaliar necessidade de cobertura nitrogenada.",
      type: "reuniao_presencial",
      startDateTime: new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 14, 0).toISOString(),
      endDateTime: new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 16, 0).toISOString(),
      location: "Agro Serra - Campo A",
      city: "Uberlândia",
      status: "agendado"
    },
    {
      id: "event-3",
      userId: "seller-1",
      clientId: "client-1",
      opportunityId: "opp-2",
      title: "Follow-up proposta",
      description: "Validar ajustes comerciais e próximo passo.",
      type: "follow_up",
      startDateTime: new Date(inFiveDays.getFullYear(), inFiveDays.getMonth(), inFiveDays.getDate(), 11, 0).toISOString(),
      endDateTime: new Date(inFiveDays.getFullYear(), inFiveDays.getMonth(), inFiveDays.getDate(), 11, 30).toISOString(),
      status: "agendado"
    },
    {
      id: "route-1",
      userId: "seller-3",
      clientId: "client-3",
      title: "Parada 1 - Fazenda Horizonte",
      description: "Conferir áreas demonstrativas e coletar feedback do gerente agrícola.",
      observation: "Levar catálogo de soluções de irrigação.",
      type: "roteiro_visita",
      startDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0).toISOString(),
      endDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 45).toISOString(),
      city: "Rio Verde",
      location: "Grupo Horizonte - Unidade Sul",
      mapsIntegration: { waypointOrder: 1 },
      status: "agendado"
    },
    {
      id: "route-2",
      userId: "seller-3",
      clientId: "client-2",
      title: "Parada 2 - Agro Serra",
      description: "Revisar plano de aplicação para próximo ciclo.",
      observation: "Validar disponibilidade de maquinário para terça-feira.",
      type: "roteiro_visita",
      startDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 15).toISOString(),
      endDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 0).toISOString(),
      city: "Rio Verde",
      location: "Agro Serra - Filial Centro",
      mapsIntegration: { waypointOrder: 2 },
      status: "agendado"
    },
    {
      id: "route-3",
      userId: "seller-3",
      clientId: "client-1",
      title: "Parada 3 - Santa Luz",
      description: "Apresentar proposta final e próximos passos.",
      observation: "Confirmar presença do decisor financeiro.",
      type: "roteiro_visita",
      startDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0).toISOString(),
      endDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 40).toISOString(),
      city: "Jataí",
      location: "Fazenda Santa Luz - Sede",
      mapsIntegration: { waypointOrder: 3 },
      status: "agendado"
    }
  ];
}

export default function AgendaPage() {
  const { user } = useAuth();
  const canFilterBySeller = user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("diaria");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("hoje");
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");
  const [selectedEvent, setSelectedEvent] = useState<AgendaEvent | null>(null);
  const [events, setEvents] = useState<AgendaEvent[]>(() => getInitialEvents());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSellersLoading, setIsSellersLoading] = useState(false);
  const [sellerOptions, setSellerOptions] = useState<Seller[]>([]);
  const [createForm, setCreateForm] = useState<CreateAgendaForm>({
    title: "",
    type: "reuniao_online",
    startDateTime: "",
    endDateTime: "",
    sellerId: ""
  });

  const sellers = useMemo<Seller[]>(() => {
    if (!canFilterBySeller && user?.id && user?.name) return [{ id: user.id, name: user.name }];
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

  const clients = useMemo<Client[]>(
    () => [
      { id: "client-1", name: "Fazenda Santa Luz" },
      { id: "client-2", name: "Agro Serra" },
      { id: "client-3", name: "Grupo Horizonte" }
    ],
    []
  );

  const opportunities = useMemo<Opportunity[]>(
    () => [
      { id: "opp-1", title: "Pacote Safra 2026" },
      { id: "opp-2", title: "Renovação de contrato" },
      { id: "opp-3", title: "Expansão irrigação" }
    ],
    []
  );

  const filteredEvents = useMemo(() => {
    const today = new Date();
    const dayStart = startOfDay(today);
    const dayEnd = endOfDay(today);
    const weekStart = startOfWeek(today);
    const weekEnd = endOfWeek(today);
    const next7End = endOfDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));

    const byRole = events.filter((event) => {
      if (user?.role === "vendedor") return event.userId === user.id;
      if (canFilterBySeller && selectedSellerId) return event.userId === selectedSellerId;
      return true;
    });

    const byPeriod = byRole.filter((event) => {
      const start = new Date(event.startDateTime);

      if (periodFilter === "hoje") return start >= dayStart && start <= dayEnd;
      if (periodFilter === "esta_semana") return start >= weekStart && start <= weekEnd;
      return start >= dayStart && start <= next7End;
    });

    return byPeriod.sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
  }, [canFilterBySeller, events, periodFilter, selectedSellerId, user?.id, user?.role]);

  const eventsGrouped = useMemo(() => {
    if (view === "diaria") {
      return filteredEvents.reduce<Record<string, AgendaEvent[]>>((acc, event) => {
        const label = new Date(event.startDateTime).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
        acc[label] = [...(acc[label] || []), event];
        return acc;
      }, {});
    }

    const weekGroups: Record<string, AgendaEvent[]> = {};
    filteredEvents.forEach((event) => {
      const start = new Date(event.startDateTime);
      const weekKey = `${startOfWeek(start).toLocaleDateString("pt-BR")} - ${endOfWeek(start).toLocaleDateString("pt-BR")}`;
      weekGroups[weekKey] = [...(weekGroups[weekKey] || []), event];
    });

    return weekGroups;
  }, [filteredEvents, view]);

  const sellerById = useMemo(() => Object.fromEntries(sellers.map((seller) => [seller.id, seller.name])), [sellers]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((client) => [client.id, client.name])), [clients]);
  const opportunityById = useMemo(() => Object.fromEntries(opportunities.map((opportunity) => [opportunity.id, opportunity.title])), [opportunities]);

  const markAsCompleted = (eventId: string) => {
    setEvents((current) => current.map((event) => (event.id === eventId ? { ...event, status: "realizado" } : event)));
    setSelectedEvent((current) => (current && current.id === eventId ? { ...current, status: "realizado" } : current));
  };

  const refreshEvents = (newEvent?: AgendaEvent) => {
    setEvents((current) => {
      if (!newEvent) return [...current];
      return [...current, newEvent].sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
    });
  };

  const openCreate = () => {
    setCreateForm({
      title: "",
      type: "reuniao_online",
      startDateTime: "",
      endDateTime: "",
      sellerId: canFilterBySeller ? selectedSellerId : user?.id || ""
    });
    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
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
      type: createForm.type,
      startDateTime: new Date(data?.startDateTime || createForm.startDateTime).toISOString(),
      endDateTime: new Date(data?.endDateTime || createForm.endDateTime).toISOString(),
      status: "agendado"
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

      if (user?.role === "vendedor") {
        payload.ownerSellerId = user.id;
      } else if (createForm.sellerId) {
        payload.ownerSellerId = createForm.sellerId;
      }

      const response = await api.post("/agenda", payload);
      refreshEvents(mapCreatedAgendaEvent(response.data));
      closeCreate();
      toast.success("Agenda criada com sucesso.");
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Erro ao criar agenda.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Agenda</h2>
          <p className="text-sm text-slate-500">Planeje compromissos comerciais e acompanhe execuções da equipe.</p>
        </div>

        <button
          type="button"
          onClick={openCreate}
          aria-label="Abrir modal de criação de agenda"
          className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
        >
          Nova agenda
        </button>
      </header>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-sm">
        <p className="font-semibold">Roteiro de visitas</p>
        <p className="mt-1">Estrutura pronta para múltiplas paradas no dia, com ordenação por horário, campo de cidade e observação.</p>
        <p className="mt-1 text-emerald-800">Base preparada para integração futura com Google Maps (waypoints por evento).</p>
      </div>

      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Visualização</label>
          <select value={view} onChange={(event) => setView(event.target.value as Visualizacao)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="diaria">Lista diária</option>
            <option value="semanal">Lista semanal</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Filtro de período</label>
          <select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="hoje">Hoje</option>
            <option value="esta_semana">Esta semana</option>
            <option value="proximos_7_dias">Próximos 7 dias</option>
          </select>
        </div>

        {canFilterBySeller ? (
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Vendedor</label>
            <select value={selectedSellerId} onChange={(event) => setSelectedSellerId(event.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
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

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {!filteredEvents.length ? (
          <p className="p-8 text-center text-sm text-slate-500">Nenhum evento encontrado para os filtros selecionados.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {Object.entries(eventsGrouped).map(([groupLabel, groupEvents]) => (
              <div key={groupLabel} className="p-4">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">{groupLabel}</h3>
                <div className="space-y-2">
                  {groupEvents.map((event) => {
                    const overdue = isPast(event);
                    const isRouteVisit = event.type === "roteiro_visita";
                    return (
                      <div key={event.id} className="relative">
                        {isRouteVisit ? <div className="absolute bottom-0 left-[15px] top-0 w-px bg-emerald-200" /> : null}
                        <button
                          type="button"
                          onClick={() => setSelectedEvent(event)}
                          className={`relative z-10 flex w-full flex-col gap-2 rounded-lg border p-3 text-left transition hover:border-brand-300 hover:bg-brand-50/40 md:flex-row md:items-center md:justify-between ${
                            isRouteVisit ? "border-emerald-200 pl-10" : "border-slate-200"
                          }`}
                        >
                          {isRouteVisit ? <span className="absolute left-[8px] top-5 h-4 w-4 rounded-full border-2 border-emerald-600 bg-white" /> : null}
                          <div>
                            <p className="font-medium text-slate-900">{event.title}</p>
                            <p className="text-xs text-slate-500">
                              {formatDateTime(event.startDateTime)} - {formatHour(event.endDateTime)}
                            </p>
                            {isRouteVisit ? (
                              <p className="mt-1 text-xs text-slate-600">
                                Cidade: <span className="font-medium">{event.city || "Não informada"}</span> • Cliente: {event.clientId ? clientById[event.clientId] || "Não informado" : "Não informado"}
                              </p>
                            ) : null}
                            {event.observation ? <p className="mt-1 text-xs text-slate-600">Obs.: {event.observation}</p> : null}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                            <span className={`rounded-full border px-2 py-1 ${TYPE_COLOR_CLASS[event.type]}`}>{TYPE_LABEL[event.type]}</span>
                            {overdue ? <span className="rounded-full border border-rose-200 bg-rose-100 px-2 py-1 text-rose-800">Vencido</span> : null}
                            <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-700">{sellerById[event.userId] || "Vendedor"}</span>
                            {event.status === "realizado" ? <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-emerald-800">Realizado</span> : null}
                          </div>
                        </button>
                        {isRouteVisit && event.status !== "realizado" ? (
                          <div className="mt-2 pl-10">
                            <button
                              type="button"
                              onClick={() => markAsCompleted(event.id)}
                              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                            >
                              Marcar como realizado
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedEvent ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick={() => setSelectedEvent(null)}>
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">{selectedEvent.title}</h3>
                <p className="text-sm text-slate-500">{TYPE_LABEL[selectedEvent.type]}</p>
              </div>
              <button type="button" onClick={() => setSelectedEvent(null)} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                ✕
              </button>
            </div>

            <dl className="grid gap-3 text-sm text-slate-700 md:grid-cols-2">
              <div>
                <dt className="font-medium text-slate-500">Início</dt>
                <dd>{formatDateTime(selectedEvent.startDateTime)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Fim</dt>
                <dd>{formatDateTime(selectedEvent.endDateTime)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Status</dt>
                <dd className="capitalize">{selectedEvent.status.replace("_", " ")}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Local</dt>
                <dd>{selectedEvent.location || "Não informado"}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Cidade</dt>
                <dd>{selectedEvent.city || "Não informada"}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="font-medium text-slate-500">Descrição</dt>
                <dd>{selectedEvent.description}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="font-medium text-slate-500">Observação</dt>
                <dd>{selectedEvent.observation || "—"}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Cliente</dt>
                <dd>
                  {selectedEvent.clientId ? (
                    <Link to={`/clientes/${selectedEvent.clientId}`} className="text-brand-700 underline">
                      {clientById[selectedEvent.clientId] || "Ver cliente"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Oportunidade</dt>
                <dd>
                  {selectedEvent.opportunityId ? (
                    <Link to={`/oportunidades/${selectedEvent.opportunityId}`} className="text-brand-700 underline">
                      {opportunityById[selectedEvent.opportunityId] || "Ver oportunidade"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>

            {selectedEvent.type === "roteiro_visita" && selectedEvent.status !== "realizado" ? (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => markAsCompleted(selectedEvent.id)}
                  className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Marcar como realizado
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick={closeCreate}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Modal de criação de agenda"
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">Nova agenda</h3>
                <p className="text-sm text-slate-500">Informe os dados básicos para criar um compromisso.</p>
              </div>
              <button type="button" onClick={closeCreate} aria-label="Fechar modal de criação de agenda" className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
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
                  placeholder="Ex: Reunião de planejamento"
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
                ) : <input type="hidden" value={user?.id || ""} readOnly />}
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

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeCreate} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  Cancelar
                </button>
                <button type="submit" disabled={isSubmitting} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-70">
                  {isSubmitting ? "Salvando..." : "Salvar agenda"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
