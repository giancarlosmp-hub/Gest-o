export type ActivityTypeKey = "ligacao" | "whatsapp" | "reuniao" | "envio_proposta" | "visita_tecnica" | "cliente_novo";

export const ACTIVITY_TYPE_OPTIONS: Array<{ value: ActivityTypeKey; label: string }> = [
  { value: "ligacao", label: "Ligação" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "reuniao", label: "Reunião" },
  { value: "envio_proposta", label: "Envio de proposta" },
  { value: "visita_tecnica", label: "Visita técnica" },
  { value: "cliente_novo", label: "Cliente novo (Prospecção)" }
];

const LEGACY_TYPE_MAP: Record<string, ActivityTypeKey> = {
  mensagem: "whatsapp",
  visita_presencial: "reuniao",
  visita: "reuniao"
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
