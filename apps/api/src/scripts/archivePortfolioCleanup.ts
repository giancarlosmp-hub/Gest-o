/**
 * Limpeza da carteira de clientes: arquiva, por regra, clientes que o ERP não trata mais como cliente da
 * carteira. Usa o motivo "PORTFOLIO_CLEANUP:<data ISO>" (buildPortfolioCleanupArchiveReason), que a
 * sincronização reconhece (reativa só quando o ERP volta a indicar cliente da carteira).
 *
 * Regra (cliente não arquivado, com código ERP; a linha do cache do /partners só decide se foi vista há até 7 dias):
 *   a) linha do cache com IDN_CLIENTE = N; ou
 *   b) ausente do cache, ou linha sem IDN_CLIENTE com vendedor do ERP sem usuário ativo no CRM, E o
 *      responsável no CRM é um usuário inativo.
 * IDN_CLIENTE = S nunca é arquivado. Protegido mesmo atendendo a regra: oportunidade aberta (etapa
 * diferente de ganho/perdido) ou pedido pendente. Linha do cache com mais de 7 dias ou sem data de visto
 * não decide nada (conta como cache desatualizado). Sem código ERP: fora do script, só contagem.
 *
 * Uso no container da API (compilado em dist/scripts):
 *   node dist/scripts/archivePortfolioCleanup.js
 *   node dist/scripts/archivePortfolioCleanup.js --apply --expect-archive=N --backup-dir=<dir>
 *   node dist/scripts/archivePortfolioCleanup.js --restore=<arquivo-de-backup>
 *
 * Autocontido: importa só @prisma/client e módulos do Node (teste de contrato em
 * archivePortfolioCleanup.test.ts). A simulação roda numa transação READ ONLY. A saída traz só contagens e
 * nomes de usuários do CRM: nunca nome, código, documento ou ID de cliente.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

// Constantes espelhadas de ultraFv3SyncService.ts, portfolioCleanupArchive.ts e orderStatusProjection.ts
// (conferidas pelo teste de contrato).
export const PARTNERS_CONFIG_KEY = "erp.ultrafv3.partners";
export const PARTNERS_LAST_SEEN_CONFIG_KEY = "erp.ultrafv3.partners.lastSeenAt";
export const PARTNER_CODE_KEYS = ["PARCEIRO", "CODPARCEIRO", "CODCLIENTE", "code", "erpCode", "codigo", "CODIGO", "partnerCode", "PARCEIRO_OUT", "IDPARCEIRO"];
export const PARTNER_SELLER_CODE_KEYS = ["VENDEDOR_DO_PARCEIRO", "CODVENDEDOR", "sellerCode", "salesmanCode", "codVendedor", "vendedorCodigo", "VENDEDOR"];
export const ARCHIVE_REASON_PREFIX = "PORTFOLIO_CLEANUP:";
export const ARCHIVE_TIMELINE_PREFIX = "Cliente arquivado pela limpeza da carteira (regra ";
export const TIMELINE_TYPE_STATUS = "status";
export const CLOSED_STAGES = ["ganho", "perdido"];
export const CACHE_MAX_AGE_DAYS = 7;
export const BACKUP_FORMAT = "archivePortfolioCleanup/v1";
// Lote das gravações: 500 linhas × 7 colunas no createMany fica longe do limite de 32.767 parâmetros do Postgres.
const UPDATE_CHUNK_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, sem horário de verão desde 2019.

export type ArchiveRule = "a" | "b";
export const buildArchiveReason = (archivedAt: Date) => `${ARCHIVE_REASON_PREFIX}${archivedAt.toISOString()}`;
export const archiveTimelineDescription = (rule: ArchiveRule) => `${ARCHIVE_TIMELINE_PREFIX}${rule})`;
const brasiliaDayKey = (date: Date) => new Date(date.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);

export type ClientRow = { id: string; code: string | null; isArchived: boolean; archiveReason: string | null; ownerSellerId: string; [column: string]: unknown };
export type UserRow = { id: string; name: string; isActive: boolean; erpCode: string | null };
export type OpportunityRow = { id: string; clientId: string; stage: string };
export type OrderRow = { opportunityId: string; status: string; operationalStatusRaw: string | null; orderStatus: string | null };

export type ArchiveInput = {
  /** Só clientes não arquivados. */
  clients: ClientRow[];
  users: UserRow[];
  opportunities: OpportunityRow[];
  /** Tentativas de pedido ERP com status pending ou sent. */
  orders: OrderRow[];
  /** Linhas brutas do cache do /partners, ou null se não houver cache legível. */
  partnerCacheRows: unknown[] | null;
  /** Código normalizado do parceiro → data em que ele veio do /partners pela última vez. */
  partnerLastSeen: Record<string, string> | null;
};

