import { neon } from "@neondatabase/serverless";

async function runVerification() {
  const migrationUrl = process.env.VERIFY_MIGRATION_URL;
  const runtimeUrl = process.env.VERIFY_RUNTIME_URL;

  if (!migrationUrl || !runtimeUrl) {
    throw new Error("Both VERIFY_MIGRATION_URL and VERIFY_RUNTIME_URL are required");
  }

  const sqlMigration = neon(migrationUrl);
  const sqlRuntime = neon(runtimeUrl);

  console.log("=== CellWeave Phase 0 STAGING Database Verification ===\n");

  // 1. Runtime SELECT 1 & current_user
  console.log("[1/5] Runtime Connection (cellweave_app, pooled):");
  const selRuntime = await sqlRuntime("SELECT 1 as ok, current_user as usr, current_database() as db;");
  console.log("  -> SELECT 1 ok:", selRuntime[0].ok === 1);
  console.log("  -> current_user:", selRuntime[0].usr);
  console.log("  -> current_database:", selRuntime[0].db);
  if (selRuntime[0].usr !== "cellweave_app") {
    throw new Error(`Expected current_user to be cellweave_app, got ${selRuntime[0].usr}`);
  }

  // 2. Migration SELECT 1 & current_user
  console.log("\n[2/5] Migration Connection (neondb_owner, direct):");
  const selMigration = await sqlMigration("SELECT 1 as ok, current_user as usr, current_database() as db;");
  console.log("  -> SELECT 1 ok:", selMigration[0].ok === 1);
  console.log("  -> current_user:", selMigration[0].usr);
  console.log("  -> current_database:", selMigration[0].db);
  if (selMigration[0].usr !== "neondb_owner") {
    throw new Error(`Expected current_user to be neondb_owner, got ${selMigration[0].usr}`);
  }

  // 3. Migration DDL probe table
  console.log("\n[3/5] Migration DDL Probe Table Creation:");
  await sqlMigration("CREATE TABLE IF NOT EXISTS _staging_phase0_probe (id serial primary key, note text);");
  console.log("  -> Created temporary table _staging_phase0_probe");

  // 4. Runtime DML tests (default privileges verification)
  console.log("\n[4/5] Runtime DML Positive Verification:");
  const ins = await sqlRuntime("INSERT INTO _staging_phase0_probe (note) VALUES ('runtime-staging-test') RETURNING id, note;");
  console.log("  -> INSERT succeeded: id=" + ins[0].id + ", note=" + ins[0].note);

  const sel = await sqlRuntime("SELECT id, note FROM _staging_phase0_probe WHERE note = 'runtime-staging-test';");
  console.log("  -> SELECT succeeded: found " + sel.length + " row(s)");

  const upd = await sqlRuntime("UPDATE _staging_phase0_probe SET note = 'runtime-staging-updated' WHERE note = 'runtime-staging-test' RETURNING id, note;");
  console.log("  -> UPDATE succeeded: updated to " + upd[0].note);

  const del = await sqlRuntime("DELETE FROM _staging_phase0_probe WHERE note = 'runtime-staging-updated' RETURNING id;");
  console.log("  -> DELETE succeeded: removed id=" + del[0].id);

  // 5. Runtime Negative Controls (DDL denials)
  console.log("\n[5/5] Runtime Negative Controls (Privilege Isolation):");

  // A. CREATE TABLE denial
  try {
    await sqlRuntime("CREATE TABLE _unauthorized_runtime_table (id int);");
    throw new Error("SECURITY VIOLATION: cellweave_app was able to CREATE TABLE!");
  } catch (err) {
    if (err.message.includes("SECURITY VIOLATION")) throw err;
    console.log("  -> CREATE TABLE correctly DENIED:", err.message.split("\n")[0]);
  }

  // B. ALTER TABLE denial
  try {
    await sqlRuntime("ALTER TABLE _staging_phase0_probe ADD COLUMN unauthorized_col text;");
    throw new Error("SECURITY VIOLATION: cellweave_app was able to ALTER TABLE!");
  } catch (err) {
    if (err.message.includes("SECURITY VIOLATION")) throw err;
    console.log("  -> ALTER TABLE correctly DENIED:", err.message.split("\n")[0]);
  }

  // C. DROP TABLE denial
  try {
    await sqlRuntime("DROP TABLE _staging_phase0_probe;");
    throw new Error("SECURITY VIOLATION: cellweave_app was able to DROP TABLE!");
  } catch (err) {
    if (err.message.includes("SECURITY VIOLATION")) throw err;
    console.log("  -> DROP TABLE correctly DENIED:", err.message.split("\n")[0]);
  }

  // Cleanup probe table using migration connection
  console.log("\nCleaning up temporary probe table...");
  await sqlMigration("DROP TABLE IF EXISTS _staging_phase0_probe;");
  console.log("  -> Temporary probe table removed cleanly.");

  console.log("\n============================================================");
  console.log("STAGING DATABASE LEAST-PRIVILEGE VERIFICATION: PASSED");
  console.log("============================================================");
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
