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
const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false });
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

import type {
  QcStartRequest,
  QcSelectionParameters,
  QcApprovalRequest,
  QcPreparedExecution,
  QcJobResult,
  QcControl,
  QcDecision,
  QcProjection,
  QcApprovalSignal,
} from "@cellweave/contracts";

const qcRoot = "https://contracts.cellweave.dev/schemas/jobs/qc-execution.v1.json#/$defs/";
export const validQcStartRequest = ajv.compile<QcStartRequest>({ $ref: qcRoot + "QcStartRequest" });
export const validQcSelectionParameters = ajv.compile<QcSelectionParameters>({
  $ref: qcRoot + "QcSelectionParameters",
});
export const validQcApprovalRequest = ajv.compile<QcApprovalRequest>({
  $ref: qcRoot + "QcApprovalRequest",
});
export const validQcPreparedExecution = ajv.compile<QcPreparedExecution>({
  $ref: qcRoot + "QcPreparedExecution",
});
export const validQcJobResult = ajv.compile<QcJobResult>({ $ref: qcRoot + "QcJobResult" });
export const validQcControl = ajv.compile<QcControl>({ $ref: qcRoot + "QcControl" });
export const validQcDecision = ajv.compile<QcDecision>({ $ref: qcRoot + "QcDecision" });
export const validQcProjection = ajv.compile<QcProjection>({ $ref: qcRoot + "QcProjection" });
export const validQcApprovalSignal = ajv.compile<QcApprovalSignal>({
  $ref: qcRoot + "QcApprovalSignal",
});

import type { QcReviewView, QcInputOptions } from "@cellweave/contracts";
export const validQcReviewView = ajv.compile<QcReviewView>({ $ref: qcRoot + "QcReviewView" });
export const validQcInputOptions = ajv.compile<QcInputOptions>({ $ref: qcRoot + "QcInputOptions" });
