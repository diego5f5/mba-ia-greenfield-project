import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoMetadata, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 ** 3;

function driverCode(error: unknown): string | undefined {
  return error instanceof QueryFailedError
    ? (error.driverError as { code?: string }).code
    : undefined;
}

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `owner${n}`,
        nickname: `owner${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, publicId: string): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      public_id: publicId,
      channel_id: channelId,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      file_size_bytes: 1048576,
      source_key: `videos/${id}/source`,
    });
  }

  it('should persist a video without status as draft and keep the service-generated id', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, 'AbCdEfGhIjK');

    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.upload_id).toBeNull();
    expect(stored.thumbnail_key).toBeNull();
    expect(stored.created_at).toBeInstanceOf(Date);
  });

  it('should enforce a unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'duplicate01'));

    const error: unknown = await videoRepository
      .save(buildVideo(channel.id, 'duplicate01'))
      .catch((e: unknown) => e);

    expect(driverCode(error)).toBe('23505');
  });

  it('should reject a video whose channel does not exist', async () => {
    const error: unknown = await videoRepository
      .save(buildVideo(randomUUID(), 'orphanVideo'))
      .catch((e: unknown) => e);

    expect(driverCode(error)).toBe('23503');
  });

  it('should read a 10 GiB file_size_bytes back as a number', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, 'bigFile0001');
    video.file_size_bytes = TEN_GIB;
    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });

    expect(stored.file_size_bytes).toBe(TEN_GIB);
    expect(typeof stored.file_size_bytes).toBe('number');
  });

  it('should round-trip jsonb metadata and processing fields', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, 'metadata001');
    const metadata: VideoMetadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 4500000,
      size_bytes: 1048576,
    };
    Object.assign(video, {
      status: VideoStatus.READY,
      metadata,
      duration_seconds: 12.5,
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
      processed_at: new Date(),
    });
    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });

    expect(stored.metadata).toEqual(metadata);
    expect(stored.duration_seconds).toBe(12.5);
    expect(stored.status).toBe(VideoStatus.READY);
  });

  it('should load the owning channel through the relation', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel.id, 'relation001'),
    );

    const stored = await videoRepository.findOneOrFail({
      where: { id: video.id },
      relations: { channel: true },
    });

    expect(stored.channel.id).toBe(channel.id);
  });
});
