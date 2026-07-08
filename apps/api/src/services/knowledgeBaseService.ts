import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

export type KnowledgeContextDocument = {
  id: string;
  category: string | null;
  title: string;
  summary: string | null;
  excerpt: string;
  score: number;
};

export type KnowledgeContextResult = {
  documents: KnowledgeContextDocument[];
  context: string;
  elapsedMs: number;
};

export type KnowledgeContextSource = "client-suggestion" | "opportunity-message" | "assistant-whatsapp";

type KnowledgeDocumentRecord = {
  id: string;
  category: string | null;
  title: string;
  summary: string | null;
  content: string;
};

type KnowledgeDocumentDelegate = {
  createMany?: (args: { data: Array<{ title: string; category: string; summary: string; content: string; isActive: boolean }>; skipDuplicates?: boolean }) => Promise<unknown>;
  findMany?: (args: {
    where: unknown;
    select: { id: true; category: true; title: true; summary: true; content: true };
    take: number;
    orderBy: { updatedAt: "desc" };
  }) => Promise<KnowledgeDocumentRecord[]>;
};

export const INITIAL_KNOWLEDGE_DOCUMENTS = [
  {
    title: "Uso responsável da Base de Conhecimento Demetra",
    category: "governanca",
    summary: "Orienta a IA Comercial a usar conhecimento interno apenas quando for relevante ao contexto comercial.",
    content: "Use informações internas da Demetra somente quando forem relevantes ao cliente, oportunidade ou conversa. Não mencione ao cliente que uma base interna foi consultada e não invente dados que não estejam no contexto recebido.",
    isActive: true
  }
] as const;

const MAX_QUERY_LENGTH = 800;
const MAX_DOCUMENTS = 4;
const MAX_EXCERPT_LENGTH = 650;
const MAX_CONTEXT_LENGTH = 2400;
const MAX_SEARCH_CANDIDATES = 12;

const compactText = (value: unknown, maxLength: number) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
};

const tokenize = (value: string) =>
  Array.from(new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((token) => token.length >= 3))).slice(0, 24);

const calculateScore = (queryTokens: string[], documentText: string) => {
  const normalized = documentText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return queryTokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
};

const getKnowledgeDocumentDelegate = () => (prisma as unknown as { knowledgeDocument?: KnowledgeDocumentDelegate }).knowledgeDocument;

