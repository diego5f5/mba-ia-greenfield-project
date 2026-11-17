---
libs:
  "@aws-sdk/client-s3":
    version: "3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T09:25:27-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T09:25:27-03:00"
  "bullmq":
    version: "6.5.4"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-17T09:25:27-03:00"
  "@nestjs/bullmq":
    version: "12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-17T09:25:27-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T09:24:06-03:00"
---

# Library References — Phase 03 (videos)

Versions are pinned to the newest release published at least two weeks before this fetch (supply-chain hygiene); install them **exactly** (`npm install --save-exact`) inside the `nestjs-api` container. Peer compatibility checked via `npm view`: `@nestjs/bullmq@12.0.0` peers `@nestjs/common|core ^10 || ^11 || ^12` and `bullmq ^3–^6` — compatible with the installed NestJS 11. FFmpeg/ffprobe are OS packages (Debian `ffmpeg` in the dev image), not npm dependencies (`phase-03-videos/TD-08`).

### @aws-sdk/client-s3

Used by `phase-03-videos/TD-01`, TD-02, TD-03, TD-05, TD-08, TD-10.

- **S3-compatible endpoint (MinIO):** construct `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. `forcePathStyle` (v2's `s3ForcePathStyle`) is required for MinIO so the bucket goes in the path (`http://minio:9000/{bucket}/{key}`), not in the hostname.
- **Checksums:** `requestChecksumCalculation` / `responseChecksumValidation` accept `WHEN_SUPPORTED` (default) or `WHEN_REQUIRED`. `UploadPartCommand` has `requestChecksumRequired: false`, so with `WHEN_REQUIRED` no checksum header is computed/signed into presigned part URLs — set `requestChecksumCalculation: 'WHEN_REQUIRED'` on the client used for presigning so browsers/`curl` can `PUT` raw bytes (TD-01).
- **Two clients (TD-02):** one client with `endpoint = S3_ENDPOINT` (internal, `http://minio:9000`) for every network call; a second client with `endpoint = S3_PUBLIC_ENDPOINT` used only by `getSignedUrl` for client-facing URLs (signing is local; it makes no network call).
- **Multipart commands (TD-05/TD-06):**
  - `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`.
  - `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — presigned, never sent by the API. `PartNumber` is 1..10,000; parts are 5 MiB–5 GiB except the last.
  - `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` — an invalid/missing part answers HTTP 400.
  - `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
  - `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType` (size/type verification at completion).
  - `PutObjectCommand({ Bucket, Key, Body, ContentType })` (worker uploads the thumbnail JPEG).
- **GetObject response overrides (TD-10):** `GetObjectCommand` accepts `ResponseContentDisposition` / `ResponseContentType`; per the S3 API these overrides only work on signed requests — which presigned URLs are.

### @aws-sdk/s3-request-presigner

Used by `phase-03-videos/TD-05` (part URLs), TD-08 (worker input URL), TD-10 (stream/download URLs).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

const partUrl = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);
const downloadUrl = await getSignedUrl(
  publicClient,
  new GetObjectCommand({
    Bucket,
    Key,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
  }),
  { expiresIn: 900 },
);
```

- `expiresIn` is in seconds; default **900**.
- `x-amz-*` headers are hoisted to the query string unless listed in `unhoistableHeaders` — keep the defaults (no extra signed headers) so a plain `PUT`/`GET` works.

### bullmq

Used by `phase-03-videos/TD-04`, TD-06, TD-11.

- **Retries:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay } })` — exponential retries after `2^(attempt-1) * delay` ms.
- **Non-retryable failures:** `throw new UnrecoverableError(msg)` (from `bullmq`) inside the processor moves the job to failed **without** retries, overriding `attempts` (TD-11 invalid-media path).
- **Idempotent enqueue:** `{ jobId: customId }` — a job with an existing id is ignored, so `jobId = videoId` makes repeated completion calls safe. Custom ids must not contain `:` nor be digit-only (a UUID qualifies). Caveat: if `removeOnComplete`/`removeOnFail` deletes the job, the same id can be added again.
- **Final-failure detection:** in the `failed` worker event, compare `job.attemptsMade` with `job.opts.attempts` (or the error being `UnrecoverableError`) before marking the video `failed`.
- **Connections:** for workers, ioredis `maxRetriesPerRequest` must be `null` (BullMQ sets it by default when it creates the connection from `{ host, port }`).

### @nestjs/bullmq

Used by `phase-03-videos/TD-04`, TD-07.

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
BullModule.registerQueue({
  name: VIDEO_PROCESSING_QUEUE,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
});
```

- **Producer:** `constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}` then `this.queue.add(name, data, { jobId })`.
- **Consumer:** `@Processor(VIDEO_PROCESSING_QUEUE)` on a class that `extends WorkerHost` and implements `async process(job: Job): Promise<unknown>`; errors thrown in `process()` fail the job and are retried per `attempts`/`backoff`, without crashing the module. Worker options (e.g., `{ concurrency }`) go in the decorator's second argument.
- **Events:** `@OnWorkerEvent('failed') onFailed(job: Job, err: Error)` / `@OnWorkerEvent('completed')` inside the processor class (bound to its Worker; skipped on request-scoped processors).
- **`worker` getter** is only available after module init (use `onApplicationBootstrap`, not the constructor).
- **Separate process (TD-07):** registering the `@Processor` provider only in the worker's module (bootstrapped with `NestFactory.createApplicationContext`) keeps the API process a pure producer.
