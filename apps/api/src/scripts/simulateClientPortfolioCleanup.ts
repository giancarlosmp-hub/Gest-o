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
 * --list-transfers (só junto com --departed-user): lista, um por linha, os clientes desses usuários
 * que NÃO são candidatos, com código ERP, nome, cidade/UF, motivo da proteção e vendedor atual do ERP
 * no cache do /partners. É a única saída com dados de cliente e vai para o stderr: redirecionar o
 * stdout (o resumo) para um arquivo não leva a lista junto. Não copie a lista para arquivo, teste,
 * commit, PR ou relatório.
 *
 * Autocontido: importa só @prisma/client e módulos do Node (teste de contrato em
 * simulateClientPortfolioCleanup.test.ts). Lê tudo numa transação READ ONLY. O resumo (stdout) traz só
 * contagens e nomes de usuários do CRM: nunca nome, código, documento ou ID de cliente.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

// Constantes espelhadas de ultraFv3SyncService.ts (conferidas pelo teste de contrato).
export const PARTNERS_CONFIG_KEY = "erp.ultrafv3.partners";
export const PARTNERS_LAST_SEEN_CONFIG_KEY = "erp.ultrafv3.partners.lastSeenAt";
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
  /^Cliente reativado automaticamente por nova compra no ERP/,
  /^Cliente reativado automaticamente: o ERP voltou a indicar cliente da carteira/,
  /^Cliente arquivado pela limpeza da carteira \(regra [ab]\)$/,
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
  /** Só carregados com --list-transfers. */
  name?: string;
  city?: string;
  state?: string;
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
  /** Código normalizado do parceiro → data em que ele veio do /partners pela última vez (null: sem registro). */
  partnerLastSeen: Record<string, string> | null;
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

export const parsePartnerLastSeen = (value: string | null | undefined): Record<string, string> | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter(([, seenAt]) => typeof seenAt === "string")) as Record<string, string>;
  } catch {
    return null;
  }
};

