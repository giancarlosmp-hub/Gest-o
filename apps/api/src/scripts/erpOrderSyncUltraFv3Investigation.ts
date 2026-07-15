import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OFFICIAL_ORDER_KEYS = new Set([
  "PEDIDO",
  "PEDIDO_ID",
  "PEDIDO_NUMERO",
  "NUMERO_PEDIDO_ERP",
  "NUM_PEDIDO_ERP",
  "NROPEDIDO",
  "NR_PEDIDO",
  "CODPEDIDO",
  "COD_PEDIDO",
  "ID_PEDIDO",
  "idPedido",
  "pedidoId",
  "numeroPedidoErp",
  "erpOrderNumber",
  "orderNumber",
  "pedido",
]);

const REDACT_KEY_RE = /(token|senha|password|authorization|cookie|secret|credential|cpf|cnpj|email|telefone|phone|celular|endereco|address|cliente|nome|razao|fantasia)/i;

type PathHit = { path: string; value: string };

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    REDACT_KEY_RE.test(key) ? "[REDACTED]" : sanitize(entry, depth + 1),
  ]));
}

function collectOfficialNumberHits(value: unknown, path = "$", depth = 0): PathHit[] {
  if (!value || typeof value !== "object" || depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectOfficialNumberHits(entry, `${path}[${index}]`, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const nextPath = `${path}.${key}`;
    const direct = OFFICIAL_ORDER_KEYS.has(key) && ["string", "number", "bigint"].includes(typeof entry) && String(entry).trim()
      ? [{ path: nextPath, value: String(entry).trim() }]
      : [];
    return [...direct, ...collectOfficialNumberHits(entry, nextPath, depth + 1)];
  });
}

function firstOfficialNumberHit(value: unknown): PathHit | null {
  return collectOfficialNumberHits(value)[0] ?? null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não está configurada; informe a URL read-only do PostgreSQL do CRM para executar a investigação sem alterar dados.");
  }

  const pedido3360Rows = await prisma.erpOrderSync.findMany({
    where: {
      OR: [
        { numPedido: "3360" },
        { erpOrderNumber: "3360" },
        { payloadSent: { path: ["NUM_PEDIDO"], equals: "3360" } },
      ],
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const oldSequentialRows = await prisma.erpOrderSync.findMany({
    where: { status: "sent", numPedido: { not: null } },
    orderBy: [{ createdAt: "asc" }],
    take: 25,
  });

  const recentProblemRows = await prisma.erpOrderSync.findMany({
    where: {
      OR: [
        { numPedido: "0" },
        { erpOrderNumber: "0" },
        { numPedido: { startsWith: "PMR", mode: "insensitive" } },
        { erpOrderNumber: { startsWith: "PMR", mode: "insensitive" } },
      ],
    },
    orderBy: [{ createdAt: "desc" }],
    take: 25,
  });

  const candidateRowsByResponse = await prisma.erpOrderSync.findMany({
    where: { status: "sent", erpResponse: { not: undefined } },
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  });

  const allRows = [...pedido3360Rows, ...oldSequentialRows, ...recentProblemRows, ...candidateRowsByResponse];
  const rowsById = new Map(allRows.map((row) => [row.id, row]));
  const relevant = [...rowsById.values()].filter((row) =>
    row.numPedido === "3360" ||
    row.erpOrderNumber === "3360" ||
    getPath(row.payloadSent, "NUM_PEDIDO") === "3360" ||
    row.status === "sent" ||
    row.numPedido === "0" ||
    row.erpOrderNumber === "0" ||
    /^PMR/i.test(row.numPedido ?? "") ||
    /^PMR/i.test(row.erpOrderNumber ?? "") ||
    firstOfficialNumberHit(row.erpResponse) ||
    firstOfficialNumberHit(row.lastStatusPayload)
  );

  const records = relevant.map((row) => {
    const payloadNumPedido = getPath(row.payloadSent, "NUM_PEDIDO");
    const postHit = firstOfficialNumberHit(row.erpResponse);
    const statusHit = firstOfficialNumberHit(row.lastStatusPayload);
    return {
      id: row.id,
      opportunityId: row.opportunityId,
      pedidoIdImportacao: row.pedidoIdImportacao,
      numPedido: row.numPedido,
      "payloadSent.NUM_PEDIDO": payloadNumPedido ?? null,
      erpOrderNumber: row.erpOrderNumber,
      erpOrderNumberLikelySource: postHit?.value === row.erpOrderNumber ? `erpResponse:${postHit.path}` : row.erpOrderNumber === row.numPedido || row.erpOrderNumber === payloadNumPedido ? "NUM_PEDIDO fallback/copy" : "undetermined",
      erpResponseOfficialNumberHits: collectOfficialNumberHits(row.erpResponse),
      lastStatusOfficialNumberHits: collectOfficialNumberHits(row.lastStatusPayload),
      erpResponse: sanitize(row.erpResponse),
      lastStatusPayload: sanitize(row.lastStatusPayload),
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      status: row.status,
      erro: sanitize(row.syncErrors),
    };
  });

  const summary = {
    totalRelevantRecords: records.length,
    pedido3360Records: records.filter((row) => row.numPedido === "3360" || row.erpOrderNumber === "3360" || row["payloadSent.NUM_PEDIDO"] === "3360").length,
    erpResponseContainsOfficialNumberEquivalent: records.filter((row) => row.erpResponseOfficialNumberHits.length).length,
    lastStatusContainsOfficialNumberEquivalent: records.filter((row) => row.lastStatusOfficialNumberHits.length).length,
    numPedidoFallbackOrCopy: records.filter((row) => row.erpOrderNumberLikelySource === "NUM_PEDIDO fallback/copy").length,
    pmrOrZeroRecords: records.filter((row) => row.numPedido === "0" || row.erpOrderNumber === "0" || /^PMR/i.test(row.numPedido ?? "") || /^PMR/i.test(row.erpOrderNumber ?? "")).length,
  };

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary, records }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
