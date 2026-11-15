/**
 * Simulação SOMENTE LEITURA da regra nova do dono do cliente na sincronização de parceiros do UltraFV3
 * (partnerOwnerRule.ts): o campo Vendedor do cadastro do ERP manda no dono, também na passada por vendedor.
 * Não existe modo que grave. Rodar ANTES do deploy para saber quantos clientes trocariam de dono.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/simulatePartnerOwnerRule.js
 *
 * Fonte: o cache do /partners (AppConfig) gravado pela sincronização. Só entram linhas vistas no /partners
 * nas últimas 48 horas (o cache mantém parceiros que deixaram de vir) e marcadas como cliente
 * (IDN_CLIENTE = S), como na sincronização. O cliente do CRM é achado pelo código do parceiro (sem
 * casamento por documento) e a regra usa o tenant do próprio cliente.
 *
 * Saída (stdout, JSON): só contagens e ids internos de usuário do CRM. Nunca nome, documento, telefone,
 * código ou id de cliente. Lê tudo numa transação READ ONLY.
 *
 * Imports: só @prisma/client, módulos do Node e partnerOwnerRule.js (sem imports), conferido pelo teste
 * de contrato em simulatePartnerOwnerRule.test.ts.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildErpSellerDirectory, normalizeErpSellerCode, resolvePartnerOwner } from "../services/partnerOwnerRule.js";

// Constantes espelhadas de ultraFv3SyncService.ts (conferidas pelo teste de contrato).
export const PARTNERS_CONFIG_KEY = "erp.ultrafv3.partners";
export const PARTNERS_LAST_SEEN_CONFIG_KEY = "erp.ultrafv3.partners.lastSeenAt";
export const PARTNER_CODE_KEYS = ["PARCEIRO", "CODPARCEIRO", "CODCLIENTE", "code", "erpCode", "codigo", "CODIGO", "partnerCode", "PARCEIRO_OUT", "IDPARCEIRO"];
export const PARTNER_SELLER_CODE_KEYS = ["VENDEDOR_DO_PARCEIRO", "CODVENDEDOR", "sellerCode", "salesmanCode", "codVendedor", "vendedorCodigo", "VENDEDOR"];
export const LEGACY_ARCHIVED_DUPLICATE_PREFIX = "[ARQUIVADO ERP DUP]";
export const SEEN_WITHIN_HOURS = 48;

export type SimUser = { id: string; erpCode: string | null; tenantMemberships: { tenantId: string }[] };
export type SimClient = { id: string; code: string | null; tenantId: string | null; ownerSellerId: string; isArchived: boolean };
export type SimulationInput = {
  partnerCacheRows: unknown[] | null;
  partnerLastSeen: Record<string, string> | null;
  users: SimUser[];
  clients: SimClient[];
};

const pickFirstString = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
};

const parseJson = (value: string | null | undefined): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export type SimulationSummary = {
  modo: "simulacao_somente_leitura";
  janelaVistoHoras: number;
  cache: {
    linhas: number;
    ignoradasNaoVistasNaJanela: number;
    ignoradasNaoCliente: number;
    ignoradasSemCodigo: number;
    ignoradasInvalidas: number;
  };
  clientes: {
    avaliados: number;
    mudariamDeDono: number;
    mudariamDeDonoArquivados: number;
    semMudanca: number;
    semVendedorNoCadastro: number;
    vendedorDoCadastroSemUsuarioAtivo: number;
    semClienteNoCrmPeloCodigo: number;
    codigoEmMaisDeUmCliente: number;
    clienteSemTenant: number;
  };
  /** Por par (dono atual → novo dono), ids internos de usuário do CRM. */
  mudancas: { donoAtualId: string; novoDonoId: string; clientes: number }[];
};

