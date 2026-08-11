/** Persistence boundary for the disposable evidence/plan ledger proof.
 * Implementations must be injected; this module deliberately has no Prisma/runtime dependency.
 */
export type LedgerWriteResult = "REGISTERED" | "IDEMPOTENT_REPLAY";

export interface EvidenceRecord {
  evidenceId: string; evidenceHash: string; contractVersion: string; inventoryVersion: string;
  generatedAt: Date; expiresAt: Date; result: "READY" | "BLOCKED";
}
export interface PlanRecord {
  planId: string; planHash: string; evidenceId: string; evidenceHash: string;
  planVersion: string; targetTenantId: string; dryRunOnly: true; applyAuthorized: false;
  status: "PLANNED";
}
export type LedgerEventType = "EVIDENCE_REGISTERED" | "PLAN_REGISTERED" | "IDEMPOTENT_REPLAY" | "CONFLICT_REJECTED";
export interface LedgerEvent { eventType: LedgerEventType; evidenceId?: string; planId?: string; }

export interface PreflightPlanLedger {
  registerEvidence(record: Readonly<EvidenceRecord>): Promise<LedgerWriteResult>;
  registerPlan(record: Readonly<PlanRecord>): Promise<LedgerWriteResult>;
  appendEvent(event: Readonly<LedgerEvent>): Promise<void>;
  lookupEvidence(evidenceId: string): Promise<Readonly<EvidenceRecord> | null>;
  lookupPlan(planId: string): Promise<Readonly<PlanRecord> | null>;
}
