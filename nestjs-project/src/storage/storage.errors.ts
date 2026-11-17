/**
 * Infrastructure error raised when the object storage refuses to assemble a
 * multipart upload (missing/invalid part, wrong ETag, wrong order, unknown
 * upload). It is not a DomainException: callers translate it into the
 * appropriate domain error.
 */
export class MultipartUploadRejectedError extends Error {
  constructor(
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Multipart upload rejected by storage: ${reason}`, options);
    this.name = 'MultipartUploadRejectedError';
  }
}

/** S3 error names that mean "this multipart upload cannot be completed". */
export const MULTIPART_REJECTION_ERROR_NAMES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
] as const;
