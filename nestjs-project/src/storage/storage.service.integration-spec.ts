import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { MultipartUploadRejectedError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;
const URL_TTL_SECONDS = 300;

async function createStorageModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();
}

async function putPart(url: string, body: Buffer): Promise<string> {
  // Copy into an ArrayBuffer-backed view: fetch's BodyInit rejects Buffer types.
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration, MinIO)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const newKey = (): string => {
    const key = `test/storage/${randomUUID()}/object`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    // Tests run inside the Compose network: the host-facing public endpoint
    // (localhost:9000) is not reachable from the container.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    module = await createStorageModule();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  it('assembles an object uploaded in two parts through presigned part URLs', async () => {
    const key = newKey();
    const first = Buffer.alloc(FIVE_MIB, 'a');
    const second = Buffer.alloc(1000, 'b');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const etag1 = await putPart(
      await storage.presignUploadPart(key, uploadId, 1, URL_TTL_SECONDS),
      first,
    );
    const etag2 = await putPart(
      await storage.presignUploadPart(key, uploadId, 2, URL_TTL_SECONDS),
      second,
    );
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    await expect(storage.headObject(key)).resolves.toEqual({
      contentLength: first.length + second.length,
      contentType: 'video/mp4',
    });
  });

  it('returns null from headObject for a missing key', async () => {
    await expect(
      storage.headObject(`test/storage/${randomUUID()}/missing`),
    ).resolves.toBeNull();
  });

  it('serves a byte range through a presigned GET URL with 206', async () => {
    const key = newKey();
    await storage.putObject(key, Buffer.alloc(4096, 'x'), 'video/mp4');
    const url = await storage.presignGetObject(key, {
      expiresIn: URL_TTL_SECONDS,
      endpoint: 'public',
    });

    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('applies ResponseContentDisposition and ResponseContentType overrides', async () => {
    const key = newKey();
    await storage.putObject(key, Buffer.alloc(10, 'y'), 'video/mp4');
    const url = await storage.presignGetObject(key, {
      expiresIn: URL_TTL_SECONDS,
      endpoint: 'public',
      responseContentType: 'video/webm',
      responseContentDisposition: 'attachment; filename="clip.webm"',
    });

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.webm"',
    );
    expect(response.headers.get('content-type')).toBe('video/webm');
  });

  it('throws MultipartUploadRejectedError when a part ETag does not match', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await putPart(
      await storage.presignUploadPart(key, uploadId, 1, URL_TTL_SECONDS),
      Buffer.alloc(100, 'c'),
    );

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(MultipartUploadRejectedError);
    await expect(storage.headObject(key)).resolves.toBeNull();

    await storage.abortMultipartUpload(key, uploadId);
  });

  describe('endpoint used for signing', () => {
    const publicEndpoint = 'http://storage.public.example:9000';
    let signingModule: TestingModule;
    let signingStorage: StorageService;

    beforeAll(async () => {
      // Signing is a local computation, so an unreachable host is fine here.
      process.env.S3_PUBLIC_ENDPOINT = publicEndpoint;
      signingModule = await createStorageModule();
      signingStorage = signingModule.get(StorageService);
    });

    afterAll(async () => {
      await signingModule.close();
      process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    });

    it('signs part URLs with the public endpoint host', async () => {
      const url = await signingStorage.presignUploadPart(
        'videos/x/source',
        'upload-id',
        1,
        URL_TTL_SECONDS,
      );
      expect(new URL(url).host).toBe(new URL(publicEndpoint).host);
    });

    it('signs internal GET URLs with the internal endpoint host', async () => {
      const url = await signingStorage.presignGetObject('videos/x/source', {
        expiresIn: URL_TTL_SECONDS,
        endpoint: 'internal',
      });
      expect(new URL(url).host).toBe(new URL(process.env.S3_ENDPOINT!).host);
    });
  });
});
