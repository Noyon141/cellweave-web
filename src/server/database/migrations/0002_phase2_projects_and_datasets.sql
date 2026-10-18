CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"organism" text,
	"tissue" text,
	"disease_context" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"sample_key" text NOT NULL,
	"display_name" text,
	"condition" text,
	"batch" text,
	"biological_replicate" text,
	"technical_replicate" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "samples_exp_key_unique" UNIQUE("experiment_id","sample_key")
);
--> statement-breakpoint
CREATE TABLE "dataset_files" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_files_version_key_unique" UNIQUE("dataset_version_id","r2_key")
);
--> statement-breakpoint
CREATE TABLE "dataset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"source_format" text NOT NULL,
	"canonical_format" text,
	"organism" text,
	"gene_id_scheme" text,
	"reference_build" text,
	"cell_count" integer,
	"gene_count" integer,
	"source_checksum" text,
	"canonical_checksum" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_versions_ds_num_unique" UNIQUE("dataset_id","version_number"),
	CONSTRAINT "dataset_versions_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasets_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"r2_upload_id" text NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"expected_size" bigint NOT NULL,
	"part_size" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failure_code" text,
	"failure_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_status_check" CHECK (status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'VERIFYING', 'VERIFIED', 'IMPORTED', 'FAILED', 'ABORTED', 'EXPIRED', 'QUARANTINED'))
);
--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_experiment_org_fk" FOREIGN KEY ("experiment_id","organization_id") REFERENCES "public"."experiments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_files" ADD CONSTRAINT "dataset_files_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_files" ADD CONSTRAINT "dataset_files_version_org_fk" FOREIGN KEY ("dataset_version_id","organization_id") REFERENCES "public"."dataset_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_org_fk" FOREIGN KEY ("dataset_id","organization_id") REFERENCES "public"."datasets"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_version_org_fk" FOREIGN KEY ("dataset_version_id","organization_id") REFERENCES "public"."dataset_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiments_org_project_idx" ON "experiments" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "samples_org_experiment_idx" ON "samples" USING btree ("organization_id","experiment_id");--> statement-breakpoint
CREATE INDEX "dataset_files_org_version_idx" ON "dataset_files" USING btree ("organization_id","dataset_version_id");--> statement-breakpoint
CREATE INDEX "dataset_versions_org_dataset_idx" ON "dataset_versions" USING btree ("organization_id","dataset_id");--> statement-breakpoint
CREATE INDEX "datasets_org_project_idx" ON "datasets" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "datasets_org_status_idx" ON "datasets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "upload_sessions_org_project_idx" ON "upload_sessions" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_org_version_idx" ON "upload_sessions" USING btree ("organization_id","dataset_version_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_status_expires_idx" ON "upload_sessions" USING btree ("status","expires_at");