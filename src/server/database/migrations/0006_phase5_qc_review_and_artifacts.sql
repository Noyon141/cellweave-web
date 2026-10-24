-- Phase 5 expands operational persistence; no Phase 3 scientific columns/functions change.
ALTER TABLE analysis_runs ADD COLUMN kind text NOT NULL DEFAULT 'IMPORT' CHECK(kind IN ('IMPORT','QC'));
ALTER TABLE workflow_steps ADD COLUMN qc_context jsonb;
ALTER TABLE workflow_steps ADD COLUMN qc_result jsonb;
ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_id_org_run_unique UNIQUE(id,organization_id,analysis_run_id);
--> statement-breakpoint
CREATE TABLE artifacts (
 id text PRIMARY KEY, organization_id text NOT NULL, project_id text NOT NULL,
 dataset_version_id text NOT NULL, analysis_run_id text,workflow_step_id text,
 artifact_type text NOT NULL CHECK(artifact_type IN ('CANONICAL_DATASET','QC_REPORT','FILTERED_DATASET')),
 storage_provider text NOT NULL DEFAULT 'R2' CHECK(storage_provider='R2'),bucket text NOT NULL,object_key text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),size_bytes bigint NOT NULL CHECK(size_bytes>=0 AND size_bytes<=9007199254740991),
 mime_type text NOT NULL,pipeline_version text,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id),UNIQUE(id,organization_id,project_id),UNIQUE(id,organization_id,project_id,analysis_run_id),UNIQUE(organization_id,object_key),
 CHECK(artifact_type='CANONICAL_DATASET' OR (analysis_run_id IS NOT NULL AND workflow_step_id IS NOT NULL AND pipeline_version IS NOT NULL)),
 FOREIGN KEY(dataset_version_id,organization_id) REFERENCES dataset_versions(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(analysis_run_id,organization_id) REFERENCES analysis_runs(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(workflow_step_id,organization_id,analysis_run_id) REFERENCES workflow_steps(id,organization_id,analysis_run_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX artifacts_canonical_version_unique ON artifacts(dataset_version_id,organization_id) WHERE artifact_type='CANONICAL_DATASET';
CREATE INDEX artifacts_run_idx ON artifacts(organization_id,analysis_run_id);
--> statement-breakpoint
CREATE TABLE artifact_lineage (
 organization_id text NOT NULL,project_id text NOT NULL,analysis_run_id text NOT NULL,
 parent_artifact_id text NOT NULL,child_artifact_id text NOT NULL,relationship text NOT NULL,
 PRIMARY KEY(parent_artifact_id,child_artifact_id,relationship),CHECK(parent_artifact_id<>child_artifact_id),
 FOREIGN KEY(parent_artifact_id,organization_id,project_id) REFERENCES artifacts(id,organization_id,project_id) ON DELETE RESTRICT,
 FOREIGN KEY(child_artifact_id,organization_id,project_id,analysis_run_id) REFERENCES artifacts(id,organization_id,project_id,analysis_run_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE qc_decisions (
 id text PRIMARY KEY,organization_id text NOT NULL,project_id text NOT NULL,analysis_run_id text NOT NULL,dataset_version_id text NOT NULL,
 qc_revision integer NOT NULL CHECK(qc_revision>0),preview_step_id text NOT NULL,selection_artifact_id text NOT NULL,
 request_key text NOT NULL,request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL,decision jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(analysis_run_id,qc_revision),UNIQUE(id,organization_id,analysis_run_id),UNIQUE(organization_id,actor_id,request_key),
 FOREIGN KEY(analysis_run_id,organization_id) REFERENCES analysis_runs(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(dataset_version_id,organization_id) REFERENCES dataset_versions(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(preview_step_id,organization_id,analysis_run_id) REFERENCES workflow_steps(id,organization_id,analysis_run_id) ON DELETE RESTRICT,
 FOREIGN KEY(selection_artifact_id,organization_id,project_id,analysis_run_id) REFERENCES artifacts(id,organization_id,project_id,analysis_run_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE qc_revisions (
 analysis_run_id text PRIMARY KEY,organization_id text NOT NULL,project_id text NOT NULL,qc_revision integer NOT NULL DEFAULT 1 CHECK(qc_revision>0),
 canonical_artifact_id text NOT NULL,qc_step_id text NOT NULL,preview_step_id text,preview_revision integer NOT NULL DEFAULT 0,
 decision_id text,cancel_actor_id text,approval_pending boolean NOT NULL DEFAULT false,filter_committed boolean NOT NULL DEFAULT false,
 analysis_parameters jsonb NOT NULL,
 FOREIGN KEY(analysis_run_id,organization_id) REFERENCES analysis_runs(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(canonical_artifact_id,organization_id,project_id) REFERENCES artifacts(id,organization_id,project_id) ON DELETE RESTRICT,
 FOREIGN KEY(qc_step_id,organization_id,analysis_run_id) REFERENCES workflow_steps(id,organization_id,analysis_run_id) ON DELETE RESTRICT,
 FOREIGN KEY(preview_step_id,organization_id,analysis_run_id) REFERENCES workflow_steps(id,organization_id,analysis_run_id) ON DELETE RESTRICT,
 FOREIGN KEY(decision_id,organization_id,analysis_run_id) REFERENCES qc_decisions(id,organization_id,analysis_run_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION phase5_reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable scientific record' USING ERRCODE='42501'; END $$;
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION phase5_reject_immutable_mutation();
CREATE TRIGGER artifact_lineage_immutable BEFORE UPDATE OR DELETE ON artifact_lineage FOR EACH ROW EXECUTE FUNCTION phase5_reject_immutable_mutation();
CREATE TRIGGER qc_decisions_immutable BEFORE UPDATE OR DELETE ON qc_decisions FOR EACH ROW EXECUTE FUNCTION phase5_reject_immutable_mutation();
REVOKE ALL ON artifacts,artifact_lineage,qc_decisions FROM PUBLIC,cellweave_app_runtime;
GRANT SELECT,INSERT ON artifacts,artifact_lineage,qc_decisions TO cellweave_app_runtime;
GRANT SELECT,INSERT,UPDATE ON qc_revisions TO cellweave_app_runtime;
REVOKE DELETE,TRUNCATE ON qc_revisions FROM cellweave_app_runtime;
--> statement-breakpoint
CREATE FUNCTION phase5_guard_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.analysis_run_id,NEW.organization_id,NEW.project_id,NEW.qc_revision,NEW.canonical_artifact_id,NEW.qc_step_id,NEW.analysis_parameters)
 IS DISTINCT FROM ROW(OLD.analysis_run_id,OLD.organization_id,OLD.project_id,OLD.qc_revision,OLD.canonical_artifact_id,OLD.qc_step_id,OLD.analysis_parameters)
 OR (OLD.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id)
 OR (OLD.filter_committed AND NOT NEW.filter_committed)
 OR (OLD.cancel_actor_id IS NOT NULL AND NEW.cancel_actor_id IS DISTINCT FROM OLD.cancel_actor_id)
 THEN RAISE EXCEPTION 'Immutable QC authority' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qc_revision_authority BEFORE UPDATE ON qc_revisions FOR EACH ROW EXECUTE FUNCTION phase5_guard_revision();
--> statement-breakpoint
CREATE FUNCTION phase5_guard_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.qc_context IS NOT NULL AND (
 (NEW.qc_context - 'deadlineAt') IS DISTINCT FROM (OLD.qc_context - 'deadlineAt')
 OR (OLD.qc_context->>'deadlineAt' IS NOT NULL AND NEW.qc_context->>'deadlineAt' IS DISTINCT FROM OLD.qc_context->>'deadlineAt')
 OR (OLD.qc_result IS NOT NULL AND NEW.qc_result IS DISTINCT FROM OLD.qc_result)
 ) THEN RAISE EXCEPTION 'Immutable QC step authority' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qc_step_authority BEFORE UPDATE ON workflow_steps FOR EACH ROW EXECUTE FUNCTION phase5_guard_step();
