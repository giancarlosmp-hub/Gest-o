import { useEffect, useMemo, useState } from "react";
import api from "../../lib/apiClient";

type PlanningAction = {
  type: "visit" | "call" | "proposal" | "follow_up" | "whatsapp" | "review";
  clientId?: string | null;
  opportunityId?: string | null;
  title: string;
  city?: string | null;
  score: number;
  priorityLevel: "urgente" | "alta" | "normal" | "baixa";
  reason: string;
  objective: string;
  suggestedPeriod: "morning" | "afternoon" | null;
  estimatedDurationMinutes: number;
  source: string;
};

type PlanningDay = {
  date: string;
  label: string;
  existingAppointments: Array<{ id: string; title: string; startsAt: string; endsAt: string; city?: string | null; type: string }>;
  suggestedActions: PlanningAction[];
};

type WeeklyPlan = {
  weekStart: string;
  weekEnd: string;
  summary: string;
  workload: { plannedActions: number; visits: number; calls: number; proposals: number; followUps: number; capacityStatus: "balanced" | "light" | "overloaded" };
  days: PlanningDay[];
  warnings: string[];
  source: "ai" | "deterministic";
};

type Props = { sellerId?: string; weekStart?: string };

const actionLabel: Record<PlanningAction["type"], string> = {
  visit: "Visita",
  call: "Ligação",
  proposal: "Proposta",
  follow_up: "Follow-up",
  whatsapp: "WhatsApp",
  review: "Revisão"
};

const priorityClass: Record<PlanningAction["priorityLevel"], string> = {
  urgente: "border-red-200 bg-red-50 text-red-800",
  alta: "border-orange-200 bg-orange-50 text-orange-800",
  normal: "border-blue-200 bg-blue-50 text-blue-800",
  baixa: "border-slate-200 bg-slate-50 text-slate-700"
};

const formatHour = (value: string) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function ActionCard({ action }: { action: PlanningAction }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Sugerido</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClass[action.priorityLevel]}`}>{action.priorityLevel} · score {action.score}</span>
        <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{actionLabel[action.type]}</span>
      </div>
      <h4 className="mt-2 text-sm font-semibold text-slate-900">{action.title}</h4>
      <p className="mt-1 text-xs text-slate-600"><strong>Motivo:</strong> {action.reason}</p>
      <p className="mt-1 text-xs text-slate-600"><strong>Objetivo:</strong> {action.objective}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-medium text-slate-500">
        <span>{action.city || "Cidade não informada"}</span>
        <span>{action.suggestedPeriod === "morning" ? "Manhã" : action.suggestedPeriod === "afternoon" ? "Tarde" : "Período flexível"}</span>
        <span>{action.estimatedDurationMinutes} min</span>
      </div>
    </article>
  );
}

export default function WeeklyCommercialPlan({ sellerId, weekStart }: Props) {
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const params = useMemo(() => ({ ...(sellerId ? { sellerId } : {}), ...(weekStart ? { weekStart } : {}) }), [sellerId, weekStart]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    api.get("/ai/commercial-planning/week", { params, signal: controller.signal })
      .then((response) => {
        if (!active) return;
        setPlan(response.data);
        setOpenDay(response.data?.days?.[0]?.date ?? null);
      })
      .catch(() => active && setPlan(null))
      .finally(() => active && setLoading(false));
    return () => { active = false; controller.abort(); };
  }, [params]);

  if (loading) return <section className="rounded-xl border bg-white p-4 text-sm text-slate-500">Carregando planejamento comercial inteligente…</section>;
  if (!plan) return <section className="rounded-xl border bg-white p-4 text-sm text-slate-500">Planejamento comercial indisponível no momento.</section>;

  return (
    <section className="space-y-3 rounded-xl border bg-white p-3 shadow-sm sm:p-4" aria-label="Planejamento Comercial Inteligente">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Planejamento Comercial Inteligente</p>
          <h3 className="text-lg font-semibold text-slate-900">Semana de {plan.weekStart} a {plan.weekEnd}</h3>
          <p className="mt-1 text-sm text-slate-600">{plan.summary}</p>
        </div>
        <span className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600">{plan.source === "ai" ? "Resumo com IA" : "Fallback determinístico"}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.plannedActions}</strong><br />ações</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.visits}</strong><br />visitas</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.calls}</strong><br />contatos</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.proposals}</strong><br />propostas</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.capacityStatus}</strong><br />capacidade</span>
      </div>

      <div className="hidden gap-3 lg:grid lg:grid-cols-5">
        {plan.days.map((day) => (
          <div key={day.date} className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <h4 className="text-sm font-semibold text-slate-900">{day.label}</h4>
            <p className="text-[11px] text-slate-500">{day.date}</p>
            {day.existingAppointments.map((appointment) => <div key={appointment.id} className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900"><strong>Já agendado</strong><br />{formatHour(appointment.startsAt)} · {appointment.title}</div>)}
            {day.suggestedActions.map((action, index) => <ActionCard key={`${day.date}-${action.clientId || action.opportunityId || index}`} action={action} />)}
          </div>
        ))}
      </div>

      <div className="space-y-2 lg:hidden">
        {plan.days.map((day) => (
          <details key={day.date} open={openDay === day.date} onToggle={(event) => (event.currentTarget.open ? setOpenDay(day.date) : null)} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">{day.label} · {day.suggestedActions.length} ações · {day.existingAppointments.length} agendado(s)</summary>
            <div className="mt-2 space-y-2">
              {day.existingAppointments.map((appointment) => <div key={appointment.id} className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900"><strong>Já agendado</strong><br />{formatHour(appointment.startsAt)} · {appointment.title}</div>)}
              {day.suggestedActions.map((action, index) => <ActionCard key={`${day.date}-${action.clientId || action.opportunityId || index}`} action={action} />)}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
