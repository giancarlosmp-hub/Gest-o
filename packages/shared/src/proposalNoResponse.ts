// "Proposta sem retorno": oportunidade na etapa proposta cujo último contato (lastContactAt; sem ele, o
// followUpDate) foi há mais de 7 dias, contados em dias de Brasília (UTC-3 fixo, como portfolioStatus.ts).
// Bordas: contato há 7 dias ainda não conta; há 8 conta. Uma regra só para a contagem do alerta da Central do
// Dia, a etiqueta da "Minha lista de hoje" e o filtro ?noResponse=true de GET /opportunities. Cliente em
// cobrança fica de fora nos três; quem aplica é quem tem o dado da cobrança.
export const PROPOSAL_NO_RESPONSE_DAYS = 7;
export const PROPOSAL_NO_RESPONSE_STAGE = "proposta";
export const PROPOSAL_NO_RESPONSE_URL_PARAM = "noResponse";

const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

type DateInput = Date | string | null | undefined;

export type ProposalContactInput = { stage?: string | null; lastContactAt?: DateInput; followUpDate?: DateInput };

const toValidDate = (value: DateInput) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Dia de Brasília como número de dias desde 01/01/1970.
const brazilDayIndex = (instant: Date) => Math.floor((instant.getTime() - BRAZIL_UTC_OFFSET_MS) / DAY_MS);

export const proposalLastContactOf = (opportunity: ProposalContactInput) =>
  toValidDate(opportunity.lastContactAt) ?? toValidDate(opportunity.followUpDate);

// Dias de Brasília desde o último contato; negativo quando a data é futura e null sem data válida.
export const proposalDaysWithoutContact = (opportunity: ProposalContactInput, now: Date) => {
  const lastContact = proposalLastContactOf(opportunity);
  return lastContact ? brazilDayIndex(now) - brazilDayIndex(lastContact) : null;
};

// Contato antes deste instante (início do dia de Brasília de 7 dias atrás) deixa a proposta sem retorno.
// O filtro do banco usa o corte; a contagem e a etiqueta, isProposalWithoutResponse: as duas formas são a mesma regra.
export const proposalNoResponseCutoff = (now: Date) => new Date((brazilDayIndex(now) - PROPOSAL_NO_RESPONSE_DAYS) * DAY_MS + BRAZIL_UTC_OFFSET_MS);

export const isProposalWithoutResponse = (opportunity: ProposalContactInput, now: Date) => {
  if (String(opportunity.stage || "").toLowerCase() !== PROPOSAL_NO_RESPONSE_STAGE) return false;
  const days = proposalDaysWithoutContact(opportunity, now);
  return days !== null && days > PROPOSAL_NO_RESPONSE_DAYS;
};
