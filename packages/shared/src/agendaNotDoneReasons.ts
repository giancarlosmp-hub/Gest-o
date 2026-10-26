// Motivos de "Não realizado" (Agenda e Rota): catálogo fixo para medir por que o planejado não aconteceu.
// Sem migration: a Agenda guarda o código em AgendaEvent.notDoneReason (TEXT) e a Rota em AgendaStop.resultReason
// (TEXT), com a descrição de "outro" em AgendaStop.resultSummary. Nada gravado é reescrito: registros antigos são
// traduzidos só na leitura.

export const AGENDA_NOT_DONE_REASONS = [
  { code: "cliente_ausente", label: "Cliente ausente / não atendeu" },
  { code: "cliente_remarcou", label: "Cliente cancelou ou pediu para remarcar" },
  { code: "clima_estrada", label: "Clima ou condição da estrada" },
  { code: "veiculo", label: "Problema com veículo" },
  { code: "demanda_urgente", label: "Demanda comercial urgente em outro cliente" },
  { code: "falta_tempo", label: "Atraso na rota / faltou tempo" },
  { code: "outro", label: "Outro (descrição obrigatória)" }
] as const;

export type AgendaNotDoneReasonCode = (typeof AGENDA_NOT_DONE_REASONS)[number]["code"];

export const AGENDA_NOT_DONE_REASON_CODES = AGENDA_NOT_DONE_REASONS.map((reason) => reason.code) as [
  AgendaNotDoneReasonCode,
  ...AgendaNotDoneReasonCode[]
];

export const NOT_DONE_REASON_REQUIRED_MESSAGE = "Escolha o motivo de não ter sido realizado.";
export const NOT_DONE_DESCRIPTION_REQUIRED_MESSAGE = "Descreva o motivo em \"Outro\".";
export const NOT_DONE_DESCRIPTION_MAX_LENGTH = 240;

export type ParsedNotDoneReason = {
  code: AgendaNotDoneReasonCode;
  description: string | null;
  // Registro anterior ao catálogo (texto livre da Agenda ou código antigo da Rota).
  legacy: boolean;
};

export const isAgendaNotDoneReasonCode = (value: unknown): value is AgendaNotDoneReasonCode =>
  typeof value === "string" && (AGENDA_NOT_DONE_REASON_CODES as string[]).includes(value);

const cleanDescription = (description?: string | null) => description?.trim() || null;

// Primeiro problema do motivo escolhido, ou null. "Outro" exige descrição (mínimo de 2 caracteres).
export const notDoneReasonError = (code: unknown, description?: string | null) => {
  if (!isAgendaNotDoneReasonCode(code)) return NOT_DONE_REASON_REQUIRED_MESSAGE;
  if (code === "outro" && (cleanDescription(description)?.length ?? 0) < 2) return NOT_DONE_DESCRIPTION_REQUIRED_MESSAGE;
  return null;
};

const OTHER_PREFIX = "outro:";

// Agenda: o código vai sozinho em notDoneReason; "outro" leva a descrição ("outro: descrição").
export const formatAgendaNotDoneReason = (code: AgendaNotDoneReasonCode, description?: string | null) =>
  code === "outro" ? `${OTHER_PREFIX} ${cleanDescription(description) ?? ""}`.trim() : code;

// Agenda: código do catálogo, "outro: descrição" ou texto livre antigo (vira "Outro" com o texto original).
export const parseAgendaNotDoneReason = (value: string | null | undefined): ParsedNotDoneReason | null => {
  const raw = value?.trim();
  if (!raw) return null;
  if (isAgendaNotDoneReasonCode(raw)) return { code: raw, description: null, legacy: false };
  if (raw.startsWith(OTHER_PREFIX)) return { code: "outro", description: cleanDescription(raw.slice(OTHER_PREFIX.length)), legacy: false };
  return { code: "outro", description: raw, legacy: true };
};

// Rota: códigos antigos da parada (antes do catálogo), traduzidos só na leitura.
const LEGACY_STOP_REASONS: Record<string, { code: AgendaNotDoneReasonCode; description: string | null }> = {
  chuva: { code: "clima_estrada", description: null },
  estrada: { code: "clima_estrada", description: null },
  reagendar: { code: "outro", description: "Precisa reagendar" }
};

// Rota: resultReason com o código; a descrição de "outro" vem do resumo da parada (resultSummary).
export const parseStopNotDoneReason = (reason: string | null | undefined, summary?: string | null): ParsedNotDoneReason | null => {
  const raw = reason?.trim();
  if (!raw) return null;
  if (isAgendaNotDoneReasonCode(raw)) return { code: raw, description: raw === "outro" ? cleanDescription(summary) : null, legacy: false };
  const legacy = LEGACY_STOP_REASONS[raw];
  if (legacy) return { ...legacy, legacy: true };
  return { code: "outro", description: raw, legacy: true };
};

// Texto para a tela: rótulo do catálogo; "Outro" mostra a descrição entre parênteses.
export const describeNotDoneReason = (parsed: ParsedNotDoneReason | null) => {
  if (!parsed) return null;
  if (parsed.code === "outro") return parsed.description ? `Outro (${parsed.description})` : "Outro";
  return AGENDA_NOT_DONE_REASONS.find((reason) => reason.code === parsed.code)!.label;
};

export type NotDoneReasonCounts = Record<AgendaNotDoneReasonCode, number>;

export const emptyNotDoneReasonCounts = (): NotDoneReasonCounts =>
  Object.fromEntries(AGENDA_NOT_DONE_REASON_CODES.map((code) => [code, 0])) as NotDoneReasonCounts;
