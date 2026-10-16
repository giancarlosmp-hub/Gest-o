/**
 * Simulação SOMENTE LEITURA da limpeza da carteira de clientes. Não existe modo que grave.
 *
 * Regra aprovada para arquivar no futuro: cliente não arquivado, com código ERP, sem histórico humano
 * no CRM, sem oportunidade, sem pedido no CRM e sem compra no ERP nos últimos 24 meses (Brasília).
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/simulateClientPortfolioCleanup.js [--departed-user="Nome do usuário"]...
 *
 * --departed-user (repetível): usuários do CRM que saíram da empresa. O relatório lista quantos
 * clientes deles NÃO são candidatos (precisam ser transferidos antes de desativar o usuário).
 *
 * Autocontido: importa só @prisma/client e módulos do Node (teste de contrato em
 * simulateClientPortfolioCleanup.test.ts). Lê tudo numa transação READ ONLY. A saída traz só
 * contagens e nomes de usuários do CRM: nunca nome, código, documento ou ID de cliente.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

// Constantes espelhadas de ultraFv3SyncService.ts (conferidas pelo teste de contrato).
export const PARTNERS_CONFIG_KEY = "erp.ultrafv3.partners";
export const PARTNER_CODE_KEYS = ["PARCEIRO", "CODPARCEIRO", "CODCLIENTE", "code", "erpCode", "codigo", "CODIGO", "partnerCode", "PARCEIRO_OUT", "IDPARCEIRO"];
export const PARTNER_SELLER_CODE_KEYS = ["VENDEDOR_DO_PARCEIRO", "CODVENDEDOR", "sellerCode", "salesmanCode", "codVendedor", "vendedorCodigo", "VENDEDOR"];
export const MERGED_ARCHIVE_REASON_PREFIX = "MERGED_INTO:";

/**
 * Eventos de timeline sem oportunidade gravados por sincronização, saneamento ou integração (não por
 * usuário). Qualquer outro evento de cliente conta como histórico humano (na dúvida, protege).
 */
export const SYSTEM_TIMELINE_PATTERNS: RegExp[] = [
  /^Cliente atualizado via UltraFV3\. Vendedor alterado de /,
  /^Cadastro duplicado .* fundido ao cliente principal via sincronização UltraFV3\./,
  /^Duplicado arquivado automaticamente via UltraFV3: /,
  /^Tenant comprovado e adotado por sincronização UltraFV3 autenticada\./,
  /^Cliente reativado automaticamente pela sincronização UltraFV3 /,
  /^Duplicado legado arquivado automaticamente pelo saneamento UltraFV3/,
  /^Cadastro legado duplicado .* fundido ao cliente principal pelo saneamento UltraFV3\./,
  /^Nova mensagem recebida pelo WhatsApp oficial\.$/,
];

export const PURCHASE_WINDOW_MONTHS = 24;
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, sem horário de verão desde 2019.

export type ClientRow = {
  id: string;
  code: string | null;
  isArchived: boolean;
  archiveReason: string | null;
  ownerSellerId: string;
  lastPurchaseDate: Date | null;
  financialProfile: unknown;
};
export type UserRow = { id: string; name: string; isActive: boolean; erpCode: string | null };
export type TimelineRow = { clientId: string | null; description: string };
export type HumanSource = "atividade" | "agenda" | "paradaDeRoteiro" | "contato" | "conversaWhatsapp" | "timelineDeUsuario";
export type ProtectionReason = "historicoHumano" | "oportunidade" | "pedido" | "compraUltimos24Meses";

export type PortfolioInput = {
  clients: ClientRow[];
  users: UserRow[];
  /** clientId por fonte de histórico humano (sem timeline). */
  humanSources: Record<Exclude<HumanSource, "timelineDeUsuario">, (string | null)[]>;
  /** Eventos de timeline de cliente sem oportunidade. */
  clientTimeline: TimelineRow[];
  opportunities: { id: string; clientId: string }[];
  /** opportunityId das tentativas de pedido ERP. */
  orderOpportunityIds: string[];
  /** Linhas brutas do cache do /partners (AppConfig), ou null se não houver cache. */
  partnerCacheRows: unknown[] | null;
};

// ---------------------------------------------------------------------------------------------
// Datas (Brasília).

