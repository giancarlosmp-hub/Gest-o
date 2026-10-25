import { PROPOSAL_NO_RESPONSE_URL_PARAM, isProposalWithoutResponse, type ProposalContactInput } from "@salesforce-pro/shared";

// "Propostas sem retorno" da Central do Dia: a contagem e o link usam a regra de packages/shared
// (isProposalWithoutResponse), a mesma da etiqueta da "Minha lista de hoje" e do filtro da tela de Oportunidades.
// Cliente em cobrança fica de fora, como no filtro da API.
export const proposalsNoResponsePath = () => `/oportunidades?status=open&${PROPOSAL_NO_RESPONSE_URL_PARAM}=true`;

export const isNoResponseFilterInUrl = (searchParams: URLSearchParams) => searchParams.get(PROPOSAL_NO_RESPONSE_URL_PARAM) === "true";

export const countProposalsWithoutResponse = (opportunities: Array<ProposalContactInput & { clientInCollection?: boolean }>, now = new Date()) =>
  opportunities.filter((opportunity) => !opportunity.clientInCollection && isProposalWithoutResponse(opportunity, now)).length;
