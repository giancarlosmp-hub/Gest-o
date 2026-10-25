import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Aparelho em outro fuso: os dias continuam os de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { isProposalWithoutResponse } = await import("@salesforce-pro/shared");
const { buildSellerDayList } = await import("../src/lib/sellerDayList");
const { countProposalsWithoutResponse, isNoResponseFilterInUrl, proposalsNoResponsePath } = await import("../src/lib/proposalsNoResponse");
const { coolingClientsPath } = await import("../src/lib/clientListFilters");

const br = (dayTime: string) => new Date(`${dayTime}:00.000-03:00`).toISOString();
const now = new Date(br("2026-11-06T10:00"));
const proposal = (id: string, extra: Record<string, unknown>) => ({
  id, title: `Proposta ficticia ${id}`, stage: "proposta", followUpDate: br("2026-11-20T10:00"), client: { id: `cl-${id}`, name: `Cliente Ficticio ${id}` }, ...extra
});

const opportunities = [
  // Contato há 6 e 7 dias não entra; há 8 entra. 23h de Brasília continua sendo o mesmo dia.
  proposal("p6", { lastContactAt: br("2026-10-31T09:00") }),
  proposal("p7", { lastContactAt: br("2026-10-30T23:00") }),
  proposal("p8", { lastContactAt: br("2026-10-29T23:00") }),
  // Sem último contato vale o follow-up: há 9 dias também é follow-up vencido, que tem precedência na etiqueta.
  proposal("p-followup", { lastContactAt: null, followUpDate: br("2026-10-28T10:00") }),
  // Outra etapa não é proposta sem retorno.
  { ...proposal("p-negociacao", { lastContactAt: br("2026-10-01T10:00") }), stage: "negociacao" },
  // Cliente em cobrança fica fora da contagem e da lista.
  proposal("p-cobranca", { lastContactAt: br("2026-10-01T10:00"), clientInCollection: true })
];

assert.deepEqual(
  opportunities.map((item) => isProposalWithoutResponse(item, now)),
  [false, false, true, true, false, true],
  "regra: mais de 7 dias de Brasília do último contato (lastContactAt; sem ele, followUpDate)"
);

// Contagem do alerta: a regra, sem cliente em cobrança.
assert.equal(countProposalsWithoutResponse(opportunities, now), 2);

// Etiqueta da "Minha lista de hoje": a mesma regra. Cada proposta sem retorno da contagem está na lista; a etiqueta
// "Proposta sem retorno" sai só quando nada mais urgente vale (o follow-up vencido tem precedência).
const list = buildSellerDayList({ priorities: [], opportunities, now });
const tagOf = (id: string) => list.find((item) => item.opportunityId === id)?.tag ?? null;
assert.deepEqual(
  ["p6", "p7", "p8", "p-followup", "p-negociacao", "p-cobranca"].map(tagOf),
  [null, null, "proposal_no_response", "followup_overdue", null, null]
);
assert.equal(list.find((item) => item.opportunityId === "p8")!.daysLate, 8, "dias sem contato em dias de Brasília");
const counted = opportunities.filter((item) => !item.clientInCollection && isProposalWithoutResponse(item, now)).map((item) => item.id);
assert(counted.every((id) => list.some((item) => item.opportunityId === id)), "toda proposta da contagem está na lista");
const tagged = list.filter((item) => item.tag === "proposal_no_response").map((item) => item.opportunityId!);
assert(tagged.every((id) => counted.includes(id)), "toda etiqueta de proposta sem retorno está na contagem");

// Links da Central do Dia: a lista certa de cada alerta.
assert.equal(proposalsNoResponsePath(), "/oportunidades?status=open&noResponse=true");
assert.equal(coolingClientsPath(), "/clientes?status=esfriando");
assert.equal(isNoResponseFilterInUrl(new URLSearchParams("status=open&noResponse=true")), true);
assert.equal(isNoResponseFilterInUrl(new URLSearchParams("status=open&stage=proposta")), false);

// A Central do Dia usa os dois links e a contagem compartilhada; a tela de Oportunidades lê o filtro da URL.
const home = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
assert.match(home, /to: proposalsNoResponsePath\(\)/);
assert.match(home, /to: coolingClientsPath\(\)/);
assert.match(home, /countProposalsWithoutResponse\(opportunities, now\)/);
assert.doesNotMatch(home, /portfolioStatusClientsPath\("ativo"\)|stage=proposta"/, "links antigos saíram");
const opportunitiesPage = readFileSync(new URL("../src/pages/OpportunitiesPage.tsx", import.meta.url), "utf8");
assert.match(opportunitiesPage, /noResponse: isNoResponseFilterInUrl\(searchParams\)/);
assert.equal(opportunitiesPage.match(/\/>Propostas sem retorno/g)?.length, 2, "filtro no painel e na lista");
const clientsPage = readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(clientsPage, /isClientStatusFilter\(searchParams.get\("status"\)\)/);
assert.match(clientsPage, /<option value=\{COOLING_STATUS_FILTER\}>/);

console.log("PROPOSALS_NO_RESPONSE=PASS rule_6d_7d_out_8d_in=PASS count_without_collection=PASS tag_same_rule=PASS central_links=PASS url_filters=PASS");
