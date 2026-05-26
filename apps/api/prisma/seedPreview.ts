import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PREVIEW_SEED_TAG = "[preview-seed]";
const PREVIEW_SEED_PASSWORD = "123456";
const PREVIEW_SELLERS = [
  { name: "Vendedora Preview Ana", email: "ana.preview@preview.local", region: "Sudeste" },
  { name: "Vendedor Preview Bruno", email: "bruno.preview@preview.local", region: "Sul" },
  { name: "Vendedora Preview Carla", email: "carla.preview@preview.local", region: "Centro-Oeste" }
] as const;

type PreviewClientTemplate = {
  name: string;
  city: string;
  state: string;
  region: string;
  segment: string;
};

const PREVIEW_PRODUCTS = [
  {
    erpProductCode: "1001",
    erpProductClassCode: "SEMENTE",
    name: "Semente Soja Premium",
    className: "Sementes",
    unit: "SC",
    brand: "Demetra",
    groupName: "Soja",
    defaultPrice: 210,
    minPrice: 190,
    prices: [{ erpPriceId: "P1001", branchCode: "01", price: 210 }]
  },
  {
    erpProductCode: "2003",
    erpProductClassCode: "FERT",
    name: "Fertilizante NPK 20-05-20",
    className: "Fertilizantes",
    unit: "SC",
    brand: "Demetra",
    groupName: "Nutrição",
    defaultPrice: 168,
    minPrice: 150,
    prices: [{ erpPriceId: "P2003", branchCode: "01", price: 168 }]
  },
  {
    erpProductCode: "3010",
    erpProductClassCode: "DEF",
    name: "Inseticida Controle Total",
    className: "Defensivos",
    unit: "LT",
    brand: "Demetra",
    groupName: "Proteção",
    defaultPrice: 98.5,
    minPrice: 89.9,
    prices: [{ erpPriceId: "P3010", branchCode: "02", price: 98.5 }]
  },
  {
    erpProductCode: "4107",
    erpProductClassCode: "BIO",
    name: "Inoculante NitroFix",
    className: "Biológicos",
    unit: "LT",
    brand: "Demetra",
    groupName: "Biológicos",
    defaultPrice: 74,
    minPrice: 66,
    prices: [{ erpPriceId: "P4107", branchCode: "01", price: 74 }]
  },
  {
    erpProductCode: "5202",
    erpProductClassCode: "HERB",
    name: "Herbicida Pós-Emergente",
    className: "Defensivos",
    unit: "LT",
    brand: "Demetra",
    groupName: "Proteção",
    defaultPrice: 132,
    minPrice: 121,
    prices: [{ erpPriceId: "P5202", branchCode: "02", price: 132 }]
  },
  {
    erpProductCode: "6301",
    erpProductClassCode: "FOLIAR",
    name: "Fertilizante Foliar Premium",
    className: "Nutrição Foliar",
    unit: "LT",
    brand: "Demetra",
    groupName: "Nutrição",
    defaultPrice: 58,
    minPrice: 52,
    prices: [{ erpPriceId: "P6301", branchCode: "01", price: 58 }]
  }
] as const;

const PREVIEW_CLIENTS: PreviewClientTemplate[] = [
  { name: "Fazenda Horizonte", city: "Ribeirão Preto", state: "SP", region: "Sudeste", segment: "Soja" },
  { name: "Sítio Boa Safra", city: "Uberaba", state: "MG", region: "Sudeste", segment: "Milho" },
  { name: "Grupo Campo Forte", city: "Patrocínio", state: "MG", region: "Sudeste", segment: "Café" },
  { name: "Agro Vale Verde", city: "Londrina", state: "PR", region: "Sul", segment: "Soja" },
  { name: "Fazenda Santa Luz", city: "Cascavel", state: "PR", region: "Sul", segment: "Milho" },
  { name: "Cooperativa Três Rios", city: "Passo Fundo", state: "RS", region: "Sul", segment: "Trigo" },
  { name: "Agro Serra Azul", city: "Rio Verde", state: "GO", region: "Centro-Oeste", segment: "Soja" },
  { name: "Fazenda Nova Esperança", city: "Sorriso", state: "MT", region: "Centro-Oeste", segment: "Algodão" },
  { name: "Grupo Alto Cerrado", city: "Dourados", state: "MS", region: "Centro-Oeste", segment: "Milho" },
  { name: "Fazenda Bela Vista", city: "Campo Grande", state: "MS", region: "Centro-Oeste", segment: "Soja" }
];

