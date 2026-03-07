export type ActivityTypeKey = "visita" | "reuniao" | "ligacao" | "followup" | "proposta_enviada" | "proposta_negociacao" | "fechamento";

export const ACTIVITY_TYPE_OPTIONS: Array<{ value: ActivityTypeKey; label: string }> = [
  { value: "visita", label: "Visita" },
  { value: "reuniao", label: "Reunião" },
  { value: "ligacao", label: "Ligação" },
  { value: "followup", label: "Follow-up" },
  { value: "proposta_enviada", label: "Proposta enviada" },
  { value: "proposta_negociacao", label: "Proposta em negociação" },
  { value: "fechamento", label: "Fechamento" }
];

const LEGACY_TYPE_MAP: Record<string, ActivityTypeKey> = {
  follow_up: "followup",
  envio_proposta: "proposta_enviada",
  visita_tecnica: "visita",
  whatsapp: "ligacao",
  cliente_novo: "visita"
};

const LABEL_BY_TYPE = ACTIVITY_TYPE_OPTIONS.reduce<Record<ActivityTypeKey, string>>((accumulator, option) => {
  accumulator[option.value] = option.label;
  return accumulator;
}, {} as Record<ActivityTypeKey, string>);

const TYPE_BY_LABEL = ACTIVITY_TYPE_OPTIONS.reduce<Record<string, ActivityTypeKey>>((accumulator, option) => {
  accumulator[option.label.toLowerCase()] = option.value;
  return accumulator;
}, {});

export function normalizeActivityType(type: string): ActivityTypeKey | string {
  return LEGACY_TYPE_MAP[type] ?? type;
}

export function toLabel(type: string): string {
  const normalized = normalizeActivityType(type);
  if (normalized in LABEL_BY_TYPE) {
    return LABEL_BY_TYPE[normalized as ActivityTypeKey];
  }

  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function fromLabel(label: string): ActivityTypeKey | string {
  const normalizedLabel = label.trim().toLowerCase();
  return TYPE_BY_LABEL[normalizedLabel] ?? label;
}
