import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Aparelho em outro fuso: tudo abaixo precisa continuar em horário de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { AGENDA_EVENT_TYPE_LABELS } = await import("@salesforce-pro/shared");
const { ACTIVITY_CATALOG_OPTIONS, ACTIVITY_TYPE_OPTIONS, toLabel } = await import("../src/constants/activityTypes");
const {
  brazilDateTime,
  brazilDayKeyOf,
  brazilMinutesOfDay,
  brazilTimeKey,
  brazilWeekday,
  formatBrazil,
  fromBrazilDateTimeInput,
  shiftBrazilDayKey,
  toBrazilDateTimeInput
} = await import("../src/lib/brazilDate");
const {
  activityDateTimeDefaults,
  activityFormError,
  activityTypeForAgendaType,
  agendaEventActions,
  completeAgendaEventHref,
  needsNextStepDecision,
  NEXT_STEP_REQUIRED_MESSAGE,
  nextStepPayload,
  agendaNotDoneReasonText,
  notDoneFormError,
  notDonePayload,
  reschedulePayload
} = await import("../src/lib/agendaActivity");

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const activitiesPage = source("../src/pages/ActivitiesPage.tsx");
const agendaPage = source("../src/pages/AgendaPage.tsx");
const dialogs = source("../src/components/agenda/AgendaEventDialogs.tsx");

// 24/10/2026 às 10:30 em Brasília (13:30 UTC, 22:30 em Tóquio).
const now = new Date("2026-10-24T13:30:00.000Z");
assert.equal(now.getHours(), 22, "o teste roda com o aparelho em Tóquio");

const noNextStep = { mode: "" as const, type: "", day: "", time: "", durationMinutes: "30", reason: "" };
const baseForm = { day: "2026-10-24", time: "10:00", summary: "Cliente ficticio pediu proposta", opportunityOpen: false, nextStep: noNextStep };

// --- Fuso: aparelho em Tóquio mostra e grava horário de Brasília ---
assert.equal(brazilTimeKey(now), "10:30");
assert.equal(brazilDayKeyOf(now), "2026-10-24");
assert.equal(brazilDayKeyOf("2026-10-25T02:30:00.000Z"), "2026-10-24", "23:30 de Brasília ainda é o mesmo dia");
assert.equal(brazilMinutesOfDay("2026-10-24T12:00:00.000Z"), 9 * 60, "compromisso das 9h fica na linha das 9h do calendário");
assert.equal(fromBrazilDateTimeInput("2026-10-24T09:00").toISOString(), "2026-10-24T12:00:00.000Z");
assert.equal(toBrazilDateTimeInput("2026-10-24T12:00:00.000Z"), "2026-10-24T09:00");
assert.equal(formatBrazil("2026-10-24T12:00:00.000Z", { hour: "2-digit", minute: "2-digit" }), "09:00");
assert.equal(brazilWeekday("2026-10-24"), 6, "24/10/2026 é sábado");
assert.equal(shiftBrazilDayKey("2026-10-31", 1), "2026-11-01");
assert.equal(shiftBrazilDayKey("2026-03-01", -1), "2026-02-28");

