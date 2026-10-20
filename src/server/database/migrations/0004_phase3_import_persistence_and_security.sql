ALTER TABLE "dataset_files" ADD CONSTRAINT "dataset_files_id_org_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "dataset_files" ADD CONSTRAINT "dataset_files_id_org_version_unique" UNIQUE("id","organization_id","dataset_version_id");--> statement-breakpoint
ALTER TABLE "dataset_files" ADD CONSTRAINT "dataset_files_id_org_ver_r2_unique" UNIQUE("id","organization_id","dataset_version_id","r2_key");--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_id_org_ver_r2_unique" UNIQUE("id","organization_id","dataset_version_id","r2_key");--> statement-breakpoint
CREATE TABLE "dataset_file_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"dataset_file_id" text NOT NULL,
	"upload_session_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"sha256" text NOT NULL,
	"compression" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_file_provenance_file_unique" UNIQUE("dataset_file_id"),
	CONSTRAINT "dataset_file_provenance_session_unique" UNIQUE("upload_session_id"),
	CONSTRAINT "dataset_file_provenance_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dataset_file_provenance_compression_check" CHECK (compression IN ('NONE', 'GZIP'))
);--> statement-breakpoint
CREATE TABLE "dataset_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"source_format" text NOT NULL,
	"source_checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_imports_version_unique" UNIQUE("dataset_version_id"),
	CONSTRAINT "dataset_imports_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "dataset_imports_id_org_ver_unique" UNIQUE("id","organization_id","dataset_version_id"),
	CONSTRAINT "dataset_imports_source_format_check" CHECK (source_format IN ('H5AD', 'TENX_H5', 'TENX_MTX', 'GENERIC_MATRIX')),
	CONSTRAINT "dataset_imports_source_checksum_check" CHECK (source_checksum ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "dataset_import_files" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"import_id" text NOT NULL,
	"dataset_file_id" text NOT NULL,
	"role" text NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_import_files_import_file_unique" UNIQUE("import_id","dataset_file_id"),
	CONSTRAINT "dataset_import_files_import_role_ord_unique" UNIQUE("import_id","role","ordinal"),
	CONSTRAINT "dataset_import_files_role_check" CHECK (role IN ('PRIMARY', 'MATRIX', 'FEATURES', 'BARCODES', 'CELL_METADATA', 'FEATURE_METADATA')),
	CONSTRAINT "dataset_import_files_ordinal_check" CHECK (ordinal >= 0)
);--> statement-breakpoint
ALTER TABLE "dataset_file_provenance" ADD CONSTRAINT "dataset_file_provenance_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_file_provenance" ADD CONSTRAINT "dataset_file_provenance_file_org_fk" FOREIGN KEY ("dataset_file_id","organization_id","dataset_version_id","r2_key") REFERENCES "public"."dataset_files"("id","organization_id","dataset_version_id","r2_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_file_provenance" ADD CONSTRAINT "dataset_file_provenance_session_org_fk" FOREIGN KEY ("upload_session_id","organization_id","dataset_version_id","r2_key") REFERENCES "public"."upload_sessions"("id","organization_id","dataset_version_id","r2_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_imports" ADD CONSTRAINT "dataset_imports_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_imports" ADD CONSTRAINT "dataset_imports_version_org_fk" FOREIGN KEY ("dataset_version_id","organization_id") REFERENCES "public"."dataset_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_import_files" ADD CONSTRAINT "dataset_import_files_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_import_files" ADD CONSTRAINT "dataset_import_files_import_fk" FOREIGN KEY ("import_id","organization_id","dataset_version_id") REFERENCES "public"."dataset_imports"("id","organization_id","dataset_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_import_files" ADD CONSTRAINT "dataset_import_files_file_fk" FOREIGN KEY ("dataset_file_id","organization_id","dataset_version_id") REFERENCES "public"."dataset_files"("id","organization_id","dataset_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dataset_file_provenance_org_ver_idx" ON "dataset_file_provenance" USING btree ("organization_id","dataset_version_id");--> statement-breakpoint
CREATE INDEX "dataset_imports_org_ver_idx" ON "dataset_imports" USING btree ("organization_id","dataset_version_id");--> statement-breakpoint
CREATE INDEX "dataset_import_files_org_ver_idx" ON "dataset_import_files" USING btree ("organization_id","dataset_version_id");--> statement-breakpoint
CREATE INDEX "dataset_import_files_import_idx" ON "dataset_import_files" USING btree ("import_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION finalize_dataset_version_import(
  p_organization_id text,
  p_dataset_version_id text,
  p_canonical_checksum text,
  p_organism text,
  p_gene_id_scheme text,
  p_reference_build text,
  p_cell_count integer,
  p_gene_count integer,
  p_actor_type text,
  p_actor_id text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_audit_event_id text DEFAULT NULL
)
RETURNS TABLE (
  status text,
  canonical_artifact_key text,
  finalized_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project_id text;
  v_canonical_artifact_key text;
  v_version_record RECORD;
  v_import_id text;
  v_import_format text;
  v_import_source_checksum text;
  v_manifest_file_count integer;
  v_provenance_count integer;
  v_sessions_updated integer;
  v_versions_updated integer;
  v_finalized_at timestamptz;
  v_audit_id text;
BEGIN
  IF p_organization_id IS NULL OR p_dataset_version_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: organization_id and dataset_version_id are required';
  END IF;

  IF p_canonical_checksum IS NULL OR p_canonical_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_CHECKSUM: canonical_checksum must be 64-char lowercase hex';
  END IF;

  IF p_cell_count IS NULL OR p_cell_count < 1 THEN
    RAISE EXCEPTION 'INVALID_COUNTS: cell_count must be at least 1';
  END IF;

  IF p_gene_count IS NULL OR p_gene_count < 1 THEN
    RAISE EXCEPTION 'INVALID_COUNTS: gene_count must be at least 1';
  END IF;

  IF p_organism IS NULL OR length(trim(p_organism)) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: organism is required';
  END IF;

  IF p_gene_id_scheme IS NULL OR length(trim(p_gene_id_scheme)) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: gene_id_scheme is required';
  END IF;

  SELECT d.project_id
  INTO v_project_id
  FROM dataset_versions dv
  JOIN datasets d
    ON d.id = dv.dataset_id
   AND d.organization_id = dv.organization_id
  WHERE dv.id = p_dataset_version_id
    AND dv.organization_id = p_organization_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'DATASET_VERSION_NOT_FOUND: version % not found in org %',
      p_dataset_version_id, p_organization_id;
  END IF;

  v_canonical_artifact_key := 'org/' || p_organization_id || '/project/' || v_project_id || '/datasets/' || p_dataset_version_id || '/canonical/canonical.h5ad';

  SELECT *
  INTO v_version_record
  FROM dataset_versions
  WHERE id = p_dataset_version_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  SELECT di.id, di.source_format, di.source_checksum
  INTO v_import_id, v_import_format, v_import_source_checksum
  FROM dataset_imports di
  WHERE di.dataset_version_id = p_dataset_version_id
    AND di.organization_id = p_organization_id;

  IF v_import_id IS NULL THEN
    RAISE EXCEPTION 'IMPORT_MANIFEST_NOT_FOUND: no import manifest found for version %',
      p_dataset_version_id;
  END IF;

  IF v_version_record.source_format <> v_import_format THEN
    RAISE EXCEPTION 'SOURCE_FORMAT_MISMATCH: version format % does not match import manifest format %',
      v_version_record.source_format, v_import_format;
  END IF;

  IF v_version_record.canonical_checksum IS NOT NULL THEN
    IF v_version_record.canonical_format = 'H5AD'
       AND v_version_record.canonical_checksum = p_canonical_checksum
       AND v_version_record.source_checksum = v_import_source_checksum
       AND v_version_record.organism = p_organism
       AND v_version_record.gene_id_scheme = p_gene_id_scheme
       AND (v_version_record.reference_build IS NOT DISTINCT FROM p_reference_build)
       AND v_version_record.cell_count = p_cell_count
       AND v_version_record.gene_count = p_gene_count THEN
      status := 'ALREADY_FINALIZED';
      canonical_artifact_key := v_canonical_artifact_key;
      finalized_at := v_version_record.created_at;
      RETURN NEXT;
      RETURN;
    ELSE
      RAISE EXCEPTION 'FINALIZATION_CONFLICT: dataset version % is already finalized with differing properties',
        p_dataset_version_id;
    END IF;
  END IF;

  SELECT COUNT(*)
  INTO v_manifest_file_count
  FROM dataset_import_files dif
  WHERE dif.import_id = v_import_id
    AND dif.organization_id = p_organization_id
    AND dif.dataset_version_id = p_dataset_version_id;

  IF v_manifest_file_count = 0 THEN
    RAISE EXCEPTION 'IMPORT_EMPTY: import manifest % has no files', v_import_id;
  END IF;

  IF v_import_format = 'H5AD' AND v_manifest_file_count <> 1 THEN
    RAISE EXCEPTION 'CARDINALITY_ERROR: H5AD import requires exactly 1 PRIMARY file, found %', v_manifest_file_count;
  ELSIF v_import_format = 'TENX_H5' AND v_manifest_file_count <> 1 THEN
    RAISE EXCEPTION 'CARDINALITY_ERROR: TENX_H5 import requires exactly 1 PRIMARY file, found %', v_manifest_file_count;
  ELSIF v_import_format = 'TENX_MTX' AND v_manifest_file_count <> 3 THEN
    RAISE EXCEPTION 'CARDINALITY_ERROR: TENX_MTX import requires exactly 3 files (MATRIX, FEATURES, BARCODES), found %', v_manifest_file_count;
  END IF;

  SELECT COUNT(*)
  INTO v_provenance_count
  FROM dataset_import_files dif
  JOIN dataset_file_provenance dfp
    ON dfp.dataset_file_id = dif.dataset_file_id
   AND dfp.organization_id = dif.organization_id
   AND dfp.dataset_version_id = dif.dataset_version_id
  WHERE dif.import_id = v_import_id
    AND dif.organization_id = p_organization_id
    AND dif.dataset_version_id = p_dataset_version_id;

  IF v_provenance_count <> v_manifest_file_count THEN
    RAISE EXCEPTION 'INCOMPLETE_PROVENANCE: % files in manifest but % have verified provenance',
      v_manifest_file_count, v_provenance_count;
  END IF;

  UPDATE upload_sessions us
  SET status = 'IMPORTED',
      updated_at = clock_timestamp()
  FROM dataset_import_files dif
  JOIN dataset_file_provenance dfp
    ON dfp.dataset_file_id = dif.dataset_file_id
   AND dfp.organization_id = dif.organization_id
   AND dfp.dataset_version_id = dif.dataset_version_id
  WHERE us.id = dfp.upload_session_id
    AND us.organization_id = p_organization_id
    AND us.dataset_version_id = p_dataset_version_id
    AND dif.import_id = v_import_id
    AND dif.organization_id = p_organization_id
    AND dif.dataset_version_id = p_dataset_version_id
    AND us.status = 'VERIFIED';

  GET DIAGNOSTICS v_sessions_updated = ROW_COUNT;

  IF v_sessions_updated <> v_manifest_file_count THEN
    RAISE EXCEPTION 'UPLOAD_SESSION_STATE_CONFLICT: expected % verified upload sessions to mark IMPORTED, but updated %',
      v_manifest_file_count, v_sessions_updated;
  END IF;

  v_finalized_at := clock_timestamp();

  UPDATE dataset_versions
  SET canonical_format = 'H5AD',
      canonical_checksum = p_canonical_checksum,
      source_checksum = v_import_source_checksum,
      organism = p_organism,
      gene_id_scheme = p_gene_id_scheme,
      reference_build = p_reference_build,
      cell_count = p_cell_count,
      gene_count = p_gene_count
  WHERE id = p_dataset_version_id
    AND organization_id = p_organization_id
    AND canonical_checksum IS NULL;

  GET DIAGNOSTICS v_versions_updated = ROW_COUNT;

  IF v_versions_updated <> 1 THEN
    RAISE EXCEPTION 'CONCURRENT_FINALIZATION_CONFLICT: dataset version % was finalized concurrently',
      p_dataset_version_id;
  END IF;

  v_audit_id := COALESCE(p_audit_event_id, 'aud_' || gen_random_uuid());

  INSERT INTO audit_events (
    id,
    organization_id,
    actor_type,
    actor_id,
    action,
    resource_type,
    resource_id,
    metadata,
    ip_hash,
    user_agent,
    created_at
  ) VALUES (
    v_audit_id,
    p_organization_id,
    p_actor_type,
    p_actor_id,
    'dataset.imported',
    'dataset_version',
    p_dataset_version_id,
    jsonb_build_object(
      'datasetVersionId', p_dataset_version_id,
      'sourceFormat', v_version_record.source_format,
      'canonicalFormat', 'H5AD',
      'canonicalArtifactKey', v_canonical_artifact_key,
      'canonicalChecksum', p_canonical_checksum,
      'sourceChecksum', v_import_source_checksum,
      'organism', p_organism,
      'geneIdScheme', p_gene_id_scheme,
      'referenceBuild', p_reference_build,
      'cellCount', p_cell_count,
      'geneCount', p_gene_count
    ),
    p_ip_hash,
    p_user_agent,
    v_finalized_at
  );

  status := 'FINALIZED';
  canonical_artifact_key := v_canonical_artifact_key;
  finalized_at := v_finalized_at;
  RETURN NEXT;
END;
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cellweave_import_finalizer') THEN
    CREATE ROLE cellweave_import_finalizer;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cellweave_app_runtime') THEN
    CREATE ROLE cellweave_app_runtime;
  END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'neondb_owner') THEN
    ALTER TABLE "dataset_file_provenance" OWNER TO neondb_owner;
    ALTER TABLE "dataset_imports" OWNER TO neondb_owner;
    ALTER TABLE "dataset_import_files" OWNER TO neondb_owner;
    ALTER FUNCTION finalize_dataset_version_import OWNER TO neondb_owner;
  END IF;
END
$$;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "dataset_file_provenance", "dataset_imports", "dataset_import_files" TO cellweave_import_finalizer;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION finalize_dataset_version_import TO cellweave_import_finalizer;--> statement-breakpoint
GRANT SELECT ON TABLE "dataset_file_provenance", "dataset_imports", "dataset_import_files" TO cellweave_app_runtime;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "dataset_file_provenance", "dataset_imports", "dataset_import_files" FROM cellweave_app_runtime;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION finalize_dataset_version_import FROM cellweave_app_runtime;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION finalize_dataset_version_import FROM PUBLIC;
