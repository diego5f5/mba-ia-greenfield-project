import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createInvalidVideoFixture,
  createValidVideoFixture,
  FIXTURE_DURATION_SECONDS,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
} from '../test/video-fixture';
import { THUMBNAIL_TMP_PREFIX } from './media.constants';
import { InvalidMediaError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaProbeService } from './media-probe.service';

const URL_TTL_SECONDS = 300;

/** Width/height from the first SOF marker of a baseline/progressive JPEG. */
function readJpegSize(jpeg: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      throw new Error('Malformed JPEG');
    }
    const marker = jpeg[offset + 1];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return {
        height: jpeg.readUInt16BE(offset + 5),
        width: jpeg.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error('No SOF marker found');
}

describe('MediaProbeService (integration, ffmpeg + MinIO)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let module: TestingModule;
  let storage: StorageService;
  let media: MediaProbeService;
  const createdKeys: string[] = [];

  async function upload(body: Buffer, contentType: string): Promise<string> {
    const key = `test/media/${randomUUID()}/source`;
    createdKeys.push(key);
    await storage.putObject(key, body, contentType);
    return storage.presignGetObject(key, {
      expiresIn: URL_TTL_SECONDS,
      endpoint: 'internal',
    });
  }

  const leftoverTmpDirs = async (): Promise<string[]> =>
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith(THUMBNAIL_TMP_PREFIX),
    );

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    media = module.get(MediaProbeService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  it('probes a valid MP4 served by the storage', async () => {
    const url = await upload(await createValidVideoFixture(), 'video/mp4');

    const result = await media.probe(url);

    expect(result.duration_seconds).toBeGreaterThan(
      FIXTURE_DURATION_SECONDS - 0.1,
    );
    expect(result.duration_seconds).toBeLessThan(
      FIXTURE_DURATION_SECONDS + 0.1,
    );
    expect(result.metadata).toMatchObject({
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(result.metadata.size_bytes).toBeGreaterThan(0);
    expect(result.metadata.container_format).toContain('mp4');
  });

  it('rejects a file without a video stream with InvalidMediaError', async () => {
    const url = await upload(createInvalidVideoFixture(), 'video/mp4');

    await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('extracts a 1280px wide JPEG thumbnail keeping the aspect ratio', async () => {
    const url = await upload(await createValidVideoFixture(), 'video/mp4');
    const before = await leftoverTmpDirs();

    const jpeg = await media.extractThumbnail(url, FIXTURE_DURATION_SECONDS);

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(readJpegSize(jpeg)).toEqual({ width: 1280, height: 960 });
    expect(await leftoverTmpDirs()).toEqual(before);
  });

  it('leaves no temporary files when ffmpeg fails', async () => {
    const url = await upload(createInvalidVideoFixture(), 'video/mp4');
    const before = await leftoverTmpDirs();

    await expect(media.extractThumbnail(url, null)).rejects.toThrow();

    expect(await leftoverTmpDirs()).toEqual(before);
  });
});