export type CacheLineAge = "semDataDeVisto" | "vistaHaAte1Dia" | "vistaHa1a7Dias" | "vistaHaMaisDe7Dias";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Idade da linha do cache: parceiro que deixou de vir do ERP fica com a linha antiga. */
export function cacheLineAge(seenAt: string | undefined, now: Date): CacheLineAge {
  const seen = seenAt ? new Date(seenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return "semDataDeVisto";
  const age = now.getTime() - seen.getTime();
  return age <= DAY_MS ? "vistaHaAte1Dia" : age <= 7 * DAY_MS ? "vistaHa1a7Dias" : "vistaHaMaisDe7Dias";
}

/** Grupo do motivo de arquivamento sem IDs nem texto livre: prefixo "XXX:", identificador snake_case ou rótulo. */
export function archiveReasonGroup(reason: string | null) {
  const value = reason?.trim() ?? "";
  if (!value) return "(sem motivo)";
  const prefix = /^([A-Z][A-Z0-9_]*:)/.exec(value);
  if (prefix) return prefix[1];
  if (/^[a-z][a-z0-9_]*$/.test(value)) return value;
  return "(texto livre)";
}

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

type ErpCacheContext = {
  cache: Map<string, Record<string, unknown>>;
  lastSeen: Record<string, string>;
  usersByErpCode: Map<string, UserRow[]>;
  now: Date;
};

function buildErpCacheContext(input: PortfolioInput, now: Date): ErpCacheContext {
  const usersByErpCode = new Map<string, UserRow[]>();
  for (const user of input.users) {
    const code = user.erpCode ? normalizePartnerCode(user.erpCode) : "";
    if (code) usersByErpCode.set(code, [...(usersByErpCode.get(code) ?? []), user]);
  }
  return { cache: indexPartnerCache(input.partnerCacheRows), lastSeen: input.partnerLastSeen ?? {}, usersByErpCode, now };
}

const cacheKeyOf = (client: ClientRow) => (client.code?.trim() ? normalizePartnerCode(client.code) : "");

function resolveErpSeller(row: Record<string, unknown>, context: ErpCacheContext) {
  const sellerCode = normalizePartnerCode(pickFirstString(row, PARTNER_SELLER_CODE_KEYS));
  const sellers = sellerCode ? context.usersByErpCode.get(sellerCode) ?? [] : [];
  const status: ErpSellerStatus = !sellerCode ? "semCodigoDeVendedor"
    : !sellers.length ? "semUsuarioNoCrm"
    : sellers.length > 1 ? "codigoEmMaisDeUmUsuario"
    : sellers[0].isActive ? "usuarioAtivo" : "usuarioInativo";
  return { sellerCode, sellers, status };
}

function summarizeErpCache(verdicts: ClientVerdict[], context: ErpCacheContext) {
  const rows = verdicts.flatMap((verdict) => {
    const key = cacheKeyOf(verdict.client);
    const row = key ? context.cache.get(key) : undefined;
    return row ? [{ verdict, row, key }] : [];
  });
  const classified = rows.map(({ verdict, row, key }) => {
    const { sellers, status } = resolveErpSeller(row, context);
    return {
      flag: classifyCustomerFlag(row),
      seller: status,
      otherOwner: sellers.length === 1 && sellers[0].id !== verdict.client.ownerSellerId,
      age: cacheLineAge(context.lastSeen[key], context.now),
    };
  });
  return {
    total: verdicts.length,
    encontradosNoCache: rows.length,
    ausentesDoCache: verdicts.length - rows.length,
    idnCliente: countBy(classified, (row) => row.flag),
    vendedorErp: countBy(classified, (row) => row.seller),
    idnClienteNEVendedorSemUsuario: classified.filter((row) => row.flag === "N" && row.seller === "semUsuarioNoCrm").length,
    vendedorErpDiferenteDoResponsavelNoCrm: classified.filter((row) => row.otherOwner).length,
    idadeDaLinhaNoCache: countBy(classified, (row) => row.age),
  };
}

type CandidateFlagGroup = "S" | "N" | "semCampoIdnCliente" | "ausenteDoCache";
const CANDIDATE_FLAG_GROUPS: CandidateFlagGroup[] = ["S", "N", "semCampoIdnCliente", "ausenteDoCache"];

/** Candidatos com código ERP: IDN_CLIENTE do cache × tipo de candidato (nunca comprou / comprou há mais de 24 meses). */
function crossCandidatesByCustomerFlag(candidates: ClientVerdict[], context: ErpCacheContext) {
  const groupOf = (verdict: ClientVerdict): CandidateFlagGroup => {
    const key = cacheKeyOf(verdict.client);
    const row = key ? context.cache.get(key) : undefined;
    if (!row) return "ausenteDoCache";
    const flag = classifyCustomerFlag(row);
    return flag === "ausente" ? "semCampoIdnCliente" : flag;
  };
  return Object.fromEntries(CANDIDATE_FLAG_GROUPS.map((group) => {
    const rows = candidates.filter((verdict) => groupOf(verdict) === group);
    return [group, {
      total: rows.length,
      semDataDeCompra: rows.filter((row) => row.candidateKind === "semDataDeCompra").length,
      ultimaCompraHaMaisDe24Meses: rows.filter((row) => row.candidateKind === "ultimaCompraHaMaisDe24Meses").length,
    }];
  })) as Record<CandidateFlagGroup, { total: number; semDataDeCompra: number; ultimaCompraHaMaisDe24Meses: number }>;
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
    const { users, rows, notCandidates } = departedPortfolio(input, active, name);
    if (users.length > 1) avisos.push(`Mais de um usuário com o nome informado em --departed-user (${users.length}); contagens somadas.`);
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

  const erpContext = buildErpCacheContext(input, options.now);
  if (input.partnerCacheRows === null) avisos.push(`Sem cache do /partners (${PARTNERS_CONFIG_KEY}) legível: IDN_CLIENTE e vendedor do ERP não avaliados.`);
  else avisos.push("O cache do /partners guarda a última linha recebida de cada parceiro; parceiro que deixou de vir (ex.: transferido para vendedor sem credencial no CRM) pode estar desatualizado. Veja idadeDaLinhaNoCache.");
  if (input.partnerCacheRows !== null && input.partnerLastSeen === null) avisos.push(`Sem registro de quando cada parceiro veio do ERP (${PARTNERS_LAST_SEEN_CONFIG_KEY}): idade das linhas do cache não avaliada.`);

  const purchaseSourceOf = (rows: ClientVerdict[]) => countBy(rows, (row) => row.purchase.source);
  const candidatesWithCode = withCode.filter((row) => row.matchesRule);
  const archived = verdicts.filter((row) => row.state !== "naoArquivado");
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
      linhasNoCache: erpContext.cache.size,
      linhasComDataDeVisto: [...erpContext.cache.keys()].filter((key) => erpContext.lastSeen[key]).length,
      candidatos: summarizeErpCache(candidatesWithCode, erpContext),
      protegidos: summarizeErpCache(withCode.filter((row) => !row.matchesRule), erpContext),
      candidatosIdnClientePorCompra: crossCandidatesByCustomerFlag(candidatesWithCode, erpContext),
    },
    arquivadosPorMotivo: { total: archived.length, porPrefixo: countBy(archived, (row) => archiveReasonGroup(row.client.archiveReason)) },
    avisos,
  };
}

