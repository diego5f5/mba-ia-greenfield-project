import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  FFMPEG_BIN,
  FFMPEG_THUMBNAIL_TIMEOUT_MS,
  FFPROBE_BIN,
  FFPROBE_TIMEOUT_MS,
  MEDIA_MAX_BUFFER_BYTES,
  THUMBNAIL_OFFSET_RATIO,
  THUMBNAIL_TMP_PREFIX,
  THUMBNAIL_WIDTH_PX,
} from './media.constants';
import { InvalidMediaError } from './media.errors';
import type {
  FfprobeOutput,
  FfprobeStream,
  MediaProbeResult,
} from './media-probe.types';

interface ExecFileFailure extends Error {
  /** Exit code (number) or spawn error code such as `ENOENT` (string). */
  code?: number | string | null;
}

function toNumberOrNull(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads media straight from a URL (HTTP range requests) with the system
 * `ffprobe`/`ffmpeg` binaries. Binaries run through `execFile` — no shell, so
 * the URL is a single argv entry and cannot be interpreted
 * (phase-03-videos/TD-08).
 */
@Injectable()
export class MediaProbeService {
  async probe(inputUrl: string): Promise<MediaProbeResult> {
    let stdout: string;
    try {
      stdout = await this.run(
        FFPROBE_BIN,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        FFPROBE_TIMEOUT_MS,
      );
    } catch (error) {
      // A numeric code is the binary's own exit status (unreadable input).
      // Anything else (ENOENT, timeout) is infrastructure: let it propagate.
      if (typeof (error as ExecFileFailure).code === 'number') {
        // The message is persisted as `processing_error`: never echo stderr,
        // which can contain the presigned URL.
        throw new InvalidMediaError(
          `ffprobe exited with code ${(error as ExecFileFailure).code}`,
          { cause: error },
        );
      }
      throw error;
    }
    return this.mapOutput(stdout);
  }

  async extractThumbnail(
    inputUrl: string,
    durationSeconds: number | null,
  ): Promise<Buffer> {
    const offset =
      durationSeconds === null ? 0 : durationSeconds * THUMBNAIL_OFFSET_RATIO;
    const dir = await mkdtemp(join(tmpdir(), THUMBNAIL_TMP_PREFIX));
    const outputPath = join(dir, 'thumbnail.jpg');
    try {
      await this.run(
        FFMPEG_BIN,
        [
          '-v',
          'error',
          '-ss',
          offset.toFixed(3),
          '-i',
          inputUrl,
          '-frames:v',
          '1',
          '-vf',
          `scale=${THUMBNAIL_WIDTH_PX}:-2`,
          '-q:v',
          '3',
          '-y',
          outputPath,
        ],
        FFMPEG_THUMBNAIL_TIMEOUT_MS,
      );
      return await readFile(outputPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private mapOutput(stdout: string): MediaProbeResult {
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new InvalidMediaError('ffprobe output is not valid JSON', {
        cause: error,
      });
    }

    const streams: FfprobeStream[] = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    if (!video) {
      throw new InvalidMediaError('no video stream found');
    }
    const audio = streams.find((s) => s.codec_type === 'audio');
    const format = parsed.format ?? {};

    return {
      duration_seconds: toNumberOrNull(format.duration),
      metadata: {
        width: video.width ?? null,
        height: video.height ?? null,
        video_codec: video.codec_name ?? null,
        audio_codec: audio?.codec_name ?? null,
        container_format: format.format_name ?? null,
        bit_rate: toNumberOrNull(format.bit_rate),
        size_bytes: toNumberOrNull(format.size),
      },
    };
  }

  private run(file: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { maxBuffer: MEDIA_MAX_BUFFER_BYTES, timeout, encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            reject(
              Object.assign(new Error(error.message), { code: error.code }),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
