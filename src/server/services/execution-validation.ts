import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { EXECUTION_JSON_SCHEMAS } from "@cellweave/contracts";
import type {
  ExecutionControl,
  ExecutionEnvelope,
  ExecutionCeilings,
  PreparedExecution,
  ExecutionResult,
  ExecutionProjection,
  MetadataMappingSubmission,
} from "@cellweave/contracts";
const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
for (const schema of EXECUTION_JSON_SCHEMAS) ajv.addSchema(schema);
const root = "https://contracts.cellweave.dev/schemas/jobs/workflow-execution.v1.json#/$defs/";
export const validEnvelope = ajv.compile<ExecutionEnvelope>({ $ref: root + "ExecutionEnvelope" });
export const validCeilings = ajv.compile<ExecutionCeilings>({ $ref: root + "ExecutionCeilings" });
export const validPrepared = ajv.compile<PreparedExecution>({ $ref: root + "PreparedExecution" });
export const validResult = ajv.compile<ExecutionResult>({ $ref: root + "ExecutionResult" });
export const validProjection = ajv.compile<ExecutionProjection>({
  $ref: root + "ExecutionProjection",
});
export const validMapping = ajv.compile<MetadataMappingSubmission>({
  $ref: "https://contracts.cellweave.dev/schemas/domain/metadata-mapping-submission.v1.json",
});

export const validControl = ajv.compile<ExecutionControl>({ $ref: root + "ExecutionControl" });