function departedPortfolio(input: PortfolioInput, active: ClientVerdict[], name: string) {
  const users = input.users.filter((user) => normalizeName(user.name) === normalizeName(name));
  const ids = new Set(users.map((user) => user.id));
  const rows = active.filter((row) => ids.has(row.client.ownerSellerId));
  const notCandidates = rows.filter((row) => !(row.matchesRule && row.hasErpCode));
  return { users, rows, notCandidates };
}

export type TransferRow = {
  usuario: string;
  codigoErp: string;
  nome: string;
  cidadeUf: string;
  motivos: string;
  vendedorErp: string;
  linhaDoCache: string;
};

/**
 * --list-transfers: clientes não arquivados dos usuários desligados que NÃO são candidatos (precisam ser
 * transferidos). Única saída com dados de cliente: o CLI manda para o stderr e nunca para o resumo.
 */
export function buildTransferList(input: PortfolioInput, options: { now: Date; departedUserNames: string[] }): TransferRow[] {
  const active = classifyClients(input, options.now).filter((row) => row.state === "naoArquivado");
  const context = buildErpCacheContext(input, options.now);
  const list = options.departedUserNames.flatMap((name) => departedPortfolio(input, active, name).notCandidates.map((verdict) => {
    const { client } = verdict;
    const key = cacheKeyOf(client);
    const row = key ? context.cache.get(key) : undefined;
    let vendedorErp = "(sem código ERP)";
    if (key && !row) vendedorErp = "(ausente do cache)";
    if (row) {
      const { sellerCode, sellers, status } = resolveErpSeller(row, context);
      vendedorErp = status === "semCodigoDeVendedor" ? "(sem vendedor na linha)"
        : status === "semUsuarioNoCrm" ? `${sellerCode} (sem usuário no CRM)`
        : status === "codigoEmMaisDeUmUsuario" ? `${sellerCode} (código em mais de um usuário)`
        : `${sellerCode} (${sellers[0].name}${sellers[0].isActive ? "" : ", inativo"})`;
    }
    const seenAt = key ? context.lastSeen[key] : undefined;
    return {
      usuario: name,
      codigoErp: client.code?.trim() || "(sem código)",
      nome: client.name ?? "",
      cidadeUf: [client.city, client.state].filter(Boolean).join("/"),
      motivos: [...verdict.reasons, ...(verdict.hasErpCode ? [] : ["semCodigoErp"])].join(","),
      vendedorErp,
      linhaDoCache: !row ? "-" : seenAt ? `vista em ${brasiliaDayKey(new Date(seenAt))}` : "sem data de visto",
    };
  }));
  return list.sort((a, b) => a.usuario.localeCompare(b.usuario) || a.nome.localeCompare(b.nome) || a.codigoErp.localeCompare(b.codigoErp));
}

