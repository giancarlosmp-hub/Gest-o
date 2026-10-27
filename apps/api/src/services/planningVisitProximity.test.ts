import assert from "node:assert/strict";
import { prisma } from "../config/prisma.js";
import { aiService } from "./ai/aiService.js";
import { buildDayRouteLinks, planningIntelligenceService } from "./planningIntelligenceService.js";
import { findOfficialTerritoryCity } from "./territoryOfficialCities.js";

// Agrupamento de visitas por cidades próximas (centroide do IBGE, raio em linha reta entre TODAS as visitas do dia).
// Clientes e atividades fictícios; só os municípios são reais (o catálogo público do IBGE). Prisma e IA simulados.
// Semana futura de segunda 2027-03-01 a sexta 2027-03-05: todos os dias abertos.
type Row = Record<string, any>;

(aiService as any).chat = async () => null;

const WEEK = "2027-03-01";
const FAR_DUE = "2027-04-01T15:00:00.000Z";
const at = (iso: string) => new Date(iso);
const visit = (id: string, city: string, state: string | null, dueIso = FAR_DUE, type = "visita"): Row => ({
  id, type, dueDate: at(dueIso), date: at(dueIso), city, clientId: `cli-${id}`, opportunityId: null, description: `Atividade ${id}`, notes: null,
  createdAt: at("2026-10-01T12:00:00.000Z"), client: { name: `Cliente Ficticio ${id}`, city, state },
});
const event = (id: string, type: string, startIso: string, city: string): Row => ({
  id, title: `Compromisso ${id}`, type, startDateTime: at(startIso), endDateTime: new Date(at(startIso).getTime() + 3_600_000), status: "agendado",
  city, clientId: null, opportunityId: null, updatedAt: at("2026-10-01T12:00:00.000Z"), stops: [],
});
const territory = (state: string, city: string): Row => ({ state, city, ibgeCode: findOfficialTerritoryCity(state, city)!.ibgeCode, updatedAt: at("2026-10-01T12:00:00.000Z") });

let events: Row[] = [];
let activities: Row[] = [];
let territoryCities: Row[] = [];
let storedRadius: string | null = null;
const setModel = (model: string, methods: Record<string, unknown>) => Object.assign((prisma as any)[model], methods);
setModel("agendaEvent", { findMany: async () => events });
setModel("opportunity", { findMany: async () => [] });
setModel("activity", { findMany: async () => activities });
setModel("client", { findMany: async () => [] });
setModel("erpOrderSync", { findMany: async () => [] });
setModel("sellerTerritoryCity", { findMany: async () => territoryCities });
// Visitas pela carteira (valor estimado do cliente e última visita): valores padrão e nenhuma visita registrada.
setModel("appConfig", { findMany: async () => [] });
setModel("agendaStop", { groupBy: async () => [] });
setModel("activity", { groupBy: async () => [] });
setModel("appConfig", { findUnique: async () => (storedRadius === null ? null : { value: storedRadius }) });

const generate = (refresh = true) => planningIntelligenceService.generateWeeklyCommercialPlan({ viewerUserId: "seller-a", viewerRole: "vendedor", weekStart: WEEK, refresh }) as Promise<Row>;
const dayOfClient = (plan: Row, clientId: string) => plan.days.find((day: Row) => day.suggestedActions.some((action: Row) => action.clientId === clientId))?.date ?? null;
const actionOf = (plan: Row, clientId: string) => plan.days.flatMap((day: Row) => day.suggestedActions).find((action: Row) => action.clientId === clientId);
const unallocatedIds = (plan: Row) => plan.unallocatedPriorities.map((action: Row) => action.clientId);

const results: string[] = [];

