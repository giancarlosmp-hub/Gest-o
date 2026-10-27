export type TerritorySellerOption = { id: string; isActive: boolean; canEdit: boolean; territoryCount: number };

// Vendedor que a tela de Territórios Comerciais abre: o já escolhido; senão o primeiro ativo; sem ativo, o primeiro.
export const initialTerritorySellerId = (sellers: TerritorySellerOption[], current: string) =>
  current || (sellers.find((seller) => seller.isActive) ?? sellers[0])?.id || "";

export const TERRITORY_VIEW_ONLY_MESSAGE = "Seu perfil permite apenas visualizar este território. Alterações são restritas a Diretor/Gerente conforme escopo da equipe.";

// Aviso quando o território não pode ser editado: vendedor inativo só transfere (ou não tem cidades); fora disso, o
// perfil só visualiza. Sem aviso quando pode editar.
export const territoryReadOnlyMessage = (seller: TerritorySellerOption | undefined) => {
  if (seller?.canEdit) return null;
  if (seller && !seller.isActive) {
    return seller.territoryCount > 0
      ? "Vendedor inativo: o território só pode ser transferido para um vendedor ativo."
      : "Vendedor inativo, sem cidades no território.";
  }
  return TERRITORY_VIEW_ONLY_MESSAGE;
};
