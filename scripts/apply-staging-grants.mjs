import { neon } from "@neondatabase/serverless";

async function applyGrants() {
  const migrationUrl = process.env.STAGING_MIGRATION_URL;
  if (!migrationUrl) {
    throw new Error("STAGING_MIGRATION_URL is required");
  }

  const sql = neon(migrationUrl);

  console.log("1. Granting CONNECT ON DATABASE neondb TO cellweave_app...");
  await sql("GRANT CONNECT ON DATABASE neondb TO cellweave_app;");

  console.log("2. Granting USAGE ON SCHEMA public TO cellweave_app...");
  await sql("GRANT USAGE ON SCHEMA public TO cellweave_app;");

  console.log("3. Explicitly revoking CREATE ON SCHEMA public FROM cellweave_app...");
  await sql("REVOKE CREATE ON SCHEMA public FROM cellweave_app;");

  console.log("4. Granting DML on existing tables in public schema...");
  await sql("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cellweave_app;");

  console.log("5. Granting USAGE on existing sequences in public schema...");
  await sql("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO cellweave_app;");

  console.log("6. Configuring ALTER DEFAULT PRIVILEGES for neondb_owner on tables...");
  await sql("ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cellweave_app;");

  console.log("7. Configuring ALTER DEFAULT PRIVILEGES for neondb_owner on sequences...");
  await sql("ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cellweave_app;");

  console.log("All least-privilege permissions applied successfully!");
}

applyGrants().catch((err) => {
  console.error("Grant error:", err);
  process.exit(1);
});