type SeedOpportunityTemplate = {
  stage: Prisma.OpportunityStage;
  title: string;
  daysFromNowProposal: number;
  daysFromNowFollowUp: number;
  daysFromNowExpectedClose: number;
  closedAtOffset?: number;
  value: number;
  probability: number;
};

type PreviewAgendaTemplate = {
  title: string;
  type: Prisma.AgendaEventType;
  startOffsetDays: number;
  startHour: number;
  durationHours: number;
  status: Prisma.AgendaEventStatus;
  notes: string;
  withStops?: boolean;
};

const OPPORTUNITY_TEMPLATES: SeedOpportunityTemplate[] = [
  { stage: "prospeccao", title: "Pipeline prospecção 1", daysFromNowProposal: -4, daysFromNowFollowUp: 3, daysFromNowExpectedClose: 12, value: 38000, probability: 25 },
  { stage: "prospeccao", title: "Pipeline prospecção 2", daysFromNowProposal: -38, daysFromNowFollowUp: -10, daysFromNowExpectedClose: -2, value: 29000, probability: 20 },
  { stage: "negociacao", title: "Pipeline negociação 1", daysFromNowProposal: -2, daysFromNowFollowUp: 2, daysFromNowExpectedClose: 9, value: 62000, probability: 55 },
  { stage: "negociacao", title: "Pipeline negociação 2", daysFromNowProposal: -21, daysFromNowFollowUp: -5, daysFromNowExpectedClose: -1, value: 51000, probability: 48 },
  { stage: "proposta", title: "Pipeline proposta 1", daysFromNowProposal: -6, daysFromNowFollowUp: 1, daysFromNowExpectedClose: 7, value: 45000, probability: 75 },
  { stage: "proposta", title: "Pipeline proposta 2", daysFromNowProposal: -45, daysFromNowFollowUp: -15, daysFromNowExpectedClose: -4, value: 47000, probability: 70 },
  { stage: "ganho", title: "Negócio ganho 1", daysFromNowProposal: -5, daysFromNowFollowUp: -2, daysFromNowExpectedClose: -1, closedAtOffset: -1, value: 88000, probability: 100 },
  { stage: "ganho", title: "Negócio ganho 2", daysFromNowProposal: -27, daysFromNowFollowUp: -20, daysFromNowExpectedClose: -18, closedAtOffset: -18, value: 94000, probability: 100 },
  { stage: "perdido", title: "Negócio perdido 1", daysFromNowProposal: -8, daysFromNowFollowUp: -3, daysFromNowExpectedClose: -2, closedAtOffset: -2, value: 41000, probability: 0 },
  { stage: "perdido", title: "Negócio perdido 2", daysFromNowProposal: -36, daysFromNowFollowUp: -24, daysFromNowExpectedClose: -20, closedAtOffset: -20, value: 53000, probability: 5 }
];

const PREVIEW_AGENDA_TEMPLATES: PreviewAgendaTemplate[] = [
  { title: "Reunião online de alinhamento", type: "reuniao_online", startOffsetDays: 0, startHour: 9, durationHours: 1, status: "agendado", notes: "Revisar proposta comercial." },
  { title: "Reunião conflito carteira A", type: "reuniao_online", startOffsetDays: 0, startHour: 9, durationHours: 2, status: "agendado", notes: "Conflito de horário proposital para validação visual." },
  { title: "Visita presencial de diagnóstico", type: "reuniao_presencial", startOffsetDays: 1, startHour: 14, durationHours: 2, status: "agendado", notes: "Levantamento técnico da safra." },
  { title: "Visita presencial conflito rota", type: "reuniao_presencial", startOffsetDays: 1, startHour: 14, durationHours: 1, status: "agendado", notes: "Segundo compromisso no mesmo horário." },
  { title: "Follow-up pós proposta", type: "followup", startOffsetDays: 2, startHour: 10, durationHours: 1, status: "agendado", notes: "Confirmar próximos passos." },
  { title: "Follow-up pós visita", type: "followup", startOffsetDays: 3, startHour: 11, durationHours: 1, status: "agendado", notes: "Enviar resumo comercial." },
  { title: "Roteiro de visita regional", type: "roteiro_visita", startOffsetDays: 0, startHour: 8, durationHours: 6, status: "agendado", notes: "Roteiro com paradas prioritárias.", withStops: true },
  { title: "Roteiro interior estratégico", type: "roteiro_visita", startOffsetDays: 4, startHour: 7, durationHours: 8, status: "agendado", notes: "Roteiro completo em múltiplas cidades.", withStops: true },
  { title: "Reunião atrasada de renegociação", type: "reuniao_online", startOffsetDays: -2, startHour: 16, durationHours: 1, status: "vencido", notes: "Evento atrasado para validar indicadores." },
  { title: "Visita concluída de fechamento", type: "reuniao_presencial", startOffsetDays: -1, startHour: 11, durationHours: 1, status: "realizado", notes: "Visita concluída para histórico." },
  { title: "Reunião futura de planejamento trimestral", type: "reuniao_online", startOffsetDays: 9, startHour: 15, durationHours: 2, status: "agendado", notes: "Compromisso futuro para visão de longo prazo." }
];