// ---------------------------------------------------------------------------------------------
// Cache do /partners (mesma leitura da sincronização).

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

const parseJson = (value: string | null | undefined): unknown => {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};
export const parsePartnerCache = (value: string | null | undefined) => {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : null;
};
export const parsePartnerLastSeen = (value: string | null | undefined) => {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.fromEntries(Object.entries(parsed).filter(([, seenAt]) => typeof seenAt === "string")) as Record<string, string>;
};

/** Linha recente: vista há até 7 dias. Sem data de visto ou mais antiga: não decide. */
export function cacheLineFreshness(seenAt: string | undefined, now: Date): "recente" | "semDataDeVisto" | "vistaHaMaisDe7Dias" {
  const seen = seenAt ? new Date(seenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return "semDataDeVisto";
  return now.getTime() - seen.getTime() <= CACHE_MAX_AGE_DAYS * DAY_MS ? "recente" : "vistaHaMaisDe7Dias";
}

/** Mesmo critério de orderStatusGroup: pendente é o que não é erro, cancelado nem finalizado. */
export function isPendingOrder(order: Pick<OrderRow, "status" | "operationalStatusRaw" | "orderStatus">) {
  if (order.status === "pending") return true;
  if (order.status !== "sent") return false;
  const raw = (order.operationalStatusRaw || "").toUpperCase();
  if (raw === "CANCELADO" || order.orderStatus === "cancelado") return false;
  if (raw === "FINALIZADO" || order.orderStatus === "entregue") return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Regra.

export type ProtectionReason = "oportunidadeAberta" | "pedidoPendente";
export type RuleDetail = "idnClienteN" | "ausenteDoCache" | "vendedorErpSemUsuarioAtivo";
export type NotCandidateReason =
  | "idnClienteS"
  | "linhaSemIdnClienteComVendedorErpAtivo"
  | "linhaSemIdnClienteComResponsavelAtivo"
  | "ausenteDoCacheComResponsavelAtivo"
  | "semCacheDoPartners";

export type ClientDecision =
  | { kind: "semCodigoErp" }
  | { kind: "cacheDesatualizado"; age: "semDataDeVisto" | "vistaHaMaisDe7Dias" }
  | { kind: "naoCandidato"; reason: NotCandidateReason }
  | { kind: "candidato"; rule: ArchiveRule; detail: RuleDetail }
  | { kind: "protegido"; rule: ArchiveRule; detail: RuleDetail; reasons: ProtectionReason[] };

export type ArchivePlan = {
  decisions: { client: ClientRow; decision: ClientDecision }[];
  candidates: { client: ClientRow; rule: ArchiveRule }[];
  cacheAvailable: boolean;
  lastSeenAvailable: boolean;
};

export function planPortfolioArchive(input: ArchiveInput, now: Date): ArchivePlan {
  const usersById = new Map(input.users.map((user) => [user.id, user]));
  const activeSellerCodes = new Set(input.users.filter((user) => user.isActive && user.erpCode).map((user) => normalizePartnerCode(user.erpCode!)).filter(Boolean));
  const cache = new Map<string, Record<string, unknown>>();
  for (const row of input.partnerCacheRows ?? []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const code = normalizePartnerCode(pickFirstString(row as Record<string, unknown>, PARTNER_CODE_KEYS));
    if (code) cache.set(code, row as Record<string, unknown>);
  }
  const lastSeen = input.partnerLastSeen ?? {};
  const openOpportunityClients = new Set(input.opportunities.filter((row) => !CLOSED_STAGES.includes(row.stage)).map((row) => row.clientId));
  const opportunityClient = new Map(input.opportunities.map((row) => [row.id, row.clientId]));
  const pendingOrderClients = new Set(input.orders.filter(isPendingOrder).map((row) => opportunityClient.get(row.opportunityId)).filter((id): id is string => Boolean(id)));

  const decide = (client: ClientRow): ClientDecision => {
    const code = client.code?.trim() ? normalizePartnerCode(client.code) : "";
    if (!code) return { kind: "semCodigoErp" };
    if (input.partnerCacheRows === null) return { kind: "naoCandidato", reason: "semCacheDoPartners" };
    const ownerInactive = usersById.get(client.ownerSellerId)?.isActive === false;
    const row = cache.get(code);
    let match: { rule: ArchiveRule; detail: RuleDetail } | null = null;
    if (!row) {
      if (!ownerInactive) return { kind: "naoCandidato", reason: "ausenteDoCacheComResponsavelAtivo" };
      match = { rule: "b", detail: "ausenteDoCache" };
    } else {
      const age = cacheLineFreshness(lastSeen[code], now);
      if (age !== "recente") return { kind: "cacheDesatualizado", age };
      const flag = classifyCustomerFlag(row);
      if (flag === "S") return { kind: "naoCandidato", reason: "idnClienteS" };
      if (flag === "N") match = { rule: "a", detail: "idnClienteN" };
      else {
        const sellerCode = normalizePartnerCode(pickFirstString(row, PARTNER_SELLER_CODE_KEYS));
        if (sellerCode && activeSellerCodes.has(sellerCode)) return { kind: "naoCandidato", reason: "linhaSemIdnClienteComVendedorErpAtivo" };
        if (!ownerInactive) return { kind: "naoCandidato", reason: "linhaSemIdnClienteComResponsavelAtivo" };
        match = { rule: "b", detail: "vendedorErpSemUsuarioAtivo" };
      }
    }
    const reasons: ProtectionReason[] = [];
    if (openOpportunityClients.has(client.id)) reasons.push("oportunidadeAberta");
    if (pendingOrderClients.has(client.id)) reasons.push("pedidoPendente");
    return reasons.length ? { kind: "protegido", ...match, reasons } : { kind: "candidato", ...match };
  };

  const decisions = input.clients.filter((client) => !client.isArchived).map((client) => ({ client, decision: decide(client) }));
  const candidates = decisions.flatMap(({ client, decision }) => (decision.kind === "candidato" ? [{ client, rule: decision.rule }] : []));
  return { decisions, candidates, cacheAvailable: input.partnerCacheRows !== null, lastSeenAvailable: input.partnerLastSeen !== null };
}

// ---------------------------------------------------------------------------------------------
// Resumo (só contagens e nomes de usuários do CRM).

const count = <T>(rows: T[], predicate: (row: T) => boolean) => rows.filter(predicate).length;

export function summarizePlan(plan: ArchivePlan, users: UserRow[], now: Date) {
  const decisions = plan.decisions.map((row) => row.decision);
  const candidates = decisions.filter((row): row is Extract<ClientDecision, { kind: "candidato" }> => row.kind === "candidato");
  const protectedRows = decisions.filter((row): row is Extract<ClientDecision, { kind: "protegido" }> => row.kind === "protegido");
  const stale = decisions.filter((row): row is Extract<ClientDecision, { kind: "cacheDesatualizado" }> => row.kind === "cacheDesatualizado");
  const notCandidates = decisions.filter((row): row is Extract<ClientDecision, { kind: "naoCandidato" }> => row.kind === "naoCandidato");
  const usersById = new Map(users.map((user) => [user.id, user]));
  const bySeller = new Map<string, { a: number; b: number }>();
  for (const { client, rule } of plan.candidates) {
    const entry = bySeller.get(client.ownerSellerId) ?? { a: 0, b: 0 };
    entry[rule] += 1;
    bySeller.set(client.ownerSellerId, entry);
  }
  const avisos: string[] = [];
  if (!plan.cacheAvailable) avisos.push(`Sem cache do /partners (${PARTNERS_CONFIG_KEY}) legível: nenhum cliente é decidido.`);
  else if (!plan.lastSeenAvailable) avisos.push(`Sem registro de quando cada parceiro veio do ERP (${PARTNERS_LAST_SEEN_CONFIG_KEY}): toda linha do cache conta como desatualizada.`);
  return {
    referencia: { agoraBrasilia: brasiliaDayKey(now), linhaDoCacheDecideSeVistaHaAte: `${CACHE_MAX_AGE_DAYS} dias` },
    naoArquivados: decisions.length,
    candidatos: {
      total: candidates.length,
      regraA: count(candidates, (row) => row.rule === "a"),
      regraB: count(candidates, (row) => row.rule === "b"),
      regraBAusenteDoCache: count(candidates, (row) => row.detail === "ausenteDoCache"),
      regraBVendedorErpSemUsuarioAtivo: count(candidates, (row) => row.detail === "vendedorErpSemUsuarioAtivo"),
    },
    // Um cliente pode ter os dois motivos: cada coluna conta quem tem aquele motivo.
    protegidos: {
      total: protectedRows.length,
      porMotivo: {
        oportunidadeAberta: count(protectedRows, (row) => row.reasons.includes("oportunidadeAberta")),
        pedidoPendente: count(protectedRows, (row) => row.reasons.includes("pedidoPendente")),
      },
      porRegra: { a: count(protectedRows, (row) => row.rule === "a"), b: count(protectedRows, (row) => row.rule === "b") },
    },
    cacheDesatualizado: {
      total: stale.length,
      semDataDeVisto: count(stale, (row) => row.age === "semDataDeVisto"),
      vistaHaMaisDe7Dias: count(stale, (row) => row.age === "vistaHaMaisDe7Dias"),
    },
    naoCandidatos: Object.fromEntries((["idnClienteS", "linhaSemIdnClienteComVendedorErpAtivo", "linhaSemIdnClienteComResponsavelAtivo", "ausenteDoCacheComResponsavelAtivo", "semCacheDoPartners"] as NotCandidateReason[])
      .map((reason) => [reason, count(notCandidates, (row) => row.reason === reason)])),
    semCodigoErp: count(decisions, (row) => row.kind === "semCodigoErp"),
    candidatosPorVendedorResponsavel: [...bySeller.entries()]
      .map(([sellerId, rules]) => {
        const user = usersById.get(sellerId);
        return { vendedor: user?.name ?? "(usuário inexistente)", usuarioAtivo: user?.isActive ?? false, regraA: rules.a, regraB: rules.b, total: rules.a + rules.b };
      })
      .sort((a, b) => a.vendedor.localeCompare(b.vendedor)),
    avisos,
  };
}

// ---------------------------------------------------------------------------------------------
// Banco: interface mínima do Prisma usada pelo script (o teste usa uma implementação em memória).

type Reader = { findMany(args: unknown): Promise<unknown[]> };
export type ArchiveDb = {
  client: Reader & { updateMany(args: unknown): Promise<{ count: number }> };
  user: Reader;
  opportunity: Reader;
  erpOrderSync: Reader;
  timelineEvent: Reader & { createMany(args: unknown): Promise<{ count: number }>; deleteMany(args: unknown): Promise<{ count: number }> };
  appConfig: { findUnique(args: unknown): Promise<unknown> };
};
export type TransactionRunner = <T>(fn: (tx: ArchiveDb) => Promise<T>) => Promise<T>;

const CLIENT_DECISION_SELECT = { id: true, code: true, isArchived: true, archiveReason: true, ownerSellerId: true };

export async function loadArchiveInput(db: ArchiveDb): Promise<ArchiveInput> {
  const [clients, users, opportunities, orders, partnerCache, partnerLastSeen] = await Promise.all([
    db.client.findMany({ where: { isArchived: false }, select: CLIENT_DECISION_SELECT }),
    db.user.findMany({ select: { id: true, name: true, isActive: true, erpCode: true } }),
    db.opportunity.findMany({ select: { id: true, clientId: true, stage: true } }),
    db.erpOrderSync.findMany({ where: { status: { in: ["pending", "sent"] } }, select: { opportunityId: true, status: true, operationalStatusRaw: true, orderStatus: true } }),
    db.appConfig.findUnique({ where: { key: PARTNERS_CONFIG_KEY }, select: { value: true } }),
    db.appConfig.findUnique({ where: { key: PARTNERS_LAST_SEEN_CONFIG_KEY }, select: { value: true } }),
  ]);
  return {
    clients: clients as ClientRow[],
    users: users as UserRow[],
    opportunities: opportunities as OpportunityRow[],
    orders: orders as OrderRow[],
    partnerCacheRows: parsePartnerCache((partnerCache as { value: string } | null)?.value),
    partnerLastSeen: parsePartnerLastSeen((partnerLastSeen as { value: string } | null)?.value),
  };
}

export type BackupTimelineEvent = { id: string; type: string; description: string; clientId: string; opportunityId: null; ownerSellerId: string; createdAt: string };
export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  archiveReason: string;
  /** Estado anterior completo de cada cliente arquivado (todas as colunas do Client). */
  clients: Record<string, unknown>[];
  rules: Record<string, ArchiveRule>;
  /** Eventos de timeline que o apply criou (o restore os remove pelo id). */
  timeline: BackupTimelineEvent[];
};

const writeBackupFile = (backupDir: string, backup: BackupFile) => {
  if (!statSync(backupDir).isDirectory()) throw new Error("--backup-dir não é um diretório.");
  const file = resolve(backupDir, `portfolio-cleanup-archive-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(backup, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  if (written.clients.length !== backup.clients.length || written.timeline.length !== backup.timeline.length || written.archiveReason !== backup.archiveReason) {
    throw new Error("Backup gravado não confere com o estado lido.");
  }
  return file;
};

const chunks = <T>(items: T[], size = UPDATE_CHUNK_SIZE) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function applyArchive(runInTransaction: TransactionRunner, options: { expected: number; backupDir: string; now?: Date }) {
  const now = options.now ?? new Date();
  return runInTransaction(async (tx) => {
    const input = await loadArchiveInput(tx);
    const plan = planPortfolioArchive(input, now);
    const summary = summarizePlan(plan, input.users, now);
    if (plan.candidates.length !== options.expected) {
      throw new Error(`Contagem divergente; nada foi gravado. --expect-archive=${options.expected}, encontrado ${plan.candidates.length}.`);
    }
    if (!plan.candidates.length) return { summary, backupFile: null, archived: 0 };
    const ids = plan.candidates.map(({ client }) => client.id);
    const fullRows = (await tx.client.findMany({ where: { id: { in: ids } } })) as ClientRow[];
    if (fullRows.length !== ids.length || fullRows.some((row) => row.isArchived)) throw new Error("Clientes mudaram durante a leitura; nada foi gravado.");
    const archiveReason = buildArchiveReason(now);
    const timeline: BackupTimelineEvent[] = plan.candidates.map(({ client, rule }) => ({
      id: randomUUID(),
      type: TIMELINE_TYPE_STATUS,
      description: archiveTimelineDescription(rule),
      clientId: client.id,
      opportunityId: null,
      ownerSellerId: client.ownerSellerId,
      createdAt: now.toISOString(),
    }));
    const backupFile = writeBackupFile(options.backupDir, {
      format: BACKUP_FORMAT,
      createdAt: now.toISOString(),
      archiveReason,
      clients: fullRows,
      rules: Object.fromEntries(plan.candidates.map(({ client, rule }) => [client.id, rule])),
      timeline,
    });
    for (const chunk of chunks(ids)) {
      const updated = await tx.client.updateMany({ where: { id: { in: chunk }, isArchived: false }, data: { isArchived: true, archiveReason } });
      if (updated.count !== chunk.length) throw new Error("Arquivamento divergente do plano; transação desfeita.");
    }
    let created = 0;
    for (const chunk of chunks(timeline)) {
      created += (await tx.timelineEvent.createMany({ data: chunk.map((event) => ({ ...event, createdAt: now })) })).count;
    }
    if (created !== timeline.length) throw new Error("Eventos de timeline divergentes do plano; transação desfeita.");
    return { summary, backupFile, archived: ids.length };
  });
}

export function parseBackupFile(content: string): BackupFile {
  const backup = JSON.parse(content) as BackupFile;
  if (backup.format !== BACKUP_FORMAT || typeof backup.archiveReason !== "string" || !backup.archiveReason.startsWith(ARCHIVE_REASON_PREFIX)
    || !Array.isArray(backup.clients) || !Array.isArray(backup.timeline)) {
    throw new Error("Arquivo de backup em formato inesperado.");
  }
  for (const client of backup.clients) {
    if (typeof client.id !== "string" || client.isArchived !== false || !("archiveReason" in client)) throw new Error("Backup incompleto: cliente sem o estado anterior.");
  }
  return backup;
}

/** Desfaz exatamente o apply: volta isArchived e archiveReason ao valor anterior e remove os eventos criados. */
export async function restoreFromBackup(runInTransaction: TransactionRunner, backup: BackupFile) {
  return runInTransaction(async (tx) => {
    const ids = backup.clients.map((client) => String(client.id));
    const current = (await tx.client.findMany({ where: { id: { in: ids } }, select: { id: true, isArchived: true, archiveReason: true } })) as ClientRow[];
    const changed = current.filter((client) => !client.isArchived || client.archiveReason !== backup.archiveReason);
    if (current.length !== ids.length || changed.length) {
      throw new Error(`Estado atual não corresponde ao pós-arquivamento (${ids.length - current.length} ausentes, ${changed.length} alterados); nada foi restaurado.`);
    }
    const eventIds = backup.timeline.map((event) => event.id);
    const events = await tx.timelineEvent.findMany({ where: { id: { in: eventIds } }, select: { id: true } });
    if (events.length !== eventIds.length) throw new Error("Eventos do arquivamento ausentes; nada foi restaurado.");
    const byReason = new Map<string | null, string[]>();
    for (const client of backup.clients) {
      const reason = (client.archiveReason ?? null) as string | null;
      byReason.set(reason, [...(byReason.get(reason) ?? []), String(client.id)]);
    }
    for (const [reason, reasonIds] of byReason) {
      for (const chunk of chunks(reasonIds)) {
        const updated = await tx.client.updateMany({ where: { id: { in: chunk }, isArchived: true, archiveReason: backup.archiveReason }, data: { isArchived: false, archiveReason: reason } });
        if (updated.count !== chunk.length) throw new Error("Restauração divergente do backup; transação desfeita.");
      }
    }
    let removed = 0;
    for (const chunk of chunks(eventIds)) removed += (await tx.timelineEvent.deleteMany({ where: { id: { in: chunk } } })).count;
    if (removed !== eventIds.length) throw new Error("Remoção de eventos divergente do backup; transação desfeita.");
    return { clientesRestaurados: ids.length, eventosRemovidos: removed };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions =
  | { mode: "simulate" }
  | { mode: "apply"; expected: number; backupDir: string }
  | { mode: "restore"; file: string };

const USAGE = "uso: archivePortfolioCleanup [--apply --expect-archive=N --backup-dir=<dir>] | [--restore=<arquivo>]";

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--(apply|expect-archive|backup-dir|restore)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    values.set(match[1], match[2] ?? true);
  }
  const text = (key: string) => {
    const value = values.get(key);
    if (typeof value !== "string") throw new Error(`${USAGE}\n--${key}=<caminho> é obrigatório.`);
    return value;
  };
  if (values.has("restore")) {
    if (values.size !== 1) throw new Error(USAGE);
    return { mode: "restore", file: text("restore") };
  }
  if (values.has("apply")) {
    if (values.get("apply") !== true) throw new Error(USAGE);
    const expected = values.get("expect-archive");
    if (typeof expected !== "string" || !/^\d+$/.test(expected)) throw new Error(`${USAGE}\n--apply exige --expect-archive=N.`);
    return { mode: "apply", expected: Number(expected), backupDir: text("backup-dir") };
  }
  if (values.size) throw new Error(`${USAGE}\nAs opções --expect-archive e --backup-dir só valem com --apply.`);
  return { mode: "simulate" };
}

export type ArchiveClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = ArchiveDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida os argumentos antes de criar o client: argumento inválido nunca abre conexão. */
export async function runCli(args: string[], createClient: () => ArchiveClient, log: (line: string) => void = console.log, now = new Date()) {
  const options = parseCliArgs(args);
  const client = createClient();
  const runInTransaction: TransactionRunner = (fn) =>
    client.$transaction((tx) => fn(tx as ArchiveDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 10_000 });
  try {
    if (options.mode === "simulate") {
      // Snapshot consistente e o banco recusa qualquer escrita nesta transação.
      const { plan, users } = await client.$transaction(async (tx) => {
        const readOnly = tx as ReadOnlyTx;
        await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
        const input = await loadArchiveInput(readOnly);
        return { plan: planPortfolioArchive(input, now), users: input.users };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizePlan(plan, users, now) }, null, 2));
    } else if (options.mode === "apply") {
      const result = await applyArchive(runInTransaction, { expected: options.expected, backupDir: options.backupDir, now });
      log(JSON.stringify({ modo: "apply concluído", arquivados: result.archived, backup: result.backupFile, ...result.summary }, null, 2));
    } else {
      const backup = parseBackupFile(readFileSync(options.file, "utf8"));
      const result = await restoreFromBackup(runInTransaction, backup);
      log(JSON.stringify({ modo: "restore concluído", ...result }, null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as ArchiveClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
