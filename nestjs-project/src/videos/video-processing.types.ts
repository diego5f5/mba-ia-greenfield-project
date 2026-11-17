/**
 * Payload of the `process-video` job on the `video-processing` queue.
 * It carries only the internal video id; the consumer reloads the row, so no
 * state is duplicated in Redis (phase-03-videos § Events/Messages).
 */
export interface ProcessVideoJobData {
  videoId: string;
}
