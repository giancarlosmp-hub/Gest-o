import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PARTNERS_CONFIG_KEY,
  PARTNERS_LAST_SEEN_CONFIG_KEY,
  PARTNER_CODE_KEYS,
  PARTNER_SELLER_CODE_KEYS,
  archiveReasonGroup,
  buildTransferList,
  cacheLineAge,
  classifyClients,
  isSystemTimeline,
  loadPortfolioInput,
  parseCliArgs,
  purchaseWindowStart,
  resolvePurchaseDate,
  runCli,
  summarizePortfolio,
  type PortfolioClient,
  type PortfolioDb,
} from "./simulateClientPortfolioCleanup.js";

// ---------------------------------------------------------------------------------------------
// Contrato: o script roda no container só com @prisma/client e módulos do Node, e não grava.
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const scriptSource = source("./simulateClientPortfolioCleanup.ts");
const specifiers = [...scriptSource.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]);
assert.ok(specifiers.length > 0, "o teste de contrato precisa encontrar os imports");
for (const specifier of specifiers) {
  assert.ok(specifier === "@prisma/client" || specifier.startsWith("node:"), `import não permitido no script: ${specifier}`);
}
assert.doesNotMatch(scriptSource, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRawUnsafe|\$queryRawUnsafe)\s*\(/, "o script não pode ter chamadas de escrita");
assert.deepEqual([...scriptSource.matchAll(/\$executeRaw`([^`]*)`/g)].map((match) => match[1]), ["SET TRANSACTION READ ONLY"], "único SQL cru é o READ ONLY");
assert.doesNotMatch(scriptSource, /--apply|--write|--execute/, "não existe modo de gravação");

// Constantes espelhadas conferidas contra o código da sincronização.
const sync = source("../services/ultraFv3SyncService.ts");
assert.ok(sync.includes(`const PARTNERS_CONFIG_KEY = "${PARTNERS_CONFIG_KEY}";`));
assert.ok(sync.includes(`const PARTNERS_LAST_SEEN_CONFIG_KEY = "${PARTNERS_LAST_SEEN_CONFIG_KEY}";`), "chave da data de visto do /partners divergente");
const codeBlock = /export const pickUltraFv3PartnerCode = [\s\S]*?\]\)\);/.exec(sync)?.[0] ?? "";
assert.deepEqual([...codeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_CODE_KEYS, "chaves do código do parceiro divergentes");
const sellerBlock = /const partnerSellerCodeKeys = \[[\s\S]*?\];/.exec(sync)?.[0] ?? "";
assert.deepEqual([...sellerBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]), PARTNER_SELLER_CODE_KEYS, "chaves do vendedor do parceiro divergentes");
assert.ok(sync.includes('value.trim().replace(/^0+(?=\\d)/, "") || value.trim();'), "normalização do código do parceiro mudou");
assert.ok(sync.includes('return String(raw).trim().toUpperCase() === "S" ? "customer" : "not_customer";'), "regra do IDN_CLIENTE mudou");
const globalPartners = sync.slice(sync.indexOf("export async function syncPartners("), sync.indexOf("export async function syncPartnersByUser("));
assert.ok(globalPartners.includes("await cachePartnerRows(rows);"), "cache do /partners no caminho global");
assert.ok(globalPartners.indexOf("await cachePartnerRows(rows);") < globalPartners.indexOf("classifyPartnerCustomerFlag("), "cache do /partners deve guardar as linhas antes do filtro IDN_CLIENTE");
assert.match(source("../services/commercialAutomationsService.ts"), /if \(client\.lastPurchaseDate\) return client\.lastPurchaseDate;\s*return parseDateValue\(readFinancialProfileRecord\(client\.financialProfile\)\.DATA_ULTFATURA\);/, "fonte da data de compra mudou");

// Cada texto de evento de sistema existe no código e é reconhecido pelo script.
const legacy = source("./erpFixLegacyDuplicates.ts");
const communications = source("../services/communications/communicationIntegrationService.ts");
const cleanupArchive = source("../services/portfolioCleanupArchive.ts");
const systemSamples: [string, string, string][] = [
  [sync, "Cliente atualizado via UltraFV3. Vendedor alterado de ${", "Cliente atualizado via UltraFV3. Vendedor alterado de Fulano para Beltrano. Oportunidades, atividades, autores e datas históricas foram preservados."],
  [sync, "fundido ao cliente principal via sincronização UltraFV3.", "Cadastro duplicado Cliente Fictício (C-1) fundido ao cliente principal via sincronização UltraFV3. Histórico e relacionamentos preservados no cadastro principal."],
  [sync, "Duplicado arquivado automaticamente via UltraFV3: ${", "Duplicado arquivado automaticamente via UltraFV3: Cliente Fictício. Motivo: cadastro fundido ao cliente principal."],
  [sync, '"Tenant comprovado e adotado por sincronização UltraFV3 autenticada.', "Tenant comprovado e adotado por sincronização UltraFV3 autenticada. Históricos, autoria e datas foram preservados."],
  [sync, '"Cliente reativado automaticamente pela sincronização UltraFV3 ', "Cliente reativado automaticamente pela sincronização UltraFV3 por corresponder ao cadastro principal do ERP."],
  [legacy, '"Duplicado legado arquivado automaticamente pelo saneamento UltraFV3.', "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3."],
  [legacy, "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3: ${", "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3: Cliente Fictício."],
  [legacy, "fundido ao cliente principal pelo saneamento UltraFV3.", "Cadastro legado duplicado Cliente Fictício (C-2) fundido ao cliente principal pelo saneamento UltraFV3. Histórico, oportunidades, atividades e timeline foram preservados no cliente principal."],
  [communications, 'const timelineDescription = "Nova mensagem recebida pelo WhatsApp oficial.";', "Nova mensagem recebida pelo WhatsApp oficial."],
  [cleanupArchive, 'PORTFOLIO_CLEANUP_REACTIVATION_DESCRIPTION = "Cliente reativado automaticamente por nova compra no ERP";', "Cliente reativado automaticamente por nova compra no ERP"],
];
for (const [file, fragment, sample] of systemSamples) {
  assert.ok(file.includes(fragment), `texto de evento de sistema mudou: ${fragment}`);
  assert.ok(isSystemTimeline(sample), `não reconheceu evento de sistema: ${sample}`);
}
for (const human of ["Contato via WhatsApp", "Atividade criada: visita", "Anotação fictícia do vendedor", "Cliente atualizado via UltraFV3 manualmente", "Nova mensagem recebida pelo WhatsApp oficial. Resposta do vendedor"]) {
  assert.equal(isSystemTimeline(human), false, `evento humano tratado como sistema: ${human}`);
}

// ---------------------------------------------------------------------------------------------
// Janela de 24 meses em Brasília.
const now = new Date("2026-10-16T12:00:00.000Z");
assert.equal(purchaseWindowStart(now).toISOString(), "2024-10-16T03:00:00.000Z");
assert.equal(purchaseWindowStart(new Date("2026-10-17T02:59:59.000Z")).toISOString(), "2024-10-16T03:00:00.000Z", "23:59 em Brasília ainda é o dia 16");
assert.equal(purchaseWindowStart(new Date("2026-10-17T03:00:00.000Z")).toISOString(), "2024-10-17T03:00:00.000Z");
assert.equal(purchaseWindowStart(new Date("2028-02-29T15:00:00.000Z")).toISOString(), "2026-02-28T03:00:00.000Z", "29/02 vira o último dia do mês");
assert.equal(purchaseWindowStart(new Date("2026-01-10T15:00:00.000Z")).toISOString(), "2024-01-10T03:00:00.000Z");

assert.deepEqual(resolvePurchaseDate({ lastPurchaseDate: null, financialProfile: null }), { date: null, source: "semData" });
assert.equal(resolvePurchaseDate({ lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: "não é data" } }).source, "dataInvalida");
assert.equal(resolvePurchaseDate({ lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: "2025-01-01T03:00:00.000Z" } }).source, "perfilFinanceiro");
assert.equal(resolvePurchaseDate({ lastPurchaseDate: new Date("2020-01-01"), financialProfile: { DATA_ULTFATURA: "2025-01-01" } }).source, "lastPurchaseDate", "lastPurchaseDate tem prioridade");

// ---------------------------------------------------------------------------------------------
// Fixtures fictícias: um cliente por critério.
const users = [
  { id: "u-ativo", name: "Vendedora Ficticia", isActive: true, erpCode: "101", email: "x@exemplo.invalid" },
  { id: "u-saiu", name: "Vendedor Desligado Ficticio", isActive: true, erpCode: "202", email: "y@exemplo.invalid" },
  { id: "u-inativo", name: "Vendedor Inativo Ficticio", isActive: false, erpCode: "303", email: "z@exemplo.invalid" },
];
let sequence = 0;
const client = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: `cli-${key}`,
  code: String(48000 + ++sequence),
  name: `Cliente Secreto ${key}`,
  cnpj: `00.000.000/000${sequence}-00`,
  city: "Cidade Ficticia",
  state: "XX",
  isArchived: false,
  archiveReason: null,
  ownerSellerId: "u-ativo",
  lastPurchaseDate: null,
  financialProfile: null,
  ...overrides,
});
const C = {
  semNada: client("sem-nada"),
  compraAntiga: client("compra-antiga", { lastPurchaseDate: new Date("2024-10-16T02:59:59.999Z") }),
  compraNoLimite: client("compra-no-limite", { lastPurchaseDate: new Date("2024-10-16T03:00:00.000Z") }),
  perfilRecente: client("perfil-recente", { financialProfile: { DATA_ULTFATURA: "2026-03-09T03:00:00.000Z" } }),
  perfilAntigo: client("perfil-antigo", { financialProfile: { DATA_ULTFATURA: "2019-03-09T03:00:00.000Z" } }),
  dataInvalida: client("data-invalida", { financialProfile: { DATA_ULTFATURA: "??" } }),
  atividade: client("atividade"),
  agenda: client("agenda"),
  parada: client("parada"),
  contato: client("contato"),
  conversa: client("conversa"),
  timelineHumana: client("timeline-humana"),
  timelineSistema: client("timeline-sistema"),
  oportunidade: client("oportunidade"),
  pedido: client("pedido"),
  arquivadoFusao: client("arquivado-fusao", { isArchived: true, archiveReason: "MERGED_INTO:cli-sem-nada" }),
  arquivadoOutro: client("arquivado-outro", { isArchived: true }),
  semCodigo: client("sem-codigo", { code: null }),
  semCodigoProtegido: client("sem-codigo-protegido", { code: "  " }),
  desligadoCandidato: client("desligado-candidato", { ownerSellerId: "u-saiu" }),
  desligadoProtegido: client("desligado-protegido", { ownerSellerId: "u-saiu" }),
  desligadoSemCodigo: client("desligado-sem-codigo", { ownerSellerId: "u-saiu", code: null }),
  inativoCandidato: client("inativo-candidato", { ownerSellerId: "u-inativo" }),
  arquivadoLimpeza: client("arquivado-limpeza", { isArchived: true, archiveReason: "PORTFOLIO_CLEANUP:2026-09-01T12:00:00.000Z" }),
  arquivadoLegado: client("arquivado-legado", { isArchived: true, archiveReason: "legacy_duplicate_cleanup" }),
  arquivadoTextoLivre: client("arquivado-texto-livre", { isArchived: true, archiveReason: "Duplicado do Cliente Secreto X" }),
};
const opportunities = [
  { id: "opp-1", clientId: C.oportunidade.id, title: "Oportunidade secreta" },
  { id: "opp-2", clientId: C.pedido.id, title: "Pedido secreto" },
  { id: "opp-3", clientId: C.desligadoProtegido.id, title: "x" },
  { id: "opp-4", clientId: C.semCodigoProtegido.id, title: "x" },
];
const tables: Record<string, Record<string, unknown>[]> = {
  client: Object.values(C),
  user: users,
  opportunity: opportunities,
  erpOrderSync: [{ id: "ord-1", opportunityId: "opp-2" }, { id: "ord-2", opportunityId: "opp-2" }],
  activity: [{ id: "a-1", clientId: C.atividade.id }, { id: "a-2", clientId: null }, { id: "a-3", clientId: C.atividade.id }],
  agendaEvent: [{ id: "e-1", clientId: C.agenda.id }],
  agendaStop: [{ id: "s-1", clientId: C.parada.id, checkInAt: new Date() }],
  contact: [{ id: "k-1", clientId: C.contato.id, name: "Contato Secreto" }],
  communicationConversation: [{ id: "w-1", clientId: C.conversa.id }],
  timelineEvent: [
    { id: "t-1", clientId: C.timelineHumana.id, opportunityId: null, description: "Anotação fictícia do vendedor" },
    { id: "t-2", clientId: C.timelineSistema.id, opportunityId: null, description: systemSamples[0][2] },
    { id: "t-3", clientId: C.timelineSistema.id, opportunityId: null, description: systemSamples[4][2] },
    { id: "t-4", clientId: C.semNada.id, opportunityId: "opp-1", description: "Evento de oportunidade de outro cliente" },
    { id: "t-5", clientId: null, opportunityId: null, description: "Auditoria territorial fictícia" },
  ],
  appConfig: [{ key: PARTNERS_CONFIG_KEY, value: JSON.stringify([
    { PARCEIRO: `00${C.semNada.code}`, IDN_CLIENTE: "N", VENDEDOR_DO_PARCEIRO: "999" },
    { CODPARCEIRO: C.compraAntiga.code, IDN_CLIENTE: " s ", VENDEDOR_DO_PARCEIRO: "0101" },
    { PARCEIRO: C.perfilAntigo.code, IDN_CLIENTE: "S", CODVENDEDOR: "202" },
    { PARCEIRO: C.timelineSistema.code, VENDEDOR: "303" },
    { PARCEIRO: C.dataInvalida.code, IDN_CLIENTE: "S" },
    { PARCEIRO: C.oportunidade.code, IDN_CLIENTE: "N", VENDEDOR_DO_PARCEIRO: "999" },
    { PARCEIRO: C.desligadoProtegido.code, IDN_CLIENTE: "S", VENDEDOR_DO_PARCEIRO: "303" },
    "linha inválida",
  ]) }, { key: PARTNERS_LAST_SEEN_CONFIG_KEY, value: JSON.stringify({
    [C.semNada.code]: "2026-10-16T10:00:00.000Z",
    [C.compraAntiga.code]: "2026-10-13T12:00:00.000Z",
    [C.perfilAntigo.code]: "2026-09-16T12:00:00.000Z",
    [C.desligadoProtegido.code]: "2026-10-06T12:00:00.000Z",
    [C.dataInvalida.code]: 42,
  }) }],
};

// Banco em memória somente leitura: só findMany/findUnique (qualquer escrita quebra).
const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, condition]) =>
    condition && typeof condition === "object" && "not" in (condition as object)
      ? row[key] !== (condition as { not: unknown }).not
      : row[key] === condition);
const createDb = () => {
  const delegate = (name: string) => ({
    async findMany(args: unknown) {
      const { where, select, distinct } = (args ?? {}) as { where?: Record<string, unknown>; select?: Record<string, boolean>; distinct?: string[] };
      let rows = tables[name].filter((row) => matches(row, where));
      if (distinct) {
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          const key = JSON.stringify(distinct.map((field) => row[field]));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      return rows.map((row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])) : structuredClone(row)));
    },
    async findUnique(args: unknown) {
      const { where, select } = args as { where: Record<string, unknown>; select?: Record<string, boolean> };
      const row = tables[name].find((candidate) => matches(candidate, where));
      return row ? (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row) : null;
    },
  });
  return Object.fromEntries(Object.keys(tables).map((name) => [name, delegate(name)])) as unknown as PortfolioDb;
};

// ---------------------------------------------------------------------------------------------
// Classificação: cada critério separa protegido de candidato.
const input = await loadPortfolioInput(createDb());
const verdicts = new Map(classifyClients(input, now).map((verdict) => [verdict.client.id, verdict]));
const verdictOf = (row: { id: string }) => verdicts.get(row.id)!;
const expectCandidate = (row: { id: string }, kind: string) => {
  assert.equal(verdictOf(row).matchesRule, true, `${row.id} deveria ser candidato`);
  assert.equal(verdictOf(row).candidateKind, kind, row.id);
};
const expectProtected = (row: { id: string }, reasons: string[], humanSources: string[] = []) => {
  assert.equal(verdictOf(row).matchesRule, false, `${row.id} deveria ser protegido`);
  assert.deepEqual(verdictOf(row).reasons, reasons, row.id);
  assert.deepEqual(verdictOf(row).humanSources, humanSources, row.id);
};
expectCandidate(C.semNada, "semDataDeCompra");
expectCandidate(C.compraAntiga, "ultimaCompraHaMaisDe24Meses");
expectProtected(C.compraNoLimite, ["compraUltimos24Meses"]);
expectProtected(C.perfilRecente, ["compraUltimos24Meses"]);
expectCandidate(C.perfilAntigo, "ultimaCompraHaMaisDe24Meses");
expectCandidate(C.dataInvalida, "semDataDeCompra");
expectProtected(C.atividade, ["historicoHumano"], ["atividade"]);
expectProtected(C.agenda, ["historicoHumano"], ["agenda"]);
expectProtected(C.parada, ["historicoHumano"], ["paradaDeRoteiro"]);
expectProtected(C.contato, ["historicoHumano"], ["contato"]);
expectProtected(C.conversa, ["historicoHumano"], ["conversaWhatsapp"]);
expectProtected(C.timelineHumana, ["historicoHumano"], ["timelineDeUsuario"]);
expectCandidate(C.timelineSistema, "semDataDeCompra");
expectProtected(C.oportunidade, ["oportunidade"]);
expectProtected(C.pedido, ["oportunidade", "pedido"]);
assert.equal(verdictOf(C.arquivadoFusao).state, "arquivadoPorFusao");
assert.equal(verdictOf(C.arquivadoFusao).matchesRule, false, "arquivado nunca é candidato");
assert.equal(verdictOf(C.arquivadoOutro).state, "arquivadoOutros");
assert.equal(verdictOf(C.semCodigoProtegido).hasErpCode, false, "código em branco conta como sem código");

// ---------------------------------------------------------------------------------------------
// Resumo.
const summary = summarizePortfolio(input, { now, departedUserNames: ["vendedor desligado ficticio", "Usuário Que Não Existe"] });
assert.deepEqual(summary.referencia, { hojeBrasilia: "2026-10-16", compraRecenteDesde: "2024-10-16 00:00 (Brasília)" });
assert.deepEqual(summary.clientesPorEstado, { total: 26, arquivadoOutros: 4, arquivadoPorFusao: 1, naoArquivado: 21 });

const main = summary.naoArquivadosComCodigoErp;
assert.equal(main.total, 18);
assert.deepEqual(main.candidatos, { total: 7, semDataDeCompra: 5, ultimaCompraHaMaisDe24Meses: 2 });
assert.equal(main.candidatos.semDataDeCompra + main.candidatos.ultimaCompraHaMaisDe24Meses, main.candidatos.total);
assert.equal(main.protegidos.total, 11);
assert.deepEqual(main.protegidos.porMotivo, { historicoHumano: 6, oportunidade: 3, pedido: 1, compraUltimos24Meses: 2 });
assert.deepEqual(main.protegidos.somenteUmMotivo, { historicoHumano: 6, oportunidade: 2, pedido: 0, compraUltimos24Meses: 2 });
assert.deepEqual(main.protegidos.historicoHumanoPorOrigem, { atividade: 1, agenda: 1, paradaDeRoteiro: 1, contato: 1, conversaWhatsapp: 1, timelineDeUsuario: 1 });
assert.deepEqual(main.candidatosPorFonteDaDataDeCompra, { dataInvalida: 1, lastPurchaseDate: 1, perfilFinanceiro: 1, semData: 4 });

assert.deepEqual(summary.porVendedor.map((row) => [row.vendedor, row.usuarioAtivo, row.informadoComoDesligado, row.destaque, row.candidatos, row.protegidos]), [
  ["Vendedor Desligado Ficticio", true, true, true, 1, 1],
  ["Vendedor Inativo Ficticio", false, false, true, 1, 0],
  ["Vendedora Ficticia", true, false, false, 5, 10],
]);

assert.deepEqual(summary.usuariosDesligados[0], {
  usuario: "vendedor desligado ficticio",
  encontrado: true,
  usuarioAtivo: true,
  clientesNaoArquivados: 3,
  candidatos: 1,
  naoCandidatosPrecisamTransferencia: 2,
  naoCandidatosPorMotivo: { historicoHumano: 0, oportunidade: 1, pedido: 0, compraUltimos24Meses: 0 },
  naoCandidatosSemCodigoErp: 1,
});
assert.equal(summary.usuariosDesligados[1].encontrado, false);
assert.equal(summary.usuariosDesligados[1].clientesNaoArquivados, 0);

assert.equal(summary.semCodigoErp.total, 3);
assert.deepEqual(summary.semCodigoErp.candidatos, { total: 2, semDataDeCompra: 2, ultimaCompraHaMaisDe24Meses: 0 });
assert.equal(summary.semCodigoErp.protegidos.porMotivo.oportunidade, 1);

const erp = summary.erpCacheParceiros;
assert.equal(erp.linhasNoCache, 7, "linha não-objeto é ignorada");
assert.equal(erp.linhasComDataDeVisto, 4, "data de visto que não é texto é ignorada");
assert.equal(erp.candidatos.encontradosNoCache, 5, "código com zeros à esquerda é normalizado");
assert.equal(erp.candidatos.ausentesDoCache, 2);
assert.deepEqual(erp.candidatos.idnCliente, { N: 1, S: 3, ausente: 1 });
assert.deepEqual(erp.candidatos.vendedorErp, { semCodigoDeVendedor: 1, semUsuarioNoCrm: 1, usuarioAtivo: 2, usuarioInativo: 1 });
assert.equal(erp.candidatos.idnClienteNEVendedorSemUsuario, 1);
assert.equal(erp.candidatos.vendedorErpDiferenteDoResponsavelNoCrm, 2, "vendedor do ERP com usuário diferente do responsável no CRM");
assert.deepEqual(erp.candidatos.idadeDaLinhaNoCache, { semDataDeVisto: 2, vistaHa1a7Dias: 1, vistaHaAte1Dia: 1, vistaHaMaisDe7Dias: 1 });
assert.deepEqual(erp.protegidos.idnCliente, { N: 1, S: 1 });
assert.deepEqual(erp.protegidos.vendedorErp, { semUsuarioNoCrm: 1, usuarioInativo: 1 });
assert.deepEqual(erp.protegidos.idadeDaLinhaNoCache, { semDataDeVisto: 1, vistaHaMaisDe7Dias: 1 });

// Cruzamento dos candidatos com código: IDN_CLIENTE (S / N / sem campo / ausente do cache) × tipo de candidato.
assert.deepEqual(erp.candidatosIdnClientePorCompra, {
  S: { total: 3, semDataDeCompra: 1, ultimaCompraHaMaisDe24Meses: 2 },
  N: { total: 1, semDataDeCompra: 1, ultimaCompraHaMaisDe24Meses: 0 },
  semCampoIdnCliente: { total: 1, semDataDeCompra: 1, ultimaCompraHaMaisDe24Meses: 0 },
  ausenteDoCache: { total: 2, semDataDeCompra: 2, ultimaCompraHaMaisDe24Meses: 0 },
});
const crossTotal = Object.values(erp.candidatosIdnClientePorCompra).reduce((total, group) => total + group.total, 0);
assert.equal(crossTotal, main.candidatos.total, "o cruzamento cobre todos os candidatos com código");

// Arquivados por prefixo do motivo, sem IDs nem texto livre.
assert.deepEqual(summary.arquivadosPorMotivo, {
  total: 5,
  porPrefixo: { "(sem motivo)": 1, "(texto livre)": 1, legacy_duplicate_cleanup: 1, "MERGED_INTO:": 1, "PORTFOLIO_CLEANUP:": 1 },
});
assert.equal(archiveReasonGroup("MERGED_INTO:cli-123"), "MERGED_INTO:");
assert.equal(archiveReasonGroup("  "), "(sem motivo)");
assert.equal(archiveReasonGroup("manual_duplicate_merge"), "manual_duplicate_merge");
assert.equal(archiveReasonGroup("Fulano: duplicado"), "(texto livre)", "texto livre com dois-pontos não vira prefixo");
assert.equal(archiveReasonGroup("cliente 123"), "(texto livre)");

assert.equal(cacheLineAge(undefined, now), "semDataDeVisto");
assert.equal(cacheLineAge("não é data", now), "semDataDeVisto");
assert.equal(cacheLineAge("2026-10-15T12:00:00.000Z", now), "vistaHaAte1Dia", "exatamente 24 horas");
assert.equal(cacheLineAge("2026-10-09T12:00:00.000Z", now), "vistaHa1a7Dias", "exatamente 7 dias");
assert.equal(cacheLineAge("2026-10-09T11:59:59.000Z", now), "vistaHaMaisDe7Dias");

// Sem registro de data de visto (cache anterior a este PR): avisa.
const noLastSeen = summarizePortfolio({ ...input, partnerLastSeen: null }, { now, departedUserNames: [] });
assert.ok(noLastSeen.avisos.some((line) => line.includes(PARTNERS_LAST_SEEN_CONFIG_KEY)));
assert.deepEqual(noLastSeen.erpCacheParceiros.candidatos.idadeDaLinhaNoCache, { semDataDeVisto: 5 });

// Sem cache: avisa e não quebra.
const noCache = summarizePortfolio({ ...input, partnerCacheRows: null }, { now, departedUserNames: [] });
assert.equal(noCache.erpCacheParceiros.candidatos.encontradosNoCache, 0);
assert.ok(noCache.avisos.some((line) => line.includes("Sem cache")));

// ---------------------------------------------------------------------------------------------
// CLI: argumentos, client criado só depois da validação, transação READ ONLY e nada vazado.
assert.deepEqual(parseCliArgs([]), { departedUserNames: [], listTransfers: false });
assert.deepEqual(parseCliArgs(["--departed-user=Fulano de Tal", "--departed-user= Beltrano "]), { departedUserNames: ["Fulano de Tal", "Beltrano"], listTransfers: false });
assert.deepEqual(parseCliArgs(["--list-transfers", "--departed-user=Fulano"]), { departedUserNames: ["Fulano"], listTransfers: true });
const invalidArgs = [
  ["--apply"], ["--departed-user="], ["--departed-user=  "], ["--departed-user"], ["--departed-user=Fulano", "--departed-user=fulano"], ["Fulano"], ["--write"],
  // --list-transfers só junto com --departed-user.
  ["--list-transfers"], ["--list-transfers", "--list-transfers", "--departed-user=Fulano"], ["--list-transfers=1", "--departed-user=Fulano"],
];
for (const args of invalidArgs) {
  assert.throws(() => parseCliArgs(args), /uso: simulateClientPortfolioCleanup/, JSON.stringify(args));
  let created = 0;
  await assert.rejects(runCli(args, () => { created += 1; throw new Error("não deveria criar o client"); }, () => undefined), /uso: simulateClientPortfolioCleanup/);
  assert.equal(created, 0, `client criado com argumentos inválidos: ${JSON.stringify(args)}`);
}

const statements: string[] = [];
let disconnected = false;
let transactionOptions: unknown;
const db = createDb();
const fakeClient: PortfolioClient = {
  async $transaction(fn, options) {
    transactionOptions = options;
    const tx = new Proxy(db as Record<string, unknown>, {
      get(target, property) {
        if (property === "$executeRaw") return async (query: TemplateStringsArray) => { statements.push(query.join("?")); return 0; };
        const value = target[property as string];
        if (value === undefined) throw new Error(`acesso inesperado: ${String(property)}`);
        // Cada leitura só depois do READ ONLY.
        return new Proxy(value as object, { get(delegate, method) {
          assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"], "leitura antes do READ ONLY");
          return (delegate as Record<string, unknown>)[method as string];
        } });
      },
    });
    return fn(tx);
  },
  async $disconnect() { disconnected = true; },
};
const printed: string[] = [];
const transfersWithoutFlag: string[] = [];
await runCli(["--departed-user=Vendedor Desligado Ficticio"], () => fakeClient, (line) => printed.push(line), now, (line) => transfersWithoutFlag.push(line));
assert.deepEqual(transfersWithoutFlag, [], "sem --list-transfers não lista clientes");
assert.ok(disconnected);
assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
assert.deepEqual(transactionOptions, { isolationLevel: "RepeatableRead", timeout: 120_000 });
const output = printed.join("\n");
assert.deepEqual(JSON.parse(output).naoArquivadosComCodigoErp.candidatos, main.candidatos);
const assertNoClientData = (text: string) => {
  for (const row of [...Object.values(C), ...opportunities, ...tables.contact]) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string" || !value.trim() || value.startsWith("u-") || value === "x") continue;
      // Identificador de motivo de arquivamento (snake_case) sai agrupado; não é dado de cliente.
      if (key === "archiveReason" && archiveReasonGroup(value) === value) continue;
      assert.ok(!text.includes(value), `saída vazou ${value}`);
    }
  }
  for (const secret of ["999", "0101", "Anotação fictícia", "Cliente Secreto", "2026-09-01T12"]) assert.ok(!text.includes(secret), `saída vazou ${secret}`);
};
assertNoClientData(output);

// --list-transfers: a lista vai só para o logger de transferências (stderr); o resumo (stdout) não muda.
statements.length = 0;
const listedSummary: string[] = [];
const transfers: string[] = [];
await runCli(["--departed-user=Vendedor Desligado Ficticio", "--list-transfers"], () => fakeClient, (line) => listedSummary.push(line), now, (line) => transfers.push(line));
assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
assert.deepEqual(JSON.parse(listedSummary.join("\n")), JSON.parse(output), "o resumo é o mesmo com ou sem a lista");
assertNoClientData(listedSummary.join("\n"));
assert.match(transfers[0], /^--list-transfers: 2 cliente\(s\) a transferir\. Só no terminal/);
assert.equal(transfers[1], "usuario\tcodigoErp\tnome\tcidadeUf\tmotivos\tvendedorErp\tlinhaDoCache");
assert.deepEqual(transfers.slice(2), [
  ["Vendedor Desligado Ficticio", C.desligadoProtegido.code, C.desligadoProtegido.name, "Cidade Ficticia/XX", "oportunidade", "303 (Vendedor Inativo Ficticio, inativo)", "vista em 2026-10-06"].join("\t"),
  ["Vendedor Desligado Ficticio", "(sem código)", C.desligadoSemCodigo.name, "Cidade Ficticia/XX", "semCodigoErp", "(sem código ERP)", "-"].join("\t"),
], "só os não candidatos do usuário desligado");
assert.ok(!transfers.join("\n").includes(C.desligadoCandidato.name), "candidato não entra na lista de transferência");

// Sem --list-transfers o loader nem lê nome, cidade e UF dos clientes.
assert.equal((await loadPortfolioInput(createDb())).clients[0].name, undefined);
const detailed = await loadPortfolioInput(createDb(), { withClientDetails: true });
assert.equal(detailed.clients[0].name, C.semNada.name);
assert.deepEqual(buildTransferList(detailed, { now, departedUserNames: ["Usuário Que Não Existe"] }), [], "usuário desligado inexistente: lista vazia");
const sellerStatuses = buildTransferList({ ...detailed, partnerCacheRows: null }, { now, departedUserNames: ["Vendedor Desligado Ficticio"] }).map((row) => row.vendedorErp);
assert.deepEqual(sellerStatuses, ["(ausente do cache)", "(sem código ERP)"]);

console.log("simulateClientPortfolioCleanup tests passed");
