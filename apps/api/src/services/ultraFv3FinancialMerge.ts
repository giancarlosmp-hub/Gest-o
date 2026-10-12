// Regras puras para juntar /financialProfiles e /partnerTitles buscados com a credencial de cada
// vendedor antes de gravar no Client. Nada aqui acessa banco ou ERP; o serviço de sync monta as
// entradas e persiste o plano.

export type FinancialSellerOutcome = "success" | "empty" | "error" | "skipped";

export type FinancialSellerFetch = {
  sellerId: string;
  /** Tenant comprovado pela membership do vendedor; null quando não foi possível comprovar. */
  tenantId: string | null;
  outcome: FinancialSellerOutcome;
  rows: Record<string, unknown>[];
};

export type FinancialClientTarget = {
  id: string;
  code: string;
  tenantId: string | null;
  ownerSellerId: string;
};

export type FinancialWriteExclusions = {
  /** Algum vendedor falhou sem cobertura anterior conhecida: não há como saber o que ele traria. */
  blockAll: boolean;
  excludedCodes: Set<string>;
  failedWithoutCoverage: number;
};

export type FinancialPlanContext = {
  fetches: FinancialSellerFetch[];
  clients: FinancialClientTarget[];
  /** Tenant comprovado do dono, usado só para clientes legados com tenantId nulo. */
  ownerTenantById: Map<string, string>;
  exclusions: FinancialWriteExclusions;
  codeOf: (row: Record<string, unknown>) => string;
};

export type FinancialPlanDiagnostics = {
  clientsPlanned: number;
  clientsExcludedByFailedSeller: number;
  clientsWithoutProvenTenant: number;
  clientsWithoutSameTenantSource: number;
  ownerSourcePreferred: number;
  firstReceivedFallback: number;
};

export const isSuccessfulFetch = (fetch: FinancialSellerFetch) =>
  fetch.outcome === "success" || fetch.outcome === "empty";

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const normalizeTitleKeyPart = (value: unknown) => {
  if (value === undefined || value === null) return "";
  const text = String(value).trim().toUpperCase();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, "") : text;
};

/** Identidade do título: DOCTO + PARCELA normalizados; JSON canônico só quando faltar um deles. */
export const partnerTitleDedupeKey = (row: Record<string, unknown>) => {
  const docto = normalizeTitleKeyPart(row.DOCTO);
  const parcela = normalizeTitleKeyPart(row.PARCELA);
  return docto && parcela ? `docto:${docto}|parcela:${parcela}` : `json:${canonicalJson(row)}`;
};

/**
 * Na rodada com falha, não grava nenhum código que o vendedor que falhou poderia ter retornado:
 * códigos de clientes dos quais ele é dono e os códigos que ele retornou na última rodada bem-sucedida.
 * Sem essa cobertura anterior, não dá para saber o que ele traria, então nada é gravado.
 */
export function resolveFinancialWriteExclusions(input: {
  failedSellerIds: Set<string>;
  candidateClients: FinancialClientTarget[];
  coverageBySeller: Record<string, string[]>;
}): FinancialWriteExclusions {
  const excludedCodes = new Set<string>();
  let failedWithoutCoverage = 0;
  for (const sellerId of input.failedSellerIds) {
    const coverage = input.coverageBySeller[sellerId];
    if (!Array.isArray(coverage)) failedWithoutCoverage += 1;
    else coverage.forEach((code) => excludedCodes.add(code));
  }
  for (const client of input.candidateClients) {
    if (input.failedSellerIds.has(client.ownerSellerId)) excludedCodes.add(client.code);
  }
  return { blockAll: failedWithoutCoverage > 0, excludedCodes, failedWithoutCoverage };
}

type SourcedRow = { sellerId: string; tenantId: string; row: Record<string, unknown> };

const groupSuccessfulRowsByCode = (context: FinancialPlanContext) => {
  const byCode = new Map<string, SourcedRow[]>();
  for (const fetch of context.fetches) {
    if (!isSuccessfulFetch(fetch) || !fetch.tenantId) continue;
    for (const row of fetch.rows) {
      const code = context.codeOf(row);
      if (!code) continue;
      byCode.set(code, [...(byCode.get(code) ?? []), { sellerId: fetch.sellerId, tenantId: fetch.tenantId, row }]);
    }
  }
  return byCode;
};

const emptyDiagnostics = (): FinancialPlanDiagnostics => ({
  clientsPlanned: 0,
  clientsExcludedByFailedSeller: 0,
  clientsWithoutProvenTenant: 0,
  clientsWithoutSameTenantSource: 0,
  ownerSourcePreferred: 0,
  firstReceivedFallback: 0,
});

/**
 * Percorre os clientes elegíveis e entrega as fontes do mesmo tenant. O cliente legado sem tenantId
 * só é aceito quando o tenant do dono está comprovado. Agrupa por código, tenant e dono, porque o
 * resultado só depende dessas três coisas.
 */