// A Agenda não usa mais o fuso do aparelho (calendário, lista, campos, dia).
for (const pattern of [/\.getHours\(\)/, /\.getDate\(\)/, /\.getDay\(\)/, /setDate\(/, /toLocaleDateString\(/, /toLocaleTimeString\(/, /new Date\(createForm\.startDateTime\)/]) {
  assert.doesNotMatch(agendaPage, pattern, `AgendaPage não deve usar ${pattern}`);
}
assert.match(agendaPage, /fromBrazilDateTimeInput\(createForm\.startDateTime\)/, "início do compromisso lido em Brasília");

// --- Registrar visita de ontem grava a data de ontem ---
const yesterday = activityDateTimeDefaults("2026-10-23", now);
assert.deepEqual(yesterday, { day: "2026-10-23", time: "10:30" });
assert.equal(brazilDateTime(yesterday.day, "15:00").toISOString(), "2026-10-23T18:00:00.000Z");
assert.equal(activityFormError({ ...baseForm, day: "2026-10-23", time: "15:00" }, now), null, "ontem é aceito");
assert.match(activitiesPage, /const activityAt = brazilDateTime\(form\.dueDate, form\.time\)\.toISOString\(\);/);
assert.match(activitiesPage, /dueDate: activityAt,\n\s+date: activityAt,/, "date e dueDate gravam o dia e horário escolhidos");
assert.doesNotMatch(activitiesPage, /date: requiresExecutionFields \? new Date\(\)\.toISOString\(\)/, "não grava mais o momento atual");
// Valor vindo da Agenda (instante) usa o dia e horário de Brasília do compromisso; o futuro vira agora.
assert.deepEqual(activityDateTimeDefaults("2026-10-23T19:00:00.000Z", now), { day: "2026-10-23", time: "16:00" });
assert.deepEqual(activityDateTimeDefaults("2026-10-24T18:00:00.000Z", now), { day: "2026-10-24", time: "10:30" });
assert.deepEqual(activityDateTimeDefaults("2026-10-25", now), { day: "2026-10-24", time: "10:30" });
assert.deepEqual(activityDateTimeDefaults(null, now), { day: "2026-10-24", time: "10:30" });

// --- Data futura bloqueada na tela ---
const futureMessage = "A data da atividade não pode ser futura. Para planejar, use o próximo passo ou a Agenda.";
assert.equal(activityFormError({ ...baseForm, day: "2026-10-25" }, now), futureMessage);
assert.equal(activityFormError({ ...baseForm, time: "11:00" }, now), futureMessage, "hoje, mas mais tarde que agora");
assert.match(activitiesPage, /id="activity-day" type="date" required max=\{brazilTodayKey\(\)\}/);
assert.equal(activityFormError({ ...baseForm, summary: "  " }, now), "Preencha o resumo do que foi feito.");

// --- Oportunidade aberta sem próximo passo mostra aviso antes de salvar ---
const open = { ...baseForm, opportunityOpen: true };
assert.equal(needsNextStepDecision(noNextStep, true), true);
assert.equal(activityFormError(open, now), NEXT_STEP_REQUIRED_MESSAGE);
assert.equal(activityFormError({ ...open, nextStep: { ...noNextStep, mode: "none", reason: "x" } }, now), NEXT_STEP_REQUIRED_MESSAGE, "motivo curto demais");
assert.equal(activityFormError({ ...open, nextStep: { ...noNextStep, mode: "none", reason: "Decide na safra" } }, now), null);
const scheduled = { mode: "schedule" as const, type: "ligacao", day: "2026-10-26", time: "09:00", durationMinutes: "30", reason: "" };
assert.equal(activityFormError({ ...open, nextStep: scheduled }, now), null);
assert.equal(activityFormError({ ...open, nextStep: { ...scheduled, day: "2026-10-23" } }, now), "O próximo passo não pode ficar em dia passado.");
assert.equal(activityFormError({ ...open, nextStep: { ...scheduled, time: "" } }, now), "Para o próximo passo, informe o tipo, o dia e o horário.");
assert.equal(needsNextStepDecision(noNextStep, false), false, "sem oportunidade aberta o próximo passo é opcional");
assert.deepEqual(nextStepPayload(scheduled), { type: "ligacao", startsAt: "2026-10-26T12:00:00.000Z", endsAt: "2026-10-26T12:30:00.000Z" });
assert.match(activitiesPage, /\{showNextStepWarning \? \(\s*<p role="alert"/, "aviso aparece no formulário, antes de salvar");

// --- Concluir / Reagendar / Não realizado (Agenda e Pendências) ---
const planned = { id: "evt-ficticio", type: "visita", title: "Visita ficticia", status: "planned" as const, startsAt: "2026-10-22T13:00:00.000Z", endsAt: "2026-10-22T14:00:00.000Z", ownerId: "seller-ficticio", clientId: "cli-ficticio", opportunityId: "opp-ficticia", notes: null, city: "Cidade Ficticia" };
assert.deepEqual(agendaEventActions(planned, "vendedor"), { complete: true, reschedule: true, notDone: true, reopen: false, remove: false });
assert.equal(agendaEventActions({ ...planned, type: "roteiro_visita" }, "vendedor").complete, false, "roteiro é concluído pelas paradas");
assert.deepEqual(agendaEventActions({ ...planned, status: "completed" }, "vendedor"), { complete: false, reschedule: false, notDone: false, reopen: false, remove: false });

const href = new URL(completeAgendaEventHref(planned), "http://web.invalid");
assert.equal(href.pathname, "/atividades");
assert.deepEqual(Object.fromEntries(href.searchParams), {
  open: "create",
  date: planned.startsAt,
  type: "visita",
  ownerSellerId: "seller-ficticio",
  notes: "Visita ficticia",
  title: "Visita ficticia",
  agendaEventId: "evt-ficticio",
  clientId: "cli-ficticio",
  opportunityId: "opp-ficticia",
  city: "Cidade Ficticia"
});
assert.match(activitiesPage, /api\.post\(`\/agenda\/events\/\$\{form\.agendaEventId\}\/complete`, payload\)/, "registro vinculado conclui o compromisso");
assert.match(agendaPage, /navigate\(completeAgendaEventHref\(/, "Concluir da Agenda abre o registro vinculado");
assert.match(activitiesPage, /completeAgendaEventHref\(item\)/, "Concluir das Pendências abre o registro vinculado");

assert.deepEqual(reschedulePayload({ day: "2026-10-27", time: "14:00", durationMinutes: "45" }, planned, now), { startDateTime: "2026-10-27T17:00:00.000Z", endDateTime: "2026-10-27T17:45:00.000Z" });
assert.deepEqual(reschedulePayload({ day: "2026-10-23", time: "14:00", durationMinutes: "45" }, planned, now), { error: "Escolha hoje ou um dia futuro." });
const route = { type: "roteiro_visita", startsAt: "2026-10-22T03:00:00.000Z", endsAt: "2026-10-23T02:59:59.999Z" };
assert.deepEqual(reschedulePayload({ day: "2026-10-28", time: "", durationMinutes: "" }, route, now), { startDateTime: "2026-10-28T03:00:00.000Z", endDateTime: "2026-10-29T02:59:59.999Z" });
assert.match(dialogs, /api\.patch\(`\/agenda\/\$\{event\.id\}`, payload\)/);

// "Não realizado": motivo do catálogo; "outro" exige descrição; texto livre antigo aparece como "Outro".
assert.equal(notDoneFormError({ reasonCode: "", description: "" }), "Escolha o motivo de não ter sido realizado.");
assert.equal(notDoneFormError({ reasonCode: "outro", description: " " }), 'Descreva o motivo em "Outro".');
assert.equal(notDoneFormError({ reasonCode: "outro", description: "Motivo ficticio" }), null);
for (const code of ["cliente_ausente", "cliente_remarcou", "clima_estrada", "veiculo", "demanda_urgente", "falta_tempo"]) {
  assert.equal(notDoneFormError({ reasonCode: code, description: "" }), null, code);
  assert.deepEqual(notDonePayload({ reasonCode: code, description: "ignorada" }), { reasonCode: code }, `${code} sem descrição`);
}
assert.deepEqual(notDonePayload({ reasonCode: "outro", description: "  Motivo ficticio " }), { reasonCode: "outro", description: "Motivo ficticio" });
assert.equal(agendaNotDoneReasonText("falta_tempo"), "Atraso na rota / faltou tempo");
assert.equal(agendaNotDoneReasonText("outro: Motivo ficticio"), "Outro (Motivo ficticio)");
assert.equal(agendaNotDoneReasonText("Cliente ficticio desmarcou"), "Outro (Cliente ficticio desmarcou)", "texto livre antigo");
assert.equal(agendaNotDoneReasonText(null), null);
assert.match(dialogs, /api\.post\(`\/agenda\/events\/\$\{event\.id\}\/not-done`, notDonePayload\(form\)\)/);
assert.match(dialogs, /AGENDA_NOT_DONE_REASONS\.map/, "o diálogo lista o catálogo");
assert.match(agendaPage, /agendaNotDoneReasonText\(selectedEvent\.notDoneReason\)/, "a Agenda mostra o motivo pelo catálogo");
const executionReport = source("../src/pages/CommercialExecutionReportPage.tsx");
assert.match(executionReport, /Não realizado por motivo/, "o relatório gerencial mostra a contagem por motivo");
assert.match(executionReport, /AGENDA_NOT_DONE_REASONS\.map/, "colunas na ordem do catálogo");
assert.match(executionReport, /reasonCount\(seller\.notDoneByReason, reason\.code\)/, "contagem por vendedor");
assert.match(executionReport, /reasonCount\(report\.notDoneByReason, reason\.code\)/, "total da equipe");
for (const [name, page] of [["AgendaPage", agendaPage], ["ActivitiesPage", activitiesPage]] as const) {
  assert.match(page, /<RescheduleDialog/, `${name} usa o Reagendar compartilhado`);
  assert.match(page, /<NotDoneDialog/, `${name} usa o Não realizado compartilhado`);
}
assert.match(activitiesPage, /api\.get\("\/agenda\/pending"/, "Pendências vêm de GET /agenda/pending");
assert.match(activitiesPage, /compromissos antigos sem conclusão/);

// --- Vendedor não vê Reabrir nem Excluir; gerente e diretor veem ---
for (const role of ["gerente", "diretor"]) {
  assert.equal(agendaEventActions({ ...planned, status: "completed" }, role).reopen, true, `${role} reabre`);
  assert.equal(agendaEventActions(planned, role).remove, true, `${role} exclui`);
}
assert.equal(agendaEventActions({ ...planned, status: "not_done" }, "vendedor").reopen, false);
assert.match(agendaPage, /selectedEventActions\?\.reopen \?/);
assert.match(agendaPage, /selectedEventActions\?\.remove \?/);

// --- Atividade é passado: sem Reagendar nem Duplicar; funções antigas sem botão saíram da Agenda ---
assert.doesNotMatch(activitiesPage, /Duplicar|openDuplicateModal|openRescheduleModal/);
for (const removed of ["onDuplicateForNextDay", "openFollowUpModal", "onSubmitFollowUp", "openQuickOpportunityModal", "Criar follow-up"]) {
  assert.ok(!agendaPage.includes(removed), `AgendaPage não deve ter ${removed}`);
}

// --- Catálogo único; legados só na exibição ---
assert.deepEqual(ACTIVITY_CATALOG_OPTIONS.map((option) => option.label), ["Ligação", "WhatsApp", "Visita", "Reunião online", "Reunião presencial", "Proposta", "Fechamento"]);
assert.match(activitiesPage, /\{ACTIVITY_CATALOG_OPTIONS\.map\(\(activityType\) => \(\n\s+<option key=\{activityType\.value\} value=\{activityType\.value\}>\n\s+\{activityType\.label\}/, "Nova atividade só oferece o catálogo");
assert.equal(toLabel("followup"), "Follow-up");
assert.equal(toLabel("visita_tecnica"), "Visita técnica (legado)");
assert.equal(toLabel("proposta_negociacao"), "Proposta em negociação");
assert.equal(toLabel("follow_up"), "Follow-up", "nome antigo também é exibido");
assert.ok(ACTIVITY_TYPE_OPTIONS.some((option) => option.value === "followup"), "filtro do histórico mantém os tipos legados");
assert.equal(AGENDA_EVENT_TYPE_LABELS.followup, "Follow-up", "compromisso antigo de follow-up é exibido");
assert.equal(activityTypeForAgendaType("followup"), "ligacao", "Concluir de compromisso legado oferece Ligação");
assert.equal(activityTypeForAgendaType("proposta"), "proposta_enviada");
assert.equal(activityTypeForAgendaType("roteiro_visita"), "visita");

console.log("agendaActivity tests passed");
