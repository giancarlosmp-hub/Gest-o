import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRecordingState, recordingSinceFor, RECORDING_STATE_KEY, syncRecordingState } from "./whatsappRecordingState.js";

// WhatsApp Fase B2: "gravação ligada/desligada desde" em AppConfig. Só dados fictícios.

const rows = new Map<string, string>();
let writes = 0;
const db = {
  appConfig: {
    findUnique: async ({ where }: any) => (rows.has(where.key) ? { value: rows.get(where.key)! } : null),
    upsert: async ({ where, create, update }: any) => {
      writes++;
      rows.set(where.key, rows.has(where.key) ? update.value : create.value);
      return {};
    }
  }
} as any;

const day1 = new Date("2026-11-08T10:00:00.000Z");
const day2 = new Date("2026-11-10T10:00:00.000Z");
const day3 = new Date("2026-11-12T10:00:00.000Z");

// Primeira subida (desligada): grava o início do acompanhamento.
assert.deepEqual(await syncRecordingState(false, day1, db), { changed: true, state: { enabled: false, since: day1.toISOString() } });
// Nova subida com a mesma flag: não regrava nem muda a data.
assert.equal((await syncRecordingState(false, day2, db)).changed, false);
assert.equal(writes, 1);
// Flag ligada: grava a data da subida.
assert.deepEqual(await syncRecordingState(true, day2, db), { changed: true, state: { enabled: true, since: day2.toISOString() } });
assert.equal(JSON.parse(rows.get(RECORDING_STATE_KEY)!).since, day2.toISOString());

// Valor estragado: tratado como ausente e regravado.
for (const broken of ["", "{", "[]", '{"enabled":"sim","since":"x"}', '{"enabled":true,"since":"não é data"}']) assert.equal(parseRecordingState(broken), null);
rows.set(RECORDING_STATE_KEY, "{");
assert.equal((await syncRecordingState(true, day3, db)).changed, true);

// "Desde": ligada e número conectado depois → data da conexão; conectado antes → data da ligação.
const on = { enabled: true, since: day2.toISOString() };
assert.equal(recordingSinceFor({ enabled: true, state: on, connectedAt: day3 })?.toISOString(), day3.toISOString());
assert.equal(recordingSinceFor({ enabled: true, state: on, connectedAt: day1 })?.toISOString(), day2.toISOString());
assert.equal(recordingSinceFor({ enabled: true, state: on, connectedAt: null })?.toISOString(), day2.toISOString());
// Desligada: data do desligamento, mesmo com número conectado.
assert.equal(recordingSinceFor({ enabled: false, state: { enabled: false, since: day1.toISOString() }, connectedAt: day3 })?.toISOString(), day1.toISOString());
// Estado gravado diferente da flag (sincronização falhou): sem data, salvo a conexão com a gravação ligada.
assert.equal(recordingSinceFor({ enabled: false, state: on, connectedAt: null }), null);
assert.equal(recordingSinceFor({ enabled: true, state: null, connectedAt: day3 })?.toISOString(), day3.toISOString());

// A subida da API sincroniza antes da primeira rodada do agendador.
const scheduler = readFileSync(new URL("../../jobs/whatsappMessagesScheduler.ts", import.meta.url), "utf8");
assert.ok(scheduler.indexOf("await syncRecordingState()") > 0);
assert.ok(scheduler.indexOf("await syncRecordingState()") < scheduler.indexOf("await whatsappMessagesTick()"));

console.log("whatsappRecordingState.test.ts: ok");
