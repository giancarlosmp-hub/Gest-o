import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import type { AgendaEvent, AgendaEventType } from "../models/agenda";

type Seller = { id: string; name: string };

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

const STATUS_LABEL: Record<AgendaEvent["status"], string> = {
  agendado: "Agendado",
  realizado: "Realizado",
  cancelado: "Cancelado"
};

const STATUS_COLOR_CLASS: Record<AgendaEvent["status"], string> = {
  agendado: "border-sky-200 bg-sky-100 text-sky-700",
  realizado: "border-green-200 bg-green-100 text-green-700",
  cancelado: "border-slate-200 bg-slate-100 text-slate-700"
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
  const canFilterBySeller = user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("diaria");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("hoje");
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");

  const [events, setEvents] = useState<AgendaEvent[]>(() => getInitialEvents());
  const [isEventsLoading, setIsEventsLoading] = useState(false);

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

    const loadAgendaEvents = async () => {
      setIsEventsLoading(true);
      try {
        const response = await api.get("/agenda");
        if (!active) return;

        const payload = Array.isArray(response.data?.items)
          ? response.data.items
          : Array.isArray(response.data)
            ? response.data
            : [];

        const mappedEvents = payload
          .filter((item: any) => item?.id && item?.startDateTime && item?.endDateTime)
          .map((item: any): AgendaEvent => ({
            id: String(item.id),
            userId: String(item.userId || item.ownerSellerId || item.sellerId || ""),
            clientId: item.clientId ? String(item.clientId) : undefined,
            opportunityId: item.opportunityId ? String(item.opportunityId) : undefined,
            title: String(item.title || "Sem título"),
            description: String(item.description || "Compromisso da agenda."),
            type: (item.type as AgendaEventType) || "follow_up",
            startDateTime: new Date(item.startDateTime).toISOString(),
            endDateTime: new Date(item.endDateTime).toISOString(),
            status: (item.status as AgendaEvent["status"]) || "agendado"
          }))
          .filter((item: AgendaEvent) => item.userId);

        setEvents(mappedEvents.length ? mappedEvents : getInitialEvents());
      } catch {
        if (!active) return;
        toast.error("Não foi possível carregar eventos da agenda.");
      } finally {
        if (active) setIsEventsLoading(false);
      }
    };

    void loadAgendaEvents();

    return () => {
      active = false;
    };
  }, []);

  const sellerById = useMemo(() => Object.fromEntries(sellers.map((seller) => [seller.id, seller.name])), [sellers]);

  const filteredEvents = useMemo(() => {
    const today = new Date();
    const dayStart = startOfDay(today);
    const dayEnd = endOfDay(today);

    const byRole = events.filter((event) => {
      if (user?.role === "vendedor") return event.userId === user.id;
      if (canFilterBySeller && selectedSellerId) return event.userId === selectedSellerId;
      return true;
    });

    const byPeriod = byRole.filter((event) => {
      const start = new Date(event.startDateTime);
      if (periodFilter === "hoje") return start >= dayStart && start <= dayEnd;

      if (periodFilter === "esta_semana") {
        const weekStart = startOfDay(today);
        const dayOfWeek = weekStart.getDay();
        const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        weekStart.setDate(weekStart.getDate() + diffToMonday);

        const weekEnd = endOfDay(new Date(weekStart));
        weekEnd.setDate(weekEnd.getDate() + 6);
        return start >= weekStart && start <= weekEnd;
      }

      const next7Days = endOfDay(new Date(dayStart));
      next7Days.setDate(next7Days.getDate() + 7);
      return start >= dayStart && start <= next7Days;
    });

    return byPeriod.sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
  }, [events, user?.role, user?.id, canFilterBySeller, selectedSellerId, periodFilter]);

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
      // gerente/diretor: sugere o vendedor do filtro (se tiver)
      // vendedor: fixa no próprio id
      sellerId: user?.role === "vendedor" ? user.id : selectedSellerId
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

      const response = await api.post("/agenda", payload);

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
              return (
                <div key={event.id} className="flex items-center justify-between gap-3 p-4">
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

                    {event.clientId ? (
                      <Link to={`/clientes/${event.clientId}`} className="text-sm font-medium text-brand-700 underline">
                        Ver cliente
                      </Link>
                    ) : null}
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
    </section>
  );
}
