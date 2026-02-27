import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckSquare, Clock3, MessageCircleWarning, SunMoon, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";

type Activity = {
  id: string;
  type: string;
  notes: string;
  dueDate: string;
  done: boolean;
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

type Opportunity = {
  id: string;
  title: string;
  followUpDate: string;
  client?: { id: string; name: string } | string;
};

function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "Bom dia";
  if (hour >= 12 && hour <= 17) return "Boa tarde";
  return "Boa noite";
}

function getTodayBoundaries() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function isSameDay(dateValue: string, start: Date, end: Date) {
  const date = new Date(dateValue);
  return date >= start && date < end;
}

function getMeetingType(notes: string) {
  const normalized = notes.toLowerCase();
  if (normalized.includes("online")) return "online";
  if (normalized.includes("presencial")) return "presencial";
  return "não informado";
}

const blockClass = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

export default function HomePage() {
  const { user } = useAuth();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [activitiesResponse, opportunitiesResponse] = await Promise.all([
          api.get("/activities"),
          api.get("/opportunities?status=open")
        ]);

        setActivities(Array.isArray(activitiesResponse.data) ? activitiesResponse.data : []);
        const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
          ? opportunitiesResponse.data.items
          : opportunitiesResponse.data;
        setOpportunities(Array.isArray(opportunitiesPayload) ? opportunitiesPayload : []);
      } catch {
        setActivities([]);
        setOpportunities([]);
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, []);

  const todayDateLabel = useMemo(
    () => new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()),
    []
  );

  const { meetingsToday, activitiesToday, pendingFollowUps, urgentFollowUps } = useMemo(() => {
    const { start, end } = getTodayBoundaries();
    const now = new Date();

    const meetings = activities
      .filter((item) => item.type === "reuniao" && isSameDay(item.dueDate, start, end))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    const dayActivities = activities
      .filter((item) => !item.done && isSameDay(item.dueDate, start, end))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    const pending = opportunities
      .filter((item) => new Date(item.followUpDate) >= start)
      .sort((a, b) => new Date(a.followUpDate).getTime() - new Date(b.followUpDate).getTime());

    const urgent = opportunities
      .filter((item) => {
        const followUp = new Date(item.followUpDate);
        return followUp <= end;
      })
      .map((item) => ({ ...item, overdue: new Date(item.followUpDate) < now }))
      .sort((a, b) => new Date(a.followUpDate).getTime() - new Date(b.followUpDate).getTime());

    return {
      meetingsToday: meetings,
      activitiesToday: dayActivities,
      pendingFollowUps: pending,
      urgentFollowUps: urgent,
    };
  }, [activities, opportunities]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-brand-100 bg-brand-50 p-5">
        <div className="flex items-center gap-3 text-brand-900">
          <SunMoon size={22} />
          <h1 className="text-2xl font-bold">{getGreeting()}, {user?.name ?? "Usuário"}</h1>
        </div>
        <p className="mt-2 text-sm capitalize text-slate-600">{todayDateLabel}</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Mini KPI</p>
              <h2 className="text-lg font-semibold text-slate-900">Resumo do Dia</h2>
            </div>
            <CalendarClock className="text-brand-700" size={20} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Reuniões hoje</p>
              <p className="text-2xl font-bold text-slate-900">{meetingsToday.length}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Follow-ups pendentes</p>
              <p className="text-2xl font-bold text-slate-900">{pendingFollowUps.length}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Atividades do dia</p>
              <p className="text-2xl font-bold text-slate-900">{activitiesToday.length}</p>
            </div>
          </div>
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Mini KPI</p>
              <h2 className="text-lg font-semibold text-slate-900">Reuniões de Hoje</h2>
            </div>
            <UsersRound className="text-brand-700" size={20} />
          </div>

          <div className="space-y-2">
            {loading ? (
              <p className="text-sm text-slate-500">Carregando reuniões...</p>
            ) : meetingsToday.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhuma reunião para hoje.</p>
            ) : (
              meetingsToday.map((meeting) => (
                <div key={meeting.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(meeting.dueDate))}</p>
                    <p className="text-xs text-slate-600">{meeting.opportunity?.client?.name ?? "Cliente não informado"} · {getMeetingType(meeting.notes)}</p>
                  </div>
                  <Link to={meeting.opportunity?.client?.id ? `/clientes/${meeting.opportunity.client.id}` : "/clientes"} className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800">
                    Abrir cliente
                  </Link>
                </div>
              ))
            )}
          </div>
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Mini KPI</p>
              <h2 className="text-lg font-semibold text-slate-900">Follow-ups Urgentes</h2>
            </div>
            <MessageCircleWarning className="text-brand-700" size={20} />
          </div>

          <div className="space-y-2">
            {loading ? (
              <p className="text-sm text-slate-500">Carregando follow-ups...</p>
            ) : urgentFollowUps.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum follow-up urgente.</p>
            ) : (
              urgentFollowUps.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-600">{typeof item.client === "string" ? item.client : item.client?.name ?? "Cliente não informado"}</p>
                    <p className="text-xs text-slate-500">Follow-up: {new Intl.DateTimeFormat("pt-BR").format(new Date(item.followUpDate))}</p>
                  </div>
                  {item.overdue && <span className="h-3 w-3 rounded-full bg-red-500" title="Vencido" />}
                </div>
              ))
            )}
          </div>
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Mini KPI</p>
              <h2 className="text-lg font-semibold text-slate-900">Atividades do Dia</h2>
            </div>
            <CheckSquare className="text-brand-700" size={20} />
          </div>

          <div className="space-y-2">
            {loading ? (
              <p className="text-sm text-slate-500">Carregando atividades...</p>
            ) : activitiesToday.length === 0 ? (
              <p className="text-sm text-slate-500">Sem atividades com vencimento hoje.</p>
            ) : (
              activitiesToday.map((activity) => (
                <div key={activity.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{activity.notes || "Atividade"}</p>
                    <p className="text-xs text-slate-600">{activity.opportunity?.title || "Sem oportunidade"}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                    <Clock3 size={14} />
                    {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(activity.dueDate))}
                  </span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
