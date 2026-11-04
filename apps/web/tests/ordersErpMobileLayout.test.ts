import assert from "node:assert/strict";
import fs from "node:fs";

// Celular (abaixo de 640px): Pedidos com KPIs compactos e "Filtros (N)", Títulos em Aberto e as duas tabelas da
// Integração ERP em cartões, texto das Automações conforme o estado, e a reserva da barra de ações com a altura real.
// Desktop: tabelas e grades de sempre. Contrato pelo código-fonte, como os demais testes de layout.
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const orders = read("../src/pages/OrdersPage.tsx");
const client = read("../src/pages/ClientDetailsPage.tsx");
const erp = read("../src/components/settings/ErpIntegrationPanel.tsx");
const automations = read("../src/components/settings/CommercialAutomationsPanel.tsx");
const styles = read("../src/index.css");
const actionBar = read("../src/components/mobile/MobileActionBar.tsx");

// 1. Pedidos: sem padding próprio no celular (o shell já dá 16px) e sem o space-y somado ao gap de 16px do shell.
assert.match(orders, /<div className="mx-auto max-w-7xl space-y-5 max-sm:space-y-0 sm:p-6">/);
assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.crm-page-shell > \* \{\s*display: flex;\s*flex-direction: column;\s*gap: 16px;/);

// 2. KPIs: 2 colunas compactas, ícone só a partir de sm, valor sem quebra só no celular; desktop com md:4 e xl:8.
assert.match(orders, /className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4 xl:grid-cols-8"/);
assert.match(orders, /className="min-w-0 rounded-2xl border border-slate-200 bg-white p-2\.5 shadow-sm sm:p-3"/);
assert.match(orders, /<Icon className="mb-2 text-brand-700 max-sm:hidden" size=\{18\} \/>/);
assert.match(orders, /className="mt-0\.5 text-\[15px\] font-bold text-slate-900 max-sm:whitespace-nowrap max-sm:\[overflow-wrap:normal\] sm:mt-1 sm:text-lg"/);

// 3. Filtros: busca visível, o resto em "Filtros (N)"; N conta status, datas e vendedor. No desktop a mesma grade.
assert.match(orders, /const activeFiltersCount = \[status, from, to, sellerId\]\.filter\(Boolean\)\.length;/);
assert.match(orders, /<MobileFiltersToggle activeCount=\{activeFiltersCount\}[^\n]*panelId="orders-filters" \/>/);
assert.match(orders, /<div id="orders-filters" className=\{`\$\{mobileFiltersOpen \? "grid" : "hidden"\} gap-3 sm:contents`\}>/);
assert.match(orders, /sm:grid-cols-2 lg:grid-cols-5">/);
const filterPanel = orders.slice(orders.indexOf('<div id="orders-filters"'), orders.indexOf("</section>", orders.indexOf('<div id="orders-filters"')));
for (const field of ['aria-label="Status"', 'aria-label="Data inicial"', 'aria-label="Data final"', 'aria-label="Vendedor"']) {
  assert.ok(filterPanel.includes(field), `${field} dentro do painel recolhível`);
}
assert.ok(!filterPanel.includes('placeholder="Cliente, código ou número"'), "busca fora do painel recolhível");

// 4. Cartão do pedido: valor sem quebra, datas do rodapé empilhadas no celular; itens do detalhe em 2 colunas.
assert.match(orders, /<strong className="whitespace-nowrap">\{money\.format\(order\.totalValue\)\}<\/strong>/);
assert.match(orders, /className="mt-4 flex flex-col gap-1 border-t border-slate-100 pt-3 text-xs text-slate-500 sm:flex-row sm:justify-between"/);
assert.match(orders, /className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4"/);

// 5. Títulos em Aberto: cartões no celular, tabela a partir de sm; mesma regra de "vencido" nos dois.
assert.match(client, /<ul className="space-y-2 sm:hidden" aria-label="Títulos em aberto">/);
assert.match(client, /<div className="hidden overflow-x-auto sm:block">\s*<table className="min-w-full text-left text-sm">/);
assert.match(client, /const describeOpenTitle = \(title: Record<string, unknown>\) => \{\s*const saldo = numberFromErp\(title\.SALDO_CAPITAL\) \|\| 0;\s*const dueDate = title\.DATA_VENCIMENTO \? new Date\(String\(title\.DATA_VENCIMENTO\)\) : null;\s*const overdue = Boolean\(dueDate && !Number\.isNaN\(dueDate\.getTime\(\)\) && dueDate\.getTime\(\) < Date\.now\(\) && saldo > 0\);/);
assert.equal((client.match(/describeOpenTitle\(title\)/g) ?? []).length, 2, "cartão e tabela usam a mesma regra");
const titleCards = client.slice(client.indexOf('aria-label="Títulos em aberto"'), client.indexOf("</ul>", client.indexOf('aria-label="Títulos em aberto"')));
for (const field of ["title.DOCTO", "title.PARCELA", "title.DSCFORMA", "title.DATA_VENCIMENTO", "formatCurrency(saldo)", "title.VALOR", '"vencido" : "em aberto"']) {
  assert.ok(titleCards.includes(field), `cartão do título mostra ${field}`);
}

// 6. Integração ERP: as duas tabelas viram cartões no celular; tabelas a partir de sm.
for (const label of ["Resumo de clientes por vendedor", "Histórico de execução"]) {
  assert.match(erp, new RegExp(`<ul className="mt-3 space-y-2 sm:hidden" aria-label="${label}">`));
}
assert.equal((erp.match(/<div className="mt-3 hidden overflow-x-auto sm:block">\s*<table/g) ?? []).length, 2);
const historyCards = erp.slice(erp.indexOf('aria-label="Histórico de execução"'), erp.indexOf("</ul>", erp.indexOf('aria-label="Histórico de execução"')));
for (const field of ["item.scope", "item.sellerName", "statusLabel[item.status]", "item.finishedAt || item.startedAt", "item.syncedCount", "item.durationMs", "authModeLabel(item.authMode)", "item.correlationId", "item.errorMessage"]) {
  assert.ok(historyCards.includes(field), `cartão do histórico mostra ${field}`);
}

// 7. Automações: o texto acompanha o estado do interruptor.
assert.match(automations, /\{workflow\.enabled\s*\? "Ligada: cria as oportunidades de reativação no próximo ciclo\. Confira a simulação abaixo\."\s*: "Desligada, nada é criado\. Confira a simulação abaixo antes de ligar\."\}/);

// 8. (j) Reserva da barra de ações = altura real: pt-2 (8) + min-h-16 (64) + pb 12px + borda 1px = 85px = 5.3125rem.
assert.match(styles, /--mobile-action-bar-height: 5\.3125rem;/);
assert.match(actionBar, /min-h-16/);
assert.match(actionBar, /pb-\[calc\(env\(safe-area-inset-bottom\)\+12px\)\]/);
assert.match(actionBar, /border-t border-slate-200/);
assert.match(actionBar, / pt-2 /);
assert.equal((8 + 64 + 12 + 1) / 16, 5.3125);

console.log("ORDERS_TITLES_ERP_MOBILE_LAYOUT=PASS");
