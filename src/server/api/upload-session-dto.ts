import type {
  UploadSessionDTO,
  CompleteUploadResultDTO,
} from "@/server/services/upload-session-service";

export type SafeUploadSessionDTO = Omit<UploadSessionDTO, "r2UploadId">;

/**
 * Sanitizes an UploadSessionDTO to prevent disclosure of internal storage credentials/IDs
 * (specifically r2UploadId) to browser clients.
 */
export function toSafeUploadSessionDTO(session: UploadSessionDTO): SafeUploadSessionDTO {
  const { r2UploadId: _r2UploadId, ...safe } = session;
  return safe;
}

export interface SafeCompleteUploadResultDTO {
  readonly session: SafeUploadSessionDTO;
  readonly file: CompleteUploadResultDTO["file"];
}

/**
 * Sanitizes a CompleteUploadResultDTO so that the nested session does not leak r2UploadId.
 */
export function toSafeCompleteUploadResultDTO(
  result: CompleteUploadResultDTO
): SafeCompleteUploadResultDTO {
  return {
    session: toSafeUploadSessionDTO(result.session),
    file: result.file,
  };
}
