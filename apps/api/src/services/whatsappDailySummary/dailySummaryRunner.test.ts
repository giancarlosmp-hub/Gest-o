import assert from "node:assert/strict";
import { DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG, type WhatsAppDailySummaryConfig, type WhatsAppDailySummaryRunState, type WhatsAppDailySummarySellerDay } from "@salesforce-pro/shared";
import type { CrmUserRecipient, CrmUserRecipientResolution } from "../whatsappConnection/crmUserRecipient.js";
import { EvolutionUnavailableError, type EvolutionSendResult } from "../whatsappConnection/evolutionClient.js";
import { brazilClock, parseDailySummaryConfig, sendTimeMinutes, type DailySummaryStore } from "./dailySummaryConfig.js";
import { MAX_ATTEMPTS, MAX_EXTRA_INTERVAL_MS, MIN_INTERVAL_MS, runDailySummaryTick, type DailySummaryRunnerDeps } from "./dailySummaryRunner.js";
import { checkDailySummarySender, sendDailySummaryText } from "./dailySummarySender.js";

// WhatsApp Fase D: rodada do resumo diário com dependências falsas. Só dados fictícios.

// Relógio de Brasília e configuração.
assert.deepEqual(brazilClock(new Date("2026-11-09T10:30:00.000Z")), { dayKey: "2026-11-09", minutes: 450, weekday: 1 });
assert.deepEqual(brazilClock(new Date("2026-11-10T02:59:00.000Z")), { dayKey: "2026-11-09", minutes: 23 * 60 + 59, weekday: 1 });
assert.equal(sendTimeMinutes("07:30"), 450);
assert.deepEqual(parseDailySummaryConfig(null), DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG);
assert.deepEqual(parseDailySummaryConfig("{quebrado"), DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG);
assert.deepEqual(parseDailySummaryConfig(JSON.stringify({ enabled: true, sendTime: "25:00" })), DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG, "horário inválido volta ao padrão");
assert.deepEqual(
  parseDailySummaryConfig(JSON.stringify({ enabled: true, sendTime: "08:15", senderUserId: "manager-x", sections: { todayFollowUps: false } })),
  { enabled: true, sendTime: "08:15", senderUserId: "manager-x", sections: { ...DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG.sections, todayFollowUps: false } }
);

const MONDAY_0730 = new Date("2026-11-09T10:30:00.000Z");
const at = (iso: string) => new Date(iso);

type Harness = ReturnType<typeof harness>;
function harness(options: { texts?: Record<string, string | null>; refusals?: Record<string, CrmUserRecipientResolution & { ok: false }>; results?: Record<string, EvolutionSendResult[]> } = {}) {
  const config: WhatsAppDailySummaryConfig = { ...DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG, enabled: true, senderUserId: "manager-x" };
  const sellers = [
    { id: "manager-x", name: "Gerente Remetente" },
    { id: "seller-a", name: "Vendedor Ficticio A" },
    { id: "seller-b", name: "Vendedor Ficticio B" },
    { id: "seller-c", name: "Vendedor Ficticio C" },
    { id: "seller-d", name: "Vendedor Ficticio D" },
    { id: "seller-e", name: "Vendedor Ficticio E" }
  ];
  const texts: Record<string, string | null> = { "seller-b": null, ...(options.texts ?? {}) };
  const days = new Map<string, WhatsAppDailySummarySellerDay>();
  let run: WhatsAppDailySummaryRunState | null = null;
  const sends: Array<{ instance: string; userId: string; phone: string; text: string }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const calls = { listSellers: 0, checkSender: 0, cleanup: 0, createConflicts: new Set<string>() };
  const results = options.results ?? {};
  let sender: Awaited<ReturnType<DailySummaryRunnerDeps["checkSender"]>> = { ok: true, userId: "manager-x", instanceName: "crm-instancia-ficticia" };
  let available = true;

  const store: DailySummaryStore = {
    async getSellerDays(dayKey, ids) {
      return new Map(ids.flatMap((id) => (days.has(`${dayKey}.${id}`) ? [[id, { ...days.get(`${dayKey}.${id}`)! }] as const] : [])));
    },
    async createSellerDay(dayKey, id, state) {
      if (calls.createConflicts.has(id) || days.has(`${dayKey}.${id}`)) return false;
      days.set(`${dayKey}.${id}`, { ...state });
      return true;
    },
    async updateSellerDay(dayKey, id, state) {
      assert(days.has(`${dayKey}.${id}`), "update só de linha existente");
      days.set(`${dayKey}.${id}`, { ...state });
    },
    async getRunState() {
      return run;
    },
    async setRunState(state) {
      run = state;
    },
    async cleanup() {
      calls.cleanup += 1;
      return 0;
    }
  };

  const deps: DailySummaryRunnerDeps = {
    isAvailable: () => available,
    loadConfig: async () => config,
    listSellers: async () => (calls.listSellers++, sellers),
    checkSender: async () => (calls.checkSender++, sender),
    buildText: async (seller) => (seller.id in texts ? texts[seller.id] : `Resumo ficticio de ${seller.name}`),
    resolveRecipient: async (userId) =>
      options.refusals?.[userId] ?? { ok: true, recipient: { userId, phone: `55119000001${userId.slice(-1).charCodeAt(0) % 100}` } as CrmUserRecipient },
    send: async (instance, recipient, text) => {
      sends.push({ instance, userId: recipient.userId, phone: recipient.phone, text });
      return results[recipient.userId]?.shift() ?? { kind: "sent" };
    },
    store,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    log: (level, message, data) => void logs.push(JSON.stringify({ level, message, data }))
  };
  return {
    config,
    days,
    sends,
    sleeps,
    logs,
    calls,
    deps,
    get run() {
      return run;
    },
    day: (id: string, dayKey = "2026-11-09") => days.get(`${dayKey}.${id}`),
    setSender: (value: typeof sender) => void (sender = value),
    setAvailable: (value: boolean) => void (available = value)
  };
}

