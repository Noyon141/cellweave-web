import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { env } from "../config/env";

export function createDbClient(connectionString: string = env.DATABASE_URL) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

export type DbClient = ReturnType<typeof createDbClient>;

/**
 * Universal database executor type compatible with both DbClient and active PgTransactions.
 */
export type DatabaseExecutor = Pick<DbClient, "select" | "insert" | "update" | "delete">;

let dbInstance: DbClient | null = null;

export function getDb(): DbClient {
  if (!dbInstance) {
    dbInstance = createDbClient();
  }
  return dbInstance;
}
