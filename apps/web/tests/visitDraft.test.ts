import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clearVisitDraft,
  formatVisitDraftStart,
  hasVisitDraftContent,
  loadVisitDraft,
  saveVisitDraft,
  VISIT_DRAFT_TTL_MS
} from "../src/lib/visitDraft";

// Visita em andamento guardada no aparelho. Dados fictícios; armazenamento simulado.
const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  };
};
const blockedStorage = {
  getItem: () => { throw new Error("SecurityError ficticio"); },
  setItem: () => { throw new Error("QuotaExceededError ficticio"); },
  removeItem: () => { throw new Error("SecurityError ficticio"); }
};

const checkInAt = "2026-10-23T13:05:00.000Z"; // 10:05 em Brasília
const visit = {
  type: "visita",
  dueDate: "2026-10-23",
  clientId: "cli-ficticio",
  opportunityId: "opp-ficticia",
  agendaEventId: "",
  ownerSellerId: "seller-ficticio",
  city: "Cidade Ficticia",
  notes: "",
  observations: "Cliente ficticio pediu amostra",
  result: "",
  checkIn: { checkInAt, checkInLat: -10.5, checkInLng: -50.25, checkInAccuracy: 12 }
};

// 1. Restaurado depois de recarregar: outra leitura do mesmo armazenamento devolve tudo, com o início no check-in.
const storage = memoryStorage();
const saved = saveVisitDraft("seller-ficticio", visit, { storage, now: new Date("2026-10-23T13:06:00.000Z") });
assert(saved);
const reloaded = loadVisitDraft("seller-ficticio", { storage, now: new Date("2026-10-23T15:00:00.000Z") });
assert.deepEqual(reloaded, { ...visit, version: 1, startedAt: checkInAt });
assert.equal(formatVisitDraftStart(reloaded!), "10:05", "aviso em horário de Brasília");
// Chave por usuário: outro vendedor não vê o rascunho.
assert.equal(loadVisitDraft("outro-ficticio", { storage }), null);
// Sem check-in, o início é o do primeiro rascunho e não muda com as gravações seguintes.
const noCheckIn = memoryStorage();
saveVisitDraft("seller-ficticio", { ...visit, checkIn: null }, { storage: noCheckIn, now: new Date("2026-10-23T12:00:00.000Z") });
saveVisitDraft("seller-ficticio", { ...visit, checkIn: null, observations: "Mais texto" }, { storage: noCheckIn, now: new Date("2026-10-23T12:30:00.000Z") });
assert.equal(loadVisitDraft("seller-ficticio", { storage: noCheckIn, now: new Date("2026-10-23T12:31:00.000Z") })!.startedAt, "2026-10-23T12:00:00.000Z");

// 2. Expira depois de 12 horas (e é apagado).
const almost = new Date(Date.parse(checkInAt) + VISIT_DRAFT_TTL_MS - 1);
const expired = new Date(Date.parse(checkInAt) + VISIT_DRAFT_TTL_MS);
assert(loadVisitDraft("seller-ficticio", { storage, now: almost }));
assert.equal(loadVisitDraft("seller-ficticio", { storage, now: expired }), null);
assert.equal(storage.data.size, 0, "rascunho expirado é apagado");

