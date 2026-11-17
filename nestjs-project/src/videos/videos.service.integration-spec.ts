import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadPartsException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 ** 3;

function dto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    file_name: 'aula.mp4',
    file_size: 1048576,
    content_type: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService — upload start (integration, Postgres + MinIO)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    // Tests run inside the Compose network, where the host-facing public
    // endpoint (localhost:9000) is not reachable.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queueCfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: queueCfg.host, port: queueCfg.port },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await module.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `vsvc${n}`,
        nickname: `vsvc${n}`,
        user_id: user.id,
      }),
    );
    return user;
  }

  async function storedVideo(publicId: string): Promise<Video> {
    return videoRepository.findOneOrFail({
      where: { public_id: publicId },
      relations: { channel: true },
    });
  }

  /** Cleans up the multipart upload a test left open in MinIO. */
  async function abortUpload(publicId: string): Promise<void> {
    const video = await storedVideo(publicId);
    if (video.upload_id) {
      await storage.abortMultipartUpload(video.source_key, video.upload_id);
    }
  }

  describe('createVideo', () => {
    it('persists a draft with the multipart upload and the default title', async () => {
      const user = await createUserWithChannel();

      const result = await service.createVideo(user.id, dto());

      expect(result).toMatchObject({
        status: VideoStatus.DRAFT,
        title: 'aula',
        original_file_name: 'aula.mp4',
        file_size_bytes: 1048576,
        thumbnail_url: null,
        upload: { part_size: 67108864, part_count: 1 },
      });
      expect(result.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);

      const video = await storedVideo(result.public_id);
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.upload_id).toBeTruthy();
      expect(video.source_key).toBe(`videos/${video.id}/source`);
      expect(video.channel.user_id).toBe(user.id);
      await abortUpload(result.public_id);
    });

    it('plans 160 parts for a 10 GiB file', async () => {
      const user = await createUserWithChannel();

      const result = await service.createVideo(
        user.id,
        dto({ file_name: 'grande.mkv', file_size: TEN_GIB }),
      );

      expect(result.upload).toEqual({ part_size: 67108864, part_count: 160 });
      expect((await storedVideo(result.public_id)).file_size_bytes).toBe(
        TEN_GIB,
      );
      await abortUpload(result.public_id);
    });

    it('generates distinct public ids and storage keys per video', async () => {
      const user = await createUserWithChannel();

      const first = await service.createVideo(user.id, dto());
      const second = await service.createVideo(user.id, dto());

      expect(first.public_id).not.toBe(second.public_id);
      const [a, b] = await Promise.all([
        storedVideo(first.public_id),
        storedVideo(second.public_id),
      ]);
      expect(a.source_key).not.toBe(b.source_key);
      await abortUpload(first.public_id);
      await abortUpload(second.public_id);
    });

    it('aborts the multipart upload in storage and persists nothing when the insert fails', async () => {
      const user = await createUserWithChannel();
      const createSpy = jest.spyOn(storage, 'createMultipartUpload');
      const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');
      jest
        .spyOn(videoRepository, 'save')
        .mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.createVideo(user.id, dto())).rejects.toThrow(
        'database unavailable',
      );

      expect(await videoRepository.count()).toBe(0);
      const uploadId = await (createSpy.mock.results[0]
        .value as Promise<string>);
      const sourceKey = createSpy.mock.calls[0][0];
      expect(abortSpy).toHaveBeenCalledWith(sourceKey, uploadId);

      // A real abort means storage no longer knows this upload id.
      const partUrl = await storage.presignUploadPart(
        sourceKey,
        uploadId,
        1,
        300,
      );
      const response = await fetch(partUrl, {
        method: 'PUT',
        body: new Uint8Array(10),
      });
      expect(response.status).toBe(404);
    });
  });

  describe('requestUploadPartUrls', () => {
    it('issues part URLs that accept a PUT straight into storage', async () => {
      const user = await createUserWithChannel();
      const { public_id } = await service.createVideo(user.id, dto());

      const { parts, expires_in } = await service.requestUploadPartUrls(
        user.id,
        public_id,
        [1],
      );

      expect(expires_in).toBe(3600);
      expect(parts).toHaveLength(1);
      expect(parts[0].part_number).toBe(1);
      const response = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(1024),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeTruthy();
      await abortUpload(public_id);
    });

    it('answers VIDEO_NOT_FOUND to a user who does not own the video', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const { public_id } = await service.createVideo(owner.id, dto());

      await expect(
        service.requestUploadPartUrls(other.id, public_id, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.requestUploadPartUrls(owner.id, 'doesNotExist', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await abortUpload(public_id);
    });

    it('answers UPLOAD_NOT_IN_PROGRESS once the video left draft', async () => {
      const user = await createUserWithChannel();
      const { public_id } = await service.createVideo(user.id, dto());
      await abortUpload(public_id);
      await videoRepository.update(
        { public_id },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );

      await expect(
        service.requestUploadPartUrls(user.id, public_id, [1]),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });

    it('answers INVALID_UPLOAD_PARTS for a part beyond part_count', async () => {
      const user = await createUserWithChannel();
      const { public_id } = await service.createVideo(user.id, dto());

      await expect(
        service.requestUploadPartUrls(user.id, public_id, [1, 2]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      await abortUpload(public_id);
    });
  });

  describe('completeUpload', () => {
    const createdVideoIds: string[] = [];

    afterEach(async () => {
      // Drop the jobs these tests created so they do not leak into the queue.
      await Promise.all(createdVideoIds.map((id) => queue.remove(id)));
      createdVideoIds.length = 0;
    });

    /** Uploads `size` bytes as part 1 straight to storage; returns its ETag. */
    async function uploadSinglePart(
      userId: string,
      publicId: string,
      size: number,
    ): Promise<string> {
      const { parts } = await service.requestUploadPartUrls(
        userId,
        publicId,
        [1],
      );
      const response = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(size),
      });
      expect(response.status).toBe(200);
      return response.headers.get('etag')!;
    }

    async function startUpload(
      userId: string,
      declaredSize: number,
    ): Promise<{ publicId: string; id: string; sourceKey: string }> {
      const { public_id } = await service.createVideo(
        userId,
        dto({ file_size: declaredSize }),
      );
      const video = await storedVideo(public_id);
      createdVideoIds.push(video.id);
      return { publicId: public_id, id: video.id, sourceKey: video.source_key };
    }

    it('moves the video to processing and enqueues process-video keyed by the video id', async () => {
      const user = await createUserWithChannel();
      const { publicId, id } = await startUpload(user.id, 1024);
      const etag = await uploadSinglePart(user.id, publicId, 1024);

      const result = await service.completeUpload(user.id, publicId, [
        { part_number: 1, etag },
      ]);

      expect(result.transitioned).toBe(true);
      expect(result.video.status).toBe(VideoStatus.PROCESSING);
      // Not asserting `status` in the database: the video-worker service of
      // the Compose stack may already be consuming the job.
      expect((await storedVideo(publicId)).upload_id).toBeNull();
      const job = await queue.getJob(id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: id });
      expect(job?.opts.attempts).toBe(3);
    });

    it('is idempotent: a second completion touches neither storage nor the queue', async () => {
      const user = await createUserWithChannel();
      const { publicId } = await startUpload(user.id, 1024);
      const etag = await uploadSinglePart(user.id, publicId, 1024);
      const completeSpy = jest.spyOn(storage, 'completeMultipartUpload');
      const addSpy = jest.spyOn(queue, 'add');
      const parts = [{ part_number: 1, etag }];

      const first = await service.completeUpload(user.id, publicId, parts);
      const second = await service.completeUpload(user.id, publicId, parts);

      expect(first.transitioned).toBe(true);
      expect(second.transitioned).toBe(false);
      expect(second.video.public_id).toBe(publicId);
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(addSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects a wrong ETag, keeps the video draft and accepts a corrected retry', async () => {
      const user = await createUserWithChannel();
      const { publicId, id } = await startUpload(user.id, 1024);
      const etag = await uploadSinglePart(user.id, publicId, 1024);

      await expect(
        service.completeUpload(user.id, publicId, [
          { part_number: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      const afterFailure = await storedVideo(publicId);
      expect(afterFailure.status).toBe(VideoStatus.DRAFT);
      expect(afterFailure.upload_id).toBeTruthy();
      expect(await queue.getJob(id)).toBeUndefined();

      const retry = await service.completeUpload(user.id, publicId, [
        { part_number: 1, etag },
      ]);
      expect(retry.transitioned).toBe(true);
    });

    it('fails the video and removes the object when the assembled size differs from the declared one', async () => {
      const user = await createUserWithChannel();
      const { publicId, id, sourceKey } = await startUpload(user.id, 2048);
      const etag = await uploadSinglePart(user.id, publicId, 1024);

      await expect(
        service.completeUpload(user.id, publicId, [{ part_number: 1, etag }]),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const video = await storedVideo(publicId);
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.processing_error).toBe('UPLOAD_SIZE_MISMATCH');
      expect(video.upload_id).toBeNull();
      await expect(storage.headObject(sourceKey)).resolves.toBeNull();
      expect(await queue.getJob(id)).toBeUndefined();
    });

    it('answers VIDEO_NOT_FOUND to a user who does not own the video and leaves it untouched', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const { publicId } = await startUpload(owner.id, 1024);
      const etag = await uploadSinglePart(owner.id, publicId, 1024);

      await expect(
        service.completeUpload(other.id, publicId, [{ part_number: 1, etag }]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect((await storedVideo(publicId)).status).toBe(VideoStatus.DRAFT);
      await abortUpload(publicId);
    });
  });
});
