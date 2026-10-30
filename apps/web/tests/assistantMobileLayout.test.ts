import assert from "node:assert/strict";
import fs from "node:fs";

// Assistente Comercial no celular (voz 2.1): bloco da frase recolhido, frase-modelo, cartão sem nada passando da borda
// e barras fixas que não cobrem o conteúdo. Contrato pelo código-fonte, como os demais testes de layout.
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const section = read("../src/components/opportunities/OpportunityDraftSection.tsx");
const card = read("../src/components/opportunities/OpportunityDraftCard.tsx");
const page = read("../src/pages/CrmAssistantPage.tsx");
const agenda = read("../src/pages/AgendaPage.tsx");

// 7. Frase-modelo no campo e dica do microfone do teclado.
assert.match(section, /DRAFT_PHRASE_EXAMPLE = "Cliente Agro Exemplo, Toledo\. Etapa proposta\. Tabela revenda\. Produto Marandu Vital Seed 10 quilos, 100 sacas, preço cadastrado\. Observação: retornar sexta\."/);
assert.match(section, /placeholder=\{DRAFT_PHRASE_EXAMPLE\}/);
assert.match(section, /Pode usar o microfone do teclado\./);

// 8. Começa recolhido, com a contagem do "Para confirmar" no botão.
assert.match(section, /const \[open, setOpen\] = useState\(false\)/);
assert.match(section, /`Nova oportunidade por frase\$\{drafts\.length \? ` \(\$\{drafts\.length\} para confirmar\)` : ""\}`/);
assert.match(section, /if \(!open\) \{/);

// 12. "Continuar" no lugar de "Abrir"; vencido mantém "Refazer" e "Descartar".
assert.match(section, />Continuar<\/button>/);
assert.doesNotMatch(section, />Abrir<\/button>/);
assert.match(section, />Refazer<\/button>/);
assert.match(section, />Descartar<\/button>/);

// 10. Cartão: sem grade fixa de 2 colunas no celular, busca com o botão sempre inteiro, datas na largura toda
// (appearance-none no iPhone), botão Remover sem encolher, itens sem cartão aninhado no celular.
assert.doesNotMatch(card, /"grid grid-cols-2/);
assert.match(card, /grid grid-cols-\[minmax\(0,1fr\)_auto\] gap-2/);
assert.match(card, /whitespace-nowrap rounded-xl border border-slate-200 px-3/);
assert.equal((card.match(/type="date"[^\n]*?className=\{dateInputClass\}/g) ?? []).length, 3);
assert.match(card, /const dateInputClass = `\$\{inputClass\} block appearance-none/);
assert.match(card, /shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-red-700[^>]*><Trash2 size=\{14\} \/> Remover/);
assert.match(card, /min-w-0 space-y-3 border-t pt-3 md:rounded-2xl md:border md:p-3/);

// 9. Cabeçalho: ícone pequeno ao lado do título no celular.
assert.match(page, /<h1 className="flex items-center gap-2 text-xl[^"]*md:text-2xl"><span className="shrink-0 rounded-lg bg-brand-50 p-1\.5[^"]*"><Bot className="h-5 w-5 md:h-6 md:w-6" \/><\/span>Assistente Comercial<\/h1>/);

// 11. Barras fixas acima da barra de ações rápidas do celular (fixed bottom-0, z-40, md:hidden).
assert.match(page, /className="fixed inset-x-0 bottom-\[calc\(var\(--mobile-action-bar-height\)\+env\(safe-area-inset-bottom\)\)\] z-30[^"]*md:static/);
assert.match(page, /pb-28/, "espaço no fim da página para a barra de pergunta");
assert.match(agenda, /fixed bottom-\[calc\(var\(--mobile-action-bar-height\)\+env\(safe-area-inset-bottom\)\+0\.75rem\)\] right-4 z-40/);
assert.doesNotMatch(agenda, /fixed bottom-5 right-4 z-40/);

console.log("ASSISTANT_MOBILE_LAYOUT=PASS");
