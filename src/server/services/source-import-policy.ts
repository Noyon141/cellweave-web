import { ValidationError } from "../authorization/errors";

export type ImportSourceFormat = "H5AD" | "TENX_H5" | "TENX_MTX" | "GENERIC_MATRIX";

export type ImportFileRole =
  "PRIMARY" | "MATRIX" | "FEATURES" | "BARCODES" | "CELL_METADATA" | "FEATURE_METADATA";

export interface SourceImportMember {
  datasetFileId: string;
  role: ImportFileRole;
  ordinal: number;
}

export function validateRoleCardinality(
  sourceFormat: ImportSourceFormat,
  files: readonly SourceImportMember[]
): void {
  if (!files || files.length === 0) {
    throw new ValidationError("Import manifest must contain at least one file");
  }

  // Duplicate file ID guard
  const fileIds = new Set<string>();
  for (const f of files) {
    if (fileIds.has(f.datasetFileId)) {
      throw new ValidationError(`Duplicate file ${f.datasetFileId} in import manifest`);
    }
    fileIds.add(f.datasetFileId);
  }

  const roleCounts: Record<ImportFileRole, number> = {
    PRIMARY: 0,
    MATRIX: 0,
    FEATURES: 0,
    BARCODES: 0,
    CELL_METADATA: 0,
    FEATURE_METADATA: 0,
  };

  for (const f of files) {
    if (!(f.role in roleCounts)) {
      throw new ValidationError(`Invalid file role ${f.role} in manifest`);
    }
    roleCounts[f.role]++;
  }

  if (sourceFormat === "H5AD") {
    if (roleCounts.PRIMARY !== 1 || files.length !== 1) {
      throw new ValidationError("H5AD import requires exactly 1 file with role PRIMARY");
    }
  } else if (sourceFormat === "TENX_H5") {
    if (roleCounts.PRIMARY !== 1 || files.length !== 1) {
      throw new ValidationError("TENX_H5 import requires exactly 1 file with role PRIMARY");
    }
  } else if (sourceFormat === "TENX_MTX") {
    if (
      roleCounts.MATRIX !== 1 ||
      roleCounts.FEATURES !== 1 ||
      roleCounts.BARCODES !== 1 ||
      files.length !== 3
    ) {
      throw new ValidationError(
        "TENX_MTX import requires exactly 3 files: MATRIX, FEATURES, and BARCODES"
      );
    }
  } else if (sourceFormat === "GENERIC_MATRIX") {
    const invalidRoles = roleCounts.PRIMARY + roleCounts.FEATURES + roleCounts.BARCODES;
    if (
      roleCounts.MATRIX !== 1 ||
      roleCounts.CELL_METADATA > 1 ||
      roleCounts.FEATURE_METADATA > 1 ||
      invalidRoles > 0 ||
      files.length !== roleCounts.MATRIX + roleCounts.CELL_METADATA + roleCounts.FEATURE_METADATA
    ) {
      throw new ValidationError(
        "GENERIC_MATRIX import requires exactly 1 MATRIX file, at most 1 CELL_METADATA, at most 1 FEATURE_METADATA, and no other roles"
      );
    }
  } else {
    throw new ValidationError(`Unsupported source format: ${sourceFormat}`);
  }
}