const assertCleanLogs = (h: Harness) => {
  const all = h.logs.join("\n");
  assert.doesNotMatch(all, /Vendedor|Gerente|Resumo ficticio|seller-|manager-|crm-instancia|5511/, "log sem nomes, texto, ids ou números");
};

// 1) Desligado, WhatsApp fora, fim de semana, antes do horário: nada acontece.
{
  const h = harness();
  h.setAvailable(false);
  assert.deepEqual(await runDailySummaryTick(MONDAY_0730, h.deps), { status: "skipped", reason: "whatsapp_disabled" });
  h.setAvailable(true);
  h.config.enabled = false;
  assert.deepEqual(await runDailySummaryTick(MONDAY_0730, h.deps), { status: "skipped", reason: "disabled" });
  h.config.enabled = true;
  assert.deepEqual(await runDailySummaryTick(at("2026-11-07T10:30:00.000Z"), h.deps), { status: "skipped", reason: "not_business_day" }, "sábado");
  assert.deepEqual(await runDailySummaryTick(at("2026-11-08T10:30:00.000Z"), h.deps), { status: "skipped", reason: "not_business_day" }, "domingo");
  assert.deepEqual(await runDailySummaryTick(at("2026-11-09T10:29:00.000Z"), h.deps), { status: "skipped", reason: "before_time" });
  assert.equal(h.sends.length, 0);
  assert.equal(h.calls.listSellers, 0);
}

// 2) Remetente indisponível: nada sai, nenhuma linha de vendedor, situação do dia com o código.
{
  const h = harness();
  h.setSender({ ok: false, code: "sender_not_connected" });
  assert.deepEqual(await runDailySummaryTick(MONDAY_0730, h.deps), { status: "sender_unavailable", code: "sender_not_connected" });
  assert.equal(h.sends.length, 0);
  assert.equal(h.days.size, 0);
  assert.equal(h.run?.state, "sender_unavailable");
  assert.equal(h.run?.code, "sender_not_connected");
  // Reconectado dentro da janela: a próxima rodada envia.
  h.setSender({ ok: true, userId: "manager-x", instanceName: "crm-instancia-ficticia" });
  assert.equal((await runDailySummaryTick(at("2026-11-09T11:00:00.000Z"), h.deps)).status, "done");
  assert.equal(h.sends.length, 4);
  assertCleanLogs(h);
}

