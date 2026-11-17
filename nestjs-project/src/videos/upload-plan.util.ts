import { VIDEO_PART_SIZE_BYTES } from './videos.constants';

/** Number of multipart parts needed for a file of the given size. */
export function calculatePartCount(fileSizeBytes: number): number {
  return Math.ceil(fileSizeBytes / VIDEO_PART_SIZE_BYTES);
}