const forEachEligibleClientGroup = (
  context: FinancialPlanContext,
  byCode: Map<string, SourcedRow[]>,
  diagnostics: FinancialPlanDiagnostics,
  visit: (group: { code: string; ownerSellerId: string; clientIds: string[]; sources: SourcedRow[] }) => void,
) => {
  const groups = new Map<string, { code: string; ownerSellerId: string; clientIds: string[]; sources: SourcedRow[] }>();
  for (const client of context.clients) {
    const rows = byCode.get(client.code);
    if (!rows?.length) continue;
    if (context.exclusions.blockAll || context.exclusions.excludedCodes.has(client.code)) {
      diagnostics.clientsExcludedByFailedSeller += 1;
      continue;
    }
    const tenantId = client.tenantId ?? context.ownerTenantById.get(client.ownerSellerId) ?? null;
    if (!tenantId) {
      diagnostics.clientsWithoutProvenTenant += 1;
      continue;
    }
    const sources = rows.filter((source) => source.tenantId === tenantId);
    if (!sources.length) {
      diagnostics.clientsWithoutSameTenantSource += 1;
      continue;
    }
    const key = `${client.code}\u0000${tenantId}\u0000${client.ownerSellerId}`;
    const group = groups.get(key) ?? { code: client.code, ownerSellerId: client.ownerSellerId, clientIds: [], sources };
    group.clientIds.push(client.id);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    diagnostics.clientsPlanned += group.clientIds.length;
    visit(group);
  }
};

export type FinancialProfileWrite = { clientIds: string[]; profile: Record<string, unknown> };

/** Prefere o perfil vindo do vendedor dono do cliente; usa o primeiro recebido só como fallback. */
export function planFinancialProfileWrites(context: FinancialPlanContext) {
  const byCode = groupSuccessfulRowsByCode(context);
  let profileConflicts = 0;
  for (const rows of byCode.values()) {
    if (new Set(rows.map((source) => canonicalJson(source.row))).size > 1) profileConflicts += 1;
  }
  const diagnostics = emptyDiagnostics();
  const writes: FinancialProfileWrite[] = [];
  forEachEligibleClientGroup(context, byCode, diagnostics, ({ ownerSellerId, clientIds, sources }) => {
    const fromOwner = sources.find((source) => source.sellerId === ownerSellerId);
    if (fromOwner) diagnostics.ownerSourcePreferred += clientIds.length;
    else diagnostics.firstReceivedFallback += clientIds.length;
    writes.push({ clientIds, profile: (fromOwner ?? sources[0]).row });
  });
  return { writes, diagnostics: { ...diagnostics, profileConflicts } };
}

export type PartnerTitleWrite = { clientIds: string[]; titles: Record<string, unknown>[] };

/**
 * Une os títulos de todas as fontes do mesmo tenant, deduplicados por DOCTO + PARCELA.
 * Critério quando o mesmo título chega de mais de um vendedor:
 *   1. a versão do vendedor dono do cliente;
 *   2. senão, a de maior saldo (SALDO_CAPITAL), para o alerta de crédito nunca subestimar a dívida;
 *   3. empate: fica a primeira recebida (vendedores em ordem alfabética).
 */
export function planPartnerTitleWrites(context: FinancialPlanContext & { saldoOf: (row: Record<string, unknown>) => number }) {
  const byCode = groupSuccessfulRowsByCode(context);
  const diagnostics = emptyDiagnostics();
  let duplicateTitlesMerged = 0;
  const writes: PartnerTitleWrite[] = [];
  forEachEligibleClientGroup(context, byCode, diagnostics, ({ ownerSellerId, clientIds, sources }) => {
    const merged = new Map<string, SourcedRow>();
    for (const source of sources) {
      const key = partnerTitleDedupeKey(source.row);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, source);
        continue;
      }
      duplicateTitlesMerged += 1;
      if (preferIncomingTitle(current, source, ownerSellerId, context.saldoOf)) merged.set(key, source);
    }
    if (sources.some((source) => source.sellerId === ownerSellerId)) diagnostics.ownerSourcePreferred += clientIds.length;
    else diagnostics.firstReceivedFallback += clientIds.length;
    writes.push({ clientIds, titles: [...merged.values()].map((source) => source.row) });
  });
  return { writes, diagnostics: { ...diagnostics, duplicateTitlesMerged } };
}

const preferIncomingTitle = (
  current: SourcedRow,
  incoming: SourcedRow,
  ownerSellerId: string,
  saldoOf: (row: Record<string, unknown>) => number,
) => {
  const currentIsOwner = current.sellerId === ownerSellerId;
  const incomingIsOwner = incoming.sellerId === ownerSellerId;
  if (currentIsOwner !== incomingIsOwner) return incomingIsOwner;
  return saldoOf(incoming.row) > saldoOf(current.row);
};
