import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createValidVideoFixture } from '../src/test/video-fixture';
import { WorkerModule } from '../src/worker.module';

const PASSWORD = 'password123';
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

interface VideoBody {
  public_id: string;
  status: string;
  duration_seconds: number | null;
  metadata: { width: number; height: number; video_codec: string } | null;
  thumbnail_url: string | null;
}

interface ErrorBody {
  error: string;
}

// supertest types `res.body` as `any`; narrow it to the documented contract.
function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

function getMailService(authService: AuthService): MailService {
  return (authService as unknown as { mailService: MailService }).mailService;
}

describe('Videos delivery (e2e)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let fixture: Buffer;
  let ownerToken: string;
  let otherToken: string;

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

    // Same code the `video-worker` service runs: consumes `process-video`.
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    fixture = await createValidVideoFixture();
  }, 60_000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await worker.close();
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

  function authed(token: string, method: 'get' | 'post', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  }

  async function createDraft(fileName: string, size: number): Promise<string> {
    const res = await authed(ownerToken, 'post', '/videos').send({
      file_name: fileName,
      file_size: size,
      content_type: 'video/mp4',
    });
    return bodyOf<{ public_id: string }>(res).public_id;
  }

  /** Create → PUT the single part straight on the storage → complete. */
  async function uploadVideo(
    fileName = 'aula.mp4',
    buffer: Buffer = fixture,
  ): Promise<string> {
    const publicId = await createDraft(fileName, buffer.length);
    const parts = await authed(
      ownerToken,
      'post',
      `/videos/${publicId}/upload/parts`,
    ).send({ part_numbers: [1] });
    const { url } = bodyOf<{ parts: { url: string }[] }>(parts).parts[0];
    const put = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(buffer),
    });
    const etag = put.headers.get('etag')!;
    await authed(
      ownerToken,
      'post',
      `/videos/${publicId}/upload/completion`,
    ).send({ parts: [{ part_number: 1, etag }] });
    return publicId;
  }

  async function waitForStatus(
    publicId: string,
    status: string,
  ): Promise<VideoBody> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const res = await authed(ownerToken, 'get', `/videos/${publicId}`);
      const body = bodyOf<VideoBody>(res);
      if (body.status === status || Date.now() > deadline) {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  afterEach(async () => {
    // Objects of every video created in the test.
    const rows: { source_key: string; thumbnail_key: string | null }[] =
      await dataSource.query('SELECT source_key, thumbnail_key FROM videos');
    for (const { source_key, thumbnail_key } of rows) {
      await storage.deleteObject(source_key);
      if (thumbnail_key) {
        await storage.deleteObject(thumbnail_key);
      }
    }
  });

  describe('full flow: upload → automatic processing → query, stream, download', () => {
    it(
      'shows the video ready with metadata and a servable thumbnail',
      async () => {
        const publicId = await uploadVideo();

        const early = await authed(ownerToken, 'get', `/videos/${publicId}`);
        expect(early.status).toBe(200);
        expect(['processing', 'ready']).toContain(
          bodyOf<VideoBody>(early).status,
        );

        const video = await waitForStatus(publicId, 'ready');

        expect(video.status).toBe('ready');
        expect(video.duration_seconds).toBeGreaterThan(2.9);
        expect(video.duration_seconds).toBeLessThan(3.1);
        expect(video.metadata).toMatchObject({
          width: 320,
          height: 240,
          video_codec: 'h264',
        });
        expect(video.thumbnail_url).not.toBeNull();
        const thumbnail = await fetch(video.thumbnail_url!);
        expect(thumbnail.status).toBe(200);
        expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
        await thumbnail.arrayBuffer();
      },
      READY_TIMEOUT_MS + 10_000,
    );

    it(
      'redirects the stream to the storage, which honors Range with 206',
      async () => {
        const publicId = await uploadVideo();
        await waitForStatus(publicId, 'ready');

        const res = await authed(
          ownerToken,
          'get',
          `/videos/${publicId}/stream`,
        );

        expect(res.status).toBe(302);
        const location = res.headers['location'];
        const rows: { id: string }[] = await dataSource.query(
          'SELECT id FROM videos WHERE public_id = $1',
          [publicId],
        );
        const { id } = rows[0];
        expect(new URL(location).host).toBe(
          new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
        );
        expect(new URL(location).pathname).toContain(`videos/${id}/source`);

        const ranged = await fetch(location, {
          headers: { Range: 'bytes=0-1023' },
        });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get('content-range')).toBe(
          `bytes 0-1023/${fixture.length}`,
        );
        expect(ranged.headers.get('content-type')).toBe('video/mp4');
        expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
      },
      READY_TIMEOUT_MS + 10_000,
    );

    it(
      'redirects the download to a storage URL that forces an attachment',
      async () => {
        const publicId = await uploadVideo('aula de vídeo.mp4');
        await waitForStatus(publicId, 'ready');

        const res = await authed(
          ownerToken,
          'get',
          `/videos/${publicId}/download`,
        );

        expect(res.status).toBe(302);
        const file = await fetch(res.headers['location']);
        expect(file.status).toBe(200);
        expect(file.headers.get('content-disposition')).toMatch(/^attachment/);
        expect(file.headers.get('content-disposition')).toContain(
          `filename*=UTF-8''aula%20de%20v%C3%ADdeo.mp4`,
        );
        expect((await file.arrayBuffer()).byteLength).toBe(fixture.length);
      },
      READY_TIMEOUT_MS + 10_000,
    );
  });

  describe('availability and access rules', () => {
    it('refuses stream and download while the video is not ready', async () => {
      const publicId = await createDraft('aula.mp4', 1024);

      const video = await authed(ownerToken, 'get', `/videos/${publicId}`);
      expect(bodyOf<VideoBody>(video).status).toBe('draft');

      for (const route of ['stream', 'download']) {
        const res = await authed(
          ownerToken,
          'get',
          `/videos/${publicId}/${route}`,
        );
        expect(res.status).toBe(409);
        expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
        expect(res.headers['location']).toBeUndefined();
      }
    });

    it(
      'answers 404 VIDEO_NOT_FOUND to another user on the three routes, like an unknown id',
      async () => {
        const publicId = await uploadVideo();
        await waitForStatus(publicId, 'ready');

        for (const path of [
          `/videos/${publicId}`,
          `/videos/${publicId}/stream`,
          `/videos/${publicId}/download`,
        ]) {
          const res = await authed(otherToken, 'get', path);
          expect(res.status).toBe(404);
          expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
          expect(res.headers['location']).toBeUndefined();
        }

        const unknown = await authed(ownerToken, 'get', '/videos/AAAAAAAAAAA');
        expect(unknown.status).toBe(404);
        expect(bodyOf<ErrorBody>(unknown).error).toBe('VIDEO_NOT_FOUND');
      },
      READY_TIMEOUT_MS + 10_000,
    );

    it('requires authentication on the three routes', async () => {
      for (const path of [
        '/videos/AAAAAAAAAAA',
        '/videos/AAAAAAAAAAA/stream',
        '/videos/AAAAAAAAAAA/download',
      ]) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
      }
    });
  });
});
