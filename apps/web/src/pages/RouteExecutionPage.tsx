import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AGENDA_EVENT_TYPE_OPTIONS } from "@salesforce-pro/shared";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";
import { getApiErrorMessage } from "../lib/apiError";
import { brazilMonthKey, brazilTodayKey, formatBrazil, shiftBrazilDayKey } from "../lib/brazilDate";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import { NEXT_STEP_REQUIRED_MESSAGE, needsNextStepDecision, type NextStepMode } from "../lib/agendaActivity";
import {
  STOP_EXECUTION_STATUS_LABELS,
  STOP_NOT_DONE_REASONS,
  STOP_SUMMARY_MAX_LENGTH,
  initialStopResultForm,
  isRouteFinished,
  mapsAppHref,
  openStreetMapRouteHref,
  stopExecutionStatus,
  stopMapDestination,
  stopResultError,
  stopResultPayload,
  type StopExecutionStatus,
  type StopResultForm
} from "../lib/routeExecution";
import {
  ROUTE_STOP_QUEUE_CHANGE_EVENT,
  enqueueRouteStopAction,
  flushRouteStopQueue,
  isNetworkError,
  loadRouteStopQueue,
  pendingRouteStopActions,
  type RouteStopAction,
  type RouteStopGeo
} from "../lib/routeStopQueue";
import type { AgendaStop } from "../models/agenda";

// Executar roteiro: o vendedor faz check-in e check-out em cada parada e registra o resultado. Pensada para o celular;
// sem internet, check-in e check-out ficam guardados no aparelho e são enviados quando a conexão volta.

type RouteEvent = {
  id: string;
  title: string;
  type: string;
  status: string;
  startsAt: string;
  sellerId: string;
  stops: AgendaStop[];
};

type OpportunityOption = { id: string; title: string; stage: string; ownerSellerId?: string };

// Próximo passo vira compromisso na Agenda (catálogo único, sem roteiro).
const NEXT_STEP_TYPE_OPTIONS = AGENDA_EVENT_TYPE_OPTIONS.filter((option) => option.value !== "roteiro_visita");

const STATUS_CHIP_CLASS: Record<StopExecutionStatus, string> = {
  pendente: "border-slate-200 bg-slate-50 text-slate-700",
  em_visita: "border-sky-200 bg-sky-50 text-sky-800",
  realizada: "border-emerald-200 bg-emerald-50 text-emerald-800",
  nao_realizada: "border-rose-200 bg-rose-50 text-rose-800"
};

const fieldClassName = "w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm";
const labelClassName = "mb-1 block text-xs font-medium uppercase text-slate-500";

const formatTime = (value: string) => formatBrazil(value, { hour: "2-digit", minute: "2-digit" });

const isOpenStage = (stage: string) => stage !== "ganho" && stage !== "perdido";

// GPS do aparelho; sem permissão, sem sinal ou demorando, segue sem localização (nunca bloqueia).
const captureStopPosition = (timeoutMs = 8000): Promise<Omit<RouteStopGeo, "timestamp">> => {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          ...(Number.isFinite(position.coords.accuracy) && position.coords.accuracy > 0 ? { accuracy: position.coords.accuracy } : {})
        }),
      () => resolve({}),
      { timeout: timeoutMs, maximumAge: 60_000, enableHighAccuracy: true }
    );
  });
};

// Sem eventId (Central do Dia): o primeiro roteiro de hoje com paradas, de preferência um ainda em aberto.
const pickTodayRoute = (items: RouteEvent[]) => {
  const routes = items
    .filter((item) => item.type === "roteiro_visita" && item.stops?.length)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return routes.find((item) => !isRouteFinished(item.stops)) || routes[0] || null;
};

