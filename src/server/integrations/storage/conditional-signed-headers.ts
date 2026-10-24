import { StorageError } from "./storage-types";
export function assertConditionalPutSignedHeaders(putUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(putUrl);
  } catch (error) {
    throw new StorageError(
      "Presigner returned an invalid PUT capability URL",
      "PROVIDER_ERROR",
      false,
      error
    );
  }

  const signedHeadersRaw =
    parsed.searchParams.get("X-Amz-SignedHeaders") ??
    parsed.searchParams.get("x-amz-signedheaders") ??
    "";

  const signedHeaders = signedHeadersRaw
    .split(";")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  if (!signedHeaders.includes("if-none-match") || !signedHeaders.includes("content-type")) {
    throw new StorageError(
      "Presigned PUT capability did not cryptographically bind required conditional headers (if-none-match, content-type)",
      "PROVIDER_ERROR",
      false
    );
  }
}
