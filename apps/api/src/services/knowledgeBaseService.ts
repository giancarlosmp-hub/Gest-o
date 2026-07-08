import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

export const KNOWLEDGE_CONTEXT_MAX_CHARS = 2400;
export const KNOWLEDGE_CONTEXT_MAX_DOCUMENTS = 4;

const MAX_QUERY_LENGTH = 800;
const MAX_DOCUMENTS = KNOWLEDGE_CONTEXT_MAX_DOCUMENTS;
const MAX_EXCERPT_LENGTH = 650;
const MAX_CONTEXT_LENGTH = KNOWLEDGE_CONTEXT_MAX_CHARS;
const MAX_SEARCH_CANDIDATES = 12;

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

export type KnowledgeContextSource =
  | "client-suggestion"
  | "opportunity-message"
  | "assistant-whatsapp";

export const INITIAL_KNOWLEDGE_DOCUMENTS = [
  {
    title: "Conhecimento institucional Demetra Agro e Acervo Sementes",
    category: "institucional",
    sourceType: "interno",
    sourceName: "seed-inicial",
    summary: "Base institucional mínima para a IA Comercial.",
    tags: ["demetra", "acervo-sementes", "institucional", "portfólio"],
    content: [
      "Demetra Agro é distribuidora de sementes.",
      "Acervo Sementes é marca própria.",
      "O portfólio inclui sementes forrageiras, cobertura, pastagem, inverno e verão.",
      "A abordagem comercial deve ser consultiva e técnica, sem inventar recomendações agronômicas detalhadas."
    ].join("\n")
  }
];

type SearchKnowledgeInput = {
  query?: string | null;
  tag?: string | null;
  category?: string | null;
  includeInactive?: boolean;
  limit?: number;
};

const normalize = (value?: string | null) => (value || "").trim();

const compactText = (value: unknown, maxLength: number) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
};

const tokenize = (value: string) =>
  Array.from(
    new Set(
      value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 24);

const calculateScore = (queryTokens: string[], documentText: string) => {
  const normalized = documentText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return queryTokens.reduce(
    (score, token) => score + (normalized.includes(token) ? 1 : 0),
    0
  );
};

const buildTextFilters = (query: string): Prisma.KnowledgeDocumentWhereInput[] => {
  if (!query) return [];

  return [
    { title: { contains: query, mode: "insensitive" } },
    { content: { contains: query, mode: "insensitive" } },
    { summary: { contains: query, mode: "insensitive" } },
    { sourceName: { contains: query, mode: "insensitive" } },
    { tags: { has: query.toLowerCase() } }
  ];
};

export async function ensureInitialKnowledgeDocuments() {
  for (const doc of INITIAL_KNOWLEDGE_DOCUMENTS) {
    const exists = await prisma.knowledgeDocument.findFirst({
      where: {
        sourceType: doc.sourceType,
        sourceName: doc.sourceName,
        title: doc.title
      },
      select: { id: true }
    });

    if (!exists) {
      await prisma.knowledgeDocument.create({ data: doc });
    }
  }
}

export async function searchKnowledgeDocuments(input: SearchKnowledgeInput) {
  const query = normalize(input.query);
  const tag = normalize(input.tag).toLowerCase();
  const category = normalize(input.category);

  const and: Prisma.KnowledgeDocumentWhereInput[] = [];

  if (!input.includeInactive) and.push({ isActive: true });
  if (category) and.push({ category });
  if (tag) and.push({ tags: { has: tag } });

  const textFilters = buildTextFilters(query);
  if (textFilters.length) and.push({ OR: textFilters });

  return prisma.knowledgeDocument.findMany({
    where: and.length ? { AND: and } : undefined,
    orderBy: [{ updatedAt: "desc" }],
    take: Math.min(Math.max(input.limit ?? 25, 1), 100)
  });
}

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

export const getKnowledgeContextForAi = async (
  query: string
): Promise<KnowledgeContextResult> => {
  const startedAt = Date.now();
  const normalizedQuery = compactText(query, MAX_QUERY_LENGTH);
  const queryTokens = tokenize(normalizedQuery);

  if (!normalizedQuery || queryTokens.length === 0) {
    return { documents: [], context: "", elapsedMs: Date.now() - startedAt };
  }

  const documents = await searchKnowledgeDocuments({
    query: normalizedQuery,
    limit: MAX_SEARCH_CANDIDATES
  });

  const ranked = documents
    .map((document) => {
      const score = calculateScore(
        queryTokens,
        `${document.category ?? ""} ${document.title} ${document.summary ?? ""} ${document.content}`
      );

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
    ranked
      .map((document) =>
        [
          `- Categoria: ${document.category || "geral"}`,
          `Título: ${document.title}`,
          `Resumo: ${document.summary || document.excerpt}`
        ].join(" | ")
      )
      .join("\n"),
    MAX_CONTEXT_LENGTH
  );

  return {
    documents: ranked,
    context,
    elapsedMs: Date.now() - startedAt
  };
};

const summarizeKnowledgeError = (error: unknown) => {
  if (!(error instanceof Error)) return String(error).slice(0, 120);
  if (error.message.includes("DATABASE_URL")) return "knowledge_database_unavailable";
  if (
    error.message.includes("KnowledgeDocument") ||
    error.message.includes("knowledgeDocument")
  ) {
    return "knowledge_query_failed";
  }

  return error.message.replace(/\s+/g, " ").slice(0, 120);
};

export const resolveKnowledgeContextForAi = async (
  source: KnowledgeContextSource,
  query: string
) => {
  const startedAt = Date.now();

  try {
    const result = await getKnowledgeContextForAi(query);
    const contextUsed = result.context.trim().length > 0;

    logApiEvent("INFO", `[ai/${source}] knowledge-context`, {
      documentsFound: result.documents.length,
      categories: Array.from(
        new Set(result.documents.map((document) => document.category || "geral"))
      ),
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