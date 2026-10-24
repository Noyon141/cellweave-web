import "server-only";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { env } from "../config/env";
import * as schema from "./schema";
import type { DbClient } from "./client";
import {
  DatasetImportFinalizationConfigurationError,
  DatasetImportFinalizationDatabaseError,
  DatasetImportFinalizationSecurityError,
} from "../services/dataset-import-finalization-errors";

const FINALIZER_ROLE = "cellweave_import_finalizer";
let finalizerInstance: Promise<DbClient> | null = null;

async function createImportFinalizerDb(): Promise<DbClient> {
  const connectionString = env.IMPORT_FINALIZER_DATABASE_URL;
  if (!connectionString) {
    throw new DatasetImportFinalizationConfigurationError();
  }

  try {
    const url = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.username) !== FINALIZER_ROLE
    ) {
      throw new Error();
    }
  } catch {
    throw new DatasetImportFinalizationConfigurationError();
  }

  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString });
    // Once per initialized pool, not once per finalization.
    const result = await pool.query<{ current_user: string }>("SELECT current_user");
    if (result.rows.length !== 1 || result.rows[0]?.current_user !== FINALIZER_ROLE) {
      throw new DatasetImportFinalizationSecurityError();
    }
    return drizzle(pool, { schema });
  } catch (error: unknown) {
    await pool?.end().catch(() => undefined);
    if (error instanceof DatasetImportFinalizationSecurityError) {
      throw error;
    }
    throw new DatasetImportFinalizationDatabaseError();
  }
}

/** Isolated lazy singleton. Concurrent callers share initialization and role verification. */
export function getImportFinalizerDb(): Promise<DbClient> {
  if (!finalizerInstance) {
    finalizerInstance = createImportFinalizerDb().catch((error: unknown) => {
      finalizerInstance = null;
      throw error;
    });
  }
  return finalizerInstance;
}
