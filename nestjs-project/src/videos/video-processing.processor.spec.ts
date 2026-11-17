import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { InvalidMediaError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { ProcessVideoJobData } from './video-processing.types';

const VIDEO_ID = '0b9a7c8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d';
const SOURCE_URL = 'http://minio:9000/bucket/videos/x/source?sig=1';
const METADATA = {
  width: 320,
  height: 240,
  video_codec: 'h264',
  audio_codec: 'aac',
  container_format: 'mov,mp4',
  bit_rate: 1000,
  size_bytes: 2000,
};

function buildJob(
  overrides: { attemptsMade?: number; attempts?: number } = {},
): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const repository = { findOne: jest.fn(), update: jest.fn() };
  const storage = { presignGetObject: jest.fn(), putObject: jest.fn() };
  const media = { probe: jest.fn(), extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    storage.presignGetObject.mockResolvedValue(SOURCE_URL);
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: media },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  describe('process', () => {
    it('ignores a video that does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await processor.process(buildJob());

      expect(media.probe).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'ignores a video in status %s',
      async (status) => {
        repository.findOne.mockResolvedValue({ id: VIDEO_ID, status });

        await processor.process(buildJob());

        expect(storage.presignGetObject).not.toHaveBeenCalled();
        expect(media.probe).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(repository.update).not.toHaveBeenCalled();
      },
    );

    it('probes, stores the thumbnail and marks the video ready in one update', async () => {
      const jpeg = Buffer.from([0xff, 0xd8]);
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
        source_key: `videos/${VIDEO_ID}/source`,
      });
      media.probe.mockResolvedValue({
        duration_seconds: 3.04,
        metadata: METADATA,
      });
      media.extractThumbnail.mockResolvedValue(jpeg);

      await processor.process(buildJob());

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source`,
        expect.objectContaining({ endpoint: 'internal' }),
      );
      expect(media.extractThumbnail).toHaveBeenCalledWith(SOURCE_URL, 3.04);
      expect(storage.putObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        jpeg,
        'image/jpeg',
      );
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration_seconds: 3.04,
          metadata: METADATA,
          thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
          processing_error: null,
          processed_at: expect.any(Date) as Date,
        },
      );
    });

    it('turns InvalidMediaError into an UnrecoverableError', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
        source_key: 'k',
      });
      media.probe.mockRejectedValue(new InvalidMediaError('no video stream'));

      const error: unknown = await processor
        .process(buildJob())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toContain('no video stream');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('lets infrastructure errors propagate so BullMQ retries', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
        source_key: 'k',
      });
      const failure = new Error('minio down');
      media.probe.mockResolvedValue({
        duration_seconds: 1,
        metadata: METADATA,
      });
      media.extractThumbnail.mockResolvedValue(Buffer.alloc(1));
      storage.putObject.mockRejectedValue(failure);

      await expect(processor.process(buildJob())).rejects.toBe(failure);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('only logs an intermediate failure', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 1 }),
        new Error('timeout'),
      );

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('marks the video failed on the last attempt', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 3 }),
        new Error('timeout'),
      );

      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: 'timeout',
          processed_at: expect.any(Date) as Date,
        },
      );
    });

    it('marks the video failed on the first attempt of an UnrecoverableError', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 1 }),
        new UnrecoverableError('Invalid media: no video stream found'),
      );

      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          processing_error: 'Invalid media: no video stream found',
        }),
      );
    });

    it('does not throw when persisting the failure fails', async () => {
      repository.update.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(buildJob({ attemptsMade: 3 }), new Error('x')),
      ).resolves.toBeUndefined();
    });

    it('ignores a failure event without a job', async () => {
      await processor.onFailed(undefined, new Error('stalled'));

      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
