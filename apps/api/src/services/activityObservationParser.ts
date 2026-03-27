export type ObservationIntent =
  | "pediu_proposta"
  | "negociacao_preco"
  | "aguardando_decisao"
  | "sem_interesse"
  | "quer_retorno"
  | "indefinido";

export type ObservationSentiment = "positivo" | "neutro" | "negativo";
export type ObservationInterestLevel = "alto" | "medio" | "baixo";

export type ParsedActivityObservation = {
  sentiment: ObservationSentiment;
  interestLevel: ObservationInterestLevel;
  detectedIntent: ObservationIntent;
  suggestedNextAction: string;
  suggestedFollowUpDays: number | null;
  keywords: string[];
};

const normalizeObservation = (observation: string) =>
  observation
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const hasAnyTerm = (text: string, terms: string[]) => terms.some((term) => text.includes(term));

export const parseActivityObservation = (observation?: string | null): ParsedActivityObservation => {
  const rawObservation = observation?.trim() || "";
  if (!rawObservation) {
    return {
      sentiment: "neutro",
      interestLevel: "medio",
      detectedIntent: "indefinido",
      suggestedNextAction: "Manter acompanhamento padrão da oportunidade.",
      suggestedFollowUpDays: null,
      keywords: []
    };
  }

  const text = normalizeObservation(rawObservation);
  const keywords = new Set<string>();

  if (hasAnyTerm(text, ["proposta", "orcamento", "cotacao"])) keywords.add("proposta");
  if (hasAnyTerm(text, ["preco", "desconto", "valor", "condicao"])) keywords.add("preço");
  if (hasAnyTerm(text, ["decisao", "avaliando", "aprovar", "comite"])) keywords.add("decisão");
  if (hasAnyTerm(text, ["sem interesse", "nao interessa", "nao vai seguir"])) keywords.add("desinteresse");
  if (hasAnyTerm(text, ["retorno", "retornar", "voltar contato"])) keywords.add("retorno");
  if (hasAnyTerm(text, ["urgente", "prioridade"])) keywords.add("urgência");

  if (hasAnyTerm(text, ["sem interesse", "nao interessa", "nao vai seguir", "encerrar"])) {
    return {
      sentiment: "negativo",
      interestLevel: "baixo",
      detectedIntent: "sem_interesse",
      suggestedNextAction: "Confirmar motivo da perda e registrar encerramento da oportunidade.",
      suggestedFollowUpDays: null,
      keywords: [...keywords]
    };
  }

  if (hasAnyTerm(text, ["proposta", "orcamento", "cotacao", "enviar proposta"])) {
    return {
      sentiment: "positivo",
      interestLevel: "alto",
      detectedIntent: "pediu_proposta",
      suggestedNextAction: "Enviar proposta comercial com escopo, preço e prazo.",
      suggestedFollowUpDays: 1,
      keywords: [...keywords]
    };
  }

  if (hasAnyTerm(text, ["preco", "desconto", "valor alto", "revisar valor", "condicao"])) {
    return {
      sentiment: "neutro",
      interestLevel: "medio",
      detectedIntent: "negociacao_preco",
      suggestedNextAction: "Preparar contraproposta com ajuste de condições e margem.",
      suggestedFollowUpDays: 2,
      keywords: [...keywords]
    };
  }

  if (hasAnyTerm(text, ["decisao", "aguardando", "aprovar", "comite", "diretoria"])) {
    return {
      sentiment: "neutro",
      interestLevel: "medio",
      detectedIntent: "aguardando_decisao",
      suggestedNextAction: "Agendar retorno curto para acompanhar status da decisão.",
      suggestedFollowUpDays: 2,
      keywords: [...keywords]
    };
  }

  if (hasAnyTerm(text, ["retorno", "retornar", "falar depois", "proxima semana", "proximo mes"])) {
    const suggestedFollowUpDays = hasAnyTerm(text, ["proximo mes", "mês que vem"]) ? 30 : 3;
    return {
      sentiment: "neutro",
      interestLevel: "medio",
      detectedIntent: "quer_retorno",
      suggestedNextAction: "Programar follow-up na janela solicitada pelo cliente.",
      suggestedFollowUpDays,
      keywords: [...keywords]
    };
  }

  return {
    sentiment: "neutro",
    interestLevel: "medio",
    detectedIntent: "indefinido",
    suggestedNextAction: "Manter acompanhamento padrão da oportunidade.",
    suggestedFollowUpDays: null,
    keywords: [...keywords]
  };
};
