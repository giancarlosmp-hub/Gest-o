import assert from "node:assert/strict";
import fs from "node:fs";
import { countActiveOpportunityFilters, mobileFiltersLabel, type OpportunityFilterValues } from "../src/lib/opportunityFilters";

// Oportunidades no celular: lista em cartões, filtros recolhidos em "Filtros (N)", Excluir só dentro do menu ⋯ com
// confirmação. Desktop continua com a tabela e a mesma grade de filtros. Contrato pelo código-fonte, como os demais.
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../src/pages/OpportunitiesPage.tsx");
const toggle = read("../src/components/mobile/MobileFiltersToggle.tsx");
const styles = read("../src/index.css");

// 1. Contador: padrão de "Limpar filtros" = 0; cada filtro diferente do padrão soma 1; o responsável só conta para
// quem pode escolher (diretor/gerente).
const defaults: OpportunityFilterValues = {
  status: "open", stage: "", ownerSellerId: "", clientId: "", crop: "", season: "", dateFrom: "", dateTo: "", overdue: false, noResponse: false
};
assert.equal(countActiveOpportunityFilters(defaults, { countOwner: true }), 0);
assert.equal(countActiveOpportunityFilters({ ...defaults, status: "all" }, { countOwner: true }), 1);
assert.equal(countActiveOpportunityFilters({ ...defaults, stage: "proposta", crop: "Soja", overdue: true, noResponse: true }, { countOwner: true }), 4);
assert.equal(countActiveOpportunityFilters({ ...defaults, clientId: "cliente-ficticio", dateFrom: "2026-11-01", dateTo: "2026-11-30" }, { countOwner: true }), 3);
assert.equal(countActiveOpportunityFilters({ ...defaults, ownerSellerId: "vendedor-ficticio" }, { countOwner: true }), 1);
assert.equal(countActiveOpportunityFilters({ ...defaults, ownerSellerId: "vendedor-ficticio" }, { countOwner: false }), 0);
assert.equal(mobileFiltersLabel(0), "Filtros");
assert.equal(mobileFiltersLabel(2), "Filtros (2)");
assert.match(page, /const clearFilters = \(\) => \{\s*setFilters\(\{\s*status: "open",\s*stage: "",/, "o padrão do contador é o mesmo de Limpar filtros");
assert.match(page, /countActiveOpportunityFilters\(filters, \{ countOwner: canFilterByOwner \}\)/);

// 2. Botão "Filtros (N)" só no celular; invólucro some no desktop (sm:contents) e os campos ficam na grade de sempre.
assert.match(toggle, /sm:hidden/);
assert.match(toggle, /aria-expanded=\{open\}/);
assert.match(toggle, /mobileFiltersLabel\(activeCount\)/);
for (const panelId of ["opportunity-list-filters", "opportunity-pipeline-filters"]) {
  assert.match(page, new RegExp(`<MobileFiltersToggle [^\n]*panelId="${panelId}" />`));
  assert.match(page, new RegExp(`<div id="${panelId}" className=\\{\`\\$\\{mobileFiltersOpen \\? "grid" : "hidden"\\} gap-[23] sm:contents\`\\}>`));
}
assert.match(page, /<div className="grid gap-3 lg:grid-cols-10">/, "grade de filtros do desktop mantida");
assert.match(page, /<h3 className="mb-3 hidden text-base font-semibold text-slate-900 sm:block">Filtros<\/h3>/);

// 3. Lista: tabela só no desktop; cartões só no celular (mesmas classes de 640px já usadas na tela).
assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.opportunity-desktop-only \{\s*display: none !important;/);
assert.match(styles, /@media \(min-width: 641px\) \{\s*\.opportunity-mobile-only \{\s*display: none !important;/);
assert.match(page, /<div className="opportunity-desktop-only overflow-auto rounded-2xl[^"]*" data-action-menu-boundary>\s*<table className="min-w-\[1500px\]/);
const cards = page.slice(page.indexOf('<div className="opportunity-mobile-only space-y-3" data-action-menu-boundary>'));
assert.ok(cards.length < page.length, "bloco de cartões do celular presente");
// Fim do bloco: o fragmento da Lista fecha antes do ") : (" do Pipeline (o "</>" do menu é seguido de ") : null}").
const cardBlock = cards.slice(0, cards.search(/<\/>\s*\) : \(/));
assert.ok(cardBlock.length > 0, "fim do bloco de cartões encontrado");

// 4. Cartão: cliente, valor, etapa, retorno previsto e status de retorno visíveis; "Detalhes" como ação principal.
assert.match(cardBlock, /\{getClientName\(item\)\}/);
assert.match(cardBlock, /\{formatCurrencyBRL\(item\.value\)\}/);
assert.match(cardBlock, /\{stageLabel\[item\.stage\]\}/);
assert.match(cardBlock, /Retorno previsto: \{formatDateBR\(item\.expectedCloseDate\)\}/);
assert.match(cardBlock, /<ReturnStatusBadge status=\{getReturnStatus\(item\)\} \/>/);
assert.match(cardBlock, /<CollectionWarning item=\{item\} \/>/);
assert.match(cardBlock, /min-h-11 flex-1[^>]*onClick=\{\(\) => navigate\(`\/oportunidades\/\$\{item\.id\}`\)\}>\s*Detalhes/);
assert.doesNotMatch(cardBlock, /min-w-\[/, "cartão sem largura mínima fixa");

// 5. Excluir nunca solto no cartão: só dentro do menu ⋯ (ActionMenuPopover) e passando pela confirmação.
const menuStart = cardBlock.indexOf("<ActionMenuPopover");
const menuEnd = cardBlock.indexOf("</ActionMenuPopover>");
assert.ok(menuStart > 0 && menuEnd > menuStart, "menu ⋯ no cartão");
const outsideMenu = cardBlock.slice(0, menuStart) + cardBlock.slice(menuEnd);
assert.doesNotMatch(outsideMenu, />Excluir</);
assert.match(cardBlock.slice(menuStart, menuEnd), /onClick=\{\(\) => requestDeleteOpportunity\(item\)\}>Excluir</);
assert.match(page, /const requestDeleteOpportunity = \(item: Pick<Opportunity, "id" \| "title">\) => \{\s*closeActionMenus\(\);\s*setDeleteTarget\(/);
assert.match(page, /<DeleteOpportunityConfirmModal/);
assert.match(cardBlock, /aria-label="Abrir ações da oportunidade"/);

// 6. O menu ⋯ da linha da tabela no celular saiu (a tabela não aparece mais no celular).
assert.equal((page.match(/opportunity-mobile-only flex justify-center/g) ?? []).length, 0);

console.log("OPPORTUNITIES_MOBILE_LAYOUT=PASS");
