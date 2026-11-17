import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_DURATION_SECONDS = 3;
export const FIXTURE_WIDTH = 320;
export const FIXTURE_HEIGHT = 240;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (error) => {
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Generates a short H.264 + AAC MP4 at runtime (no binary fixture in git).
 * `faststart` moves the moov atom up front so URL reads need few ranges.
 */
export async function createValidVideoFixture(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const output = join(dir, 'fixture.mp4');
  try {
    await runFfmpeg([
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${FIXTURE_DURATION_SECONDS}:size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=25`,
      '-f',
      'lavfi',
      '-i',
      `sine=duration=${FIXTURE_DURATION_SECONDS}`,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Random bytes: not decodable as any media container. */
export function createInvalidVideoFixture(sizeBytes = 64 * 1024): Buffer {
  return randomBytes(sizeBytes);
}
