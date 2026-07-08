import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

export const KNOWLEDGE_CONTEXT_MAX_CHARS = 2400;
export const KNOWLEDGE_CONTEXT_MAX_DOCUMENTS = 4;
const KNOWLEDGE_CONTEXT_MAX_QUERY_CHARS = 320;
const KNOWLEDGE_CONTEXT_MAX_SNIPPET_CHARS = 700;

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

export type KnowledgeContextSource = {
  id: string;
  title: string;
  category: string;
  sourceType: string;
  sourceName: string | null;
  score: number;
};

export type KnowledgeContextDocument = KnowledgeContextSource & {
  summary: string | null;
  snippet: string;
};

export type KnowledgeContextResult = {
  documents: KnowledgeContextDocument[];
  context: string;
  elapsedMs: number;
};

const normalize = (value?: string | null) => (value || "").trim();
const normalizeSpaces = (value?: string | null) => normalize(value).replace(/\s+/g, " ");
const clampText = (value: string, maxChars: number) => (value.length > maxChars ? `${value.slice(0, Math.max(maxChars - 1, 0))}…` : value);

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

const scoreKnowledgeDocument = (doc: { title: string; content: string; summary: string | null; tags: string[] }, query: string) => {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length >= 3);
  if (!terms.length) return 1;
  const fields = [doc.title, doc.summary || "", doc.content, doc.tags.join(" ")].map((field) => field.toLowerCase());
  return terms.reduce((score, term) => score + fields.reduce((sum, field, index) => sum + (field.includes(term) ? [4, 3, 1, 5][index] : 0), 0), 0);
};

const buildSnippet = (doc: { content: string; summary: string | null }, maxChars = KNOWLEDGE_CONTEXT_MAX_SNIPPET_CHARS) => {
  const text = normalizeSpaces([doc.summary, doc.content].filter(Boolean).join(" "));
  return clampText(text, maxChars);
};

export async function ensureInitialKnowledgeDocuments() {
  for (const doc of INITIAL_KNOWLEDGE_DOCUMENTS) {
    const exists = await prisma.knowledgeDocument.findFirst({
      where: { sourceType: doc.sourceType, sourceName: doc.sourceName, title: doc.title },
      select: { id: true }
    });
    if (!exists) await prisma.knowledgeDocument.create({ data: doc });
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

export const formatKnowledgeContextBlock = (documents: KnowledgeContextDocument[]) => {
  if (!documents.length) return "";
  const items = documents.map((doc, index) => [`${index + 1}. ${doc.title} (${doc.category})`, doc.summary ? `Resumo: ${doc.summary}` : null, `Trecho: ${doc.snippet}`].filter(Boolean).join("\n"));
  return [
    "Conhecimento interno Demetra/Acervo disponível:",
    items.join("\n\n"),
    "Use este conhecimento apenas se for relevante.",
    "Não invente informações além do contexto."
  ].join("\n");
};

export async function getKnowledgeContextForAi(query: string, maxChars = KNOWLEDGE_CONTEXT_MAX_CHARS): Promise<KnowledgeContextResult> {
  const startedAt = Date.now();
  const safeQuery = clampText(normalizeSpaces(query), KNOWLEDGE_CONTEXT_MAX_QUERY_CHARS);
  const safeMaxChars = Math.max(0, Math.min(maxChars, KNOWLEDGE_CONTEXT_MAX_CHARS));

  try {
    const found = await searchKnowledgeDocuments({ query: safeQuery, limit: KNOWLEDGE_CONTEXT_MAX_DOCUMENTS });
    const documents = found
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        sourceType: doc.sourceType,
        sourceName: doc.sourceName,
        summary: doc.summary ? clampText(normalizeSpaces(doc.summary), 220) : null,
        snippet: buildSnippet(doc),
        score: scoreKnowledgeDocument(doc, safeQuery)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, KNOWLEDGE_CONTEXT_MAX_DOCUMENTS);

    const context = clampText(formatKnowledgeContextBlock(documents), safeMaxChars);
    const elapsedMs = Date.now() - startedAt;
    logApiEvent("INFO", "[knowledge-base/ai-context] resolved", { queryLength: safeQuery.length, documents: documents.length, contextLength: context.length, elapsedMs });
    return { documents, context, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logApiEvent("WARN", "[knowledge-base/ai-context] fallback-empty", { queryLength: safeQuery.length, elapsedMs, error: error instanceof Error ? error.message : String(error) });
    return { documents: [], context: "", elapsedMs };
  }
}

export const resolveKnowledgeContextForAi = async (query: string, maxChars = KNOWLEDGE_CONTEXT_MAX_CHARS) => getKnowledgeContextForAi(query, maxChars);
