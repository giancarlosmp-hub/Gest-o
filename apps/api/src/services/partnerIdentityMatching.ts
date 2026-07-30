export type PartnerIdentityCandidate = {
  id: string;
  code: string | null;
  cnpj: string | null;
  cnpjNormalized: string | null;
};

export type PartnerMatchStrategy =
  | "code_exact"
  | "document_exact"
  | "identity_fallback_no_document"
  | "rejected_document_conflict"
  | "create_no_safe_match"
  | "ambiguous_identity_no_document";

export type PartnerIdentityResolution<T extends PartnerIdentityCandidate> = {
  candidates: T[];
  matchStrategy: PartnerMatchStrategy;
  rejectedCandidateIds: string[];
  ambiguous: boolean;
};

const uniqueById = <T extends PartnerIdentityCandidate>(candidates: T[]) =>
  [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];

/**
 * Resolves only establishment-safe matches. `normalizedDocument` must contain a
 * validated, complete CPF/CNPJ (11 or 14 digits), never a CNPJ root.
 */
export function resolvePartnerIdentityMatch<T extends PartnerIdentityCandidate>(params: {
  code: string;
  normalizedDocument: string;
  byCode: T[];
  byDocument: T[];
  byIdentity: T[];
  normalizeCandidateDocument: (candidate: T) => string;
}): PartnerIdentityResolution<T> {
  const { code, normalizedDocument, byCode, byDocument, byIdentity, normalizeCandidateDocument } = params;

  if (byCode.length) {
    const documentConflicts = normalizedDocument
      ? byCode.filter((candidate) => {
          const candidateDocument = normalizeCandidateDocument(candidate);
          return Boolean(candidateDocument && candidateDocument !== normalizedDocument);
        })
      : [];
    if (documentConflicts.length) {
      return {
        candidates: [],
        matchStrategy: "rejected_document_conflict",
        rejectedCandidateIds: documentConflicts.map(({ id }) => id),
        ambiguous: true,
      };
    }
    return { candidates: uniqueById(byCode), matchStrategy: "code_exact", rejectedCandidateIds: [], ambiguous: false };
  }

  if (byDocument.length) {
    return { candidates: uniqueById(byDocument), matchStrategy: "document_exact", rejectedCandidateIds: [], ambiguous: false };
  }

  if (normalizedDocument) {
    const conflicts = byIdentity.filter((candidate) => {
      const candidateDocument = normalizeCandidateDocument(candidate);
      return Boolean(candidateDocument && candidateDocument !== normalizedDocument);
    });
    return {
      candidates: [],
      matchStrategy: conflicts.length ? "rejected_document_conflict" : "create_no_safe_match",
      rejectedCandidateIds: conflicts.map(({ id }) => id),
      ambiguous: false,
    };
  }

  const safeIdentity = byIdentity.filter((candidate) =>
    !normalizeCandidateDocument(candidate) && (!candidate.code || candidate.code === code));
  if (safeIdentity.length === 1) {
    return {
      candidates: safeIdentity,
      matchStrategy: "identity_fallback_no_document",
      rejectedCandidateIds: [],
      ambiguous: false,
    };
  }
  if (safeIdentity.length > 1) {
    return {
      candidates: [],
      matchStrategy: "ambiguous_identity_no_document",
      rejectedCandidateIds: safeIdentity.map(({ id }) => id),
      ambiguous: true,
    };
  }
  return {
    candidates: [],
    matchStrategy: "create_no_safe_match",
    rejectedCandidateIds: byIdentity.map(({ id }) => id),
    ambiguous: false,
  };
}