// 3. Apagado ao salvar, ao descartar e ao sair: os três caminhos chamam clearVisitDraft.
saveVisitDraft("seller-ficticio", visit, { storage, now: new Date(checkInAt) });
clearVisitDraft("seller-ficticio", { storage });
assert.equal(loadVisitDraft("seller-ficticio", { storage, now: new Date(checkInAt) }), null);
const page = readFileSync(new URL("../src/pages/ActivitiesPage.tsx", import.meta.url), "utf8");
// Depois de salvar com sucesso, pelo registro avulso ou pelo "Concluir" do compromisso.
assert.match(page, /await api\.post\(`\/agenda\/events\/\$\{form\.agendaEventId\}\/complete`, payload\);\n\s+\} else \{\n\s+await api\.post\("\/activities", \{[\s\S]*?\}\);\n\s+\}\n\s+if \(form\.type === "visita" && canWriteVisitDraft\) clearVisitDraft\(user\?\.id\);/, "apagado ao salvar com sucesso");
assert.match(page, /const discardVisitDraft = \(\) => \{\n\s+clearVisitDraft\(user\?\.id\);/, "apagado ao descartar no formulário");
assert.match(page, />\s*Descartar visita em andamento\s*</);
const banner = readFileSync(new URL("../src/components/visit/VisitDraftBanner.tsx", import.meta.url), "utf8");
assert.match(banner, /Visita em andamento desde \{formatVisitDraftStart\(draft\)\}/);
assert.match(banner, /onClick=\{\(\) => clearVisitDraft\(user\?\.id\)\}/, "apagado ao descartar no aviso");
const auth = readFileSync(new URL("../src/context/AuthContext.tsx", import.meta.url), "utf8");
assert.match(auth, /const logout = async \(\) => \{[\s\S]*clearVisitDraft\(user\?\.id\);[\s\S]*setUser\(null\);/, "apagado no logout");
const layout = readFileSync(new URL("../src/layouts/AppLayout.tsx", import.meta.url), "utf8");
assert.match(layout, /<VisitDraftBanner \/>\n\s+<Outlet \/>/, "aviso em qualquer tela do CRM, desktop e mobile");

// 4. Armazenamento indisponível não quebra: nada lança, sem rascunho.
assert.equal(saveVisitDraft("seller-ficticio", visit, { storage: blockedStorage }), null);
assert.equal(loadVisitDraft("seller-ficticio", { storage: blockedStorage }), null);
assert.doesNotThrow(() => clearVisitDraft("seller-ficticio", { storage: blockedStorage }));
assert.equal(saveVisitDraft("seller-ficticio", visit, { storage: null }), null);
assert.equal(loadVisitDraft("seller-ficticio", { storage: null }), null);
// Conteúdo corrompido é descartado sem erro.
const corrupted = memoryStorage();
corrupted.setItem("gest-o:visit-draft:seller-ficticio", "{nao-e-json");
assert.equal(loadVisitDraft("seller-ficticio", { storage: corrupted }), null);
assert.equal(corrupted.data.size, 0);
// Sem usuário logado não grava nem lê.
assert.equal(saveVisitDraft(null, visit, { storage }), null);
assert.equal(loadVisitDraft(undefined, { storage }), null);

// Só vira rascunho depois do check-in ou de algo preenchido.
const empty = { checkIn: null, clientId: "", notes: "", observations: " ", result: "" };
assert.equal(hasVisitDraftContent(empty), false);
assert.equal(hasVisitDraftContent({ ...empty, checkIn: visit.checkIn }), true);
assert.equal(hasVisitDraftContent({ ...empty, observations: "Texto ficticio" }), true);

// "Concluir" de uma visita da Agenda: cliente e notas vêm preenchidos; sem GPS nem nada digitado, não há rascunho.
const fromAgenda = { clientId: "cli-ficticio", notes: "Visita ficticia agendada" };
const openedFromAgenda = { ...empty, ...fromAgenda };
assert.equal(hasVisitDraftContent(openedFromAgenda, fromAgenda), false, "abrir o Concluir não cria o rascunho");
assert.equal(hasVisitDraftContent({ ...openedFromAgenda, notes: "Visita ficticia agendada " }, fromAgenda), false);
assert.equal(hasVisitDraftContent({ ...openedFromAgenda, checkIn: visit.checkIn }, fromAgenda), true, "o check-in cria");
assert.equal(hasVisitDraftContent({ ...openedFromAgenda, observations: "Resumo ficticio" }, fromAgenda), true, "digitar cria");
assert.equal(hasVisitDraftContent({ ...openedFromAgenda, notes: "Notas ficticias novas" }, fromAgenda), true);
assert.equal(hasVisitDraftContent({ ...openedFromAgenda, clientId: "cli-outro" }, fromAgenda), true, "trocar o cliente cria");
assert.equal(hasVisitDraftContent(openedFromAgenda), true, "sem o preenchido, cliente conta como conteúdo");
assert.match(page, /setVisitDraftPrefill\(\{ clientId, notes: notes \|\| title \}\)/, "o Concluir guarda o que veio preenchido");
assert.match(page, /hasVisitDraftContent\(draft, visitDraftPrefill\)/);

console.log("visit draft tests passed");