// 3) Rodada normal: vazio não envia, destino recusado registra o motivo, intervalo entre envios, remetente
//    fora da lista, incerto e falha registrados só com o código.
{
  const h = harness({
    refusals: { "seller-c": { ok: false, reason: "phone_matches_client" } },
    results: { "seller-d": [{ kind: "uncertain", code: "timeout" }], "seller-e": [{ kind: "not_sent", code: "connection_refused", retryable: true }] }
  });
  const result = await runDailySummaryTick(MONDAY_0730, h.deps);
  assert.equal(result.status, "done");
  assert.deepEqual(h.sends.map((send) => send.userId), ["seller-a", "seller-d", "seller-e"], "sem o remetente, sem vazio, sem recusado");
  assert(h.sends.every((send) => send.instance === "crm-instancia-ficticia"));
  assert.equal(h.sends[0].text, "Resumo ficticio de Vendedor Ficticio A");
  assert.deepEqual(h.sleeps, [MIN_INTERVAL_MS + MAX_EXTRA_INTERVAL_MS / 2, MIN_INTERVAL_MS + MAX_EXTRA_INTERVAL_MS / 2], "intervalo só entre envios");
  assert.equal(h.day("manager-x"), undefined);
  assert.deepEqual(
    ["seller-a", "seller-b", "seller-c", "seller-d", "seller-e"].map((id) => [h.day(id)?.status, h.day(id)?.code, h.day(id)?.attempts]),
    [["sent", null, 1], ["empty", null, 0], ["refused", "phone_matches_client", 0], ["uncertain", "timeout", 1], ["failed", "connection_refused", 1]]
  );
  assert.equal(h.run?.state, "done");
  assert.deepEqual(h.run?.counts, { sending: 0, sent: 1, uncertain: 1, failed: 1, empty: 1, refused: 1 });
  assert.equal(h.calls.cleanup, 1, "limpeza uma vez no primeiro dia");
  assertCleanLogs(h);

  // 4) Rodada seguinte no mesmo dia: só a conexão recusada tenta de novo; enviado, incerto, vazio e recusado não.
  await runDailySummaryTick(at("2026-11-09T10:35:00.000Z"), h.deps);
  assert.deepEqual(h.sends.map((send) => send.userId), ["seller-a", "seller-d", "seller-e", "seller-e"]);
  assert.deepEqual([h.day("seller-e")?.status, h.day("seller-e")?.attempts], ["sent", 2]);
  assert.equal(h.calls.cleanup, 1, "limpeza não repete no mesmo dia");
  await runDailySummaryTick(at("2026-11-09T10:40:00.000Z"), h.deps);
  assert.equal(h.sends.length, 4, "nada mais a enviar");
  assert.equal(h.calls.checkSender, 2, "sem pendentes, nem confere o remetente");

  // 5) Dia seguinte: tudo de novo, uma vez.
  await runDailySummaryTick(at("2026-11-10T10:30:00.000Z"), h.deps);
  assert.equal(h.sends.length, 7);
  assert.equal(h.day("seller-a", "2026-11-10")?.status, "sent");
  assert.equal(h.calls.cleanup, 2);
}

// 6) Conexão recusada até MAX_ATTEMPTS: para de tentar.
{
  const refused: EvolutionSendResult = { kind: "not_sent", code: "connection_refused", retryable: true };
  const h = harness({ texts: { "seller-b": "x" }, results: { "seller-a": [refused, refused, refused, refused] } });
  for (let minute = 30; minute < 30 + 5 * 6; minute += 5) await runDailySummaryTick(at(`2026-11-09T10:${minute}:00.000Z`), h.deps);
  assert.equal(h.sends.filter((send) => send.userId === "seller-a").length, MAX_ATTEMPTS);
  assert.deepEqual([h.day("seller-a")?.status, h.day("seller-a")?.attempts], ["failed", MAX_ATTEMPTS]);
}

// 7) "sending" de uma rodada interrompida (API reiniciou): incerto, nunca repete. Linha criada por outra
//    execução ao mesmo tempo: não envia.
{
  const h = harness();
  h.days.set("2026-11-09.seller-a", { status: "sending", code: null, attempts: 1, at: "2026-11-09T10:30:05.000Z" });
  h.calls.createConflicts.add("seller-d");
  await runDailySummaryTick(MONDAY_0730, h.deps);
  assert.deepEqual(h.sends.map((send) => send.userId), ["seller-c", "seller-e"]);
  assert.equal(h.day("seller-a")?.status, "sending");
  assert.equal(h.run?.counts.sending, 1);
}

