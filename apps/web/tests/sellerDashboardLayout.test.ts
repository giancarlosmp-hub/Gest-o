import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Ordem dos blocos do Dashboard por perfil, lida do JSX (a mesma ordem vale para desktop e celular;
// a diferença é só a grade). Os prints antes/depois do PR conferem o resultado na tela.
const source = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
const render = source.slice(source.indexOf("  return (\n    <div className=\"space-y-4\">"));
const at = (marker: string, from = 0) => {
  const index = render.indexOf(marker, from);
  assert(index >= 0, `não achei: ${marker}`);
  return index;
};
// Bloco JSX condicional que começa em `start`: do marcador até o ")}" que fecha no mesmo recuo.
const conditionalBlock = (start: number) => render.slice(start, render.indexOf("\n      )}", start));

const evolution = at("Evolução do mês");
const sellerBlockStart = at("{isSeller && (", evolution);
const sellerBlock = conditionalBlock(sellerBlockStart);
const activities = at("Performance de Atividades");

// Vendedor: Carteira e Curva ABC logo depois do gráfico do objetivo do mês, lado a lado a partir de md
// (uma coluna no celular), e em seguida "Minha semana"; depois Performance de Atividades.
assert(evolution < sellerBlockStart && sellerBlockStart < activities);
assert(/<div className="grid gap-3 md:grid-cols-2">\s*\{walletCard\}\s*\{abcCard\}\s*<\/div>\s*\{myWeekCard\}/.test(sellerBlock), "Carteira e Curva ABC lado a lado, depois Minha semana");
assert(!/grid-cols-1 md:|sm:grid-cols-2">\s*\{walletCard/.test(sellerBlock), "grade do vendedor sem colunas extras");

// Blocos escondidos do vendedor: Destaques, Ranking Disciplina, Score Comercial do Mês, Consistência e Performance da equipe.
const hidden = ["Destaques da Semana", "Ranking Disciplina", "Score Comercial do Mês", "Consistência</h3>", "Performance da equipe"];
const managerBlocks = [...render.matchAll(/\{!isSeller && \(/g)].map((match) => conditionalBlock(match.index!));
for (const title of hidden) {
  assert(managerBlocks.some((block) => block.includes(title)), `${title} fica só para gestão`);
  assert(!sellerBlock.includes(title), `${title} não aparece no bloco do vendedor`);
}

// Gestão: a mesma ordem de antes, com Carteira, Curva ABC e Performance da equipe no fim.
const managerOrder = [
  "Destaques da Semana",
  "Evolução do mês",
  "Performance de Atividades",
  "Ranking Disciplina",
  "Score Comercial do Mês",
  "Consistência</h3>",
];
const positions = managerOrder.map((title) => at(title));
assert.deepEqual([...positions].sort((a, b) => a - b), positions, "ordem da gestão mantida");
const bottomGrid = managerBlocks.find((block) => block.includes("Performance da equipe"))!;
assert(/md:grid-cols-2 xl:grid-cols-3">\s*\{walletCard\}\s*\{abcCard\}/.test(bottomGrid), "grade de baixo da gestão mantida");
assert(render.indexOf("{walletCard}", sellerBlockStart + sellerBlock.length) > positions.at(-1)!);

// As fatias da Carteira continuam clicáveis: o mesmo cartão (com as opções de clique) nas duas ordens.
assert(/const walletCard = \([\s\S]*options=\{walletDoughnutOptions\}/.test(source), "Carteira usa as opções clicáveis");
assert(/const walletDoughnutOptions[\s\S]*portfolioStatusClientsPath\("ativo"/.test(source), "fatias levam à lista de clientes");

console.log("SELLER_DASHBOARD_LAYOUT=PASS seller_order=PASS hidden_blocks=PASS manager_order=PASS wallet_clickable=PASS");