export function simulatePartnerOwnerRule(input: SimulationInput, now = new Date()): SimulationSummary {
  const directory = buildErpSellerDirectory(input.users.map((user) => ({
    id: user.id,
    erpCode: user.erpCode,
    tenantIds: user.tenantMemberships.map((membership) => membership.tenantId),
  })));
  const clientsByCode = new Map<string, SimClient[]>();
  for (const client of input.clients) {
    if (!client.code) continue;
    clientsByCode.set(client.code, [...(clientsByCode.get(client.code) ?? []), client]);
  }
  const seenSince = now.getTime() - SEEN_WITHIN_HOURS * 60 * 60 * 1000;
  const summary: SimulationSummary = {
    modo: "simulacao_somente_leitura",
    janelaVistoHoras: SEEN_WITHIN_HOURS,
    cache: { linhas: 0, ignoradasNaoVistasNaJanela: 0, ignoradasNaoCliente: 0, ignoradasSemCodigo: 0, ignoradasInvalidas: 0 },
    clientes: {
      avaliados: 0, mudariamDeDono: 0, mudariamDeDonoArquivados: 0, semMudanca: 0, semVendedorNoCadastro: 0,
      vendedorDoCadastroSemUsuarioAtivo: 0, semClienteNoCrmPeloCodigo: 0, codigoEmMaisDeUmCliente: 0, clienteSemTenant: 0,
    },
    mudancas: [],
  };
  const changes = new Map<string, { donoAtualId: string; novoDonoId: string; clientes: number }>();

  for (const row of input.partnerCacheRows ?? []) {
    summary.cache.linhas += 1;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      summary.cache.ignoradasInvalidas += 1;
      continue;
    }
    const payload = row as Record<string, unknown>;
    const code = normalizeErpSellerCode(pickFirstString(payload, PARTNER_CODE_KEYS));
    if (!code) {
      summary.cache.ignoradasSemCodigo += 1;
      continue;
    }
    const seenAt = Date.parse(input.partnerLastSeen?.[code] ?? "");
    if (!Number.isFinite(seenAt) || seenAt < seenSince) {
      summary.cache.ignoradasNaoVistasNaJanela += 1;
      continue;
    }
    if (String(payload.IDN_CLIENTE ?? "").trim().toUpperCase() !== "S") {
      summary.cache.ignoradasNaoCliente += 1;
      continue;
    }
    const matches = clientsByCode.get(code) ?? [];
    if (!matches.length) {
      summary.clientes.semClienteNoCrmPeloCodigo += 1;
      continue;
    }
    if (matches.length > 1) {
      summary.clientes.codigoEmMaisDeUmCliente += 1;
      continue;
    }
    const [client] = matches;
    if (!client.tenantId) {
      summary.clientes.clienteSemTenant += 1;
      continue;
    }
    summary.clientes.avaliados += 1;
    const decision = resolvePartnerOwner({
      erpSellerCode: pickFirstString(payload, PARTNER_SELLER_CODE_KEYS),
      directory,
      tenantId: client.tenantId,
      loginSellerId: client.ownerSellerId,
      currentOwnerId: client.ownerSellerId,
    });
    if (decision.source === "kept_erp_seller_missing") summary.clientes.semVendedorNoCadastro += 1;
    else if (decision.source === "kept_erp_seller_unmatched") summary.clientes.vendedorDoCadastroSemUsuarioAtivo += 1;
    else if (decision.ownerSellerId === client.ownerSellerId) summary.clientes.semMudanca += 1;
    else {
      summary.clientes.mudariamDeDono += 1;
      if (client.isArchived) summary.clientes.mudariamDeDonoArquivados += 1;
      const key = `${client.ownerSellerId}\u0000${decision.ownerSellerId}`;
      const entry = changes.get(key) ?? { donoAtualId: client.ownerSellerId, novoDonoId: decision.ownerSellerId, clientes: 0 };
      entry.clientes += 1;
      changes.set(key, entry);
    }
  }
  summary.mudancas = [...changes.values()].sort((a, b) =>
    b.clientes - a.clientes || a.donoAtualId.localeCompare(b.donoAtualId) || a.novoDonoId.localeCompare(b.novoDonoId));
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Banco (somente leitura)

export type OwnerRuleDb = {
  appConfig: { findUnique(args: unknown): Promise<unknown> };
  user: { findMany(args: unknown): Promise<unknown[]> };
  client: { findMany(args: unknown): Promise<unknown[]> };
};

export async function loadSimulationInput(db: OwnerRuleDb): Promise<SimulationInput> {
  const [partnerCache, partnerLastSeen, users, clients] = await Promise.all([
    db.appConfig.findUnique({ where: { key: PARTNERS_CONFIG_KEY }, select: { value: true } }),
    db.appConfig.findUnique({ where: { key: PARTNERS_LAST_SEEN_CONFIG_KEY }, select: { value: true } }),
    // Mesma consulta da sincronização: vendedores ativos com erpCode e vínculos de tenant ativos.
    db.user.findMany({
      where: { role: "vendedor", erpCode: { not: null }, isActive: true },
      select: {
        id: true,
        erpCode: true,
        tenantMemberships: { where: { status: "active", tenant: { status: "active" } }, select: { tenantId: true }, take: 2 },
      },
    }),
    // Duplicados fundidos ficam de fora, como na sincronização (o nome é filtrado no banco, não lido).
    db.client.findMany({
      where: { code: { not: null }, NOT: { name: { startsWith: LEGACY_ARCHIVED_DUPLICATE_PREFIX, mode: "insensitive" } } },
      select: { id: true, code: true, tenantId: true, ownerSellerId: true, isArchived: true },
    }),
  ]);
  const cache = parseJson((partnerCache as { value?: string } | null)?.value);
  const lastSeen = parseJson((partnerLastSeen as { value?: string } | null)?.value);
  return {
    partnerCacheRows: Array.isArray(cache) ? cache : null,
    partnerLastSeen: lastSeen && typeof lastSeen === "object" && !Array.isArray(lastSeen) ? lastSeen as Record<string, string> : null,
    users: users as SimUser[],
    clients: clients as SimClient[],
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = "uso: simulatePartnerOwnerRule (sem argumentos; somente leitura; não há modo de gravação)";

export type OwnerRuleClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = OwnerRuleDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => OwnerRuleClient, log: (line: string) => void = console.log, now = new Date()) {
  if (args.length) throw new Error(USAGE);
  const client = createClient();
  try {
    // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
    const input = await client.$transaction(async (tx) => {
      const readOnly = tx as ReadOnlyTx;
      await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadSimulationInput(readOnly);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    if (!input.partnerCacheRows) {
      log(JSON.stringify({ modo: "simulacao_somente_leitura", erro: "cache do /partners ausente ou ilegível; nada a simular" }, null, 2));
      return;
    }
    log(JSON.stringify(simulatePartnerOwnerRule(input, now), null, 2));
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as OwnerRuleClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