const TRANSFER_COLUMNS: (keyof TransferRow)[] = ["usuario", "codigoErp", "nome", "cidadeUf", "motivos", "vendedorErp", "linhaDoCache"];
export const formatTransferList = (rows: TransferRow[]) => [
  `--list-transfers: ${rows.length} cliente(s) a transferir. Só no terminal: não copie para arquivo, teste, commit, PR ou relatório.`,
  TRANSFER_COLUMNS.join("\t"),
  ...rows.map((row) => TRANSFER_COLUMNS.map((column) => row[column].replace(/\s+/g, " ")).join("\t")),
];

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

/** withClientDetails (só --list-transfers) carrega também nome, cidade e UF dos clientes. */
export async function loadPortfolioInput(db: PortfolioDb, options: { withClientDetails?: boolean } = {}): Promise<PortfolioInput> {
  const details = options.withClientDetails ? { name: true, city: true, state: true } : {};
  const [clients, users, opportunities, orders, atividade, agenda, paradaDeRoteiro, contato, conversaWhatsapp, clientTimeline, partnerCache, partnerLastSeen] = await Promise.all([
    db.client.findMany({ select: { id: true, code: true, isArchived: true, archiveReason: true, ownerSellerId: true, lastPurchaseDate: true, financialProfile: true, ...details } }),
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
    db.appConfig.findUnique({ where: { key: PARTNERS_LAST_SEEN_CONFIG_KEY }, select: { value: true } }),
  ]);
  return {
    clients: clients as ClientRow[],
    users: users as UserRow[],
    opportunities: opportunities as { id: string; clientId: string }[],
    orderOpportunityIds: (orders as { opportunityId: string }[]).map((row) => row.opportunityId),
    humanSources: { atividade, agenda, paradaDeRoteiro, contato, conversaWhatsapp },
    clientTimeline: clientTimeline as TimelineRow[],
    partnerCacheRows: parsePartnerCache((partnerCache as { value: string } | null)?.value),
    partnerLastSeen: parsePartnerLastSeen((partnerLastSeen as { value: string } | null)?.value),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions = { departedUserNames: string[]; listTransfers: boolean };

const USAGE = 'uso: simulateClientPortfolioCleanup [--departed-user="Nome do usuário"]... [--list-transfers] (somente leitura; não há modo de gravação; --list-transfers exige --departed-user)';

export function parseCliArgs(args: string[]): CliOptions {
  const departedUserNames: string[] = [];
  let listTransfers = false;
  for (const arg of args) {
    if (arg === "--list-transfers") {
      if (listTransfers) throw new Error(USAGE);
      listTransfers = true;
      continue;
    }
    const match = /^--departed-user=(.*\S.*)$/.exec(arg);
    if (!match) throw new Error(USAGE);
    const name = match[1].trim();
    if (departedUserNames.some((existing) => normalizeName(existing) === normalizeName(name))) throw new Error(USAGE);
    departedUserNames.push(name);
  }
  if (listTransfers && !departedUserNames.length) throw new Error(USAGE);
  return { departedUserNames, listTransfers };
}

export type PortfolioClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = PortfolioDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/**
 * Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. O resumo vai
 * para `log` (stdout); a lista do --list-transfers vai para `logTransfers` (stderr).
 */
export async function runCli(
  args: string[],
  createClient: () => PortfolioClient,
  log: (line: string) => void = console.log,
  now = new Date(),
  logTransfers: (line: string) => void = console.error,
) {
  const options = parseCliArgs(args);
  const client = createClient();
  try {
    // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
    const input = await client.$transaction(async (tx) => {
      const readOnly = tx as ReadOnlyTx;
      await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadPortfolioInput(readOnly, { withClientDetails: options.listTransfers });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    log(JSON.stringify(summarizePortfolio(input, { now, departedUserNames: options.departedUserNames }), null, 2));
    if (options.listTransfers) {
      for (const line of formatTransferList(buildTransferList(input, { now, departedUserNames: options.departedUserNames }))) logTransfers(line);
    }
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
