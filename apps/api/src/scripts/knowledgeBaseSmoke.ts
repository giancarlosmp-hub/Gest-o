import { prisma } from "../config/prisma.js";
import { getKnowledgeContextForAi, searchKnowledgeDocuments } from "../services/knowledgeBaseService.js";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

async function main() {
  const unique = `smoke-${Date.now()}`;
  const diretor = await prisma.user.upsert({
    where: { email: `${unique}@kb.local` },
    update: {},
    create: { name: "Smoke Diretor", email: `${unique}@kb.local`, passwordHash: "smoke", role: "diretor", isActive: true },
    select: { id: true, role: true }
  });
  const vendedor = await prisma.user.create({ data: { name: "Smoke Vendedor", email: `${unique}-seller@kb.local`, passwordHash: "smoke", role: "vendedor", isActive: true }, select: { role: true } });
  assert(vendedor.role !== "diretor" && vendedor.role !== "gerente", "vendedor não deve ter papel administrativo");

  const created = await prisma.knowledgeDocument.create({
    data: {
      title: `Documento ativo ${unique}`,
      category: "produto",
      sourceType: "manual",
      sourceName: "smoke",
      content: `Conteúdo consultivo sobre Acervo Sementes ${unique}`,
      tags: [unique, "acervo"],
      createdById: diretor.id
    }
  });
  assert(created.id, "criar documento");

  const listed = await prisma.knowledgeDocument.findMany({ where: { id: created.id } });
  assert(listed.length === 1, "listar documento");

  const edited = await prisma.knowledgeDocument.update({ where: { id: created.id }, data: { title: `Documento editado ${unique}` } });
  assert(edited.title.includes("editado"), "editar documento");

  const activeSearch = await searchKnowledgeDocuments({ query: unique, limit: 10 });
  assert(activeSearch.some((doc) => doc.id === created.id), "buscar documento ativo");

  await prisma.knowledgeDocument.update({ where: { id: created.id }, data: { isActive: false } });
  const inactiveSearch = await searchKnowledgeDocuments({ query: unique, limit: 10 });
  assert(!inactiveSearch.some((doc) => doc.id === created.id), "não retornar documento inativo");

  const longDoc = await prisma.knowledgeDocument.create({
    data: { title: `Documento contexto ${unique}`, category: "institucional", sourceType: "manual", content: `${unique} ${"x".repeat(5000)}`, tags: [unique], isActive: true }
  });
  const context = await getKnowledgeContextForAi(unique, 300);
  assert(context.length <= 300, "getKnowledgeContextForAi retorna contexto limitado");

  await prisma.knowledgeDocument.deleteMany({ where: { id: { in: [created.id, longDoc.id] } } });
  await prisma.user.deleteMany({ where: { email: { in: [`${unique}@kb.local`, `${unique}-seller@kb.local`] } } });
  console.log("Knowledge base smoke OK");
}

main().finally(async () => prisma.$disconnect());
