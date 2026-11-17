import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

const ONE_MIB = 1024 * 1024;
const PASSWORD = 'password123';

interface VideoRow {
  id: string;
  status: string;
  upload_id: string | null;
  source_key: string;
  channel_id: string;
}

interface CreatedVideoBody {
  public_id: string;
  status: string;
  title: string;
  original_file_name: string;
  file_size_bytes: number;
  thumbnail_url: string | null;
  upload: { part_size: number; part_count: number };
}

interface PartUrlsBody {
  parts: { part_number: number; url: string }[];
  expires_in: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

// supertest types `res.body` as `any`; narrow it to the documented contract.
function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

function getMailService(authService: AuthService): MailService {
  return (authService as unknown as { mailService: MailService }).mailService;
}

/** Validation errors arrive as a list of messages; join them for matching. */
function messageOf(res: request.Response): string {
  return [bodyOf<{ message: string | string[] }>(res).message].flat().join(' ');
}

describe('Videos upload (e2e)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let storage: StorageService;
  let ownerToken: string;
  let otherToken: string;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    // Tests run inside the Compose network, where the host-facing public
    // endpoint (localhost:9000) is not reachable.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await cleanAllTables(dataSource);
    await app.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin('owner@example.com');
    otherToken = await registerConfirmAndLogin('other@example.com');
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    // AuthService keeps MailService private; reach it to capture the raw
    // confirmation token that is only ever delivered by e-mail.
    const mailService = getMailService(app.get(AuthService));
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email: string, _name: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return bodyOf<{ access_token: string }>(login).access_token;
  }

