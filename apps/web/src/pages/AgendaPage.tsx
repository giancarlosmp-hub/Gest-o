import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
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
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatHour(value: string) {
  return new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
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
      startDateTime: new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        9,
        0
      ).toISOString(),
      endDateTime: new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        10,
        0
      ).toISOString(),
      status: "agendado"
    }
  ];
}

export default function AgendaPage() {
  const { user } = useAuth();
  const canFilterBySeller =
    user?.role === "gerente" || user?.role === "diretor";

  const [view, setView] = useState<Visualizacao>("diaria");
  const [periodFilter, setPeriodFilter] =
    useState<PeriodFilter>("hoje");
  const [selectedSellerId, setSelectedSellerId] =
    useState<string>("");

  const [selectedEvent, setSelectedEvent] =
    useState<AgendaEvent | null>(null);

  const [events, setEvents] = useState<AgendaEvent[]>(
    () => getInitialEvents()
  );

  const [isCreateOpen, setIsCreateOpen] =
    useState(false);

  const [createForm, setCreateForm] =
    useState<CreateAgendaForm>({
      title: "",
      type: "reuniao_online",
      startDateTime: "",
      endDateTime: "",
      sellerId: ""
    });

  const sellers = useMemo<Seller[]>(() => {
    const all = [
      { id: "seller-1", name: "Ana Vendedora" },
      { id: "seller-2", name: "Bruno Vendedor" },
      { id: "seller-3", name: "Carla Vendedora" }
    ];

    if (!canFilterBySeller && user?.id && user?.name) {
      return [{ id: user.id, name: user.name }];
    }

    return all;
  }, [canFilterBySeller, user]);

  const sellerById = useMemo(
    () =>
      Object.fromEntries(
        sellers.map((seller) => [seller.id, seller.name])
      ),
    [sellers]
  );

  const filteredEvents = useMemo(() => {
    const today = new Date();
    const dayStart = startOfDay(today);
    const dayEnd = endOfDay(today);

    const byRole = events.filter((event) => {
      if (user?.role === "vendedor")
        return event.userId === user.id;

      if (canFilterBySeller && selectedSellerId)
        return event.userId === selectedSellerId;

      return true;
    });

    return byRole.filter((event) => {
      const start = new Date(event.startDateTime);
      return start >= dayStart && start <= dayEnd;
    });
  }, [
    events,
    user,
    canFilterBySeller,
    selectedSellerId
  ]);

  const markAsCompleted = (eventId: string) => {
    setEvents((current) =>
      current.map((event) =>
        event.id === eventId
          ? { ...event, status: "realizado" }
          : event
      )
    );
  };

  const refreshEvents = (newEvent: AgendaEvent) => {
    setEvents((current) =>
      [...current, newEvent].sort(
        (a, b) =>
          new Date(a.startDateTime).getTime() -
          new Date(b.startDateTime).getTime()
      )
    );
  };

  const openCreate = () => {
    setCreateForm({
      title: "",
      type: "reuniao_online",
      startDateTime: "",
      endDateTime: "",
      sellerId: canFilterBySeller
        ? selectedSellerId
        : user?.id || ""
    });

    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
  };

  const onCreateAgenda = (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (
      !createForm.title.trim() ||
      !createForm.startDateTime ||
      !createForm.endDateTime
    ) {
      toast.error(
        "Preencha título, início e fim da agenda."
      );
      return;
    }

    if (
      new Date(createForm.startDateTime).getTime() >=
      new Date(createForm.endDateTime).getTime()
    ) {
      toast.error(
        "A data de fim deve ser maior que a data de início."
      );
      return;
    }

    const ownerId = canFilterBySeller
      ? createForm.sellerId
      : user?.id;

    if (!ownerId) {
      toast.error(
        "Selecione um vendedor para criar a agenda."
      );
      return;
    }

    const createdEvent: AgendaEvent = {
      id: `event-${Date.now()}`,
      userId: ownerId,
      title: createForm.title.trim(),
      description:
        "Compromisso criado manualmente.",
      type: createForm.type,
      startDateTime: new Date(
        createForm.startDateTime
      ).toISOString(),
      endDateTime: new Date(
        createForm.endDateTime
      ).toISOString(),
      status: "agendado"
    };

    refreshEvents(createdEvent);
    closeCreate();
    toast.success("Agenda criada com sucesso.");
  };

  return (
    <section className="space-y-4">
      <header className="flex justify-between rounded-xl border bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-xl font-semibold">
            Agenda
          </h2>
        </div>

        <button
          type="button"
          onClick={openCreate}
          className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white"
        >
          Nova agenda
        </button>
      </header>

      {/* Lista de eventos */}
      <div className="rounded-xl border bg-white shadow-sm">
        {!filteredEvents.length ? (
          <p className="p-6 text-center text-sm text-slate-500">
            Nenhum evento encontrado.
          </p>
        ) : (
          <div className="divide-y">
            {filteredEvents.map((event) => (
              <div
                key={event.id}
                className="p-4 flex justify-between items-center"
              >
                <div>
                  <p className="font-medium">
                    {event.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(
                      event.startDateTime
                    )}
                  </p>
                </div>

                <span className="text-xs">
                  {sellerById[event.userId]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal criação */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">
              Nova agenda
            </h3>

            <form
              className="space-y-3"
              onSubmit={onCreateAgenda}
            >
              <input
                value={createForm.title}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    title: event.target.value
                  }))
                }
                className="w-full rounded border px-3 py-2"
                placeholder="Título"
              />

              <div className="grid gap-3 md:grid-cols-2">
                <input
                  type="datetime-local"
                  value={
                    createForm.startDateTime
                  }
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      startDateTime:
                        event.target.value
                    }))
                  }
                  className="rounded border px-3 py-2"
                />

                <input
                  type="datetime-local"
                  value={createForm.endDateTime}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      endDateTime:
                        event.target.value
                    }))
                  }
                  className="rounded border px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="rounded border px-4 py-2"
                >
                  Cancelar
                </button>

                <button
                  type="submit"
                  className="rounded bg-brand-700 px-4 py-2 text-white"
                >
                  Salvar agenda
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}