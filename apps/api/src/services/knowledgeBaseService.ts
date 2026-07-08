import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export const KNOWLEDGE_CONTEXT_MAX_CHARS = 2400;
export const KNOWLEDGE_CONTEXT_MAX_DOCUMENTS = 4;

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

export async function getKnowledgeContextForAi(query: string, maxChars = KNOWLEDGE_CONTEXT_MAX_CHARS) {
  const documents = await searchKnowledgeDocuments({ query, limit: KNOWLEDGE_CONTEXT_MAX_DOCUMENTS });
  const snippets: string[] = [];
  let remaining = Math.max(Math.min(maxChars, KNOWLEDGE_CONTEXT_MAX_CHARS), 0);

  for (const doc of documents) {
    if (remaining <= 0) break;
    const base = [`Título: ${doc.title}`, doc.summary ? `Resumo: ${doc.summary}` : null, `Conteúdo: ${doc.content}`]
      .filter(Boolean)
      .join("\n");
    const snippet = base.slice(0, remaining);
    snippets.push(snippet);
    remaining -= snippet.length + 2;
  }

  return snippets.join("\n\n---\n\n");
}
