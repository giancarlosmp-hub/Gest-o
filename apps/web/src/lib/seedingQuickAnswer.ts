import { FORAGE_CATEGORY, calculateSeeding, fieldLossWarningMessage, parseDecimal } from "./technicalAssistant";

// "Resposta rápida" do Assistente Técnico: cultura + espaçamento → sementes por metro, sem lote.
// A germinação padrão do Catálogo Técnico é o menor padrão mínimo do MAPA (regra do technicalCatalog.json,
// importado em produção em 19/11/2026). A lista reduzida sem conexão (CULTURE_FALLBACKS) não segue essa regra:
// com ela, a germinação é pedida e o kg/ha não aparece.

export const QUICK_SPACING_OPTIONS_CM = [45, 50, 70, 90] as const;

export type QuickOrigin = "typed" | "mapa_minimum" | "culture_default" | "offline_list";

export const QUICK_ORIGIN_LABEL: Record<QuickOrigin, string> = {
  typed: "digitado por você",
  mapa_minimum: "mínimo legal do MAPA (Catálogo Técnico)",
  culture_default: "padrão da cultura (Catálogo Técnico)",
  offline_list: "lista reduzida, sem conexão",
};

export const QUICK_MAPA_GERMINATION_WARNING =
  "Estimativa segura com a germinação mínima legal; com o lote faturado, geralmente será um pouco menos.";

export const QUICK_PROMPTS = {
  population: "Informe a população desejada (plantas/ha).",
  germination: "Informe a germinação do lote.",
  germinationRange: "A germinação deve ficar entre 0 e 100%.",
  spacing: "Escolha o espaçamento.",
} as const;

export const QUICK_KG_HA_NO_PMS =
  "kg/ha não aparece: esta cultura não tem PMS padrão, e o PMS varia por lote e peneira. Para o kg/ha, use a Calculadora de Semeadura com o PMS do lote.";
export const QUICK_KG_HA_NO_PURITY =
  "kg/ha não aparece: esta cultura não tem pureza padrão. Para o kg/ha, use a Calculadora de Semeadura com a pureza do lote.";
export const QUICK_KG_HA_OFFLINE =
  "kg/ha não aparece sem conexão: a lista reduzida não tem PMS conferido. Recarregue a página para tentar de novo.";

export type QuickAnswerCulture = {
  label: string;
  category: string;
  populationTargetDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  pmsDefault: number | null;
};

/** Campos digitados; vazio = usa o padrão da cultura (população, germinação) ou 0 (perda). */
export type QuickAnswerForm = {
  populacaoHa: string;
  germinacao: string;
  perdaCampo: string;
  espacamentoCm: string;
};

export type QuickAnswer = {
  ready: boolean;
  /** Pedidos dos campos que faltam, na ordem da tela. */
  prompts: string[];
  populationHa: number | null;
  germination: number | null;
  rowSpacingCm: number | null;
  fieldLossApplied: number;
  fieldLossWarning: string | null;
  populationOrigin: QuickOrigin | null;
  germinationOrigin: QuickOrigin | null;
  germinationWarning: string | null;
  seedsPerMeter: number | null;
  /** Sementes a cada 10 m, arredondado: o vendedor confere contando 10 m de linha. */
  seedsPer10m: number | null;
  kgHa: number | null;
  pms: number | null;
  purity: number | null;
  /** Origem do PMS e da pureza usados no kg/ha (padrões da cultura). */
  pmsOrigin: QuickOrigin | null;
  purityOrigin: QuickOrigin | null;
  kgHaUnavailableReason: string | null;
};

export function isQuickAnswerCulture(culture: { category: string }) {
  return culture.category.trim() !== FORAGE_CATEGORY;
}

const positive = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

