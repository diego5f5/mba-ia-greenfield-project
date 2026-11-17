/**
 * Infrastructure error: the input is not a decodable video (ffprobe exited
 * with a non-zero code, produced unreadable output, or found no video
 * stream). Retrying cannot help, so the worker turns it into an
 * unrecoverable job failure (phase-03-videos/TD-11).
 */
export class InvalidMediaError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Invalid media: ${reason}`, options);
    this.name = 'InvalidMediaError';
  }
}
