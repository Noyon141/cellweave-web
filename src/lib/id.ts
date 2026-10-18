import { v7 as uuidv7 } from "uuid";

/**
 * Supported Domain Entity Prefixes for Phase 2
 */
export type DomainPrefix = "exp" | "smp" | "ds" | "dsv" | "dsf" | "upl";

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
 */
export function generateDomainId(prefix: DomainPrefix): string {
  return `${prefix}_${uuidv7()}`;
}
