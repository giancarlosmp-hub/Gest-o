export const productCatalogTenantWhere = (tenantId?: string) => tenantId ? { tenantId } : {};

/**
 * Production currently runs with tenancy disabled, where the ERP catalogue is
 * global and existing Product rows legitimately have tenantId = NULL.  Only
 * the explicit default-only mode turns the authenticated membership into a
 * catalogue write/read boundary.
 */
export const catalogTenantIdForMode = (
  authenticatedTenantId: string | undefined,
  tenancyMode: "disabled" | "default-only",
) => tenancyMode === "default-only" ? authenticatedTenantId : undefined;

export const isProductOwnedByTenant = (productTenantId: string | null, tenantId?: string) =>
  tenantId ? productTenantId === tenantId : true;

type ProductCatalogCandidate = {
  tenantId: string | null;
  erpProductCode: string;
  erpProductClassCode: string;
};

const normalizeCatalogCode = (value: string) => value.trim().replace(/^0+(?=\d)/, "") || "default";

export const selectProductCandidateForTenant = <T extends ProductCatalogCandidate>(
  candidates: T[],
  tenantId: string | undefined,
  productCode: string,
  classCode: string,
) => {
  const owned = candidates.filter((candidate) => isProductOwnedByTenant(candidate.tenantId, tenantId));
  const exact = owned.filter((candidate) =>
    normalizeCatalogCode(candidate.erpProductCode) === normalizeCatalogCode(productCode)
    && normalizeCatalogCode(candidate.erpProductClassCode) === normalizeCatalogCode(classCode)
  );
  return exact.length === 1 ? exact[0] : null;
};
