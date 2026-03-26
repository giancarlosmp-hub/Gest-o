import { OpportunityStage } from "@prisma/client";

type OpportunityHistoryItem = {
  description: string;
  createdAt: Date;
};

export type SalesMessageOpportunityInput = {
  clientName: string | null;
  crop: string | null;
  productOffered: string | null;
  stage: OpportunityStage;
  timelineEvents?: OpportunityHistoryItem[];
};

const stageLabel: Record<OpportunityStage, string> = {
  prospeccao: "prospecção",
  negociacao: "negociação",
  proposta: "proposta",
  ganho: "fechamento ganho",
  perdido: "perda"
};

const normalizeHistoryText = (value: string) => value.replace(/\s+/g, " ").trim();

const buildHistorySnippet = (events: OpportunityHistoryItem[] = []) => {
  const cleaned = events
    .map((event) => normalizeHistoryText(event.description))
    .filter(Boolean)
    .slice(0, 2);

  if (!cleaned.length) return "Sem histórico recente registrado";
  return cleaned.join(" | ");
};

const buildSubject = (opportunity: SalesMessageOpportunityInput) => {
  const product = opportunity.productOffered?.trim();
  const crop = opportunity.crop?.trim();

  if (product && crop) return `${product} para ${crop}`;
  if (product) return product;
  if (crop) return `o plano para ${crop}`;
  return "a proposta";
};

export const generateSalesMessage = (opportunity: SalesMessageOpportunityInput) => {
  const clientName = opportunity.clientName?.trim() || "cliente";
  const stage = stageLabel[opportunity.stage] || "andamento comercial";
  const subject = buildSubject(opportunity);
  const history = buildHistorySnippet(opportunity.timelineEvents || []);

  return `Olá ${clientName}, passando para alinhar sobre ${subject}. Hoje estamos na etapa de ${stage}. Último histórico: ${history}. Podemos avançar?`;
};
