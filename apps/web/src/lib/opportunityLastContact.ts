import { brazilDateTime, brazilDayKeyOf, brazilTimeKey } from "./brazilDate";

// Campo "Último contato" do formulário da oportunidade: mostra o dia de Brasília do valor gravado e só envia quando o
// usuário muda o dia, com a hora atual de Brasília. Vazio ou sem mudança não vai para a API, que de qualquer forma só
// avança a data (nunca volta por edição).
export const lastContactFormDayOf = (value?: string | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? brazilDayKeyOf(value) : "";

export const lastContactPayloadOf = (formDay: string, originalDay: string, now = new Date()) =>
  !formDay || formDay === originalDay ? undefined : brazilDateTime(formDay, brazilTimeKey(now)).toISOString();