function addDays(baseDate: Date, days: number) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + days);
  return date;
}

function withHour(baseDate: Date, hour: number, minute = 0) {
  const date = new Date(baseDate);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function monthString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function assertSafePreviewEnvironment() {
  const enablePreviewSeed = (process.env.ENABLE_PREVIEW_SEED || "").toLowerCase() === "true";
  const nodeEnv = process.env.NODE_ENV || "development";
  const databaseUrl = process.env.DATABASE_URL || "";
  const hasPreviewHint = databaseUrl.includes("preview") || databaseUrl.includes("_pr_") || databaseUrl.includes("pr-");

  if (!enablePreviewSeed) {
    throw new Error("ENABLE_PREVIEW_SEED=true é obrigatório para executar seed de preview.");
  }

  if (nodeEnv === "production") {
    throw new Error("Seed de preview bloqueado em NODE_ENV=production.");
  }

  if (!hasPreviewHint) {
    throw new Error("DATABASE_URL não parece ser de preview. Seed abortado por segurança.");
  }
}

async function upsertSeller(name: string, email: string, region: string) {
  const passwordHash = await bcrypt.hash(PREVIEW_SEED_PASSWORD, 10);
  return prisma.user.upsert({
    where: { email },
    update: {
      name,
      role: "vendedor",
      region,
      isActive: true,
      passwordHash
    },
    create: {
      name,
      email,
      role: "vendedor",
      region,
      isActive: true,
      passwordHash
    }
  });
}

function toPrismaErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return { name: "UnknownError", message: String(error), code: undefined, meta: undefined, stack: undefined };
  }
  const maybeError = error as { name?: string; message?: string; code?: string; meta?: unknown; stack?: string };
  return {
    name: maybeError.name,
    message: maybeError.message,
    code: maybeError.code,
    meta: maybeError.meta,
    stack: maybeError.stack
  };
}

