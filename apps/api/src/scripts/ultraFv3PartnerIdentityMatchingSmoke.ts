import assert from "node:assert/strict";
import {
  resolvePartnerIdentityMatch,
  type PartnerIdentityCandidate,
} from "../services/partnerIdentityMatching.js";

type Candidate = PartnerIdentityCandidate & { name: string; city: string; state: string };

const candidate = (overrides: Partial<Candidate> & Pick<Candidate, "id">): Candidate => ({
  code: null,
  cnpj: null,
  cnpjNormalized: null,
  name: "COCAMAR COOPERATIVA AGROINDUSTRIAL",
  city: "MARINGA",
  state: "PR",
  ...overrides,
});

const resolve = (params: {
  code: string;
  document?: string;
  byCode?: Candidate[];
  byDocument?: Candidate[];
  byIdentity?: Candidate[];
}) => resolvePartnerIdentityMatch({
  code: params.code,
  normalizedDocument: params.document ?? "",
  byCode: params.byCode ?? [],
  byDocument: params.byDocument ?? [],
  byIdentity: params.byIdentity ?? [],
  normalizeCandidateDocument: (item) => item.cnpjNormalized ?? "",
});

const headquarters4484 = candidate({ id: "crm-4484", code: "4484", cnpjNormalized: "79114450004071" });
const branch5050 = candidate({ id: "crm-5050", code: "5050", cnpjNormalized: "79114450003342" });

// A: same normalized identity, but distinct complete branch documents => create 5050.
const caseA = resolve({ code: "5050", document: "79114450003342", byIdentity: [headquarters4484] });
assert.equal(caseA.matchStrategy, "rejected_document_conflict");
assert.deepEqual(caseA.candidates, []);

// B: a complete document is a strong match even when the incoming ERP code changed.
const caseB = resolve({ code: "5050", document: "79114450003342", byDocument: [candidate({ ...branch5050, code: "legacy-code" })] });
assert.equal(caseB.matchStrategy, "document_exact");
assert.equal(caseB.candidates[0]?.id, "crm-5050");

// C: identity fallback is allowed only when both sides have no valid document and no code conflict.
const noDocument = candidate({ id: "no-document", code: null });
const caseC = resolve({ code: "5050", byIdentity: [noDocument] });
assert.equal(caseC.matchStrategy, "identity_fallback_no_document");
assert.equal(caseC.candidates[0]?.id, "no-document");

// D: two otherwise safe no-document identities are ambiguous and cannot be merged.
const caseD = resolve({ code: "5050", byIdentity: [noDocument, candidate({ id: "no-document-2" })] });
assert.equal(caseD.matchStrategy, "ambiguous_identity_no_document");
assert.equal(caseD.ambiguous, true);
assert.deepEqual(caseD.candidates, []);

// E: fantasy-name differences do not weaken the complete-document conflict.
const caseE = resolve({ code: "5050", document: "79114450003342", byIdentity: [candidate({ ...headquarters4484, name: "COCAMAR SEDE" })] });
assert.equal(caseE.matchStrategy, "rejected_document_conflict");

// F: the existing 5050 establishment continues to update normally by exact code.
const caseF = resolve({ code: "5050", document: "79114450003342", byCode: [branch5050] });
assert.equal(caseF.matchStrategy, "code_exact");
assert.equal(caseF.candidates[0]?.id, "crm-5050");

// G: two branches sharing corporate identity remain independent establishments.
const firstBranch = resolve({ code: "4484", document: "79114450004071", byIdentity: [branch5050] });
const secondBranch = resolve({ code: "5050", document: "79114450003342", byIdentity: [headquarters4484] });
assert.equal(firstBranch.candidates.length, 0);
assert.equal(secondBranch.candidates.length, 0);

// H: later rows resolve by their own code/document, so neither can swap the other's code.
const after5050Created = [headquarters4484, branch5050];
const later4484 = resolve({
  code: "4484",
  document: "79114450004071",
  byCode: after5050Created.filter((item) => item.code === "4484"),
  byDocument: after5050Created.filter((item) => item.cnpjNormalized === "79114450004071"),
});
assert.equal(later4484.matchStrategy, "code_exact");
assert.equal(later4484.candidates.length, 1);
assert.equal(later4484.candidates[0]?.id, "crm-4484");
assert.equal(after5050Created.find((item) => item.id === "crm-5050")?.code, "5050");

console.log("UltraFV3 partner identity matching smoke passed (cases A-H)");