export const brasiliaDayKey = (date: Date) => new Date(date.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);

/** 00:00 em Brasília do mesmo dia do calendário, `months` meses antes de hoje (dia 31 vira o último dia do mês). */
export function purchaseWindowStart(now: Date, months = PURCHASE_WINDOW_MONTHS) {
  const [year, month, day] = brasiliaDayKey(now).split("-").map(Number);
  const totalMonths = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)) + BRASILIA_OFFSET_MS);
}

/** Mesma fonte de resolvePurchaseDate (commercialAutomationsService): lastPurchaseDate, senão DATA_ULTFATURA do perfil financeiro. */
export function resolvePurchaseDate(client: Pick<ClientRow, "lastPurchaseDate" | "financialProfile">): { date: Date | null; source: "lastPurchaseDate" | "perfilFinanceiro" | "semData" | "dataInvalida" } {
  if (client.lastPurchaseDate) return { date: client.lastPurchaseDate, source: "lastPurchaseDate" };
  const profile = client.financialProfile;
  const raw = profile && typeof profile === "object" && !Array.isArray(profile) ? (profile as Record<string, unknown>).DATA_ULTFATURA : undefined;
  if (raw === undefined || raw === null || raw === "") return { date: null, source: "semData" };
  const parsed = typeof raw === "string" || typeof raw === "number" ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return { date: null, source: "dataInvalida" };
  return { date: parsed, source: "perfilFinanceiro" };
}

// ---------------------------------------------------------------------------------------------
// Cache bruto do /partners.

export const normalizePartnerCode = (value: string) => value.trim().replace(/^0+(?=\d)/, "") || value.trim();

const pickFirstString = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
};

export type CustomerFlag = "S" | "N" | "ausente";
export const classifyCustomerFlag = (payload: Record<string, unknown>): CustomerFlag => {
  const raw = payload.IDN_CLIENTE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "ausente";
  return String(raw).trim().toUpperCase() === "S" ? "S" : "N";
};

export function indexPartnerCache(rows: unknown[] | null) {
  const byCode = new Map<string, Record<string, unknown>>();
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const code = normalizePartnerCode(pickFirstString(row as Record<string, unknown>, PARTNER_CODE_KEYS));
    if (code) byCode.set(code, row as Record<string, unknown>);
  }
  return byCode;
}

export const parsePartnerCache = (value: string | null | undefined): unknown[] | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Classificação.

export const isSystemTimeline = (description: string) => SYSTEM_TIMELINE_PATTERNS.some((pattern) => pattern.test(description));

export type ClientVerdict = {
  client: ClientRow;
  state: "naoArquivado" | "arquivadoPorFusao" | "arquivadoOutros";
  hasErpCode: boolean;
  reasons: ProtectionReason[];
  humanSources: HumanSource[];
  purchase: ReturnType<typeof resolvePurchaseDate>;
  /** Só para não arquivados: todos os critérios da regra atendidos (sem olhar o código ERP). */
  matchesRule: boolean;
  candidateKind: "semDataDeCompra" | "ultimaCompraHaMaisDe24Meses" | null;
};

