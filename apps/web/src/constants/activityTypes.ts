export type ActivityTypeKey =
  | "ligacao"
  | "whatsapp"
  | "reuniao"
  | "envio_proposta"
  | "visita_tecnica"
  | "cliente_novo"
  | "visita"
  | "followup"
  | "proposta_enviada"
  | "proposta_negociacao"
  | "fechamento"
  | "reuniao_online"
  | "reuniao_presencial";

export const ACTIVITY_TYPE_OPTIONS: Array<{ value: ActivityTypeKey; label: string }> = [
  { value: "ligacao", label: "Ligação" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "reuniao_online", label: "Reunião online" },
  { value: "reuniao_presencial", label: "Reunião presencial" },
  { value: "reuniao", label: "Reunião" },
  { value: "visita", label: "Visita" },
  { value: "followup", label: "Follow-up" },
  { value: "proposta_enviada", label: "Proposta" },
  { value: "proposta_negociacao", label: "Proposta em negociação" },
  { value: "fechamento", label: "Fechamento" },
  { value: "envio_proposta", label: "Envio de proposta (legado)" },
  { value: "visita_tecnica", label: "Visita técnica (legado)" },
  { value: "cliente_novo", label: "Cliente novo (Prospecção)" }
];

// Catálogo único da Nova atividade, igual ao da Agenda. Proposta é gravada como proposta_enviada (a atividade
// não tem o tipo "proposta"). Os demais tipos são legados: só aparecem em registros antigos e nos filtros.
const ACTIVITY_CATALOG_TYPES: ActivityTypeKey[] = ["ligacao", "whatsapp", "visita", "reuniao_online", "reuniao_presencial", "proposta_enviada", "fechamento"];

export const ACTIVITY_CATALOG_OPTIONS = ACTIVITY_CATALOG_TYPES.map((value) => ({
  value,
  label: ACTIVITY_TYPE_OPTIONS.find((option) => option.value === value)!.label
}));

export const isActivityCatalogType = (type: string): type is ActivityTypeKey => ACTIVITY_CATALOG_TYPES.includes(type as ActivityTypeKey);

const LEGACY_TYPE_MAP: Record<string, ActivityTypeKey> = {
  mensagem: "whatsapp",
  visita_presencial: "reuniao",
  follow_up: "followup",
  envio_proposta: "proposta_enviada",
  visita: "visita"
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
