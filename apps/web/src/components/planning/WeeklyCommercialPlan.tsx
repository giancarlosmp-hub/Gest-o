import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../../context/AuthContext";
import api from "../../lib/apiClient";
import { AI_REQUEST_TIMEOUT_MS } from "../../lib/aiRequest";
import { getApiErrorMessage } from "../../lib/apiError";
import { canActOnPlan, defaultScheduleTime, openHref, registerHref, toAgendaEvent, type PlanningAction } from "./weeklyPlanActions";

type Appointment = { id: string; title: string; startsAt: string; endsAt: string; city?: string | null; type: string };

type PlanningDay = {
  date: string;
  label: string;
  existingAppointments: Appointment[];
  suggestedActions: PlanningAction[];
  // Google Maps com as cidades do dia na ordem; mais de um quando o dia passa de 4 cidades.
  routeLinks?: string[];
};

type WeeklyPlan = {
  sellerId: string;
  weekStart: string;
  weekEnd: string;
  summary: string;
  workload: { plannedActions: number; visits: number; calls: number; proposals: number; followUps: number; capacityStatus: "balanced" | "light" | "overloaded" };
  visitRadiusKm?: number;
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

const capacityLabel: Record<WeeklyPlan["workload"]["capacityStatus"], string> = {
  balanced: "Carga equilibrada",
  light: "Carga leve",
  overloaded: "Carga alta"
};

// Horários e datas sempre no relógio de Brasília, qualquer que seja o fuso do aparelho.
const formatHour = (value: string) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(value));
const formatDay = (date: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`));

type ScheduleDraft = { key: string; fromDate: string; action: PlanningAction; date: string; time: string; durationMinutes: number };

type ScheduleDialogProps = { draft: ScheduleDraft; saving: boolean; onChange: (draft: ScheduleDraft) => void; onCancel: () => void; onConfirm: () => void };

// Janela do "Agendar": dia, horário e duração da sugestão já preenchidos e editáveis; nada é gravado sem Confirmar.
function ScheduleDialog({ draft, saving, onChange, onCancel, onConfirm }: ScheduleDialogProps) {
  const valid = Boolean(draft.date && draft.time && draft.durationMinutes > 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title">
      <form
        className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl"
        onSubmit={(event) => { event.preventDefault(); if (valid && !saving) onConfirm(); }}
      >
        <h3 id="schedule-dialog-title" className="text-base font-semibold text-slate-900">Agendar compromisso</h3>
        <p className="mt-1 text-sm text-slate-600">{draft.action.title}</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="col-span-2 block text-sm font-medium text-slate-700">
            Dia
            <input type="date" required value={draft.date} onChange={(event) => onChange({ ...draft, date: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Horário
            <input type="time" required value={draft.time} onChange={(event) => onChange({ ...draft, time: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Duração (min)
            <input type="number" required min={5} step={5} value={draft.durationMinutes || ""} onChange={(event) => onChange({ ...draft, durationMinutes: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">Horário de Brasília.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">Cancelar</button>
          <button type="submit" disabled={!valid || saving} className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60">{saving ? "Agendando…" : "Confirmar"}</button>
        </div>
      </form>
    </div>
  );
}

type ActionCardProps = { action: PlanningAction; date: string; sellerId: string; canAct: boolean; scheduling: boolean; onSchedule: () => void };

function ActionCard({ action, date, sellerId, canAct, scheduling, onSchedule }: ActionCardProps) {
  const open = openHref(action);
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Sugerido</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClass[action.priorityLevel]}`}>{action.priorityLevel} · {action.score} pontos</span>
        <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{actionLabel[action.type]}</span>
        {action.outsideTerritory ? <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Fora do território</span> : null}
      </div>
      <h4 className="mt-2 text-sm font-semibold text-slate-900">{action.title}</h4>
      <p className="mt-1 text-xs text-slate-600"><strong>Motivo:</strong> {action.reason}</p>
      <p className="mt-1 text-xs text-slate-600"><strong>Objetivo:</strong> {action.objective}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-medium text-slate-500">
        <span>{action.city || "Cidade não informada"}</span>
        <span>{action.suggestedPeriod === "morning" ? "Manhã" : action.suggestedPeriod === "afternoon" ? "Tarde" : "Período flexível"}</span>
        <span>{action.estimatedDurationMinutes} min</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canAct ? (
          <>
            <button type="button" onClick={onSchedule} disabled={scheduling} className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-800 disabled:opacity-60">{scheduling ? "Agendando…" : "Agendar"}</button>
            <Link to={registerHref(action, date, sellerId)} className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Registrar</Link>
          </>
        ) : null}
        {open ? <Link to={open} className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Abrir</Link> : null}
      </div>
    </article>
  );
}

// Abre o Google Maps (app no celular) com a rota; sem chave e sem mapa embutido.
function RouteLinks({ links }: { links?: string[] }) {
  if (!links?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((link, index) => (
        <a key={link} href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-slate-50">
          {links.length === 1 ? "Ver rota do dia" : `Rota ${index + 1}/${links.length}`}
        </a>
      ))}
    </div>
  );
}

