-- Phase 4 operational metadata only. Existing Phase 3 finalization is unchanged.
CREATE TABLE analysis_runs (
 id text PRIMARY KEY, organization_id text NOT NULL, project_id text NOT NULL,
 dataset_version_id text NOT NULL, pipeline_version text NOT NULL, actor_id text NOT NULL,
 request_key text NOT NULL,request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 executor_subject text NOT NULL CHECK(executor_subject = 'cellweave-orchestrator'),
 temporal_workflow_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'START_PENDING' CHECK(status IN ('DRAFT','UPLOADING','START_PENDING','VALIDATING','QC_RUNNING','QC_REVIEW_REQUIRED','QUEUED','RUNNING','PAUSED_QUOTA','CANCEL_REQUESTED','CANCELLED','SUCCEEDED','FAILED')),
 execution_envelope jsonb NOT NULL, projection_version integer NOT NULL DEFAULT 0 CHECK(projection_version>=0),
 cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT analysis_runs_id_org_unique UNIQUE(id,organization_id),
 CONSTRAINT analysis_runs_actor_request_unique UNIQUE(organization_id,actor_id,request_key),
 FOREIGN KEY(dataset_version_id,organization_id) REFERENCES dataset_versions(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX analysis_runs_org_status_idx ON analysis_runs(organization_id,status);
--> statement-breakpoint
CREATE TABLE workflow_steps (
 id text PRIMARY KEY, organization_id text NOT NULL, analysis_run_id text NOT NULL,
 step_key text NOT NULL,step_version text NOT NULL,submission_id text NOT NULL UNIQUE,
 provider_job_id text,provider_state text NOT NULL DEFAULT 'UNKNOWN' CHECK(provider_state IN ('UNKNOWN','PENDING','RUNNING','COMPLETED','FAILED','CANCELLED','TIMEOUT')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','QUEUED','RUNNING','SUCCEEDED','RETRYING','FAILED','SKIPPED','CANCELLED')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),finalization_started boolean NOT NULL DEFAULT false,
 result jsonb,provenance jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(analysis_run_id,organization_id) REFERENCES analysis_runs(id,organization_id) ON DELETE CASCADE,
 CONSTRAINT workflow_steps_run_key_unique UNIQUE(analysis_run_id,step_key)
);
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON analysis_runs,workflow_steps TO cellweave_app_runtime;
--> statement-breakpoint
REVOKE DELETE,TRUNCATE ON analysis_runs,workflow_steps FROM cellweave_app_runtime;
