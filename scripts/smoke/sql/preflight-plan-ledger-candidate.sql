BEGIN;
CREATE ROLE preflight_plan_ledger_writer NOLOGIN;

CREATE TABLE public.tenant_preflight_evidence_registry (
 evidence_id text PRIMARY KEY, evidence_hash text NOT NULL,
 contract_version text NOT NULL, inventory_version text NOT NULL,
 generated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 result text NOT NULL CHECK (result IN ('READY','BLOCKED')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE (evidence_id,evidence_hash), CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
 CHECK (expires_at > generated_at)
);
CREATE TABLE public.tenant_backfill_plan_ledger (
 plan_id text PRIMARY KEY, plan_hash text NOT NULL UNIQUE,
 evidence_id text NOT NULL, evidence_hash text NOT NULL,
 plan_version text NOT NULL, target_tenant_id text NOT NULL,
 dry_run_only boolean NOT NULL CHECK (dry_run_only),
 apply_authorized boolean NOT NULL CHECK (NOT apply_authorized),
 status text NOT NULL DEFAULT 'PLANNED' CHECK (status = 'PLANNED'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 FOREIGN KEY (evidence_id,evidence_hash)
   REFERENCES public.tenant_preflight_evidence_registry(evidence_id,evidence_hash)
);
CREATE TABLE public.tenant_backfill_plan_event (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_type text NOT NULL CHECK (event_type IN ('EVIDENCE_REGISTERED','PLAN_REGISTERED','IDEMPOTENT_REPLAY','CONFLICT_REJECTED')),
 evidence_id text, plan_id text, created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CHECK (evidence_id IS NOT NULL OR plan_id IS NOT NULL)
);

CREATE FUNCTION public.reject_preflight_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='append-only ledger'; END $$;
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON public.tenant_preflight_evidence_registry FOR EACH STATEMENT EXECUTE FUNCTION public.reject_preflight_ledger_mutation();
CREATE TRIGGER plan_append_only BEFORE UPDATE OR DELETE ON public.tenant_backfill_plan_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.reject_preflight_ledger_mutation();
CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON public.tenant_backfill_plan_event FOR EACH STATEMENT EXECUTE FUNCTION public.reject_preflight_ledger_mutation();

CREATE FUNCTION public.register_preflight_evidence(p_id text,p_hash text,p_contract text,p_inventory text,p_generated timestamptz,p_expires timestamptz,p_result text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.tenant_preflight_evidence_registry;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('preflight-evidence:' || p_id,0));
 SELECT * INTO existing FROM public.tenant_preflight_evidence_registry WHERE evidence_id=p_id;
 IF FOUND THEN
   IF existing.evidence_hash IS DISTINCT FROM p_hash OR existing.contract_version IS DISTINCT FROM p_contract OR existing.inventory_version IS DISTINCT FROM p_inventory OR existing.generated_at IS DISTINCT FROM p_generated OR existing.expires_at IS DISTINCT FROM p_expires OR existing.result IS DISTINCT FROM p_result THEN
     RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='conflicting evidence replay';
   END IF;
   INSERT INTO public.tenant_backfill_plan_event(event_type,evidence_id) VALUES('IDEMPOTENT_REPLAY',p_id);
   RETURN 'IDEMPOTENT_REPLAY';
 END IF;
 INSERT INTO public.tenant_preflight_evidence_registry(evidence_id,evidence_hash,contract_version,inventory_version,generated_at,expires_at,result)
 VALUES(p_id,p_hash,p_contract,p_inventory,p_generated,p_expires,p_result);
 INSERT INTO public.tenant_backfill_plan_event(event_type,evidence_id) VALUES('EVIDENCE_REGISTERED',p_id);
 RETURN 'REGISTERED';
END $$;

CREATE FUNCTION public.register_preflight_plan(p_id text,p_hash text,p_evidence_id text,p_evidence_hash text,p_version text,p_tenant text,p_dry boolean,p_apply boolean,p_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.tenant_preflight_evidence_registry; existing public.tenant_backfill_plan_ledger;
BEGIN
 SELECT * INTO e FROM public.tenant_preflight_evidence_registry WHERE evidence_id=p_evidence_id AND evidence_hash=p_evidence_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='evidence binding missing'; END IF;
 IF e.result IS DISTINCT FROM 'READY' OR e.expires_at<=statement_timestamp() THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='evidence is not eligible'; END IF;
 IF p_dry IS DISTINCT FROM true OR p_apply IS DISTINCT FROM false OR p_status IS DISTINCT FROM 'PLANNED' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='unsafe plan'; END IF;
 -- Lock order is fixed: validate/lock evidence, then lock the identity-scoped plan key.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('preflight-plan:' || p_id,0));
 SELECT * INTO existing FROM public.tenant_backfill_plan_ledger WHERE plan_id=p_id;
 IF FOUND THEN
  IF existing.plan_hash IS DISTINCT FROM p_hash OR existing.evidence_id IS DISTINCT FROM p_evidence_id OR existing.evidence_hash IS DISTINCT FROM p_evidence_hash OR existing.plan_version IS DISTINCT FROM p_version OR existing.target_tenant_id IS DISTINCT FROM p_tenant OR existing.dry_run_only IS DISTINCT FROM p_dry OR existing.apply_authorized IS DISTINCT FROM p_apply OR existing.status IS DISTINCT FROM p_status THEN
   RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='conflicting plan replay'; END IF;
  INSERT INTO public.tenant_backfill_plan_event(event_type,evidence_id,plan_id) VALUES('IDEMPOTENT_REPLAY',p_evidence_id,p_id);
  RETURN 'IDEMPOTENT_REPLAY';
 END IF;
 INSERT INTO public.tenant_backfill_plan_ledger(plan_id,plan_hash,evidence_id,evidence_hash,plan_version,target_tenant_id,dry_run_only,apply_authorized,status)
 VALUES(p_id,p_hash,p_evidence_id,p_evidence_hash,p_version,p_tenant,p_dry,p_apply,p_status);
 INSERT INTO public.tenant_backfill_plan_event(event_type,evidence_id,plan_id) VALUES('PLAN_REGISTERED',p_evidence_id,p_id);
 RETURN 'REGISTERED';
END $$;

REVOKE ALL ON public.tenant_preflight_evidence_registry,public.tenant_backfill_plan_ledger,public.tenant_backfill_plan_event FROM PUBLIC,preflight_plan_ledger_writer;
GRANT SELECT ON public.tenant_preflight_evidence_registry,public.tenant_backfill_plan_ledger,public.tenant_backfill_plan_event TO preflight_plan_ledger_writer;
REVOKE ALL ON FUNCTION public.register_preflight_evidence(text,text,text,text,timestamptz,timestamptz,text), public.register_preflight_plan(text,text,text,text,text,text,boolean,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_preflight_evidence(text,text,text,text,timestamptz,timestamptz,text), public.register_preflight_plan(text,text,text,text,text,text,boolean,boolean,text) TO preflight_plan_ledger_writer;
COMMIT;
