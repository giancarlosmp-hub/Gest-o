export type ActivityObservationSentiment = "positivo" | "neutro" | "negativo";

export type ActivityObservationInterestLevel = "alto" | "medio" | "baixo";

export type ActivityObservationIntent =
  | "pediu_proposta"
  | "quer_retorno"
  | "sem_interesse"
  | "negociacao_preco"
  | "aguardando_decisao"
  | "visita_realizada"
  | "indefinido";

export type ActivityObservationInsights = {
  sentiment: ActivityObservationSentiment;
  interestLevel: ActivityObservationInterestLevel;
  detectedIntent: ActivityObservationIntent;
  suggestedNextAction: string;
  suggestedFollowUpDays: number | null;
  keywords: string[];
};

type IntentRule = {
  intent: Exclude<ActivityObservationIntent, "indefinido">;
  patterns: string[];
  suggestedNextAction: string;
  suggestedFollowUpDays: number | null;
  priority: number;
};

const INTENT_RULES: IntentRule[] = [
  {
    intent: "sem_interesse",
    patterns: [
      "sem interesse",
      "nao tem interesse",
      "nao vai plantar",
      "nao fechou",
      "descartou compra",
      "nao quer seguir"
    ],
    suggestedNextAction: "confirmar motivo da perda e registrar objeção principal",
    suggestedFollowUpDays: null,
    priority: 100
  },
  {
    intent: "pediu_proposta",
    patterns: ["pediu proposta", "quer proposta", "mandar proposta", "enviar proposta", "solicitou proposta"],
    suggestedNextAction: "enviar proposta e confirmar recebimento com o cliente",
    suggestedFollowUpDays: 1,
    priority: 95
  },
  {
    intent: "negociacao_preco",
    patterns: [
      "achou caro",
      "preco alto",
      "preco muito alto",
      "vai avaliar preco",
      "pediu desconto",
      "negociar preco"
    ],
    suggestedNextAction: "revisar condições comerciais e preparar argumentação de valor",
    suggestedFollowUpDays: 2,
    priority: 90
  },
  {
    intent: "quer_retorno",
    patterns: [
      "retornar semana que vem",
      "ligar depois",
      "retorno em alguns dias",
      "retornar depois",
      "falar na proxima semana"
    ],
    suggestedNextAction: "agendar retorno na data combinada",
    suggestedFollowUpDays: 7,
    priority: 80
  },
  {
    intent: "aguardando_decisao",
    patterns: [
      "vai decidir",
      "aguardando resposta",
      "vai falar com socio",
      "depende da aprovacao",
      "aguardando decisao"
    ],
    suggestedNextAction: "definir data de decisão com responsável e acompanhar",
    suggestedFollowUpDays: 3,
    priority: 70
  },
  {
    intent: "visita_realizada",
    patterns: ["visita realizada", "conversei com o cliente", "visita concluida", "realizada visita"],
    suggestedNextAction: "registrar desdobramentos da visita e próximo passo",
    suggestedFollowUpDays: 5,
    priority: 60
  }
];

const POSITIVE_PATTERNS = [
  "interessado",
  "bem receptivo",
  "gostou",
  "quer fechar",
  "fechar negocio",
  "avancou"
];

const NEGATIVE_PATTERNS = [
  "sem interesse",
  "nao interessado",
  "achou caro",
  "dificil fechar",
  "nao vai plantar",
  "insatisfeito"
];

const HIGH_INTEREST_HINTS = ["quer fechar", "interessado", "pediu proposta", "quer proposta"];
const LOW_INTEREST_HINTS = ["sem interesse", "nao vai plantar", "nao quer seguir", "nao fechou"];

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const collectMatches = (text: string, patterns: string[]) => patterns.filter((pattern) => text.includes(pattern));

const detectIntent = (normalizedObservation: string): Omit<ActivityObservationInsights, "sentiment" | "interestLevel"> => {
  let winner: {
    rule: IntentRule;
    matches: string[];
    score: number;
  } | null = null;

  for (const rule of INTENT_RULES) {
    const matches = collectMatches(normalizedObservation, rule.patterns);
    if (!matches.length) continue;

    const score = matches.length * 100 + rule.priority;
    if (!winner || score > winner.score) {
      winner = { rule, matches, score };
    }
  }

  if (!winner) {
    return {
      detectedIntent: "indefinido",
      suggestedNextAction: "registrar próximo passo manualmente",
      suggestedFollowUpDays: null,
      keywords: []
    };
  }

  return {
    detectedIntent: winner.rule.intent,
    suggestedNextAction: winner.rule.suggestedNextAction,
    suggestedFollowUpDays: winner.rule.suggestedFollowUpDays,
    keywords: [...winner.matches]
  };
};

const detectSentiment = (normalizedObservation: string): ActivityObservationSentiment => {
  const positiveHits = collectMatches(normalizedObservation, POSITIVE_PATTERNS).length;
  const negativeHits = collectMatches(normalizedObservation, NEGATIVE_PATTERNS).length;

  if (negativeHits > positiveHits) return "negativo";
  if (positiveHits > negativeHits) return "positivo";
  return "neutro";
};

const detectInterestLevel = (
  normalizedObservation: string,
  detectedIntent: ActivityObservationIntent
): ActivityObservationInterestLevel => {
  if (detectedIntent === "sem_interesse") return "baixo";
  if (detectedIntent === "pediu_proposta") return "alto";
  if (detectedIntent === "negociacao_preco" || detectedIntent === "quer_retorno" || detectedIntent === "aguardando_decisao") {
    return "medio";
  }
  if (collectMatches(normalizedObservation, HIGH_INTEREST_HINTS).length) return "alto";
  if (collectMatches(normalizedObservation, LOW_INTEREST_HINTS).length) return "baixo";

  return "medio";
};

export const parseActivityObservation = (observation: string): ActivityObservationInsights => {
  const normalizedObservation = normalizeText(observation || "");
  const intentAnalysis = detectIntent(normalizedObservation);
  const sentiment = detectSentiment(normalizedObservation);
  const interestLevel = detectInterestLevel(normalizedObservation, intentAnalysis.detectedIntent);

  return {
    sentiment,
    interestLevel,
    detectedIntent: intentAnalysis.detectedIntent,
    suggestedNextAction: intentAnalysis.suggestedNextAction,
    suggestedFollowUpDays: intentAnalysis.suggestedFollowUpDays,
    keywords: intentAnalysis.keywords
  };
};
