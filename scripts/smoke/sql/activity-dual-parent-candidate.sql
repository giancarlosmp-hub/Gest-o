-- PROOF ONLY: not a production migration. Historical conflicts must be diagnosed/remediated first.
CREATE UNIQUE INDEX "Opportunity_id_clientId_key"
  ON public."Opportunity" (id, "clientId");

ALTER TABLE public."Activity"
  ADD CONSTRAINT "Activity_opportunityId_clientId_fkey"
  FOREIGN KEY ("opportunityId", "clientId")
  REFERENCES public."Opportunity" (id, "clientId")
  ON DELETE SET NULL
  ON UPDATE RESTRICT
  NOT VALID;
