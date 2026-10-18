import { STORAGE_DEFAULTS, StorageError } from "./storage-types";

export interface BuildDatasetSourceObjectKeyParams {
  readonly organizationId: string;
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly fileName: string;
}

/**
 * Normalizes and validates user-supplied file names for safe object storage.
 *
 * Invariants:
 * 1. Rejects NUL (\0) and control characters.
 * 2. Removes directory components from both POSIX (/) and Windows (\) path formats.
 * 3. Rejects directory traversal semantics ("..").
 * 4. Rejects empty names after normalization or pure dot files (".", "..").
 * 5. Rejects absolute paths.
 * 6. Enforces MAX_FILENAME_LENGTH (255 characters).
 * 7. Preserves valid extensions (e.g., .h5ad, .mtx.gz, .tsv.gz).
 */
export function normalizeSafeFileName(rawFileName: string): string {
  if (typeof rawFileName !== "string" || rawFileName.trim().length === 0) {
    throw new StorageError("File name must be a non-empty string", "INVALID_FILENAME");
  }

  // Check for NUL and control characters (ASCII 0x00 to 0x1F, and 0x7F)
  if (/[\x00-\x1f\x7f]/.test(rawFileName)) {
    throw new StorageError(
      "File name contains prohibited control or NUL characters",
      "INVALID_FILENAME"
    );
  }

  // Reject absolute paths
  if (
    rawFileName.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(rawFileName) ||
    rawFileName.startsWith("\\\\")
  ) {
    throw new StorageError("File name cannot be an absolute path", "INVALID_FILENAME");
  }

  // Normalize path separators to forward slash, then extract basename
  const unified = rawFileName.replace(/\\/g, "/");
  const segments = unified.split("/").filter((s) => s.length > 0);

  // If traversal ".." was included anywhere in path components
  if (segments.includes("..") || unified.includes("..")) {
    throw new StorageError(
      "File name cannot contain directory traversal semantics (..)",
      "INVALID_FILENAME"
    );
  }

  const base = segments[segments.length - 1];
  if (!base || base.trim().length === 0 || base === "." || base === "..") {
    throw new StorageError(
      "File name resolves to an empty or invalid base name",
      "INVALID_FILENAME"
    );
  }

  const trimmed = base.trim();

  // Validate UTF-8 byte length (using TextEncoder for true byte count)
  const byteLength = new TextEncoder().encode(trimmed).length;
  if (byteLength > STORAGE_DEFAULTS.MAX_FILENAME_LENGTH) {
    throw new StorageError(
      `File name exceeds maximum length of ${STORAGE_DEFAULTS.MAX_FILENAME_LENGTH} bytes`,
      "INVALID_FILENAME"
    );
  }

  return trimmed;
}

/**
 * Builds the canonical deterministic source object key for a dataset file.
 *
 * Pattern: org/{organizationId}/project/{projectId}/datasets/{datasetVersionId}/source/{safeFileName}
 *
 * Invariants:
 * 1. Client never supplies or modifies prefix components.
 * 2. Organization, project, and dataset version boundaries are strictly enforced.
 * 3. File name is sanitized and normalized to prevent escaping the source folder.
 */
export function buildDatasetSourceObjectKey(params: BuildDatasetSourceObjectKeyParams): string {
  const { organizationId, projectId, datasetVersionId, fileName } = params;

  if (!organizationId || typeof organizationId !== "string" || organizationId.trim().length === 0) {
    throw new StorageError(
      "organizationId is required for object key construction",
      "INVALID_OBJECT_KEY"
    );
  }
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new StorageError(
      "projectId is required for object key construction",
      "INVALID_OBJECT_KEY"
    );
  }
  if (
    !datasetVersionId ||
    typeof datasetVersionId !== "string" ||
    datasetVersionId.trim().length === 0
  ) {
    throw new StorageError(
      "datasetVersionId is required for object key construction",
      "INVALID_OBJECT_KEY"
    );
  }

  // Prevent injection in ID strings
  if (
    organizationId.includes("/") ||
    organizationId.includes("\\") ||
    organizationId.includes("..")
  ) {
    throw new StorageError("organizationId contains invalid path characters", "INVALID_OBJECT_KEY");
  }
  if (projectId.includes("/") || projectId.includes("\\") || projectId.includes("..")) {
    throw new StorageError("projectId contains invalid path characters", "INVALID_OBJECT_KEY");
  }
  if (
    datasetVersionId.includes("/") ||
    datasetVersionId.includes("\\") ||
    datasetVersionId.includes("..")
  ) {
    throw new StorageError(
      "datasetVersionId contains invalid path characters",
      "INVALID_OBJECT_KEY"
    );
  }

  const safeFileName = normalizeSafeFileName(fileName);

  return `org/${organizationId}/project/${projectId}/datasets/${datasetVersionId}/source/${safeFileName}`;
}
