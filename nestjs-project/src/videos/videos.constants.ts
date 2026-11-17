/** Size of every multipart part except the last (phase-03-videos/TD-05). */
export const VIDEO_PART_SIZE_BYTES = 64 * 1024 * 1024;

/** Largest accepted upload: 10 GiB (phase-03-videos/TD-05). */
export const VIDEO_MAX_FILE_SIZE_BYTES = 10 * 1024 ** 3;

/** Lifetime of presigned part/stream/download/thumbnail URLs, in seconds. */
export const VIDEO_URL_TTL_SECONDS = 3600;

/** Part URLs that can be requested in one call. */
export const VIDEO_MAX_PARTS_PER_REQUEST = 100;

/** S3 allows at most 10,000 parts per multipart upload. */
export const VIDEO_MAX_PARTS_PER_UPLOAD = 10_000;

export const VIDEO_TITLE_MAX_LENGTH = 100;

export const VIDEO_FILE_NAME_MAX_LENGTH = 255;

/** Only `video/*` media types are accepted (phase-03-videos/TD-05). */
export const VIDEO_CONTENT_TYPE_PATTERN = /^video\/[\w.+-]+$/;

/** Attempts to generate a collision-free `public_id` (phase-03-videos/TD-09). */
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;
export const PROCESS_VIDEO_JOB = 'process-video' as const;

/**
 * Retry policy of `process-video` (phase-03-videos/TD-11): 3 attempts with
 * exponential backoff. Finished jobs are deliberately kept (no
 * `removeOnComplete`/`removeOnFail`) so `jobId = videoId` keeps deduplicating.
 */
export const VIDEO_PROCESSING_QUEUE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
} as const;

/** Lifetime of the internal presigned URL the worker feeds to ffprobe/ffmpeg. */
export const VIDEO_PROCESSING_URL_TTL_SECONDS = 3600;

export const videoThumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