async function createPreviewDataset() {
  let currentStep = "init";
  try {
    const now = new Date();
    const currentMonth = monthString(now);
    const previousMonth = monthString(new Date(now.getFullYear(), now.getMonth() - 1, 1));

    currentStep = "upsert user/vendedor";
    const sellers = await Promise.all(
      PREVIEW_SELLERS.map((seller) => upsertSeller(seller.name, seller.email, seller.region))
    );

    const previewProducts = [] as Array<{ id: string; unit: string | null; erpProductCode: string; erpProductClassCode: string; name: string; defaultPrice: number | null }>;
    for (const productTemplate of PREVIEW_PRODUCTS) {
      currentStep = "upsert product";
      const product = await prisma.product.upsert({
      where: {
        erpProductCode_erpProductClassCode: {
          erpProductCode: productTemplate.erpProductCode,
          erpProductClassCode: productTemplate.erpProductClassCode
        }
      },
      update: {
        name: productTemplate.name,
        className: productTemplate.className,
        unit: productTemplate.unit,
        brand: productTemplate.brand,
        groupName: productTemplate.groupName,
        defaultPrice: productTemplate.defaultPrice,
        minPrice: productTemplate.minPrice,
        stockQuantity: 120,
        isActive: true,
        isSuspended: false
      },
      data: {
        erpProductCode: productTemplate.erpProductCode,
        erpProductClassCode: productTemplate.erpProductClassCode,
        name: productTemplate.name,
        className: productTemplate.className,
        unit: productTemplate.unit,
        brand: productTemplate.brand,
        groupName: productTemplate.groupName,
        defaultPrice: productTemplate.defaultPrice,
        minPrice: productTemplate.minPrice,
        stockQuantity: 120,
        isActive: true,
        isSuspended: false,
        rawErpPayload: {
          CODPRODUTO: productTemplate.erpProductCode,
          CODPRODUTO_CLAS: productTemplate.erpProductClassCode,
          DSCPRODUTO: productTemplate.name,
          DSCPRODUTO_CLAS: productTemplate.className,
          UND_MEDIDA: productTemplate.unit,
          PRECO: productTemplate.defaultPrice
        }
      }
    });
    previewProducts.push(product);

      currentStep = "upsert productPrice";
      await prisma.productPrice.createMany({
        skipDuplicates: true,
        data: productTemplate.prices
          .filter((price) => price.price > 0)
          .map((price) => ({
          productId: product.id,
          erpPriceId: price.erpPriceId,
          branchCode: price.branchCode,
          validFrom: now,
          price: price.price
        }))
      });
    }

    const clients = [] as Array<{ id: string; city: string | null; ownerSellerId: string }>;

  for (const [index, clientTemplate] of PREVIEW_CLIENTS.entries()) {
    const ownerSeller = sellers[index % sellers.length];
    const seededName = `${PREVIEW_SEED_TAG} ${clientTemplate.name}`;

    currentStep = "upsert client";
    const existingClient = await prisma.client.findFirst({
      where: { name: seededName, ownerSellerId: ownerSeller.id },
      orderBy: { createdAt: "asc" }
    });
    const client = existingClient
      ? await prisma.client.update({
      where: { id: existingClient.id },
      data: {
        name: seededName,
        city: clientTemplate.city,
        state: clientTemplate.state,
        region: clientTemplate.region,
        segment: clientTemplate.segment,
        potentialHa: 180 + index * 22,
        farmSizeHa: 280 + index * 30,
        ownerSellerId: ownerSeller.id
      }
    })
      : await prisma.client.create({
      data: {
        name: seededName,
        city: clientTemplate.city,
        state: clientTemplate.state,
        region: clientTemplate.region,
        segment: clientTemplate.segment,
        potentialHa: 180 + index * 22,
        farmSizeHa: 280 + index * 30,
        ownerSellerId: ownerSeller.id
      }
    });

    await prisma.contact.create({
      data: {
        name: `${PREVIEW_SEED_TAG} Contato ${index + 1}`,
        phone: `1199000${String(index + 1).padStart(4, "0")}`,
        email: `contato${index + 1}.preview@preview.local`,
        role: "Comprador",
        clientId: client.id,
        ownerSellerId: ownerSeller.id
      }
    });

    clients.push(client);
  }

  let opportunityCounter = 0;
  for (const [index, template] of OPPORTUNITY_TEMPLATES.entries()) {
    const ownerSeller = sellers[index % sellers.length];
    const client = clients[index % clients.length];

    const proposalDate = addDays(now, template.daysFromNowProposal);
    const followUpDate = addDays(now, template.daysFromNowFollowUp);
    const expectedCloseDate = addDays(now, template.daysFromNowExpectedClose);
    const closedAt = typeof template.closedAtOffset === "number" ? addDays(now, template.closedAtOffset) : null;

    const opportunityTitle = `${PREVIEW_SEED_TAG} ${template.title}`;
    const existingOpportunity = await prisma.opportunity.findFirst({
      where: { title: opportunityTitle, ownerSellerId: ownerSeller.id, clientId: client.id },
      orderBy: { createdAt: "asc" }
    });
    const opportunityPayload = {
      title: opportunityTitle,
      value: template.value,
      stage: template.stage,
      crop: index % 2 === 0 ? "soja" : "milho",
      season: `${now.getFullYear()}/${now.getFullYear() + 1}`,
      areaHa: 90 + index * 14,
      productOffered: index % 2 === 0 ? "Tratamento de sementes" : "Defensivos",
      proposalDate,
      followUpDate,
      expectedCloseDate,
      closedAt,
      lastContactAt: followUpDate,
      probability: template.probability,
      notes: `${PREVIEW_SEED_TAG} oportunidade para validação de dashboard e relatórios`,
      clientId: client.id,
      ownerSellerId: ownerSeller.id
    };
    currentStep = "upsert opportunity";
    const opportunity = existingOpportunity
      ? await prisma.opportunity.update({
      where: { id: existingOpportunity.id },
      data: opportunityPayload
    })
      : await prisma.opportunity.create({
      data: opportunityPayload
    });
    if (template.stage === "ganho") {
      const itemProduct = previewProducts[index % previewProducts.length];
      const itemUnitPrice = Number(itemProduct.defaultPrice || 100);
      currentStep = "upsert opportunityItem";
      await prisma.opportunityItem.upsert({
        where: { opportunityId_lineNumber: { opportunityId: opportunity.id, lineNumber: 1 } },
        update: {
          productId: itemProduct.id,
          erpProductCode: itemProduct.erpProductCode,
          erpProductClassCode: itemProduct.erpProductClassCode,
          productNameSnapshot: itemProduct.name,
          unit: itemProduct.unit || "SC",
          quantity: 1,
          unitPrice: itemUnitPrice,
          discountType: "value",
          discountValue: 0,
          grossTotal: itemUnitPrice,
          discountTotal: 0,
          netTotal: itemUnitPrice,
          notes: `${PREVIEW_SEED_TAG} item obrigatório para oportunidade ganha`
        },
        create: {
          opportunityId: opportunity.id,
          productId: itemProduct.id,
          lineNumber: 1,
          erpProductCode: itemProduct.erpProductCode,
          erpProductClassCode: itemProduct.erpProductClassCode,
          productNameSnapshot: itemProduct.name,
          unit: itemProduct.unit || "SC",
          quantity: 1,
          unitPrice: itemUnitPrice,
          discountType: "value",
          discountValue: 0,
          grossTotal: itemUnitPrice,
          discountTotal: 0,
          netTotal: itemUnitPrice,
          notes: `${PREVIEW_SEED_TAG} item obrigatório para oportunidade ganha`
        }
      });
    }

    const activityDueDate = addDays(now, (opportunityCounter % 2 === 0 ? -3 : 4) + index);
    const isDone = activityDueDate < now;
    await prisma.activity.create({
      data: {
        type: opportunityCounter % 2 === 0 ? "visita" : "follow_up",
        notes: `${PREVIEW_SEED_TAG} atividade ${opportunityCounter + 1}`,
        dueDate: activityDueDate,
        done: isDone,
        clientId: client.id,
        opportunityId: opportunity.id,
        ownerSellerId: ownerSeller.id
      }
    });

    opportunityCounter += 1;
  }

  for (const [index, template] of PREVIEW_AGENDA_TEMPLATES.entries()) {
    const ownerSeller = sellers[index % sellers.length];
    const client = clients[index % clients.length];
    const opportunity = await prisma.opportunity.findFirst({
      where: { ownerSellerId: ownerSeller.id, title: { contains: PREVIEW_SEED_TAG } },
      orderBy: { createdAt: "asc" }
    });
    const startDate = withHour(addDays(now, template.startOffsetDays), template.startHour);
    const endDate = withHour(addDays(now, template.startOffsetDays), template.startHour + template.durationHours);

    currentStep = "create agendaEvent";
    const createdAgenda = await prisma.agendaEvent.create({
      data: {
        title: `${PREVIEW_SEED_TAG} ${template.title}`,
        type: template.type,
        status: template.status,
        startDateTime: startDate,
        endDateTime: endDate,
        notes: `${PREVIEW_SEED_TAG} ${template.notes}`,
        city: client.city,
        sellerId: ownerSeller.id,
        clientId: client.id,
        opportunityId: opportunity?.id
      }
    });

    if (template.withStops) {
      const stopClients = clients.slice(index, index + 3);
      currentStep = "create agendaStop";
      await prisma.agendaStop.createMany({
        data: stopClients.map((stopClient, stopIndex) => ({
          agendaEventId: createdAgenda.id,
          order: stopIndex + 1,
          clientId: stopClient.id,
          city: stopClient.city,
          notes: `${PREVIEW_SEED_TAG} parada ${stopIndex + 1}`,
          plannedTime: withHour(addDays(now, template.startOffsetDays), template.startHour + stopIndex + 1)
        }))
      });
    }
  }

  for (const seller of sellers) {
    currentStep = "upsert goal";
    await prisma.goal.upsert({
      where: { sellerId_month: { sellerId: seller.id, month: currentMonth } },
      update: { targetValue: 250000 },
      create: {
        sellerId: seller.id,
        month: currentMonth,
        targetValue: 250000
      }
    });

    await prisma.goal.upsert({
      where: { sellerId_month: { sellerId: seller.id, month: previousMonth } },
      update: { targetValue: 200000 },
      create: {
        sellerId: seller.id,
        month: previousMonth,
        targetValue: 200000
      }
    });
  }

    console.log("Preview seed concluído com sucesso.", {
    sellers: sellers.length,
    clients: PREVIEW_CLIENTS.length,
    opportunities: OPPORTUNITY_TEMPLATES.length,
    agendaEvents: PREVIEW_AGENDA_TEMPLATES.length,
    tag: PREVIEW_SEED_TAG
    });
  } catch (error) {
    console.error("[seedPreview] Falha durante createPreviewDataset", {
      step: currentStep,
      ...toPrismaErrorDetails(error)
    });
    throw error;
  }
}

async function main() {
  assertSafePreviewEnvironment();
  await createPreviewDataset();
}

main()
  .catch((error) => {
    console.error("Falha ao executar preview seed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
