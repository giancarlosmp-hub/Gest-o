import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckSquare, Clock3, MessageCircleWarning, SunMoon, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { useReminders } from "../hooks/useReminders";
import { normalizeActivityType } from "../constants/activityTypes";
import { getApiErrorMessage } from "../lib/apiError";

type Activity = {
  id: string;
  type: string;
  notes: string;
  dueDate: string;
  createdAt: string;
  done: boolean;
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

type AgendaEventLite = {
  id: string;
  title: string;
  type: string;
  status?: "planned" | "completed" | "cancelled";
  startsAt?: string;
  startDateTime?: string;
};

type ActivityKpi = {
  type: string;
  targetValue: number;
};

type Opportunity = {
  id: string;
  title: string;
  followUpDate?: string | null;
  expectedCloseDate?: string | null;
  stage: string;
  value?: number;
  lastContactAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  client?: { id: string; name: string } | string;
};

type SmartAlertItem = {
  id: "followups_overdue" | "opportunities_without_followup" | "proposals_no_response" | "cooling_clients";
  label: string;
  helper: string;
  count: number;
  to?: string;
  unavailable?: boolean;
};

type CoolingClientsState = {
  count: number;
  unavailable: boolean;
  message?: string;
};

type WeeklyVisitItem = {
  userId: string;
  name: string;
  visitsDone: number;
  goal: number;
  medal: "gold" | "silver" | "bronze" | "none";
  missing: number;
};

type WeeklyMission = {
  key: "visits_25" | "followups_5" | "proposals_2" | "overdue_0" | string;
  title: string;
  progress: number;
  target: number;
  done: boolean;
  medal?: WeeklyVisitItem["medal"];
};

type WeeklyMissionSeller = {
  userId: string;
  name: string;
  missions: WeeklyMission[];
};

const WEEKLY_MISSIONS_CACHE_TTL_MS = 45_000;
let weeklyMissionsCache: { key: string; expiresAt: number; payload: WeeklyMissionSeller[] } | null = null;

type PipelineOpportunity = Opportunity & {
  priorityType: "followup_overdue" | "opportunity_overdue" | "proposal_no_response";
  daysLate: number;
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

function getCurrentWeekStartDate() {
  const today = new Date();
  const day = today.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);
  const local = new Date(monday.getTime() - monday.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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
  const startRouteSearch = useMemo(() => {
    const params = new URLSearchParams({
      date: new Date().toISOString().slice(0, 10),
      view: "hoje",
      highlight: "next",
      execute: "1"
    });

    if (user?.id && user.role === "vendedor") {
      params.set("sellerId", user.id);
    }

    return params.toString();
  }, [user?.id, user?.role]);

  const { alerts, reminders, refreshReminders } = useReminders({ autoLoad: false });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityKpis, setActivityKpis] = useState<ActivityKpi[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [agendaEventsToday, setAgendaEventsToday] = useState<AgendaEventLite[]>([]);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [coolingClients, setCoolingClients] = useState<CoolingClientsState>({ count: 0, unavailable: false });
  const [weeklyMissions, setWeeklyMissions] = useState<WeeklyMissionSeller[]>([]);
  const [loading, setLoading] = useState(true);

  const dashboardQueryKey = useMemo(() => new Date().toISOString().slice(0, 7), []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const loadData = async () => {
      setLoading(true);
      void refreshReminders(controller.signal);
      try {
        setPipelineError(null);
        const today = new Date().toISOString().slice(0, 10);
        const [activitiesResponse, opportunitiesResponse, activityKpisResponse, agendaResponse] = await Promise.all([
          api.get("/activities", { signal: controller.signal }),
          api.get("/opportunities?status=open", { signal: controller.signal }),
          api.get(`/activity-kpis?month=${dashboardQueryKey}`, { signal: controller.signal }),
          api.get(`/agenda/events?from=${today}&to=${today}`, { signal: controller.signal })
        ]);

        if (!active) return;
        setActivities(Array.isArray(activitiesResponse.data) ? activitiesResponse.data : []);
        const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
          ? opportunitiesResponse.data.items
          : opportunitiesResponse.data;
        setOpportunities(Array.isArray(opportunitiesPayload) ? opportunitiesPayload : []);
        setActivityKpis(Array.isArray(activityKpisResponse.data) ? activityKpisResponse.data : []);
        const agendaPayload = Array.isArray(agendaResponse.data?.items) ? agendaResponse.data.items : agendaResponse.data;
        setAgendaEventsToday(Array.isArray(agendaPayload) ? agendaPayload : []);

        try {
          const coolingResponse = await api.get("/clients/alerts/cooling", { signal: controller.signal });
          if (!active) return;
          const count = Number(coolingResponse.data?.count ?? 0);
          setCoolingClients({ count: Number.isFinite(count) ? count : 0, unavailable: false });
        } catch (coolingError: unknown) {
          if (!active || (coolingError as { code?: string })?.code === "ERR_CANCELED") return;
          const status = (coolingError as { response?: { status?: number } })?.response?.status;
          if (status === 404) {
            setCoolingClients({
              count: 0,
              unavailable: true,
              message: "Alerta de clientes esfriando indisponível no momento."
            });
          } else {
            setCoolingClients({
              count: 0,
              unavailable: true,
              message: getApiErrorMessage(coolingError, "Não foi possível carregar clientes esfriando.")
            });
          }
        }
      } catch (error) {
        if (!active || (error as { code?: string })?.code === "ERR_CANCELED") return;
        setPipelineError("Não foi possível carregar o Pipeline do Dia agora. Tente novamente em instantes.");
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadData();
    return () => {
      active = false;
      controller.abort();
    };
  }, [dashboardQueryKey, refreshReminders]);


  useEffect(() => {
    let active = true;
    const weekStart = getCurrentWeekStartDate();
    const cacheKey = `${user?.role || "anon"}:${user?.id || "anon"}:${weekStart}`;

    const loadWeeklyMissions = async () => {
      if (weeklyMissionsCache && weeklyMissionsCache.key === cacheKey && weeklyMissionsCache.expiresAt > Date.now()) {
        setWeeklyMissions(weeklyMissionsCache.payload);
        return;
      }

      try {
        const response = await api.get<WeeklyMissionSeller[]>(`/reports/weekly-missions?weekStart=${weekStart}`);
        if (!active) return;
        const payload = Array.isArray(response.data) ? response.data : [];
        setWeeklyMissions(payload);
        weeklyMissionsCache = {
          key: cacheKey,
          payload,
          expiresAt: Date.now() + WEEKLY_MISSIONS_CACHE_TTL_MS
        };
      } catch {
        if (!active) return;
        setWeeklyMissions([]);
      }
    };

    void loadWeeklyMissions();
    return () => {
      active = false;
    };
  }, [user?.id, user?.role]);
  const todayDateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("pt-BR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }).format(new Date()),
    []
  );

  const { plannedAppointmentsToday, meetingsToday, activitiesToday, pendingFollowUps, urgentFollowUps } = useMemo(() => {
    const { start, end } = getTodayBoundaries();
    const now = new Date();

    const plannedAppointments = agendaEventsToday
      .filter((item) => (item.status ?? "planned") === "planned")
      .filter((item) => isSameDay(String(item.startsAt || item.startDateTime || ""), start, end));

    const meetings = activities
      .filter((item) => item.type === "reuniao" && isSameDay(item.dueDate, start, end))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    const dayActivities = activities
      .filter((item) => isSameDay(item.createdAt ?? item.dueDate, start, end))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

    const toFollowUpDate = (value?: string | null) => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    const pending = opportunities
      .filter((item) => {
        const followUpDate = toFollowUpDate(item.followUpDate);
        return followUpDate !== null && followUpDate >= start;
      })
      .sort((a, b) => {
        const aDate = toFollowUpDate(a.followUpDate);
        const bDate = toFollowUpDate(b.followUpDate);
        if (!aDate || !bDate) return 0;
        return aDate.getTime() - bDate.getTime();
      });

    const urgent = opportunities
      .filter((item) => {
        const followUpDate = toFollowUpDate(item.followUpDate);
        return followUpDate !== null && followUpDate <= end;
      })
      .map((item) => {
        const followUpDate = toFollowUpDate(item.followUpDate);
        return { ...item, overdue: followUpDate !== null && followUpDate < now };
      })
      .sort((a, b) => {
        const aDate = toFollowUpDate(a.followUpDate);
        const bDate = toFollowUpDate(b.followUpDate);
        if (!aDate || !bDate) return 0;
        return aDate.getTime() - bDate.getTime();
      });

    return {
      plannedAppointmentsToday: plannedAppointments,
      meetingsToday: meetings,
      activitiesToday: dayActivities,
      pendingFollowUps: pending,
      urgentFollowUps: urgent
    };
  }, [activities, agendaEventsToday, opportunities]);

  const routineMetrics = useMemo(() => {
    const now = new Date();
    const monthBusinessDays = getMonthBusinessDays(now);
    const { start, end } = getTodayBoundaries();

    const targetKeys = {
      ligacao: ["ligacao"],
      visita: ["visita", "visita_tecnica", "visita_presencial"],
      proposta: ["envio_proposta"]
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
        achieved: realized >= dailyTarget && dailyTarget > 0
      };
    };

    const metrics = [
      buildMetric("Meta de ligações hoje", targetKeys.ligacao),
      buildMetric("Meta de visitas hoje", targetKeys.visita),
      buildMetric("Meta de propostas hoje", targetKeys.proposta)
    ];

    const totalTarget = metrics.reduce((sum, item) => sum + item.dailyTarget, 0);
    const totalRealized = metrics.reduce((sum, item) => sum + item.realized, 0);

    const shouldShowWarning =
      user?.role === "vendedor" &&
      now.getHours() >= 15 &&
      totalTarget > 0 &&
      totalRealized / totalTarget < 0.5;

    return { metrics, shouldShowWarning };
  }, [activities, activityKpis, user?.role]);

  const pipelineOfDay = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const noResponseDays = 7;
    const msPerDay = 1000 * 60 * 60 * 24;

    const getDayDiff = (dateValue?: string | null) => {
      if (!dateValue) return 0;
      const parsedDate = new Date(dateValue);
      if (Number.isNaN(parsedDate.getTime())) return 0;
      const dateOnly = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
      return Math.floor((today.getTime() - dateOnly.getTime()) / msPerDay);
    };

    const prioritized: PipelineOpportunity[] = opportunities
      .map((item) => {
        const followUpLateDays = getDayDiff(item.followUpDate);
        if (followUpLateDays >= 0) {
          return { ...item, priorityType: "followup_overdue" as const, daysLate: followUpLateDays };
        }

        const expectedCloseLateDays = getDayDiff(item.expectedCloseDate);
        if (expectedCloseLateDays > 0) {
          return { ...item, priorityType: "opportunity_overdue" as const, daysLate: expectedCloseLateDays };
        }

        const stage = String(item.stage || "").toLowerCase();
        const noActionDays = getDayDiff(item.lastContactAt || item.followUpDate);
        if (stage === "proposta" && noActionDays >= noResponseDays) {
          return { ...item, priorityType: "proposal_no_response" as const, daysLate: noActionDays };
        }

        return null;
      })
      .filter((item): item is PipelineOpportunity => item !== null)
      .sort((a, b) => {
        const priorityOrder = {
          followup_overdue: 0,
          opportunity_overdue: 1,
          proposal_no_response: 2
        } as const;
        const byPriority = priorityOrder[a.priorityType] - priorityOrder[b.priorityType];
        if (byPriority !== 0) return byPriority;

        const byDelay = b.daysLate - a.daysLate;
        if (byDelay !== 0) return byDelay;

        return Number(b.value || 0) - Number(a.value || 0);
      });

    return {
      total: prioritized.length,
      topFive: prioritized.slice(0, 5)
    };
  }, [opportunities]);

  const smartAlerts = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const toValidDate = (value?: string | null) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };

    const followUpsOverdue = opportunities.filter((item) => {
      const followUpDate = toValidDate(item.followUpDate);
      return followUpDate !== null && followUpDate < tomorrow;
    }).length;

    const opportunitiesWithoutFollowUp = opportunities.filter((item) => {
      const expectedCloseDate = toValidDate(item.expectedCloseDate);
      const followUpDate = toValidDate(item.followUpDate);
      const closeIsLate = expectedCloseDate !== null && expectedCloseDate < today;
      const noFollowUp = followUpDate === null;
      const followUpAfterToday = followUpDate !== null && followUpDate >= tomorrow;
      return closeIsLate && (noFollowUp || followUpAfterToday);
    }).length;

    const proposalsNoResponse = opportunities.filter((item) => {
      const stage = String(item.stage || "").toLowerCase();
      if (stage !== "proposta") return false;
      const lastActivityDate = toValidDate(item.lastActivityAt || item.updatedAt || item.lastContactAt || item.followUpDate);
      if (!lastActivityDate) return false;
      return now.getTime() - lastActivityDate.getTime() > sevenDaysMs;
    }).length;

    const items: SmartAlertItem[] = [
      {
        id: "followups_overdue",
        label: "Follow-ups vencidos hoje/atrasados",
        helper: "Existem follow-ups que já deveriam ter sido tratados.",
        count: followUpsOverdue,
        to: "/oportunidades?status=open&actionToday=true"
      },
      {
        id: "opportunities_without_followup",
        label: "Oportunidades atrasadas sem follow-up",
        helper: "Negócios com previsão vencida sem acompanhamento adequado.",
        count: opportunitiesWithoutFollowUp,
        to: "/oportunidades?status=open&overdue=true"
      },
      {
        id: "proposals_no_response",
        label: "Propostas sem retorno",
        helper: "Propostas sem interação há mais de 7 dias.",
        count: proposalsNoResponse,
        to: "/oportunidades?status=open&stage=proposta"
      },
      {
        id: "cooling_clients",
        label: "Clientes esfriando",
        helper: coolingClients.unavailable
          ? "Alerta indisponível no momento."
          : "Clientes A/B sem atividade relevante há 21+ dias.",
        count: coolingClients.count,
        to: "/clientes?classe=A",
        unavailable: coolingClients.unavailable
      }
    ];

    return {
      items,
      hasActionableAlerts: items.some((item) => !item.unavailable && item.count > 0)
    };
  }, [coolingClients.count, coolingClients.unavailable, opportunities]);

  const weeklyMissionSummary = useMemo(() => {
    const getMissionByKey = (seller: WeeklyMissionSeller, key: WeeklyMission["key"]) =>
      seller.missions.find((mission) => mission.key === key) ?? null;

    const ranking = [...weeklyMissions]
      .map((seller) => {
        const mainMission = getMissionByKey(seller, "visits_25");
        return {
          ...seller,
          mainMission,
          mainMissionProgress: Number(mainMission?.progress ?? 0)
        };
      })
      .sort((a, b) => b.mainMissionProgress - a.mainMissionProgress || a.name.localeCompare(b.name, "pt-BR"));

    const own = ranking.find((seller) => seller.userId === user?.id) ?? ranking[0] ?? null;
    return {
      own,
      top3: ranking.slice(0, 3)
    };
  }, [weeklyMissions, user?.id]);

  const ownWeeklyMissions = useMemo(() => {
    const fallback = weeklyMissionSummary.own;
    return fallback?.missions ?? [];
  }, [weeklyMissionSummary.own]);

  const getMedalLabel = (medal: WeeklyVisitItem["medal"]) => {
    if (medal === "gold") return "🥇 Ouro";
    if (medal === "silver") return "🥈 Prata";
    if (medal === "bronze") return "🥉 Bronze";
    return "Sem medalha";
  };

  const getMedalTone = (medal: WeeklyVisitItem["medal"]) => {
    if (medal === "gold") return "text-amber-600";
    if (medal === "silver") return "text-slate-600";
    if (medal === "bronze") return "text-orange-700";
    return "text-slate-500";
  };

  const getPipelinePriorityLabel = (type: PipelineOpportunity["priorityType"]) => {
    if (type === "followup_overdue") return "Follow-up vencido";
    if (type === "opportunity_overdue") return "Oportunidade atrasada";
    return "Proposta sem retorno";
  };

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-brand-900">Central do Dia</h1>
            <p className="mt-1 text-sm text-slate-600">Resumo operacional, tarefas e compromissos do dia.</p>
          </div>

          <Link
            to={`/agenda?${startRouteSearch}`}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Iniciar roteiro
          </Link>
        </div>

        <div className="mt-3 flex items-center gap-3 text-brand-900">
          <SunMoon size={22} />
          <h2 className="text-xl font-bold">
            {getGreeting()}, {user?.name ?? "Usuário"}
          </h2>
        </div>

        <p className="mt-2 text-sm text-slate-600">
          {getGreeting()} · Hoje: <span className="capitalize">{todayDateLabel}</span>
        </p>
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
                      {metric.realized} /{" "}
                      {metric.dailyTarget.toLocaleString("pt-BR", {
                        maximumFractionDigits: 1,
                        minimumFractionDigits: 1
                      })}
                    </p>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div
                      className={`h-2 rounded-full transition-all ${barColorClass}`}
                      style={{ width: `${clampedProgress}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Gamificação</p>
              <h2 className="text-lg font-semibold text-slate-900">Missões da Semana</h2>
            </div>
          </div>

          {weeklyMissionSummary.own ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {ownWeeklyMissions.map((mission) => {
                  const progress = Number(mission.progress || 0);
                  const target = Number(mission.target || 0);
                  const safePercent = target > 0 ? Math.max(0, Math.min((progress / target) * 100, 100)) : mission.done ? 100 : 0;
                  const motivational = mission.done
                    ? "Concluída! Excelente consistência. 🚀"
                    : `Falta ${Math.max(target - progress, 0)} para completar.`;

                  return (
                    <div key={mission.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-medium text-slate-700">{mission.title}</p>
                      <p className="mt-1 text-lg font-bold text-slate-900">
                        {progress}/{target}
                      </p>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-200">
                        <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${safePercent}%` }} />
                      </div>
                      {mission.key === "visits_25" && mission.medal && (
                        <p className={`mt-1 text-xs font-medium ${getMedalTone(mission.medal)}`}>{getMedalLabel(mission.medal)}</p>
                      )}
                      <p className={`mt-1 text-xs ${mission.done ? "text-emerald-700" : "text-slate-600"}`}>{motivational}</p>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Top 3 da semana</p>
                {weeklyMissionSummary.top3.map((item, index) => (
                  <div key={item.userId} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <p className="text-sm text-slate-700">
                      {index + 1}º · <span className="font-medium text-slate-900">{item.name}</span>
                    </p>
                    <p className="text-sm font-semibold text-slate-900">{item.mainMissionProgress} visitas</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">Ainda não há visitas concluídas nesta semana. Bora começar com tudo!</p>
          )}
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Pipeline</p>
              <h2 className="text-lg font-semibold text-slate-900">Pipeline do Dia</h2>
            </div>
            <Link
              to="/oportunidades?status=open&actionToday=true"
              className="rounded-md border border-brand-200 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50"
            >
              Ver todas
            </Link>
          </div>

          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Oportunidades com ação hoje</p>
            <p className="text-2xl font-bold text-slate-900">{pipelineOfDay.total}</p>
          </div>

          <div className="mt-3 space-y-2">
            {pipelineError ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">{pipelineError}</p>
            ) : loading ? (
              <p className="text-sm text-slate-500">Carregando pipeline do dia...</p>
            ) : pipelineOfDay.topFive.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhuma oportunidade com ação pendente hoje.</p>
            ) : (
              pipelineOfDay.topFive.map((item) => (
                <div key={item.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="text-sm font-medium text-slate-900">{item.title}</p>
                  <p className="text-xs text-slate-600">
                    {typeof item.client === "string" ? item.client : item.client?.name ?? "Cliente não informado"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {getPipelinePriorityLabel(item.priorityType)} · {item.daysLate} dia(s)
                  </p>
                </div>
              ))
            )}
          </div>
        </article>

        <article className={blockClass}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Prioridades</p>
              <h2 className="text-lg font-semibold text-slate-900">Alertas Inteligentes</h2>
            </div>
          </div>

          {coolingClients.message && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">{coolingClients.message}</p>
          )}

          <div className="space-y-2">
            {smartAlerts.items.map((alert) => (
              <div key={alert.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <p className="text-base font-semibold text-slate-900">{alert.count.toLocaleString("pt-BR")}</p>
                  <p className="text-sm text-slate-700">{alert.label}</p>
                  <p className="text-xs text-slate-500">{alert.helper}</p>
                </div>

                {alert.unavailable ? (
                  <span className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500">Indisponível</span>
                ) : (
                  <Link
                    to={alert.to || "/"}
                    className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800"
                  >
                    Abrir
                  </Link>
                )}
              </div>
            ))}
          </div>

          {!loading && !smartAlerts.hasActionableAlerts && (
            <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
              Tudo em dia ✅
            </p>
          )}
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
              <p className="text-xs text-slate-500">Compromissos planejados hoje</p>
              <p className="text-2xl font-bold text-slate-900">{plannedAppointmentsToday.length}</p>
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
                <div
                  key={meeting.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(
                        new Date(meeting.dueDate)
                      )}
                    </p>
                    <p className="text-xs text-slate-600">
                      {meeting.opportunity?.client?.name ?? "Cliente não informado"} · {getMeetingType(meeting.notes)}
                    </p>
                  </div>
                  <Link
                    to={meeting.opportunity?.client?.id ? `/clientes/${meeting.opportunity.client.id}` : "/clientes"}
                    className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800"
                  >
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
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-600">
                      {typeof item.client === "string" ? item.client : item.client?.name ?? "Cliente não informado"}
                    </p>
                    <p className="text-xs text-slate-500">
                      Follow-up: {item.followUpDate ? new Intl.DateTimeFormat("pt-BR").format(new Date(item.followUpDate)) : "Sem data"}
                    </p>
                  </div>
                  {(item as any).overdue && <span className="h-3 w-3 rounded-full bg-red-500" title="Vencido" />}
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
                <div
                  key={activity.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{activity.notes || "Atividade"}</p>
                    <p className="text-xs text-slate-600">{activity.opportunity?.title || "Sem oportunidade"}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                    <Clock3 size={14} />
                    {new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(
                      new Date(activity.dueDate)
                    )}
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