// 8) Instância some no meio (não existe mais): para a rodada e marca remetente indisponível.
{
  const h = harness({ results: { "seller-a": [{ kind: "not_sent", code: "instance_not_found", retryable: false }] } });
  assert.deepEqual(await runDailySummaryTick(MONDAY_0730, h.deps), { status: "sender_unavailable", code: "instance_not_found" });
  assert.deepEqual(h.sends.map((send) => send.userId), ["seller-a"]);
  assert.equal(h.day("seller-c"), undefined);
  assert.equal(h.run?.state, "sender_unavailable");
  assertCleanLogs(h);
}

// 9) Depois da janela (3 h): registra "window_closed" uma vez e não envia; nas rodadas seguintes nem lista.
{
  const h = harness();
  assert.deepEqual(await runDailySummaryTick(at("2026-11-09T13:30:00.000Z"), h.deps), { status: "skipped", reason: "window_closed" });
  assert.equal(h.run?.state, "window_closed");
  await runDailySummaryTick(at("2026-11-09T13:35:00.000Z"), h.deps);
  assert.equal(h.calls.listSellers, 1);
  assert.equal(h.sends.length, 0);
}

// 10) Remetente: diretor ou gerente ativo, número CONNECTED e instância "open" na hora.
{
  const users: Record<string, { id: string; role: string; isActive: boolean }> = {
    "manager-ok": { id: "manager-ok", role: "gerente", isActive: true },
    "director-ok": { id: "director-ok", role: "diretor", isActive: true },
    "manager-off": { id: "manager-off", role: "gerente", isActive: false },
    "seller-x": { id: "seller-x", role: "vendedor", isActive: true }
  };
  const connections: Record<string, { instanceName: string; status: string; connectedPhone: string | null }> = {
    "manager-ok": { instanceName: "crm-ficticio-1", status: "CONNECTED", connectedPhone: "5511900000201" },
    "director-ok": { instanceName: "crm-ficticio-2", status: "DISCONNECTED", connectedPhone: null }
  };
  const db = {
    user: { findUnique: async (args: any) => users[args.where.id] ?? null },
    whatsAppConnection: { findUnique: async (args: any) => connections[args.where.userId] ?? null }
  } as any;
  let state: string | Error = "open";
  const client = { connectionState: async () => (state instanceof Error ? Promise.reject(state) : state) } as any;
  assert.deepEqual(await checkDailySummarySender(null, db, client), { ok: false, code: "sender_not_configured" });
  assert.deepEqual(await checkDailySummarySender("seller-x", db, client), { ok: false, code: "sender_not_allowed" });
  assert.deepEqual(await checkDailySummarySender("manager-off", db, client), { ok: false, code: "sender_not_allowed" });
  assert.deepEqual(await checkDailySummarySender("ninguem", db, client), { ok: false, code: "sender_not_allowed" });
  assert.deepEqual(await checkDailySummarySender("director-ok", db, client), { ok: false, code: "sender_not_connected" });
  assert.deepEqual(await checkDailySummarySender("manager-ok", db, client), { ok: true, userId: "manager-ok", instanceName: "crm-ficticio-1" });
  state = "close";
  assert.deepEqual(await checkDailySummarySender("manager-ok", db, client), { ok: false, code: "sender_not_connected" });
  state = new EvolutionUnavailableError("timeout");
  assert.deepEqual(await checkDailySummarySender("manager-ok", db, client), { ok: false, code: "evolution_unavailable" });
}

// 11) Ponto único de envio: erro inesperado vira "incerto" (não repete); destino recusado não sai.
{
  const recipient = { userId: "seller-a", phone: "5511900000301" } as CrmUserRecipient;
  const failing = (error: Error) => ({ sendTextToCrmUser: async () => Promise.reject(error) }) as any;
  assert.deepEqual(await sendDailySummaryText("crm-ficticio", recipient, "x", failing(new Error("boom"))), { kind: "uncertain", code: "unexpected_error" });
  assert.deepEqual(await sendDailySummaryText("crm-ficticio", recipient, "x", failing(new Error("whatsapp_recipient_not_crm_user"))), {
    kind: "not_sent",
    code: "whatsapp_recipient_not_crm_user",
    retryable: false
  });
}

console.log("dailySummaryRunner.test.ts: ok");
