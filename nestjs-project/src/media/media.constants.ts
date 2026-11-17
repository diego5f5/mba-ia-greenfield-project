export const FFPROBE_BIN = 'ffprobe';
export const FFMPEG_BIN = 'ffmpeg';

/** Max stdout/stderr kept from the binaries (ffprobe JSON is a few KiB). */
export const MEDIA_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const FFPROBE_TIMEOUT_MS = 60_000;
export const FFMPEG_THUMBNAIL_TIMEOUT_MS = 120_000;

/** Thumbnail is grabbed at this fraction of the duration (phase-03-videos/TD-08). */
export const THUMBNAIL_OFFSET_RATIO = 0.1;
export const THUMBNAIL_WIDTH_PX = 1280;
export const THUMBNAIL_TMP_PREFIX = 'streamtube-thumb-';