export default function RouteExecutionPage() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const userId = user?.id;
  const [routeEvent, setRouteEvent] = useState<RouteEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [queue, setQueue] = useState(() => loadRouteStopQueue(userId));
  const [busyStopId, setBusyStopId] = useState("");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [resultStop, setResultStop] = useState<AgendaStop | null>(null);
  const [resultForm, setResultForm] = useState<StopResultForm>(() => initialStopResultForm("realizada"));
  const [opportunities, setOpportunities] = useState<OpportunityOption[]>([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [savingResult, setSavingResult] = useState(false);
  const flushingRef = useRef(false);

  const loadRoute = useCallback(async () => {
    setLoadError("");
    try {
      if (eventId) {
        const response = await api.get(`/agenda/events/${eventId}`);
        setRouteEvent(response.data);
      } else {
        const today = brazilTodayKey();
        const response = await api.get("/agenda/events", { params: { from: today, to: today } });
        setRouteEvent(pickTodayRoute(Array.isArray(response.data?.items) ? response.data.items : []));
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      setLoadError(
        status === 403
          ? "Este roteiro é de outro vendedor."
          : status === 404
            ? "Roteiro não encontrado."
            : getApiErrorMessage(error, "Não foi possível carregar o roteiro.")
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    setLoading(true);
    void loadRoute();
  }, [loadRoute]);

  // Fila do aparelho: envia o que ficou guardado quando a conexão volta.
  const flushQueue = useCallback(async () => {
    if (!userId || flushingRef.current || !loadRouteStopQueue(userId).length) return;
    flushingRef.current = true;
    try {
      const result = await flushRouteStopQueue(userId, (item) => api.patch(`/agenda-events/${item.stopId}/${item.action}`, item.payload));
      if (result.sent.length) {
        toast.success("Check-in e check-out guardados foram enviados.");
        void loadRoute();
      }
      if (result.refused.length) {
        toast.error("O servidor recusou um check-in ou check-out guardado. Confira a parada.");
        void loadRoute();
      }
    } finally {
      flushingRef.current = false;
    }
  }, [userId, loadRoute]);

  useEffect(() => {
    const refresh = () => setQueue(loadRouteStopQueue(userId));
    const goOnline = () => {
      setIsOnline(true);
      void flushQueue();
    };
    const goOffline = () => setIsOnline(false);
    refresh();
    window.addEventListener(ROUTE_STOP_QUEUE_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    void flushQueue();
    // navigator.onLine nem sempre avisa a volta do sinal: tenta de novo a cada 30 s enquanto houver fila.
    const retry = window.setInterval(() => void flushQueue(), 30_000);
    return () => {
      window.removeEventListener(ROUTE_STOP_QUEUE_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.clearInterval(retry);
    };
  }, [userId, flushQueue]);

  const stops = useMemo(() => [...(routeEvent?.stops || [])].sort((left, right) => left.order - right.order), [routeEvent]);
  const resolvedCount = stops.filter((stop) => stop.resultStatus).length;
  const finished = isRouteFinished(stops);
  const nextStop = stops.find((stop) => !stop.resultStatus) || null;
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

  const patchStop = (stopId: string, patch: Partial<AgendaStop>) =>
    setRouteEvent((current) =>
      current ? { ...current, stops: current.stops.map((stop) => (stop.id === stopId ? { ...stop, ...patch } : stop)) } : current
    );

  const openResultForm = async (stop: AgendaStop, status: StopResultForm["status"]) => {
    setResultStop(stop);
    setResultForm(initialStopResultForm(status));
    setOpportunities([]);
    if (!stop.clientId) return;
    setLoadingOpportunities(true);
    try {
      const response = await api.get("/opportunities", { params: { clientId: stop.clientId } });
      const items: OpportunityOption[] = Array.isArray(response.data) ? response.data : Array.isArray(response.data?.items) ? response.data.items : [];
      // Oportunidades abertas do cliente da parada, do vendedor do roteiro.
      const open = items.filter((item) => isOpenStage(item.stage) && (!item.ownerSellerId || item.ownerSellerId === routeEvent?.sellerId));
      setOpportunities(open);
      setResultForm((current) => ({ ...current, opportunityId: initialStopResultForm(current.status, open).opportunityId }));
    } catch {
      setOpportunities([]);
    } finally {
      setLoadingOpportunities(false);
    }
  };

  // Check-in e check-out: hora do toque no botão e GPS se houver. Sem internet, ficam guardados no aparelho.
  const runStopAction = async (stop: AgendaStop, action: RouteStopAction) => {
    const pressedAt = new Date().toISOString();
    setBusyStopId(stop.id);
    const position = await captureStopPosition();
    const payload: RouteStopGeo = { ...position, timestamp: pressedAt };
    const withoutLocation = position.lat === undefined;
    try {
      const response = await api.patch(`/agenda-events/${stop.id}/${action}`, payload);
      patchStop(stop.id, response.data || {});
      if (action === "check-in") toast.success(withoutLocation ? "Check-in feito, sem localização." : "Check-in feito.");
      else toast.success("Check-out feito.");
    } catch (error) {
      if (isNetworkError(error) || (typeof navigator !== "undefined" && !navigator.onLine)) {
        enqueueRouteStopAction(userId, { stopId: stop.id, action, payload });
        toast.info("Sem conexão: guardado no aparelho. Será enviado quando a conexão voltar.");
      } else {
        toast.error(getApiErrorMessage(error, action === "check-in" ? "Não foi possível fazer o check-in." : "Não foi possível fazer o check-out."));
        setBusyStopId("");
        return;
      }
    }
    setBusyStopId("");
    if (action === "check-out") void openResultForm(stop, "realizada");
  };

  const closeResultForm = () => {
    setResultStop(null);
    setOpportunities([]);
  };

  const onSaveResult = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resultStop) return;
    const formError = stopResultError(resultForm, opportunities);
    if (formError) {
      toast.error(formError);
      return;
    }
    if (resultForm.status === "realizada" && pendingRouteStopActions(queue, resultStop.id).includes("check-in")) {
      toast.error("O check-in desta parada ainda não foi enviado. Aguarde a conexão para registrar a visita.");
      return;
    }
    setSavingResult(true);
    try {
      const response = await api.patch(`/agenda-events/${resultStop.id}/result`, stopResultPayload(resultForm));
      patchStop(resultStop.id, response.data || {});
      toast.success(resultForm.status === "realizada" ? "Visita registrada." : "Parada marcada como não realizada.");
      closeResultForm();
      triggerDashboardRefresh({ month: brazilMonthKey() });
      void loadRoute();
    } catch (error) {
      toast.error(
        isNetworkError(error)
          ? "Sem conexão. Registre o resultado quando a conexão voltar."
          : getApiErrorMessage(error, "Não foi possível salvar o resultado.")
      );
    } finally {
      setSavingResult(false);
    }
  };

  const chosenOpportunity = opportunities.find((item) => item.id === resultForm.opportunityId) || null;
  const opportunityOpen = Boolean(chosenOpportunity);
  const showNextStepWarning = resultForm.status === "realizada" && needsNextStepDecision(resultForm.nextStep, opportunityOpen);
  const setNextStep = (patch: Partial<StopResultForm["nextStep"]>) =>
    setResultForm((current) => ({ ...current, nextStep: { ...current.nextStep, ...patch } }));
  const chooseNextStepMode = (mode: NextStepMode) =>
    setNextStep({
      mode,
      ...(mode === "schedule" && !resultForm.nextStep.day ? { day: shiftBrazilDayKey(brazilTodayKey(), 1) } : {}),
      ...(mode === "schedule" && !resultForm.nextStep.time ? { time: "09:00" } : {})
    });

  if (loading) {
    return <div className="mx-auto max-w-2xl p-4 text-sm text-slate-500">Carregando roteiro...</div>;
  }

  if (loadError || !routeEvent) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-4">
        <h1 className="text-xl font-bold text-slate-900">Executar roteiro</h1>
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          {loadError || "Nenhum roteiro de visitas para hoje."}
        </p>
        <Link to="/agenda" className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">Voltar para a Agenda</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-24">
      <header className="space-y-2">
        <Link to="/agenda" className="text-sm font-medium text-brand-700">← Agenda</Link>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-bold text-slate-900">{routeEvent.title}</h1>
            <p className="text-sm text-slate-500">
              {formatBrazil(routeEvent.startsAt, { weekday: "long", day: "2-digit", month: "2-digit" })} · horário de Brasília
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
            {resolvedCount} de {stops.length} paradas
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-100" aria-hidden="true">
          <div className="h-2 rounded-full bg-emerald-600" style={{ width: `${stops.length ? (resolvedCount / stops.length) * 100 : 0}%` }} />
        </div>
      </header>

      {!isOnline || queue.length ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {!isOnline ? "Sem conexão. " : ""}
          {queue.length
            ? `${queue.length === 1 ? "1 registro guardado" : `${queue.length} registros guardados`} no aparelho, aguardando conexão para enviar.`
            : "Check-in e check-out ficam guardados no aparelho e são enviados quando a conexão voltar."}
        </p>
      ) : null}

      {finished ? (
        <section role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
          <h2 className="text-lg font-semibold text-emerald-900">Roteiro concluído</h2>
          <p className="text-sm text-emerald-800">
            {stops.filter((stop) => stop.resultStatus === "realizada").length} realizadas ·{" "}
            {stops.filter((stop) => stop.resultStatus === "nao_realizada").length} não realizadas.
          </p>
        </section>
      ) : null}

      <ol className="space-y-3">
        {stops.map((stop) => {
          const queued = pendingRouteStopActions(queue, stop.id);
          const status = stopExecutionStatus(stop, queued);
          const checkedOut = Boolean(stop.checkOutAt) || queued.includes("check-out");
          const destination = stopMapDestination(stop);
          const busy = busyStopId === stop.id;
          const isNext = nextStop?.id === stop.id;
          return (
            <li key={stop.id} className={`space-y-3 rounded-xl border bg-white p-4 shadow-sm ${isNext ? "border-brand-300" : "border-slate-200"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-slate-500">Parada {stop.order}{isNext ? " · próxima" : ""}</p>
                  <p className="break-words text-base font-semibold text-slate-900">{stop.clientName || "Cliente não informado"}</p>
                  <p className="break-words text-sm text-slate-600">{stop.city || "Cidade não informada"}{stop.address ? ` · ${stop.address}` : ""}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_CHIP_CLASS[status]}`}>
                  {STOP_EXECUTION_STATUS_LABELS[status]}
                </span>
              </div>

              {stop.checkInAt || stop.checkOutAt || queued.length ? (
                <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                  {stop.checkInAt ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">
                      Check-in {formatTime(stop.checkInAt)} · {stop.checkInLat != null && stop.checkInLng != null ? "com localização" : "sem localização"}
                    </span>
                  ) : null}
                  {stop.checkOutAt ? <span className="rounded-full bg-slate-100 px-2 py-0.5">Check-out {formatTime(stop.checkOutAt)}</span> : null}
                  {queued.length ? (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-900">Aguardando conexão</span>
                  ) : null}
                </div>
              ) : null}

              {stop.resultStatus === "realizada" && stop.resultSummary ? <p className="break-words text-sm text-slate-700">{stop.resultSummary}</p> : null}
              {stop.resultStatus === "nao_realizada" ? (
                <p className="text-sm text-rose-800">
                  Motivo: {STOP_NOT_DONE_REASONS.find((reason) => reason.value === stop.resultReason)?.label || "não informado"}
                  {stop.resultSummary ? ` · ${stop.resultSummary}` : ""}
                </p>
              ) : null}

              {!stop.resultStatus ? (
                <div className="grid grid-cols-2 gap-2">
                  {status === "pendente" ? (
                    <button type="button" disabled={busy} onClick={() => void runStopAction(stop, "check-in")} className="col-span-2 rounded-lg bg-brand-700 px-3 py-3 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60">
                      {busy ? "Registrando..." : "Fazer check-in"}
                    </button>
                  ) : checkedOut ? (
                    <button type="button" onClick={() => void openResultForm(stop, "realizada")} className="col-span-2 rounded-lg bg-emerald-700 px-3 py-3 text-sm font-semibold text-white hover:bg-emerald-800">
                      Registrar resultado
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => void runStopAction(stop, "check-out")} className="col-span-2 rounded-lg bg-emerald-700 px-3 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
                      {busy ? "Registrando..." : "Fazer check-out"}
                    </button>
                  )}
                  <button type="button" onClick={() => void openResultForm(stop, "nao_realizada")} className="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50">
                    Não realizada
                  </button>
                  {destination ? (
                    <a href={openStreetMapRouteHref(destination)} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50">
                      Rota no mapa
                    </a>
                  ) : (
                    <span className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-center text-xs text-slate-400">Sem endereço para o mapa</span>
                  )}
                  {destination ? (
                    <a href={mapsAppHref(destination, userAgent)} className="col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50 md:hidden">
                      Abrir no app de mapas
                    </a>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {resultStop ? (
        <div className="mobile-modal-shell" onClick={closeResultForm}>
          <div className="mobile-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">Resultado da parada</h3>
                <p className="truncate text-sm text-slate-500">{resultStop.clientName || "Cliente não informado"}</p>
              </div>
              <button type="button" onClick={closeResultForm} className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50" aria-label="Fechar">✕</button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSaveResult}>
              <div className="mobile-modal-body space-y-4">
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Resultado">
                  {[
                    { value: "realizada" as const, label: "Realizada" },
                    { value: "nao_realizada" as const, label: "Não realizada" }
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={resultForm.status === option.value}
                      onClick={() => setResultForm((current) => ({ ...current, status: option.value }))}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium ${resultForm.status === option.value ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {resultForm.status === "nao_realizada" ? (
                  <>
                    <div>
                      <label className={labelClassName} htmlFor="stop-reason">Motivo (obrigatório)</label>
                      <select id="stop-reason" required className={fieldClassName} value={resultForm.reason} onChange={(change) => setResultForm((current) => ({ ...current, reason: change.target.value }))}>
                        <option value="">Selecione</option>
                        {STOP_NOT_DONE_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="stop-not-done-detail">Detalhe (opcional)</label>
                      <textarea id="stop-not-done-detail" maxLength={STOP_SUMMARY_MAX_LENGTH} className={`${fieldClassName} min-h-20`} value={resultForm.summary} onChange={(change) => setResultForm((current) => ({ ...current, summary: change.target.value }))} />
                    </div>
                  </>
                ) : (
                  <>
                    {!resultStop.checkInAt && !pendingRouteStopActions(queue, resultStop.id).includes("check-in") ? (
                      <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">Faça o check-in na parada antes de registrar a visita como realizada.</p>
                    ) : null}
                    <div>
                      <label className={labelClassName} htmlFor="stop-summary">Resumo da visita (obrigatório)</label>
                      <textarea id="stop-summary" required maxLength={STOP_SUMMARY_MAX_LENGTH} className={`${fieldClassName} min-h-24`} value={resultForm.summary} onChange={(change) => setResultForm((current) => ({ ...current, summary: change.target.value }))} placeholder="O que foi tratado com o cliente" />
                    </div>
                    {loadingOpportunities ? <p className="text-xs text-slate-500">Carregando oportunidades do cliente...</p> : null}
                    {opportunities.length ? (
                      <div>
                        <label className={labelClassName} htmlFor="stop-opportunity">Oportunidade aberta{opportunities.length > 1 ? " (escolha uma)" : ""}</label>
                        <select id="stop-opportunity" required={opportunities.length > 1} className={fieldClassName} value={resultForm.opportunityId} onChange={(change) => setResultForm((current) => ({ ...current, opportunityId: change.target.value }))}>
                          {opportunities.length > 1 ? <option value="">Selecione</option> : null}
                          {opportunities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                      </div>
                    ) : null}
                    {opportunityOpen ? (
                      <fieldset className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-3" aria-labelledby="stop-next-step-title">
                        <div>
                          <legend id="stop-next-step-title" className="text-sm font-semibold text-sky-900">Próximo passo</legend>
                          <p className="text-xs text-sky-800">O próximo passo vira compromisso na Agenda. Obrigatório para oportunidade aberta.</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Próximo passo">
                          {[
                            { mode: "schedule" as const, label: "Agendar próximo passo" },
                            { mode: "none" as const, label: "Sem próximo passo" }
                          ].map((option) => (
                            <button
                              key={option.mode}
                              type="button"
                              role="radio"
                              aria-checked={resultForm.nextStep.mode === option.mode}
                              onClick={() => chooseNextStepMode(option.mode)}
                              className={`rounded-lg border px-3 py-2 text-sm font-medium ${resultForm.nextStep.mode === option.mode ? "border-sky-600 bg-sky-600 text-white" : "border-sky-200 bg-white text-sky-900 hover:bg-sky-100"}`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {resultForm.nextStep.mode === "schedule" ? (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                              <label className="text-sm" htmlFor="stop-next-step-type">Tipo</label>
                              <select id="stop-next-step-type" required className={fieldClassName} value={resultForm.nextStep.type} onChange={(change) => setNextStep({ type: change.target.value })}>
                                <option value="">Selecione</option>
                                {NEXT_STEP_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="text-sm" htmlFor="stop-next-step-day">Dia</label>
                              <input id="stop-next-step-day" type="date" required min={brazilTodayKey()} className={fieldClassName} value={resultForm.nextStep.day} onChange={(change) => setNextStep({ day: change.target.value })} />
                            </div>
                            <div>
                              <label className="text-sm" htmlFor="stop-next-step-time">Horário (Brasília)</label>
                              <input id="stop-next-step-time" type="time" required className={fieldClassName} value={resultForm.nextStep.time} onChange={(change) => setNextStep({ time: change.target.value })} />
                            </div>
                            <div>
                              <label className="text-sm" htmlFor="stop-next-step-duration">Duração (min)</label>
                              <input id="stop-next-step-duration" type="number" min={1} required className={fieldClassName} value={resultForm.nextStep.durationMinutes} onChange={(change) => setNextStep({ durationMinutes: change.target.value })} />
                            </div>
                          </div>
                        ) : null}
                        {resultForm.nextStep.mode === "none" ? (
                          <div>
                            <label className="text-sm" htmlFor="stop-no-next-step-reason">Por que não há próximo passo? (obrigatório)</label>
                            <textarea id="stop-no-next-step-reason" required className={fieldClassName} value={resultForm.nextStep.reason} onChange={(change) => setNextStep({ reason: change.target.value })} placeholder="Ex.: cliente só decide na próxima safra" />
                          </div>
                        ) : null}
                        {showNextStepWarning ? (
                          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">{NEXT_STEP_REQUIRED_MESSAGE}</p>
                        ) : null}
                      </fieldset>
                    ) : null}
                  </>
                )}
              </div>
              <div className="mobile-modal-footer">
                <button type="button" onClick={closeResultForm} className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
                <button type="submit" disabled={savingResult || loadingOpportunities} className="mobile-primary-button rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70">
                  {savingResult ? "Salvando..." : "Salvar resultado"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