export const ensureInitialKnowledgeDocuments = async () => {
  const delegate = getKnowledgeDocumentDelegate();
  if (delegate?.createMany) {
    await delegate.createMany({ data: [...INITIAL_KNOWLEDGE_DOCUMENTS], skipDuplicates: true });
    return;
  }

  for (const document of INITIAL_KNOWLEDGE_DOCUMENTS) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeDocument" (id, title, category, summary, content, "isActive", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${document.title}, ${document.category}, ${document.summary}, ${document.content}, ${document.isActive}, NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM "KnowledgeDocument" existing WHERE existing.title = ${document.title}
      )
    `);
  }
};

export const searchKnowledgeDocuments = async ({ query, limit = MAX_SEARCH_CANDIDATES }: { query: string; limit?: number }) => {
  const normalizedQuery = compactText(query, MAX_QUERY_LENGTH);
  const queryTokens = tokenize(normalizedQuery);
  const boundedLimit = Math.max(1, Math.min(limit, MAX_SEARCH_CANDIDATES));

  if (!normalizedQuery || queryTokens.length === 0) {
    return { documents: [] as KnowledgeDocumentRecord[], queryTokens };
  }

  const delegate = getKnowledgeDocumentDelegate();
  if (delegate?.findMany) {
    const tokenFilters = queryTokens.slice(0, 8).flatMap((token) => [
      { title: { contains: token, mode: "insensitive" } },
      { summary: { contains: token, mode: "insensitive" } },
      { content: { contains: token, mode: "insensitive" } },
      { category: { contains: token, mode: "insensitive" } }
    ]);

    const documents = await delegate.findMany({
      where: { isActive: true, OR: tokenFilters },
      select: { id: true, category: true, title: true, summary: true, content: true },
      take: boundedLimit,
      orderBy: { updatedAt: "desc" }
    });

    return { documents, queryTokens };
  }

  const documents = await prisma.$queryRaw<KnowledgeDocumentRecord[]>`
    SELECT id, category, title, summary, content
    FROM "KnowledgeDocument"
    WHERE "isActive" = true
      AND (
        title ILIKE ${`%${normalizedQuery}%`}
        OR COALESCE(summary, '') ILIKE ${`%${normalizedQuery}%`}
        OR content ILIKE ${`%${normalizedQuery}%`}
        OR COALESCE(category, '') ILIKE ${`%${normalizedQuery}%`}
        OR EXISTS (
          SELECT 1
          FROM unnest(${queryTokens.slice(0, 8)}::text[]) AS token
          WHERE title ILIKE ('%' || token || '%')
             OR COALESCE(summary, '') ILIKE ('%' || token || '%')
             OR content ILIKE ('%' || token || '%')
             OR COALESCE(category, '') ILIKE ('%' || token || '%')
        )
      )
    ORDER BY "updatedAt" DESC
    LIMIT ${boundedLimit}
  `;

  return { documents, queryTokens };
};

export const formatKnowledgeContextBlock = (context: string | null | undefined) => {
  const normalized = compactText(context, MAX_CONTEXT_LENGTH);
  if (!normalized) return "";
  return [
    "Conhecimento interno Demetra/Acervo disponível:",
    normalized,
    "Use este conhecimento apenas se for relevante.",
    "Não invente informações além do contexto."
  ].join("\n");
};

export const getKnowledgeContextForAi = async (query: string): Promise<KnowledgeContextResult> => {
  const startedAt = Date.now();
  const { documents, queryTokens } = await searchKnowledgeDocuments({ query, limit: MAX_SEARCH_CANDIDATES });

  if (documents.length === 0 || queryTokens.length === 0) {
    return { documents: [], context: "", elapsedMs: Date.now() - startedAt };
  }

  const ranked = documents
    .map((document) => {
      const score = calculateScore(queryTokens, `${document.category ?? ""} ${document.title} ${document.summary ?? ""} ${document.content}`);
      return {
        id: document.id,
        category: document.category,
        title: compactText(document.title, 120),
        summary: compactText(document.summary, 240) || null,
        excerpt: compactText(document.summary || document.content, MAX_EXCERPT_LENGTH),
        score
      };
    })
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DOCUMENTS);

  const context = compactText(
    ranked.map((document) => [`- Categoria: ${document.category || "geral"}`, `Título: ${document.title}`, `Resumo: ${document.summary || document.excerpt}`].join(" | ")).join("\n"),
    MAX_CONTEXT_LENGTH
  );

  return { documents: ranked, context, elapsedMs: Date.now() - startedAt };
};

const summarizeKnowledgeError = (error: unknown) => {
  if (!(error instanceof Error)) return String(error).slice(0, 120);
  if (error.message.includes("DATABASE_URL")) return "knowledge_database_unavailable";
  if (error.message.includes("KnowledgeDocument") || error.message.includes("knowledgeDocument")) return "knowledge_query_failed";
  return error.message.replace(/\s+/g, " ").slice(0, 120);
};

export const resolveKnowledgeContextForAi = async (source: KnowledgeContextSource, query: string) => {
  const startedAt = Date.now();
  try {
    const result = await getKnowledgeContextForAi(query);
    const contextUsed = result.context.trim().length > 0;
    logApiEvent("INFO", `[ai/${source}] knowledge-context`, {
      documentsFound: result.documents.length,
      categories: Array.from(new Set(result.documents.map((document) => document.category || "geral"))),
      elapsedMs: result.elapsedMs,
      contextUsed
    });
    return formatKnowledgeContextBlock(result.context);
  } catch (error) {
    logApiEvent("WARN", `[ai/${source}] knowledge-context-failed`, {
      elapsedMs: Date.now() - startedAt,
      contextUsed: false,
      error: summarizeKnowledgeError(error)
    });
    return "";
  }
};
