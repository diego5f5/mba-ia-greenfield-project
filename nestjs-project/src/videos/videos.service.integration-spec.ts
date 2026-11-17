import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadPartsException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
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
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    storage = module.get(StorageService);
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
});
