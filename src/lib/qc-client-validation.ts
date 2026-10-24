import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { EXECUTION_JSON_SCHEMAS } from "@cellweave/contracts";
import type { QcReviewView, QcInputOptions } from "@cellweave/contracts";
const ajv = new Ajv2020({ strict: false, strictNumbers: true });
addFormats(ajv);
for (const schema of EXECUTION_JSON_SCHEMAS) ajv.addSchema(schema);
const root = "https://contracts.cellweave.dev/schemas/jobs/qc-execution.v1.json#/$defs/";
export const isQcReviewView = ajv.compile<QcReviewView>({ $ref: root + "QcReviewView" });
export const isQcInputOptions = ajv.compile<QcInputOptions>({ $ref: root + "QcInputOptions" });
export async function qcRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error("Request rejected. Check your permissions and the current QC revision.");
  if (!result || typeof result !== "object" || !("data" in result))
    throw new Error("Invalid QC response");
  return result.data;
}
