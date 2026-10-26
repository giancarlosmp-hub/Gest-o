import { FormEvent, useState, type ReactNode } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import { brazilDayKeyOf, brazilTimeKey, brazilTodayKey } from "../../lib/brazilDate";
import { AGENDA_NOT_DONE_REASONS, NOT_DONE_DESCRIPTION_MAX_LENGTH } from "@salesforce-pro/shared";
import { eventDurationMinutes, notDoneFormError, notDonePayload, reschedulePayload, type NotDoneForm } from "../../lib/agendaActivity";

// Janelas "Reagendar" e "Não realizado" de um compromisso, usadas pela Agenda e pelas Pendências de Atividades.

type DialogEvent = { id: string; type: string; title: string; startsAt: string; endsAt: string };

type DialogProps = {
  event: DialogEvent;
  onClose: () => void;
  onDone: () => void;
};

const fieldClassName = "w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm";
const labelClassName = "mb-1 block text-xs font-medium uppercase text-slate-500";

function DialogShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="mobile-modal-shell" onClick={onClose}>
      <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
            <p className="truncate text-sm text-slate-500">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50" aria-label="Fechar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function RescheduleDialog({ event, onClose, onDone }: DialogProps) {
  const isRoute = event.type === "roteiro_visita";
  const startsInPast = brazilDayKeyOf(event.startsAt) < brazilTodayKey();
  const [form, setForm] = useState({
    day: startsInPast ? brazilTodayKey() : brazilDayKeyOf(event.startsAt),
    time: brazilTimeKey(event.startsAt),
    durationMinutes: String(eventDurationMinutes(event))
  });
  const [saving, setSaving] = useState(false);

  const onSubmit = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    const payload = reschedulePayload(form, event);
    if ("error" in payload) {
      toast.error(payload.error);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/agenda/${event.id}`, payload);
      toast.success("Compromisso reagendado.");
      onDone();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível reagendar o compromisso."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell title="Reagendar compromisso" subtitle={event.title} onClose={onClose}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <div className="mobile-modal-body space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClassName} htmlFor="reschedule-day">Novo dia</label>
              <input id="reschedule-day" type="date" required min={brazilTodayKey()} value={form.day} onChange={(change) => setForm((current) => ({ ...current, day: change.target.value }))} className={fieldClassName} />
            </div>
            {isRoute ? null : (
              <>
                <div>
                  <label className={labelClassName} htmlFor="reschedule-time">Horário</label>
                  <input id="reschedule-time" type="time" required value={form.time} onChange={(change) => setForm((current) => ({ ...current, time: change.target.value }))} className={fieldClassName} />
                </div>
                <div>
                  <label className={labelClassName} htmlFor="reschedule-duration">Duração (min)</label>
                  <input id="reschedule-duration" type="number" min={1} required value={form.durationMinutes} onChange={(change) => setForm((current) => ({ ...current, durationMinutes: change.target.value }))} className={fieldClassName} />
                </div>
              </>
            )}
          </div>
          <p className="text-xs text-slate-500">{isRoute ? "O roteiro muda de dia e mantém as paradas." : "Horário de Brasília."}</p>
        </div>
        <div className="mobile-modal-footer">
          <button type="button" onClick={onClose} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
          <button type="submit" disabled={saving} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
            {saving ? "Salvando..." : "Reagendar"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export function NotDoneDialog({ event, onClose, onDone }: DialogProps) {
  const [form, setForm] = useState<NotDoneForm>({ reasonCode: "", description: "" });
  const [saving, setSaving] = useState(false);

  const onSubmit = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    const error = notDoneFormError(form);
    if (error) {
      toast.error(error);
      return;
    }
    setSaving(true);
    try {
      await api.post(`/agenda/events/${event.id}/not-done`, notDonePayload(form));
      toast.success("Compromisso marcado como não realizado.");
      onDone();
    } catch (requestError) {
      toast.error(getApiErrorMessage(requestError, "Não foi possível marcar o compromisso como não realizado."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell title="Não realizado" subtitle={event.title} onClose={onClose}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <div className="mobile-modal-body space-y-2">
          <label className={labelClassName} htmlFor="not-done-reason">Motivo (obrigatório)</label>
          <select
            id="not-done-reason"
            required
            value={form.reasonCode}
            onChange={(change) => setForm((current) => ({ ...current, reasonCode: change.target.value }))}
            className={fieldClassName}
          >
            <option value="">Escolha o motivo</option>
            {AGENDA_NOT_DONE_REASONS.map((reason) => <option key={reason.code} value={reason.code}>{reason.label}</option>)}
          </select>
          {form.reasonCode === "outro" ? (
            <>
              <label className={labelClassName} htmlFor="not-done-description">Descrição (obrigatória)</label>
              <textarea
                id="not-done-description"
                required
                maxLength={NOT_DONE_DESCRIPTION_MAX_LENGTH}
                value={form.description}
                onChange={(change) => setForm((current) => ({ ...current, description: change.target.value }))}
                placeholder="Descreva o que aconteceu"
                className="min-h-24 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </>
          ) : null}
        </div>
        <div className="mobile-modal-footer">
          <button type="button" onClick={onClose} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
          <button type="submit" disabled={saving} className="mobile-primary-button rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-800 disabled:opacity-70">
            {saving ? "Salvando..." : "Marcar não realizado"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
