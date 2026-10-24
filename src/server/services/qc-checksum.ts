import { createHash } from "node:crypto";
import type { QcSelectionParameters } from "@cellweave/contracts";
export function qcSelectionChecksum(parameters: QcSelectionParameters): string {
  function canonical(value: unknown): string {
    if (typeof value === "number") {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value);
      return "n" + bytes.toString("hex");
    }
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  }
  return createHash("sha256")
    .update("qc-selection-f64-v1:" + canonical(parameters))
    .digest("hex");
}