// 1. Raio de 70 km (padrão) medido entre todas as visitas do dia.
//    Toledo–Marechal Cândido Rondon 39 km, Toledo–Palotina 48, Rondon–Palotina 46: as três juntas.
//    Cascavel está a 54 km de Toledo mas a 92 de Rondon: não entra na segunda (só pela âncora entraria).
//    Francisco Beltrão–Pitanga 203 km e Pitanga–Guarapuava 81 km: dias separados. Ponta Grossa: sem dia livre.
{
  activities = [
    visit("toledo", "Toledo", "PR"),
    visit("rondon", "Marechal Cândido Rondon", "PR"),
    visit("cascavel", "Cascavel", "PR"),
    visit("beltrao", "Francisco Beltrão", "PR"),
    visit("pitanga", "Pitanga", "PR"),
    visit("palotina", "Palotina", "PR"),
    visit("guarapuava", "Guarapuava", "PR"),
    visit("ponta-grossa", "Ponta Grossa", "PR"),
    // Ligação não tem restrição de cidade: entra num dia mesmo longe de tudo.
    visit("ligacao-longe", "Ponta Grossa", "PR", FAR_DUE, "ligacao"),
  ];
  const plan = await generate();
  assert.equal(plan.visitRadiusKm, 70, "raio padrão");
  assert.equal(dayOfClient(plan, "cli-toledo"), "2027-03-01");
  assert.equal(dayOfClient(plan, "cli-rondon"), "2027-03-01");
  assert.equal(dayOfClient(plan, "cli-palotina"), "2027-03-01", "48 km de Toledo e 46 de Rondon");
  assert.equal(dayOfClient(plan, "cli-cascavel"), "2027-03-02", "54 km de Toledo mas 92 de Rondon: outro dia");
  assert.equal(dayOfClient(plan, "cli-beltrao"), "2027-03-03");
  assert.equal(dayOfClient(plan, "cli-pitanga"), "2027-03-04", "203 km de Francisco Beltrão");
  assert.equal(dayOfClient(plan, "cli-guarapuava"), "2027-03-05", "81 km de Pitanga, acima do raio");
  assert.deepEqual(unallocatedIds(plan), ["cli-ponta-grossa"], "visita sem dia compatível fica sem dia");
  assert(dayOfClient(plan, "cli-ligacao-longe"), "ligação entra num dia sem restrição de cidade");
  for (const day of plan.days) assert(day.suggestedActions.filter((action: Row) => action.type === "visit").length <= 3, "até 3 visitas por dia");
  results.push("radius_all_visits=PASS");

  // Rota do dia na ordem das visitas; ligação não entra na rota.
  const monday = plan.days.find((day: Row) => day.date === "2027-03-01");
  assert.equal(monday.routeLinks.length, 1);
  const url = new URL(monday.routeLinks[0]);
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("origin"), null, "sem origem: parte da localização atual");
  assert.equal(url.searchParams.get("waypoints"), "Toledo, PR|Marechal Cândido Rondon, PR");
  assert.equal(url.searchParams.get("destination"), "Palotina, PR");
  assert(!plan.days.some((day: Row) => day.routeLinks.some((link: string) => new URL(link).searchParams.get("destination") === "Ponta Grossa, PR")), "ligação fora da rota");
  results.push("route_in_order=PASS");
}

// 2. Raio ajustável: 300 km junta Cascavel com Toledo; a chave do cache inclui o raio (sem refresh, o plano muda).
{
  activities = [visit("toledo", "Toledo", "PR"), visit("rondon", "Marechal Cândido Rondon", "PR"), visit("cascavel", "Cascavel", "PR")];
  storedRadius = null;
  const before = await generate(false);
  assert.equal(dayOfClient(before, "cli-cascavel"), "2027-03-02");
  storedRadius = "300";
  const after = await generate(false);
  assert.equal(after.visitRadiusKm, 300);
  assert.equal(dayOfClient(after, "cli-cascavel"), "2027-03-01", "com 300 km, Cascavel vai com Toledo e Rondon");
  storedRadius = "abc";
  assert.equal((await generate()).visitRadiusKm, 70, "valor inválido volta ao padrão");
  storedRadius = null;
  results.push("configurable_radius_cache_key=PASS");
}

// 3. Sem coordenada (UF errada no cadastro ou fora de PR/SC/MS): só junta com a mesma cidade, sem adivinhar a UF.
{
  activities = [
    visit("wrong-uf-1", "Caarapó", "PR"),
    visit("sp-palmital", "Palmital", "SP"),
    visit("wrong-uf-2", "CAARAPO", "PR"),
    visit("pr-palmital", "Palmital", "PR"),
  ];
  const plan = await generate();
  assert.equal(dayOfClient(plan, "cli-wrong-uf-1"), dayOfClient(plan, "cli-wrong-uf-2"), "mesma cidade sem coordenada fica junta");
  assert.notEqual(dayOfClient(plan, "cli-sp-palmital"), dayOfClient(plan, "cli-wrong-uf-1"));
  assert.notEqual(dayOfClient(plan, "cli-sp-palmital"), dayOfClient(plan, "cli-pr-palmital"), "Palmital/SP não é Palmital/PR");
  assert.equal(actionOf(plan, "cli-wrong-uf-1").outsideTerritory, undefined, "sem território configurado, sem aviso");
  const caarapoDay = plan.days.find((day: Row) => day.date === dayOfClient(plan, "cli-wrong-uf-1"));
  assert.equal(new URL(caarapoDay.routeLinks[0]).searchParams.get("destination"), "Caarapó, PR", "rota com o nome do cadastro, uma vez só");
  results.push("no_coordinates_same_city=PASS");
}

// 4. Visita com data marcada fica no seu dia e as outras se agrupam em volta, mesmo vindo antes na prioridade.
{
  // Sem a data marcada entrar primeiro, Pitanga abriria a quarta e Guarapuava (81 km) cairia junto pela data.
  activities = [
    visit("toledo", "Toledo", "PR"),
    visit("cascavel", "Cascavel", "PR"),
    visit("beltrao", "Francisco Beltrão", "PR"),
    visit("pitanga", "Pitanga", "PR"),
    visit("guarapuava-quarta", "Guarapuava", "PR", "2027-03-03T15:00:00.000Z"),
  ];
  const plan = await generate();
  assert.equal(dayOfClient(plan, "cli-guarapuava-quarta"), "2027-03-03");
  assert.equal(dayOfClient(plan, "cli-toledo"), "2027-03-01");
  assert.equal(dayOfClient(plan, "cli-cascavel"), "2027-03-01", "54 km de Toledo, raio de 70");
  assert.equal(dayOfClient(plan, "cli-beltrao"), "2027-03-02");
  assert.equal(dayOfClient(plan, "cli-pitanga"), "2027-03-04", "81 km de Guarapuava: não vai para a quarta");
  results.push("fixed_date_anchor=PASS");
}