  async function createVideo(
    token: string,
    body: object = {
      file_name: 'aula.mp4',
      file_size: ONE_MIB,
      content_type: 'video/mp4',
    },
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function startUpload(): Promise<string> {
    const res = await createVideo(ownerToken);
    const publicId = bodyOf<CreatedVideoBody>(res).public_id;
    const row = await videoRow(publicId);
    createdKeys.push(row.source_key);
    return publicId;
  }

  async function videoRow(publicId: string): Promise<VideoRow> {
    const rows: VideoRow[] = await dataSource.query(
      'SELECT id, status, upload_id, source_key, channel_id FROM videos WHERE public_id = $1',
      [publicId],
    );
    return rows[0];
  }

  async function uploadPart(publicId: string): Promise<string> {
    const urls = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [1] });
    const { url } = bodyOf<PartUrlsBody>(urls).parts[0];
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(ONE_MIB, 7)),
    });
    expect(put.status).toBe(200);
    return put.headers.get('etag')!;
  }

  describe('POST /videos', () => {
    it('creates a draft video with the part plan', async () => {
      const res = await createVideo(ownerToken);

      expect(res.status).toBe(201);
      const body = bodyOf<CreatedVideoBody>(res);
      expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body).toMatchObject({
        status: 'draft',
        title: 'aula',
        original_file_name: 'aula.mp4',
        file_size_bytes: ONE_MIB,
        thumbnail_url: null,
        upload: { part_size: 67108864, part_count: 1 },
      });

      const row = await videoRow(body.public_id);
      createdKeys.push(row.source_key);
      const channel: { id: string }[] = await dataSource.query(
        `SELECT c.id FROM channels c JOIN users u ON u.id = c.user_id WHERE u.email = 'owner@example.com'`,
      );
      expect(row.status).toBe('draft');
      expect(row.upload_id).not.toBeNull();
      expect(row.source_key).toBe(`videos/${row.id}/source`);
      expect(row.channel_id).toBe(channel[0].id);
    });

    it('rejects a size above 10 GiB and a non-video content type', async () => {
      const tooBig = await createVideo(ownerToken, {
        file_name: 'aula.mp4',
        file_size: 10737418241,
        content_type: 'video/mp4',
      });
      expect(tooBig.status).toBe(400);
      expect(bodyOf<ErrorBody>(tooBig).error).toBe('VALIDATION_ERROR');
      expect(messageOf(tooBig)).toContain('file_size');

      const notVideo = await createVideo(ownerToken, {
        file_name: 'aula.png',
        file_size: ONE_MIB,
        content_type: 'image/png',
      });
      expect(notVideo.status).toBe(400);
      expect(bodyOf<ErrorBody>(notVideo).error).toBe('VALIDATION_ERROR');
      expect(messageOf(notVideo)).toContain('content_type');

      const rows: unknown[] = await dataSource.query('SELECT 1 FROM videos');
      expect(rows).toHaveLength(0);
    });

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        file_name: 'aula.mp4',
        file_size: ONE_MIB,
        content_type: 'video/mp4',
      });

      expect(res.status).toBe(401);
      const rows: unknown[] = await dataSource.query('SELECT 1 FROM videos');
      expect(rows).toHaveLength(0);
    });
  });

  describe('POST /videos/:public_id/upload/parts', () => {
    it('issues a URL that accepts the part PUT straight on the storage', async () => {
      const publicId = await startUpload();

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ part_numbers: [1] });

      expect(res.status).toBe(200);
      const body = bodyOf<PartUrlsBody>(res);
      expect(body.expires_in).toBe(3600);
      expect(body.parts).toHaveLength(1);
      expect(body.parts[0].part_number).toBe(1);

      const put = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(ONE_MIB, 7)),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    });

    it('answers 404 VIDEO_NOT_FOUND to a user who does not own the video', async () => {
      const publicId = await startUpload();

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] });

      expect(res.status).toBe(404);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('POST /videos/:public_id/upload/completion', () => {
    it('completes the upload, queues the processing and is idempotent', async () => {
      const publicId = await startUpload();
      const etag = await uploadPart(publicId);
      const send = () =>
        request(app.getHttpServer())
          .post(`/videos/${publicId}/upload/completion`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ parts: [{ part_number: 1, etag }] });

      const first = await send();

      expect(first.status).toBe(202);
      expect(bodyOf<{ status: string }>(first).status).toBe('processing');
      const { id } = await videoRow(publicId);
      const job = await queue.getJob(id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: id });

      const second = await send();

      expect(second.status).toBe(200);
      expect(bodyOf<{ public_id: string }>(second).public_id).toBe(publicId);
      expect(await queue.getJob(id)).toBeDefined();
    });

    it('answers 404 VIDEO_NOT_FOUND to a user who does not own the video', async () => {
      const publicId = await startUpload();

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/completion`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ part_number: 1, etag: '"abc"' }] });

      expect(res.status).toBe(404);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
      expect((await videoRow(publicId)).status).toBe('draft');
    });
  });

  describe('OpenAPI document', () => {
    it('documents the three upload routes under the videos tag', () => {
      const document = buildSwaggerDocument(app);
      const paths = document.paths;
      const operations = {
        '/videos': {
          operation: paths['/videos']?.post,
          statuses: ['201', '400', '401'],
        },
        '/videos/{public_id}/upload/parts': {
          operation: paths['/videos/{public_id}/upload/parts']?.post,
          statuses: ['200', '400', '401', '404', '409'],
        },
        '/videos/{public_id}/upload/completion': {
          operation: paths['/videos/{public_id}/upload/completion']?.post,
          statuses: ['200', '202', '400', '401', '404', '422'],
        },
      };

      for (const [path, { operation, statuses }] of Object.entries(
        operations,
      )) {
        expect({ path, defined: operation !== undefined }).toEqual({
          path,
          defined: true,
        });
        expect(operation!.tags).toContain('videos');
        expect(Object.keys(operation!.responses)).toEqual(
          expect.arrayContaining(statuses),
        );
        for (const status of statuses.filter((s) => Number(s) >= 400)) {
          expect(JSON.stringify(operation!.responses[status])).toContain(
            'ApiErrorEnvelope',
          );
        }
      }
    });
  });
});
