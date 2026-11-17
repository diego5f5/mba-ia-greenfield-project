import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import { THUMBNAIL_TMP_PREFIX } from './media.constants';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type ExecCallback = (
  error: (Error & { code?: number | string }) | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = execFile as unknown as jest.Mock<
  void,
  [string, string[], object, ExecCallback]
>;

function mockExecSuccess(stdout: string): void {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _opts: object, cb: ExecCallback) =>
      cb(null, stdout, ''),
  );
}

function mockExecFailure(code: number | string): void {
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _opts: object, cb: ExecCallback) =>
      cb(Object.assign(new Error('boom'), { code }), '', 'secret-url'),
  );
}

const URL = 'http://minio:9000/bucket/videos/1/source?X-Amz-Signature=abc';

describe('MediaProbeService', () => {
  let service: MediaProbeService;

  beforeEach(async () => {
    execFileMock.mockReset();
    const module = await Test.createTestingModule({
      providers: [MediaProbeService],
    }).compile();
    service = module.get(MediaProbeService);
  });

  describe('probe', () => {
    it('runs ffprobe without a shell, passing the URL as a single argument', async () => {
      mockExecSuccess(
        JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} }),
      );

      await service.probe(URL);

      const [file, args, rawOptions] = execFileMock.mock.calls[0];
      const options = rawOptions as {
        shell?: unknown;
        timeout: number;
        maxBuffer: number;
      };
      expect(file).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        URL,
      ]);
      expect(options.shell).toBeUndefined();
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
    });

    it('maps the ffprobe JSON, converting numeric strings', async () => {
      mockExecSuccess(
        JSON.stringify({
          streams: [
            { codec_type: 'audio', codec_name: 'aac' },
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 320,
              height: 240,
            },
          ],
          format: {
            duration: '3.040000',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            bit_rate: '123456',
            size: '98765',
          },
        }),
      );

      await expect(service.probe(URL)).resolves.toEqual({
        duration_seconds: 3.04,
        metadata: {
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
          bit_rate: 123456,
          size_bytes: 98765,
        },
      });
    });

    it('returns audio_codec null and null duration when the source has neither', async () => {
      mockExecSuccess(
        JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'vp9', width: 10, height: 20 },
          ],
          format: { format_name: 'matroska,webm' },
        }),
      );

      const result = await service.probe(URL);

      expect(result.duration_seconds).toBeNull();
      expect(result.metadata.audio_codec).toBeNull();
      expect(result.metadata.bit_rate).toBeNull();
      expect(result.metadata.size_bytes).toBeNull();
    });

    it('throws InvalidMediaError when there is no video stream', async () => {
      mockExecSuccess(
        JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
          format: { duration: '10' },
        }),
      );

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('throws InvalidMediaError when ffprobe prints invalid JSON', async () => {
      mockExecSuccess('not json');

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('throws InvalidMediaError, without leaking stderr, when ffprobe exits non-zero', async () => {
      mockExecFailure(1);

      const error: unknown = await service.probe(URL).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).not.toContain('secret-url');
    });

    it('propagates infrastructure failures (binary missing) as-is', async () => {
      mockExecFailure('ENOENT');

      const error: unknown = await service.probe(URL).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(InvalidMediaError);
      expect((error as { code?: string }).code).toBe('ENOENT');
    });
  });

  describe('extractThumbnail', () => {
    const seekOf = (): string => {
      const args = execFileMock.mock.calls[0][1];
      return args[args.indexOf('-ss') + 1];
    };

    const leftoverTmpDirs = async (): Promise<string[]> =>
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith(THUMBNAIL_TMP_PREFIX),
      );

    it('seeks to 10% of the duration', async () => {
      mockExecSuccess('');

      await service.extractThumbnail(URL, 50).catch(() => undefined);

      expect(execFileMock.mock.calls[0][0]).toBe('ffmpeg');
      expect(seekOf()).toBe('5.000');
    });

    it('seeks to 0 when the duration is unknown', async () => {
      mockExecSuccess('');

      await service.extractThumbnail(URL, null).catch(() => undefined);

      expect(seekOf()).toBe('0.000');
    });

    it('scales to 1280px wide preserving the aspect ratio', async () => {
      mockExecSuccess('');

      await service.extractThumbnail(URL, 10).catch(() => undefined);

      const args = execFileMock.mock.calls[0][1];
      expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:-2');
      expect(args).toContain(URL);
    });

    it('removes its temporary directory when ffmpeg fails', async () => {
      const before = await leftoverTmpDirs();
      mockExecFailure(1);

      await expect(service.extractThumbnail(URL, 10)).rejects.toThrow();

      expect(await leftoverTmpDirs()).toEqual(before);
    });
  });
});
