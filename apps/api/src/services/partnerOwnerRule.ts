/**
 * Regra do dono do cliente na sincronização de parceiros do UltraFV3 (sem imports: a sincronização e o
 * script de simulação somente leitura usam este mesmo módulo).
 *
 * Quem manda no dono é o campo Vendedor do cadastro do parceiro no ERP (VENDEDOR_DO_PARCEIRO e chaves
 * equivalentes), ligado ao usuário ativo do CRM com o mesmo erpCode, inclusive na passada por vendedor.
 * O login que trouxe o parceiro no /partners não decide o dono de cliente existente: dois logins podem
 * ver o mesmo cliente (carteira/rota do UltraFV3), e antes cada passada gravava o próprio vendedor,
 * alternando o dono a cada rodada.
 *
 * - Campo do ERP com usuário correspondente: o dono passa a ser esse usuário (mesmo sem login FV3).
 * - Campo vazio, ou sem usuário correspondente: cliente existente mantém o dono atual; cliente novo fica
 *   com o vendedor do login que trouxe o parceiro.
 *
 * Usuário correspondente segue o caminho global da sincronização: um único vendedor ativo com aquele
 * erpCode, com exatamente um vínculo de tenant ativo, e esse tenant é o do cliente.
 */

/** Mesma normalização do código do parceiro e do erpCode na sincronização (zeros à esquerda saem). */
export const normalizeErpSellerCode = (value: unknown) => {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^0+(?=\d)/, "") || trimmed;
};

export type ErpSellerUser = { id: string; erpCode: string | null; tenantIds: string[] };
/** erpCode normalizado → vendedores ativos com esse código. */
export type ErpSellerDirectory = Map<string, ErpSellerUser[]>;

export const buildErpSellerDirectory = (users: ErpSellerUser[]): ErpSellerDirectory => {
  const directory: ErpSellerDirectory = new Map();
  for (const user of users) {
    const code = normalizeErpSellerCode(user.erpCode);
    if (code) directory.set(code, [...(directory.get(code) ?? []), user]);
  }
  return directory;
};

/** Usuário do CRM indicado pelo campo Vendedor do ERP, ou null se não houver um correspondente seguro. */
export const resolveErpSellerUser = (directory: ErpSellerDirectory, erpSellerCode: string, tenantId: string | null) => {
  const code = normalizeErpSellerCode(erpSellerCode);
  if (!code || !tenantId) return null;
  const matches = directory.get(code) ?? [];
  if (matches.length !== 1) return null;
  const [user] = matches;
  return user.tenantIds.length === 1 && user.tenantIds[0] === tenantId ? user : null;
};

export type PartnerOwnerSource =
  /** O campo Vendedor do ERP aponta um usuário ativo do CRM: ele é o dono. */
  | "erp_seller"
  /** Campo Vendedor vazio no ERP: cliente existente mantém o dono. */
  | "kept_erp_seller_missing"
  /** Campo Vendedor sem usuário ativo correspondente no CRM: cliente existente mantém o dono. */
  | "kept_erp_seller_unmatched"
  /** Cliente novo sem vendedor do ERP utilizável: fica com o vendedor do login. */
  | "new_client_login_seller";

export type PartnerOwnerDecision = { ownerSellerId: string; source: PartnerOwnerSource };

export function resolvePartnerOwner(params: {
  /** Valor bruto do campo Vendedor do parceiro no ERP ("" quando ausente). */
  erpSellerCode: string;
  directory: ErpSellerDirectory;
  /** Tenant em que o cliente é gravado. */
  tenantId: string | null;
  /** Vendedor cujo login trouxe o parceiro no /partners. */
  loginSellerId: string;
  /** Dono atual do cliente no CRM; null para cliente novo. */
  currentOwnerId: string | null;
}): PartnerOwnerDecision {
  const erpSeller = resolveErpSellerUser(params.directory, params.erpSellerCode, params.tenantId);
  if (erpSeller) return { ownerSellerId: erpSeller.id, source: "erp_seller" };
  if (params.currentOwnerId === null) return { ownerSellerId: params.loginSellerId, source: "new_client_login_seller" };
  return {
    ownerSellerId: params.currentOwnerId,
    source: normalizeErpSellerCode(params.erpSellerCode) ? "kept_erp_seller_unmatched" : "kept_erp_seller_missing",
  };
}

/**
 * Rede de segurança: no máximo uma troca de dono por cliente por rodada. Guarda os ids dos clientes cujo
 * dono já foi trocado na rodada (todas as passadas por vendedor de uma mesma execução compartilham o Set).
 */
export type PartnerOwnerChangeRound = Set<string>;
export const createPartnerOwnerChangeRound = (): PartnerOwnerChangeRound => new Set();
