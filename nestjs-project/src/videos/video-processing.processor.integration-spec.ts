import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createInvalidVideoFixture,
  createValidVideoFixture,
  FIXTURE_DURATION_SECONDS,
} from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { ProcessVideoJobData } from './video-processing.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// The processor is instantiated without a BullMQ Worker: `process()` and
// `onFailed()` are called directly, so the live `video-worker` service in the
// Compose stack cannot interfere with these tests.
describe('VideoProcessingProcessor (integration, Postgres + MinIO + FFmpeg)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let module: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;
  const createdKeys: string[] = [];
  let counter = 0;

  function buildJob(videoId: string): Job<ProcessVideoJobData> {
    return {
      data: { videoId },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as unknown as Job<ProcessVideoJobData>;
  }

  async function createProcessingVideo(
    sourceBody: Buffer,
    status: VideoStatus = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    createdKeys.push(sourceKey, `videos/${id}/thumbnail.jpg`);
    await storage.putObject(sourceKey, sourceBody, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `proc${String(++counter).padStart(7, '0')}`,
        channel_id: channelId,
        title: 'aula',
        status,
        original_file_name: 'aula.mp4',
        content_type: 'video/mp4',
        file_size_bytes: sourceBody.length,
        source_key: sourceKey,
      }),
    );
  }

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
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
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingProcessor],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await cleanAllTables(dataSource);
    await module.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: 'processor@example.com',
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'proc',
        nickname: 'proc',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  it('turns a valid upload into a ready video with metadata and thumbnail', async () => {
    const video = await createProcessingVideo(await createValidVideoFixture());

    await processor.process(buildJob(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThan(
      FIXTURE_DURATION_SECONDS - 0.1,
    );
    expect(processed.duration_seconds).toBeLessThan(
      FIXTURE_DURATION_SECONDS + 0.1,
    );
    expect(processed.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(processed.processing_error).toBeNull();
    expect(processed.processed_at).toBeInstanceOf(Date);

    const thumbnail = await storage.headObject(processed.thumbnail_key!);
    expect(thumbnail?.contentType).toBe('image/jpeg');
    expect(thumbnail!.contentLength).toBeGreaterThan(0);
  });

  it('does not touch a video that is already ready when the job is redelivered', async () => {
    const video = await createProcessingVideo(await createValidVideoFixture());
    await processor.process(buildJob(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });
    const firstThumbnail = await storage.headObject(first.thumbnail_key!);

    await processor.process(buildJob(video.id));

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.processed_at).toEqual(first.processed_at);
    expect(second.updated_at).toEqual(first.updated_at);
    expect(await storage.headObject(second.thumbnail_key!)).toEqual(
      firstThumbnail,
    );
  });

  it('fails an invalid file with an UnrecoverableError and marks the video failed', async () => {
    const video = await createProcessingVideo(createInvalidVideoFixture());

    const error: unknown = await processor
      .process(buildJob(video.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    // `process()` leaves the row untouched; the failed handler persists it.
    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.PROCESSING);

    await processor.onFailed(buildJob(video.id), error as Error);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toContain('Invalid media');
    expect(failed.processed_at).toBeInstanceOf(Date);
    expect(failed.thumbnail_key).toBeNull();
  });

  it('does not overwrite a video that is not processing when a failure arrives late', async () => {
    const video = await createProcessingVideo(
      await createValidVideoFixture(),
      VideoStatus.READY,
    );

    await processor.onFailed(
      buildJob(video.id),
      new UnrecoverableError('late failure'),
    );

    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.READY);
  });
});