export function classifyClients(input: PortfolioInput, now: Date): ClientVerdict[] {
  const cutoff = purchaseWindowStart(now);
  const human = new Map<string, Set<HumanSource>>();
  const addHuman = (clientId: string | null, source: HumanSource) => {
    if (!clientId) return;
    if (!human.has(clientId)) human.set(clientId, new Set());
    human.get(clientId)!.add(source);
  };
  for (const [source, ids] of Object.entries(input.humanSources) as [HumanSource, (string | null)[]][]) {
    for (const clientId of ids) addHuman(clientId, source);
  }
  for (const event of input.clientTimeline) {
    if (!isSystemTimeline(event.description)) addHuman(event.clientId, "timelineDeUsuario");
  }
  const withOpportunity = new Set(input.opportunities.map((row) => row.clientId));
  const opportunityClient = new Map(input.opportunities.map((row) => [row.id, row.clientId]));
  const withOrder = new Set(input.orderOpportunityIds.map((id) => opportunityClient.get(id)).filter((id): id is string => Boolean(id)));

  return input.clients.map((client) => {
    const state = !client.isArchived ? "naoArquivado" : client.archiveReason?.startsWith(MERGED_ARCHIVE_REASON_PREFIX) ? "arquivadoPorFusao" : "arquivadoOutros";
    const purchase = resolvePurchaseDate(client);
    const humanSources = [...(human.get(client.id) ?? [])].sort();
    const reasons: ProtectionReason[] = [];
    if (humanSources.length) reasons.push("historicoHumano");
    if (withOpportunity.has(client.id)) reasons.push("oportunidade");
    if (withOrder.has(client.id)) reasons.push("pedido");
    if (purchase.date && purchase.date.getTime() >= cutoff.getTime()) reasons.push("compraUltimos24Meses");
    const matchesRule = state === "naoArquivado" && reasons.length === 0;
    return {
      client,
      state,
      hasErpCode: Boolean(client.code?.trim()),
      reasons,
      humanSources,
      purchase,
      matchesRule,
      candidateKind: matchesRule ? (purchase.date ? "ultimaCompraHaMaisDe24Meses" : "semDataDeCompra") : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Resumo (só contagens).

const normalizeName = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const countBy = <T>(rows: T[], key: (row: T) => string) => {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

const REASONS: ProtectionReason[] = ["historicoHumano", "oportunidade", "pedido", "compraUltimos24Meses"];
const HUMAN_SOURCES: HumanSource[] = ["atividade", "agenda", "paradaDeRoteiro", "contato", "conversaWhatsapp", "timelineDeUsuario"];

function summarizeGroup(verdicts: ClientVerdict[]) {
  const candidates = verdicts.filter((row) => row.matchesRule);
  const protectedRows = verdicts.filter((row) => !row.matchesRule);
  return {
    total: verdicts.length,
    candidatos: {
      total: candidates.length,
      semDataDeCompra: candidates.filter((row) => row.candidateKind === "semDataDeCompra").length,
      ultimaCompraHaMaisDe24Meses: candidates.filter((row) => row.candidateKind === "ultimaCompraHaMaisDe24Meses").length,
    },
    protegidos: {
      total: protectedRows.length,
      // Um cliente pode ter mais de um motivo: cada coluna conta quem tem aquele motivo.
      porMotivo: Object.fromEntries(REASONS.map((reason) => [reason, protectedRows.filter((row) => row.reasons.includes(reason)).length])),
      somenteUmMotivo: Object.fromEntries(REASONS.map((reason) => [reason, protectedRows.filter((row) => row.reasons.length === 1 && row.reasons[0] === reason).length])),
      historicoHumanoPorOrigem: Object.fromEntries(HUMAN_SOURCES.map((source) => [source, protectedRows.filter((row) => row.humanSources.includes(source)).length])),
    },
  };
}

type ErpSellerStatus = "semCodigoDeVendedor" | "semUsuarioNoCrm" | "usuarioInativo" | "usuarioAtivo" | "codigoEmMaisDeUmUsuario";

function summarizeErpCache(verdicts: ClientVerdict[], cache: Map<string, Record<string, unknown>>, users: UserRow[]) {
  const usersByErpCode = new Map<string, UserRow[]>();
  for (const user of users) {
    const code = user.erpCode ? normalizePartnerCode(user.erpCode) : "";
    if (code) usersByErpCode.set(code, [...(usersByErpCode.get(code) ?? []), user]);
  }
  const rows = verdicts.flatMap((verdict) => {
    const row = verdict.client.code ? cache.get(normalizePartnerCode(verdict.client.code)) : undefined;
    return row ? [{ verdict, row }] : [];
  });
  const classified = rows.map(({ verdict, row }) => {
    const sellerCode = normalizePartnerCode(pickFirstString(row, PARTNER_SELLER_CODE_KEYS));
    const sellers = sellerCode ? usersByErpCode.get(sellerCode) ?? [] : [];
    const seller: ErpSellerStatus = !sellerCode ? "semCodigoDeVendedor"
      : !sellers.length ? "semUsuarioNoCrm"
      : sellers.length > 1 ? "codigoEmMaisDeUmUsuario"
      : sellers[0].isActive ? "usuarioAtivo" : "usuarioInativo";
    return { flag: classifyCustomerFlag(row), seller, otherOwner: sellers.length === 1 && sellers[0].id !== verdict.client.ownerSellerId };
  });
  return {
    total: verdicts.length,
    encontradosNoCache: rows.length,
    ausentesDoCache: verdicts.length - rows.length,
    idnCliente: countBy(classified, (row) => row.flag),
    vendedorErp: countBy(classified, (row) => row.seller),
    idnClienteNEVendedorSemUsuario: classified.filter((row) => row.flag === "N" && row.seller === "semUsuarioNoCrm").length,
    vendedorErpDiferenteDoResponsavelNoCrm: classified.filter((row) => row.otherOwner).length,
  };
}

export function summarizePortfolio(input: PortfolioInput, options: { now: Date; departedUserNames: string[] }) {
  const verdicts = classifyClients(input, options.now);
  const usersById = new Map(input.users.map((user) => [user.id, user]));
  const departed = new Set(options.departedUserNames.map(normalizeName));
  const active = verdicts.filter((row) => row.state === "naoArquivado");
  const withCode = active.filter((row) => row.hasErpCode);
  const withoutCode = active.filter((row) => !row.hasErpCode);

  const bySeller = new Map<string, ClientVerdict[]>();
  for (const verdict of withCode) bySeller.set(verdict.client.ownerSellerId, [...(bySeller.get(verdict.client.ownerSellerId) ?? []), verdict]);
  const sellerLabel = (sellerId: string) => usersById.get(sellerId)?.name ?? "(usuário inexistente)";
  const porVendedor = [...bySeller.entries()]
    .map(([sellerId, rows]) => {
      const user = usersById.get(sellerId);
      const group = summarizeGroup(rows);
      return {
        vendedor: sellerLabel(sellerId),
        usuarioAtivo: user?.isActive ?? false,
        informadoComoDesligado: user ? departed.has(normalizeName(user.name)) : false,
        destaque: !user?.isActive || (user ? departed.has(normalizeName(user.name)) : false),
        clientes: group.total,
        candidatos: group.candidatos.total,
        candidatosSemDataDeCompra: group.candidatos.semDataDeCompra,
        candidatosCompraHaMaisDe24Meses: group.candidatos.ultimaCompraHaMaisDe24Meses,
        protegidos: group.protegidos.total,
      };
    })
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor));

  const avisos: string[] = [];
  const departedReport = options.departedUserNames.map((name) => {
    const users = input.users.filter((user) => normalizeName(user.name) === normalizeName(name));
    if (users.length > 1) avisos.push(`Mais de um usuário com o nome informado em --departed-user (${users.length}); contagens somadas.`);
    const ids = new Set(users.map((user) => user.id));
    const rows = active.filter((row) => ids.has(row.client.ownerSellerId));
    const notCandidates = rows.filter((row) => !(row.matchesRule && row.hasErpCode));
    return {
      usuario: name,
      encontrado: users.length > 0,
      usuarioAtivo: users.length ? users.some((user) => user.isActive) : null,
      clientesNaoArquivados: rows.length,
      candidatos: rows.length - notCandidates.length,
      naoCandidatosPrecisamTransferencia: notCandidates.length,
      naoCandidatosPorMotivo: Object.fromEntries(REASONS.map((reason) => [reason, notCandidates.filter((row) => row.reasons.includes(reason)).length])),
      naoCandidatosSemCodigoErp: notCandidates.filter((row) => !row.hasErpCode).length,
    };
  });

  const cache = indexPartnerCache(input.partnerCacheRows);
  if (input.partnerCacheRows === null) avisos.push(`Sem cache do /partners (${PARTNERS_CONFIG_KEY}) legível: IDN_CLIENTE e vendedor do ERP não avaliados.`);
  else avisos.push("O cache do /partners guarda a última linha recebida de cada parceiro; parceiro que deixou de vir (ex.: transferido para vendedor sem credencial no CRM) pode estar desatualizado.");

  const purchaseSourceOf = (rows: ClientVerdict[]) => countBy(rows, (row) => row.purchase.source);
  const candidatesWithCode = withCode.filter((row) => row.matchesRule);
  return {
    modo: "simulação somente leitura (não existe modo de gravação)",
    referencia: {
      hojeBrasilia: brasiliaDayKey(options.now),
      compraRecenteDesde: `${brasiliaDayKey(purchaseWindowStart(options.now))} 00:00 (Brasília)`,
    },
    clientesPorEstado: { total: verdicts.length, ...countBy(verdicts, (row) => row.state) },
    naoArquivadosComCodigoErp: {
      ...summarizeGroup(withCode),
      candidatosPorFonteDaDataDeCompra: purchaseSourceOf(candidatesWithCode),
    },
    porVendedor,
    usuariosDesligados: departedReport,
    semCodigoErp: summarizeGroup(withoutCode),
    erpCacheParceiros: {
      linhasNoCache: cache.size,
      candidatos: summarizeErpCache(candidatesWithCode, cache, input.users),
      protegidos: summarizeErpCache(withCode.filter((row) => !row.matchesRule), cache, input.users),
    },
    avisos,
  };
}

// ---------------------------------------------------------------------------------------------
// Banco: interface mínima do Prisma usada pelo script, só leitura (o teste usa uma implementação em memória).

type Reader = { findMany(args: unknown): Promise<unknown[]> };
export type PortfolioDb = {
  client: Reader;
  user: Reader;
  opportunity: Reader;
  erpOrderSync: Reader;
  activity: Reader;
  agendaEvent: Reader;
  agendaStop: Reader;
  contact: Reader;
  communicationConversation: Reader;
  timelineEvent: Reader;
  appConfig: { findUnique(args: unknown): Promise<unknown> };
};

const clientIdsOf = async (reader: Reader) =>
  ((await reader.findMany({ where: { clientId: { not: null } }, select: { clientId: true }, distinct: ["clientId"] })) as { clientId: string | null }[])
    .map((row) => row.clientId);

export async function loadPortfolioInput(db: PortfolioDb): Promise<PortfolioInput> {
  const [clients, users, opportunities, orders, atividade, agenda, paradaDeRoteiro, contato, conversaWhatsapp, clientTimeline, partnerCache] = await Promise.all([
    db.client.findMany({ select: { id: true, code: true, isArchived: true, archiveReason: true, ownerSellerId: true, lastPurchaseDate: true, financialProfile: true } }),
    db.user.findMany({ select: { id: true, name: true, isActive: true, erpCode: true } }),
    db.opportunity.findMany({ select: { id: true, clientId: true } }),
    db.erpOrderSync.findMany({ select: { opportunityId: true }, distinct: ["opportunityId"] }),
    clientIdsOf(db.activity),
    clientIdsOf(db.agendaEvent),
    clientIdsOf(db.agendaStop),
    clientIdsOf(db.contact),
    clientIdsOf(db.communicationConversation),
    db.timelineEvent.findMany({ where: { clientId: { not: null }, opportunityId: null }, select: { clientId: true, description: true } }),
    db.appConfig.findUnique({ where: { key: PARTNERS_CONFIG_KEY }, select: { value: true } }),
  ]);
  return {
    clients: clients as ClientRow[],
    users: users as UserRow[],
    opportunities: opportunities as { id: string; clientId: string }[],
    orderOpportunityIds: (orders as { opportunityId: string }[]).map((row) => row.opportunityId),
    humanSources: { atividade, agenda, paradaDeRoteiro, contato, conversaWhatsapp },
    clientTimeline: clientTimeline as TimelineRow[],
    partnerCacheRows: parsePartnerCache((partnerCache as { value: string } | null)?.value),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { departedUserNames: string[] };

const USAGE = 'uso: simulateClientPortfolioCleanup [--departed-user="Nome do usuário"]... (somente leitura; não há modo de gravação)';

export function parseCliArgs(args: string[]): CliOptions {
  const departedUserNames: string[] = [];
  for (const arg of args) {
    const match = /^--departed-user=(.*\S.*)$/.exec(arg);
    if (!match) throw new Error(USAGE);
    const name = match[1].trim();
    if (departedUserNames.some((existing) => normalizeName(existing) === normalizeName(name))) throw new Error(USAGE);
    departedUserNames.push(name);
  }
  return { departedUserNames };
}

export type PortfolioClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = PortfolioDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => PortfolioClient, log: (line: string) => void = console.log, now = new Date()) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
    const input = await client.$transaction(async (tx) => {
      const readOnly = tx as ReadOnlyTx;
      await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadPortfolioInput(readOnly);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    log(JSON.stringify(summarizePortfolio(input, { now, departedUserNames: options.departedUserNames }), null, 2));
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as PortfolioClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
