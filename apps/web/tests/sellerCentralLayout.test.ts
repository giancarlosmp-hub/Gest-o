import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Central do Dia por perfil, lida do JSX. Os prints antes/depois do PR conferem o resultado na tela.
const source = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
const at = (marker: string, from = 0, text = source) => {
  const index = text.indexOf(marker, from);
  assert(index >= 0, `não achei: ${marker}`);
  return index;
};
const between = (start: string, end: string) => source.slice(at(start), at(end, at(start)));

// Vendedor: um retorno só, antes do ramo do celular, então a mesma ordem vale para desktop e celular.
const sellerReturn = between("  if (isSeller) {\n    return (", "  if (isMobile) {\n    return (");
const sellerOrder = [
  "renderCentralDayHero(false)",
  "renderSellerOperationalAiCard()",
  "renderSellerTodayList()",
  "renderSellerAgendaToday()",
  "renderSellerRhythm()",
  "renderSellerPortfolioAlerts()"
];
const sellerPositions = sellerOrder.map((call) => at(call, 0, sellerReturn));
assert.deepEqual([...sellerPositions].sort((a, b) => a - b), sellerPositions, "ordem dos blocos do vendedor");
assert(/\{isMobile \? null : renderTopBanners\(false\)\}/.test(sellerReturn), "vendedor sem a faixa vermelha de follow-ups vencidos");
assert(!sellerReturn.includes("renderDragHandle"), "vendedor sem painéis arrastáveis");

// Títulos dos blocos do vendedor.
const sellerBlocks = between("  const renderSellerTodayList = () => (", "  const renderCentralDayHero = ");
const sellerCard = between("  const renderSellerOperationalAiCard = () => {", "  const renderCommercialInsightsCard = () => {");
assert(sellerCard.includes(">Comece por aqui</h2>"));
assert(sellerCard.includes("Registrar interação") && sellerCard.includes("WhatsApp"), "Comece por aqui mantém Abrir, Registrar e WhatsApp");
for (const title of ["Minha lista de hoje", "Agenda de hoje", "Meu ritmo", "Rotina do Dia", "Missões da Semana", "Alertas da carteira"]) {
  assert(sellerBlocks.includes(title), `bloco do vendedor: ${title}`);
}
assert(sellerBlocks.includes("Ver todas") && sellerBlocks.includes("Iniciar roteiro") && sellerBlocks.includes("renderPreviousDaysPending()"));
assert(sellerBlocks.includes("atividades concluídas hoje"), "concluídas de hoje dentro da Agenda de hoje");
assert(/excludeKey: sellerOperationalInsight \? sellerDayItemKey\(sellerOperationalInsight\)/.test(source), "o item nº 1 não se repete na lista");

// Sai do vendedor: blocos repetidos, rótulos técnicos e o Top 3 dos colegas.
for (const removed of ["Oportunidades críticas", "Followups pendentes", "Prioridades do dia", "Alertas Inteligentes", "Origem:", "Top 3", "top3", "Atenção: existem follow-ups vencidos", "Minha IA Comercial"]) {
  assert(!sellerBlocks.includes(removed) && !sellerReturn.includes(removed) && !sellerCard.includes(removed), `vendedor sem: ${removed}`);
}
// Missões: o vendedor usa só a própria linha, sem cair na de um colega.
assert(/const own = user\?\.role === "vendedor" \? ownRow : ownRow \?\? ranking\[0\] \?\? null;/.test(source), "Missões do vendedor sem colegas");
// Alertas da carteira: só contagens com link.
const alerts = between("  const renderSellerPortfolioAlerts = () => {", "  const renderCentralDayHero = ");
for (const label of ["Clientes esfriando", "Propostas sem retorno", "Clientes em cobrança"]) assert(alerts.includes(label));
assert(alerts.includes("<Link key={item.id} to={item.to}"));

// Gerente e diretor: celular e desktop como antes.
const mobile = between("  if (isMobile) {\n    return (", "  return (\n    <div className=\"flex flex-col gap-4\">");
const mobileOrder = ["renderCentralDayHero(false)", "renderCommercialInsightsCard()", "Resumo do dia", "Prioridades do dia", "Lista operacional", "Atividades do dia", "Agenda do dia"];
const mobilePositions = mobileOrder.map((marker) => at(marker, 0, mobile));
assert.deepEqual([...mobilePositions].sort((a, b) => a - b), mobilePositions, "ordem do celular da gestão");
const desktop = source.slice(at("  return (\n    <div className=\"flex flex-col gap-4\">"));
const desktopOrder = ["renderTopBanners(true)", "renderCentralDayHero(true)", "renderCommercialInsightsCard()"];
const desktopPositions = desktopOrder.map((marker) => at(marker, 0, desktop));
assert.deepEqual([...desktopPositions].sort((a, b) => a - b), desktopPositions, "topo do desktop da gestão");
assert(source.includes('const defaultPanelOrder = ["routine", "pipeline", "summary", "agenda", "followups", "critical", "alerts", "missions", "activities"] as const;'), "painéis da gestão mantidos");
for (const title of ["Rotina Comercial do Dia", "Missões da Semana", "Top 3 da semana", "Prioridades do dia", "Alertas Inteligentes", "Resumo do Dia", "Agenda de hoje", "Origem: Agenda", "Atividades executadas hoje", "Origem: Activities", "Followups pendentes", "Oportunidades críticas"]) {
  assert(desktop.includes(title), `desktop da gestão mantém: ${title}`);
}
const banners = between("  const renderTopBanners = ", "  const renderRoutineMetric = ");
assert(/\{showOverdueFollowUpAlert && alerts\.showOverdueFollowUpAlert && \(/.test(banners), "faixa vermelha continua para a gestão");

console.log("SELLER_CENTRAL_LAYOUT=PASS seller_order=PASS removed_blocks=PASS missions_own=PASS manager_mobile=PASS manager_desktop=PASS");
