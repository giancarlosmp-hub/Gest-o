import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckSquare, Clock3, MessageCircleWarning, SunMoon, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { useReminders } from "../hooks/useReminders";
import { normalizeActivityType } from "../constants/activityTypes";

type Activity = {
  id: string;
  type: string;
  notes: string;
  dueDate: string;
  createdAt: string;
  done: boolean;
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

type ActivityKpi = {
  type: string;
  targetValue: number;
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

function getMonthBusinessDays(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  let businessDays = 0;

  for (let day = 1; day <= lastDay; day += 1) {
    const weekDay = new Date(year, month, day).getDay();
    if (weekDay !== 0 && weekDay !== 6) {
      businessDays += 1;
    }
  }

  return businessDays;
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
  const { alerts, reminders, refreshReminders } = useReminders(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityKpis, setActivityKpis] = useState<ActivityKpi[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      void refreshReminders();
      try {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const [activitiesResponse, opportunitiesResponse, activityKpisResponse] = await Promise.all([
          api.get("/activities"),
          api.get("/opportunities?status=open"),
          api.get(`/activity-kpis?month=${currentMonth}`)
        ]);

        setActivities(Array.isArray(activitiesResponse.data) ? activitiesResponse.data : []);
        const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
          ? opportunitiesResponse.data.items
          : opportunitiesResponse.data;
        setOpportunities(Array.isArray(opportunitiesPayload) ? opportunitiesPayload : []);
        setActivityKpis(Array.isArray(activityKpisResponse.data) ? activityKpisResponse.data : []);
      } catch {
        setActivities([]);
        setOpportunities([]);
        setActivityKpis([]);
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

  const routineMetrics = useMemo(() => {
    const now = new Date();
    const monthBusinessDays = getMonthBusinessDays(now);
    const { start, end } = getTodayBoundaries();
    const targetKeys = {
      ligacao: ["ligacao"],
      visita: ["visita", "visita_tecnica", "visita_presencial"],
      proposta: ["envio_proposta"],
    };

    const monthlyTargetByType = activityKpis.reduce<Record<string, number>>((accumulator, item) => {
      const normalized = normalizeActivityType(item.type);
      accumulator[normalized] = (accumulator[normalized] ?? 0) + Number(item.targetValue || 0);
      return accumulator;
    }, {});

    const todayCountByType = activities.reduce<Record<string, number>>((accumulator, item) => {
      if (!isSameDay(item.createdAt ?? item.dueDate, start, end)) {
        return accumulator;
      }
      const normalized = normalizeActivityType(item.type);
      accumulator[normalized] = (accumulator[normalized] ?? 0) + 1;
      return accumulator;
    }, {});

    const buildMetric = (label: string, keys: string[]) => {
      const monthlyTarget = keys.reduce((sum, key) => sum + (monthlyTargetByType[key] ?? 0), 0);
      const dailyTarget = monthBusinessDays > 0 ? monthlyTarget / monthBusinessDays : 0;
      const realized = keys.reduce((sum, key) => sum + (todayCountByType[key] ?? 0), 0);
      const progressPercent = dailyTarget > 0 ? (realized / dailyTarget) * 100 : 0;

      return {
        label,
        dailyTarget,
        realized,
        progressPercent,
        achieved: realized >= dailyTarget && dailyTarget > 0,
      };
    };

    const metrics = [
      buildMetric("Meta de ligações hoje", targetKeys.ligacao),
      buildMetric("Meta de visitas hoje", targetKeys.visita),
      buildMetric("Meta de propostas hoje", targetKeys.proposta),
    ];

    const totalTarget = metrics.reduce((sum, item) => sum + item.dailyTarget, 0);
    const totalRealized = metrics.reduce((sum, item) => sum + item.realized, 0);
    const shouldShowWarning = user?.role === "vendedor" && now.getHours() >= 15 && totalTarget > 0 && totalRealized / totalTarget < 0.5;

    return { metrics, shouldShowWarning };
  }, [activities, activityKpis, user?.role]);

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        {alerts.showOverdueFollowUpAlert && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
            Atenção: existem follow-ups vencidos.
          </div>
        )}
        {alerts.showUpcomingMeetingBanner && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm font-medium text-blue-700">
            Lembrete: você possui {reminders.upcomingMeetingsCount} reunião(ões) nas próximas 2 horas.
          </div>
        )}
        {alerts.showNoActivitiesWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-700">
            Você ainda não registrou atividades hoje.
          </div>
        )}
        {routineMetrics.shouldShowWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-700">
            Atenção leve: você está abaixo de 50% da rotina comercial esperada até este horário.
          </div>
        )}
      </section>

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
              <p className="text-xs uppercase tracking-wide text-slate-500">Painel de Disciplina Comercial</p>
              <h2 className="text-lg font-semibold text-slate-900">Rotina Comercial do Dia</h2>
            </div>
          </div>

          <div className="space-y-3">
            {routineMetrics.metrics.map((metric) => {
              const barColorClass = metric.achieved ? "bg-green-500" : "bg-red-500";
              const clampedProgress = Math.max(0, Math.min(metric.progressPercent, 100));

              return (
                <div key={metric.label} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                    <p className="font-medium text-slate-900">{metric.label}</p>
                    <p className="text-slate-600">
                      {metric.realized} / {metric.dailyTarget.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}
                    </p>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className={`h-2 rounded-full transition-all ${barColorClass}`} style={{ width: `${clampedProgress}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </article>

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
