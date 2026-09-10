export const OPPORTUNITY_CREATE_PARAM = "open";
export const OPPORTUNITY_CREATE_VALUE = "create";

export const OPPORTUNITY_CREATE_TARGET = `/oportunidades?${OPPORTUNITY_CREATE_PARAM}=${OPPORTUNITY_CREATE_VALUE}`;

export function consumeOpportunityCreateRequest(searchParams: URLSearchParams) {
  if (searchParams.get(OPPORTUNITY_CREATE_PARAM) !== OPPORTUNITY_CREATE_VALUE) {
    return { shouldOpen: false, nextSearchParams: searchParams };
  }

  const nextSearchParams = new URLSearchParams(searchParams);
  nextSearchParams.delete(OPPORTUNITY_CREATE_PARAM);

  return { shouldOpen: true, nextSearchParams };
}