// 5. Compromisso presencial já na agenda define o lugar do dia; cidade sem UF (Irati PR/SC) desempata pelo território.
//    Irati/SC–Francisco Beltrão 69 km (Irati/PR fica a 239 km). Visita fora do território recebe aviso.
{
  territoryCities = [territory("SC", "Irati"), territory("PR", "Francisco Beltrão")];
  events = [event("irati", "roteiro_visita", "2027-03-01T12:00:00.000Z", "Irati")];
  activities = [
    visit("beltrao", "Francisco Beltrão", "PR"),
    visit("toledo", "Toledo", "PR"),
    visit("sp", "Palmital", "SP"),
    visit("wrong-uf", "Caarapó", "PR"),
  ];
  const plan = await generate();
  assert.equal(dayOfClient(plan, "cli-beltrao"), "2027-03-01", "Irati do território (SC) está a 69 km");
  assert.notEqual(dayOfClient(plan, "cli-toledo"), "2027-03-01");
  assert.equal(actionOf(plan, "cli-beltrao").outsideTerritory, undefined, "no território: sem aviso");
  assert.equal(actionOf(plan, "cli-toledo").outsideTerritory, true, "fora do território");
  assert.equal(actionOf(plan, "cli-sp").outsideTerritory, true, "UF fora de PR/SC/MS");
  assert.equal(actionOf(plan, "cli-wrong-uf").outsideTerritory, undefined, "não achada no catálogo: sem aviso");
  const monday = plan.days.find((day: Row) => day.date === "2027-03-01");
  const url = new URL(monday.routeLinks[0]);
  assert.equal(url.searchParams.get("waypoints"), "Irati, SC");
  assert.equal(url.searchParams.get("destination"), "Francisco Beltrão, PR");
  assert.equal("state" in actionOf(plan, "cli-beltrao"), false, "UF interna não vai na resposta");

  // Cidade repetida fora de sequência (compromisso em Cascavel, visita em Toledo, visita em Cascavel) entra uma vez só.
  territoryCities = [];
  events = [event("cascavel", "roteiro_visita", "2027-03-01T12:00:00.000Z", "Cascavel")];
  activities = [visit("toledo", "Toledo", "PR"), visit("cascavel", "Cascavel", "PR")];
  const repeated = await generate();
  assert.equal(dayOfClient(repeated, "cli-toledo"), "2027-03-01");
  assert.equal(dayOfClient(repeated, "cli-cascavel"), "2027-03-01");
  const repeatedUrl = new URL(repeated.days.find((day: Row) => day.date === "2027-03-01").routeLinks[0]);
  assert.equal(repeatedUrl.searchParams.get("waypoints"), "Cascavel, PR");
  assert.equal(repeatedUrl.searchParams.get("destination"), "Toledo, PR", "Cascavel não volta no fim da rota");
  events = [];
  territoryCities = [];
  results.push("territory_warning_and_tiebreak=PASS");
}

// 6. Link do Google Maps: até 4 cidades por link (3 paradas + destino); o seguinte parte da última cidade do anterior.
{
  assert.deepEqual(buildDayRouteLinks([]), []);
  const single = new URL(buildDayRouteLinks(["Toledo, PR"])[0]);
  assert.equal(single.searchParams.get("destination"), "Toledo, PR");
  assert.equal(single.searchParams.get("waypoints"), null);
  assert.equal(single.searchParams.get("travelmode"), "driving");
  const cities = Array.from({ length: 9 }, (_, index) => `Cidade Ficticia ${index + 1}, PR`);
  const four = buildDayRouteLinks(cities.slice(0, 4));
  assert.equal(four.length, 1);
  assert.equal(new URL(four[0]).searchParams.get("waypoints")?.split("|").length, 3);
  const links = buildDayRouteLinks(cities).map((link) => new URL(link).searchParams);
  assert.equal(links.length, 3);
  assert.equal(links[0].get("origin"), null);
  assert.equal(links[0].get("destination"), cities[3]);
  assert.equal(links[1].get("origin"), cities[3]);
  assert.deepEqual(links[1].get("waypoints")?.split("|"), cities.slice(4, 7));
  assert.equal(links[1].get("destination"), cities[7]);
  assert.equal(links[2].get("origin"), cities[7]);
  assert.equal(links[2].get("destination"), cities[8]);
  assert.equal(links[2].get("waypoints"), null);
  for (const link of buildDayRouteLinks(cities)) {
    assert(link.length <= 2048, "URL do Maps até 2.048 caracteres");
    assert.match(link, /waypoints=[^&]*%7C|^(?!.*waypoints)/, "barra vertical codificada");
  }
  results.push("route_links_limit=PASS");
}

console.log(`PLANNING_VISIT_PROXIMITY=PASS ${results.join(" ")}`);
