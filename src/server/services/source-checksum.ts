import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeSafeFileName } from "../integrations/storage/object-key";
import { ValidationError } from "../authorization/errors";
import {
  validateRoleCardinality,
  type ImportSourceFormat,
  type SourceImportMember,
} from "./source-import-policy";

export interface TrustedSourceFileFact extends SourceImportMember {
  fileName: string;
  byteSize: number;
  sha256: string;
}

const factsSchema = z
  .array(
    z
      .object({
        datasetFileId: z.string().min(1),
        role: z.enum([
          "PRIMARY",
          "MATRIX",
          "FEATURES",
          "BARCODES",
          "CELL_METADATA",
          "FEATURE_METADATA",
        ]),
        ordinal: z.number().int().nonnegative().max(2147483647),
        fileName: z.string().min(1),
        byteSize: z.number().int().nonnegative().safe(),
        sha256: z
          .string()
          .length(64)
          .regex(/^[a-f0-9]{64}$/),
      })
      .strict()
  )
  .min(1);

/** Pure metadata operation matching science's format-specific source-checksum policy. */
export function computeTrustedSourceChecksum(input: {
  sourceFormat: ImportSourceFormat;
  files: readonly TrustedSourceFileFact[];
}): { sourceChecksum: string; manifest: string | null } {
  const parsed = factsSchema.safeParse(input.files);
  if (!parsed.success) throw new ValidationError("Invalid persisted source file facts");
  const files = parsed.data;
  validateRoleCardinality(input.sourceFormat, files);
  const names = new Set<string>();
  for (const file of files) {
    try {
      // Validate existing persisted-safe semantics; never use a normalized replacement.
      if (!file.fileName.isWellFormed() || normalizeSafeFileName(file.fileName) !== file.fileName) {
        throw new Error();
      }
    } catch {
      throw new ValidationError("Invalid persisted source filename");
    }
    if (names.has(file.fileName)) throw new ValidationError("Duplicate persisted source filename");
    names.add(file.fileName);
  }
  switch (input.sourceFormat) {
    case "H5AD":
    case "TENX_H5": {
      const file = files[0];
      if (!file) throw new ValidationError("Missing source file");
      return { sourceChecksum: file.sha256, manifest: null };
    }
    case "TENX_MTX":
    case "GENERIC_MATRIX": {
      // UTF-8 byte order matches Python Unicode code-point order for valid Unicode.
      files.sort((a, b) =>
        Buffer.compare(Buffer.from(a.fileName, "utf8"), Buffer.from(b.fileName, "utf8"))
      );
      const manifest = files
        .map((file) => `${file.fileName}\t${file.byteSize}\t${file.sha256}\n`)
        .join("");
      return {
        manifest,
        sourceChecksum: createHash("sha256").update(manifest, "utf8").digest("hex"),
      };
    }
    default:
      throw new ValidationError("Unsupported import source format");
  }
}
