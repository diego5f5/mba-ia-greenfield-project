import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { MultipartUploadRejectedError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

const TEN_GIB = 10 * 1024 ** 3;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: `Key (${column})=(x) already exists.`,
    }),
  );
}

function dto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    file_name: 'aula.mp4',
    file_size: 1048576,
    content_type: 'video/mp4',
    ...overrides,
  };
}

function savedVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'AbCdEfGhIjK',
    channel_id: CHANNEL_ID,
    title: 'aula',
    status: VideoStatus.DRAFT,
    original_file_name: 'aula.mp4',
    content_type: 'video/mp4',
    file_size_bytes: 1048576,
    source_key: 'videos/video-1/source',
    upload_id: 'upload-1',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    processing_error: null,
    processed_at: null,
    created_at: new Date('2026-11-17T10:00:00Z'),
    updated_at: new Date('2026-11-17T10:00:00Z'),
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    presignGetObject: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.create.mockImplementation((fields: Partial<Video>) => ({
      ...fields,
    }));
    videoRepository.save.mockImplementation((video: Partial<Video>) =>
      Promise.resolve(savedVideo(video)),
    );
    channelsService.findByUserId.mockResolvedValue({
      id: CHANNEL_ID,
    } as Channel);
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    storage.presignUploadPart.mockImplementation(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`https://storage/part-${partNumber}`),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createVideo', () => {
    it.each([
      ['aula.mp4', 'aula'],
      ['archive.tar.gz', 'archive.tar'],
      ['.hidden', '.hidden'],
      ['semextensao', 'semextensao'],
    ])('defaults the title of %s to %s', async (fileName, expected) => {
      await service.createVideo(USER_ID, dto({ file_name: fileName }));

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: expected }),
      );
    });

    it('caps the default title at 100 characters', async () => {
      await service.createVideo(
        USER_ID,
        dto({ file_name: `${'a'.repeat(150)}.mp4` }),
      );

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'a'.repeat(100) }),
      );
    });

    it('keeps an explicit title', async () => {
      await service.createVideo(USER_ID, dto({ title: 'Minha aula' }));

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Minha aula' }),
      );
    });

    it('persists a draft tied to the channel and the multipart upload', async () => {
      await service.createVideo(USER_ID, dto());

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/[0-9a-f-]{36}\/source$/),
        'video/mp4',
      );
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: CHANNEL_ID,
          status: VideoStatus.DRAFT,
          upload_id: 'upload-1',
          original_file_name: 'aula.mp4',
          content_type: 'video/mp4',
          file_size_bytes: 1048576,
          public_id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/) as unknown,
        }),
      );
    });

    it('returns the upload plan with 160 parts for a 10 GiB file', async () => {
      videoRepository.save.mockImplementation((video: Partial<Video>) =>
        Promise.resolve(savedVideo({ ...video, file_size_bytes: TEN_GIB })),
      );

      const result = await service.createVideo(
        USER_ID,
        dto({ file_size: TEN_GIB }),
      );

      expect(result.upload).toEqual({ part_size: 67108864, part_count: 160 });
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.thumbnail_url).toBeNull();
    });

    it('retries with a new public_id when the first one collides', async () => {
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementation((video: Partial<Video>) =>
          Promise.resolve(savedVideo(video)),
        );

      await service.createVideo(USER_ID, dto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const ids = videoRepository.create.mock.calls.map(
        ([fields]: [Partial<Video>]) => fields.public_id,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload and fails after exhausting collisions', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.createVideo(USER_ID, dto())).rejects.toThrow(
        'Could not generate a unique public_id after 5 attempts',
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(5);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });

    it('aborts the multipart upload and rethrows any other insert error', async () => {
      videoRepository.save.mockRejectedValue(new Error('connection lost'));

      await expect(service.createVideo(USER_ID, dto())).rejects.toThrow(
        'connection lost',
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('still rethrows the original error when the abort also fails', async () => {
      videoRepository.save.mockRejectedValue(new Error('connection lost'));
      storage.abortMultipartUpload.mockRejectedValue(new Error('storage down'));

      await expect(service.createVideo(USER_ID, dto())).rejects.toThrow(
        'connection lost',
      );
    });

    it('does not create a multipart upload when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createVideo(USER_ID, dto())).rejects.toThrow(
        'No channel found',
      );

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('requestUploadPartUrls', () => {
    const ownedDraft = (overrides: Partial<Video> = {}) =>
      videoRepository.findOne.mockResolvedValue(
        savedVideo({ file_size_bytes: TEN_GIB, ...overrides }),
      );

    it('looks the video up by public_id scoped to the caller', async () => {
      ownedDraft();

      await service.requestUploadPartUrls(USER_ID, 'AbCdEfGhIjK', [1]);

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AbCdEfGhIjK', channel: { user_id: USER_ID } },
      });
    });

    it('throws VIDEO_NOT_FOUND for an unknown video or a non-owner', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.requestUploadPartUrls(USER_ID, 'AbCdEfGhIjK', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'throws UPLOAD_NOT_IN_PROGRESS when the video is %s',
      async (status) => {
        ownedDraft({ status, upload_id: null });

        await expect(
          service.requestUploadPartUrls(USER_ID, 'AbCdEfGhIjK', [1]),
        ).rejects.toBeInstanceOf(UploadNotInProgressException);
      },
    );

    it('throws INVALID_UPLOAD_PARTS for a part beyond part_count', async () => {
      ownedDraft();

      await expect(
        service.requestUploadPartUrls(USER_ID, 'AbCdEfGhIjK', [1, 161]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('accepts the last valid part and keeps the request order', async () => {
      ownedDraft();

      const result = await service.requestUploadPartUrls(
        USER_ID,
        'AbCdEfGhIjK',
        [160, 2, 1],
      );

      expect(result).toEqual({
        parts: [
          { part_number: 160, url: 'https://storage/part-160' },
          { part_number: 2, url: 'https://storage/part-2' },
          { part_number: 1, url: 'https://storage/part-1' },
        ],
        expires_in: 3600,
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        160,
        3600,
      );
    });
  });

  describe('completeUpload', () => {
    const PARTS = [
      { part_number: 1, etag: '"etag-1"' },
      { part_number: 2, etag: '"etag-2"' },
    ];
    const drafted = (overrides: Partial<Video> = {}) =>
      savedVideo({ file_size_bytes: 1048576, ...overrides });

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(drafted());
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({
        contentLength: 1048576,
        contentType: 'video/mp4',
      });
      storage.deleteObject.mockResolvedValue(undefined);
      videoRepository.update.mockResolvedValue({ affected: 1 });
      videoRepository.findOneByOrFail.mockResolvedValue(
        drafted({ status: VideoStatus.PROCESSING, upload_id: null }),
      );
      queue.add.mockResolvedValue({});
    });

    it('completes the multipart, claims draft → processing and enqueues once', async () => {
      const result = await service.completeUpload(
        USER_ID,
        'AbCdEfGhIjK',
        PARTS,
      );

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        { jobId: 'video-1' },
      );
      expect(result.transitioned).toBe(true);
      expect(result.video.status).toBe(VideoStatus.PROCESSING);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'is idempotent for a %s video: no storage, update or queue operation',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          drafted({ status, upload_id: null }),
        );

        const result = await service.completeUpload(
          USER_ID,
          'AbCdEfGhIjK',
          PARTS,
        );

        expect(result.transitioned).toBe(false);
        expect(result.video.status).toBe(status);
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('throws VIDEO_NOT_FOUND for a non-owner', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('maps a storage rejection to INVALID_UPLOAD_PARTS and keeps the video draft', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new MultipartUploadRejectedError('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('reports the current state when a concurrent completion already won', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new MultipartUploadRejectedError('NoSuchUpload'),
      );
      videoRepository.findOne
        .mockResolvedValueOnce(drafted())
        .mockResolvedValueOnce(
          drafted({ status: VideoStatus.PROCESSING, upload_id: null }),
        );

      const result = await service.completeUpload(
        USER_ID,
        'AbCdEfGhIjK',
        PARTS,
      );

      expect(result.transitioned).toBe(false);
      expect(result.video.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('propagates storage errors that are not part rejections', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new Error('storage unreachable'),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
      ).rejects.toThrow('storage unreachable');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([
      ['smaller than declared', 1000],
      ['larger than declared', 2000000],
    ])(
      'fails the video, deletes the object and throws when the file is %s',
      async (_label, contentLength) => {
        storage.headObject.mockResolvedValue({
          contentLength,
          contentType: 'video/mp4',
        });

        await expect(
          service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
        ).rejects.toBeInstanceOf(UploadSizeMismatchException);

        expect(storage.deleteObject).toHaveBeenCalledWith(
          'videos/video-1/source',
        );
        expect(videoRepository.update).toHaveBeenCalledWith(
          { id: 'video-1', status: VideoStatus.DRAFT },
          expect.objectContaining({
            status: VideoStatus.FAILED,
            processing_error: 'UPLOAD_SIZE_MISMATCH',
            upload_id: null,
          }),
        );
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('rejects a file above 10 GiB even if it matches the declared size', async () => {
      videoRepository.findOne.mockResolvedValue(
        drafted({ file_size_bytes: TEN_GIB + 1 }),
      );
      storage.headObject.mockResolvedValue({
        contentLength: TEN_GIB + 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('does not enqueue when another caller already claimed the transition', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      const result = await service.completeUpload(
        USER_ID,
        'AbCdEfGhIjK',
        PARTS,
      );

      expect(result.transitioned).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails the video with ENQUEUE_FAILED and rethrows when the queue is down', async () => {
      queue.add.mockRejectedValue(new Error('redis unreachable'));

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGhIjK', PARTS),
      ).rejects.toThrow('redis unreachable');

      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1' },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          processing_error: 'ENQUEUE_FAILED: redis unreachable',
        }),
      );
    });
  });

  describe('getVideo', () => {
    it('returns the owner video with a presigned public thumbnail URL', async () => {
      videoRepository.findOne.mockResolvedValue(
        savedVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
        }),
      );
      storage.presignGetObject.mockResolvedValue('https://public/thumb');

      const result = await service.getVideo(USER_ID, 'AbCdEfGhIjK');

      expect(result.thumbnail_url).toBe('https://public/thumb');
      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        { expiresIn: 3600, endpoint: 'public' },
      );
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AbCdEfGhIjK', channel: { user_id: USER_ID } },
      });
    });

    it('returns thumbnail_url null when there is no thumbnail yet', async () => {
      videoRepository.findOne.mockResolvedValue(savedVideo());

      const result = await service.getVideo(USER_ID, 'AbCdEfGhIjK');

      expect(result.thumbnail_url).toBeNull();
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND for an unknown video or one owned by someone else', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getVideo('other-user', 'AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe.each(['getStreamUrl', 'getDownloadUrl'] as const)('%s', (method) => {
    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'throws VIDEO_NOT_READY for a %s video',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(savedVideo({ status }));

        await expect(
          service[method](USER_ID, 'AbCdEfGhIjK'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storage.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('throws VIDEO_NOT_FOUND for a video owned by someone else', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service[method]('other-user', 'AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl', () => {
    it('presigns the source object on the public endpoint with the video content type', async () => {
      videoRepository.findOne.mockResolvedValue(
        savedVideo({ status: VideoStatus.READY, content_type: 'video/webm' }),
      );
      storage.presignGetObject.mockResolvedValue('https://public/stream');

      await expect(service.getStreamUrl(USER_ID, 'AbCdEfGhIjK')).resolves.toBe(
        'https://public/stream',
      );

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        {
          expiresIn: 3600,
          endpoint: 'public',
          responseContentType: 'video/webm',
        },
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('forces a download with an ASCII fallback and the UTF-8 original name', async () => {
      videoRepository.findOne.mockResolvedValue(
        savedVideo({
          status: VideoStatus.READY,
          original_file_name: 'Introdução.mp4',
        }),
      );
      storage.presignGetObject.mockResolvedValue('https://public/download');

      await expect(
        service.getDownloadUrl(USER_ID, 'AbCdEfGhIjK'),
      ).resolves.toBe('https://public/download');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        {
          expiresIn: 3600,
          endpoint: 'public',
          responseContentDisposition: `attachment; filename="Introdu__o.mp4"; filename*=UTF-8''Introdu%C3%A7%C3%A3o.mp4`,
        },
      );
    });
  });
});