export function quickSeedingAnswer(
  culture: QuickAnswerCulture,
  form: QuickAnswerForm,
  options: { offline: boolean }
): QuickAnswer {
  const { offline } = options;
  const prompts: string[] = [];

  const typedPopulation = positive(parseDecimal(form.populacaoHa));
  const defaultPopulation = positive(culture.populationTargetDefault);
  const populationHa = typedPopulation ?? defaultPopulation;
  const populationOrigin: QuickOrigin | null = typedPopulation
    ? "typed"
    : defaultPopulation
      ? offline
        ? "offline_list"
        : "culture_default"
      : null;
  if (populationHa == null) prompts.push(QUICK_PROMPTS.population);

  // Germinação: digitada; sem ela, o mínimo legal do MAPA do Catálogo Técnico. Sem conexão ou sem padrão, pede.
  const typedGerminationRaw = parseDecimal(form.germinacao);
  const typedGermination = positive(typedGerminationRaw);
  const defaultGermination = offline ? null : positive(culture.germinationDefault);
  let germination: number | null = null;
  let germinationOrigin: QuickOrigin | null = null;
  if (typedGermination != null) {
    if (typedGermination > 100) prompts.push(QUICK_PROMPTS.germinationRange);
    else {
      germination = typedGermination;
      germinationOrigin = "typed";
    }
  } else if (defaultGermination != null && defaultGermination <= 100) {
    germination = defaultGermination;
    germinationOrigin = "mapa_minimum";
  } else {
    prompts.push(QUICK_PROMPTS.germination);
  }

  const rowSpacingCm = positive(parseDecimal(form.espacamentoCm));
  if (rowSpacingCm == null) prompts.push(QUICK_PROMPTS.spacing);

  const fieldLossPercent = parseDecimal(form.perdaCampo) ?? 0;
  const pms = offline ? null : positive(culture.pmsDefault);
  const purity = offline ? null : positive(culture.purityDefault);

  const result = calculateSeeding({
    populationHa: populationHa ?? 0,
    rowSpacingCm: rowSpacingCm ?? 0,
    pms: pms ?? 0,
    germination: germination ?? 0,
    purity: purity ?? 0,
    fieldLossPercent,
  });

  const ready = prompts.length === 0 && result.seedsPerMeter != null;
  const seedsPerMeter = ready ? result.seedsPerMeter : null;
  const kgHa = ready && result.ready ? result.kgHa : null;
  const kgHaUnavailableReason = !ready
    ? null
    : offline
      ? QUICK_KG_HA_OFFLINE
      : pms == null
        ? QUICK_KG_HA_NO_PMS
        : purity == null
          ? QUICK_KG_HA_NO_PURITY
          : null;

  return {
    ready,
    prompts,
    populationHa,
    germination,
    rowSpacingCm,
    fieldLossApplied: result.fieldLossApplied,
    fieldLossWarning: fieldLossWarningMessage(result.fieldLossWarning),
    populationOrigin,
    germinationOrigin,
    germinationWarning: germinationOrigin === "mapa_minimum" ? QUICK_MAPA_GERMINATION_WARNING : null,
    seedsPerMeter,
    seedsPer10m: seedsPerMeter != null ? Math.round(seedsPerMeter * 10) : null,
    kgHa,
    pms: kgHa != null ? pms : null,
    purity: kgHa != null ? purity : null,
    pmsOrigin: kgHa != null ? "culture_default" : null,
    purityOrigin: kgHa != null ? "mapa_minimum" : null,
    kgHaUnavailableReason,
  };
}

const formatNumber = (value: number, digits: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Texto do Copiar e do WhatsApp. Vazio enquanto falta campo. */
export function quickAnswerText(cultureLabel: string, answer: QuickAnswer) {
  if (!answer.ready || answer.seedsPerMeter == null || answer.seedsPer10m == null) return "";
  const germinationNote = answer.germinationOrigin === "mapa_minimum" ? " (mínimo legal do MAPA)" : "";
  const lines = [
    `${cultureLabel}: ${formatNumber(answer.seedsPerMeter, 1)} sementes por metro (≈ ${answer.seedsPer10m} a cada 10 m)`,
    `Espaçamento ${formatNumber(answer.rowSpacingCm ?? 0, 1)} cm, população ${formatNumber(answer.populationHa ?? 0, 0)} plantas/ha, germinação ${formatNumber(answer.germination ?? 0, 1)}%${germinationNote}, perda a campo ${formatNumber(answer.fieldLossApplied, 1)}%.`,
  ];
  if (answer.kgHa != null && answer.pms != null && answer.purity != null) {
    lines.push(
      `Cerca de ${formatNumber(answer.kgHa, 2)} kg/ha com PMS ${formatNumber(answer.pms, 2)} g e pureza ${formatNumber(answer.purity, 1)}% (padrões da cultura).`
    );
  }
  if (answer.germinationWarning) lines.push(answer.germinationWarning);
  lines.push("Estimativa de apoio; não substitui a recomendação de um engenheiro agrônomo.");
  return lines.join("\n");
}

/** Link do WhatsApp sem número: o próprio WhatsApp pede para escolher o contato. */
export function whatsappShareUrl(text: string) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
