import type { VideoMetadata } from '../videos/entities/video.entity';

export interface MediaProbeResult {
  duration_seconds: number | null;
  metadata: VideoMetadata;
}

/** Subset of the `ffprobe -print_format json` output the service reads. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
}

export interface FfprobeFormat {
  duration?: string;
  format_name?: string;
  bit_rate?: string;
  size?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}
