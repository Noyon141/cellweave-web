import { v7 as uuidv7 } from "uuid";

/**
 * Supported Domain Entity Prefixes for Phase 2 & Phase 3
 */
export type DomainPrefix =
  "exp" | "smp" | "ds" | "dsv" | "dsf" | "upl" | "dfp" | "dim" | "dif" | "aud" | "run" | "wfs";

/**
 * Centralized Domain ID Generator
 * Generates time-sortable RFC 9562 UUIDv7 identifiers wrapped in canonical domain prefixes.
 *
 * Prefixes:
 * - exp: Experiment
 * - smp: Sample
 * - ds: Dataset
 * - dsv: Dataset Version
 * - dsf: Dataset File
 * - upl: Upload Session
 * - dfp: Dataset File Provenance
 * - dim: Dataset Import Manifest
 * - dif: Dataset Import File
 * - aud: Audit Event
 */
export function generateDomainId(prefix: DomainPrefix): string {
  return `${prefix}_${uuidv7()}`;
}