export default function WeeklyCommercialPlan({ sellerId, weekStart }: Props) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [schedulingKey, setSchedulingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const params = useMemo(() => ({ ...(sellerId ? { sellerId } : {}), ...(weekStart ? { weekStart } : {}) }), [sellerId, weekStart]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    api.get("/ai/commercial-planning/week", { params, signal: controller.signal, timeout: AI_REQUEST_TIMEOUT_MS })
      .then((response) => {
        if (!active) return;
        setPlan(response.data);
        // Abre o primeiro dia com sugestões (hoje em diante); dias que já passaram só têm compromissos.
        const days: PlanningDay[] = response.data?.days ?? [];
        setOpenDay((days.find((day) => day.suggestedActions.length) ?? days[0])?.date ?? null);
      })
      .catch(() => active && setPlan(null))
      .finally(() => active && setLoading(false));
    return () => { active = false; controller.abort(); };
  }, [params]);

  const canAct = Boolean(plan && canActOnPlan(user, plan.sellerId));

  const openSchedule = (date: string, action: PlanningAction, key: string) =>
    setDraft({ key, fromDate: date, action, date, time: defaultScheduleTime(action), durationMinutes: action.estimatedDurationMinutes });

  // O compromisso criado sai das sugestões e entra como "Já agendado" no dia escolhido; a API também não sugere de novo.
  const schedule = async ({ key, fromDate, action, date, time, durationMinutes }: ScheduleDraft) => {
    if (!plan) return;
    setSchedulingKey(key);
    try {
      const response = await api.post("/agenda/events", toAgendaEvent(action, date, plan.sellerId, time, durationMinutes));
      const created = response.data as Appointment;
      setPlan((current) => current && {
        ...current,
        days: current.days.map((day) => ({
          ...day,
          existingAppointments: day.date === date
            ? [...day.existingAppointments, { id: created.id, title: created.title || action.title, startsAt: created.startsAt, endsAt: created.endsAt, city: created.city ?? action.city ?? null, type: created.type }]
            : day.existingAppointments,
          suggestedActions: day.date === fromDate ? day.suggestedActions.filter((item) => item !== action) : day.suggestedActions
        }))
      });
      setDraft(null);
      toast.success("Compromisso agendado.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível agendar a sugestão."));
    } finally {
      setSchedulingKey(null);
    }
  };

  const renderActions = (day: PlanningDay) => day.suggestedActions.map((action, index) => {
    const key = `${day.date}-${action.clientId || action.opportunityId || index}`;
    return <ActionCard key={key} action={action} date={day.date} sellerId={plan!.sellerId} canAct={canAct} scheduling={schedulingKey === key} onSchedule={() => openSchedule(day.date, action, key)} />;
  });

  if (loading) return <section className="rounded-xl border bg-white p-4 text-sm text-slate-500">Carregando planejamento comercial inteligente…</section>;
  if (!plan) return <section className="rounded-xl border bg-white p-4 text-sm text-slate-500">Planejamento comercial indisponível no momento.</section>;

  return (
    <section className="space-y-3 rounded-xl border bg-white p-3 shadow-sm sm:p-4" aria-label="Planejamento Comercial Inteligente">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Planejamento Comercial Inteligente</p>
          <h3 className="text-lg font-semibold text-slate-900">Próximos dias úteis: {formatDay(plan.weekStart)} a {formatDay(plan.weekEnd)}</h3>
          <p className="mt-1 text-sm text-slate-600">{plan.summary}</p>
          {plan.visitRadiusKm ? <p className="mt-1 text-xs text-slate-500">Visitas do mesmo dia em cidades a até {plan.visitRadiusKm} km uma da outra (em linha reta).</p> : null}
        </div>
        <span className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600">{plan.source === "ai" ? "Sugestão da IA" : "Sugestão do sistema"}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.plannedActions}</strong><br />ações</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.visits}</strong><br />visitas</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.calls}</strong><br />contatos</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{plan.workload.proposals}</strong><br />propostas</span>
        <span className="rounded-lg bg-slate-50 p-2"><strong>{capacityLabel[plan.workload.capacityStatus]}</strong><br />capacidade</span>
      </div>

      <div className="hidden gap-3 lg:grid lg:grid-cols-5">
        {plan.days.map((day) => (
          <div key={day.date} className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <h4 className="text-sm font-semibold text-slate-900">{day.label}</h4>
            <p className="text-[11px] text-slate-500">{formatDay(day.date)}</p>
            <RouteLinks links={day.routeLinks} />
            {day.existingAppointments.map((appointment) => <div key={appointment.id} className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900"><strong>Já agendado</strong><br />{formatHour(appointment.startsAt)} · {appointment.title}</div>)}
            {renderActions(day)}
          </div>
        ))}
      </div>

      <div className="space-y-2 lg:hidden">
        {plan.days.map((day) => (
          <details key={day.date} open={openDay === day.date} onToggle={(event) => (event.currentTarget.open ? setOpenDay(day.date) : null)} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">{day.label} {formatDay(day.date)} · {day.suggestedActions.length} ações · {day.existingAppointments.length} agendado(s)</summary>
            <div className="mt-2 space-y-2">
              <RouteLinks links={day.routeLinks} />
              {day.existingAppointments.map((appointment) => <div key={appointment.id} className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900"><strong>Já agendado</strong><br />{formatHour(appointment.startsAt)} · {appointment.title}</div>)}
              {renderActions(day)}
            </div>
          </details>
        ))}
      </div>
      {draft ? <ScheduleDialog draft={draft} saving={schedulingKey === draft.key} onChange={setDraft} onCancel={() => setDraft(null)} onConfirm={() => void schedule(draft)} /> : null}
    </section>
  );
}
