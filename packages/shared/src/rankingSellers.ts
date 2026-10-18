// Rankings: vendedor inativo só aparece se tiver valor maior que zero no período, marcado "(desligado)".
export const INACTIVE_SELLER_MARK = "(desligado)";

export const isVisibleInRanking = (isActive: boolean, value: number) => isActive || value > 0;

export const rankingSellerName = (name: string, isActive: boolean) => (isActive ? name : `${name} ${INACTIVE_SELLER_MARK}`);
