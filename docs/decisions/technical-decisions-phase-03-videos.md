---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-17
scope_description: "Backend foundation for video upload and processing: object storage usage (client, endpoints, bucket layout), processing queue technology, 10GB direct-to-storage upload protocol, draft pre-registration and upload completion signal, video worker runtime, FFmpeg-based metadata/thumbnail extraction, unique public video identifier, streaming/download delivery, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (pre-registration, upload handshake, completion, stream/download endpoints), the object-storage integration, the queue producer, and the video worker (same codebase, separate process) plus the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no implementation in this phase: Phase 03 has no screen capability in `docs/project-plan.md`, and the video UI (player, download button) is delivered by Phase 05. The Cross-layer TDs below (TD-05, TD-06, TD-09, TD-10) fix the HTTP contracts the frontend will consume later; no frontend-only decision is open.

Object storage itself is **not** an open choice: `docs/diagrams/software-arch.mermaid` and `CLAUDE.md` already fix "S3 or MinIO" (MinIO locally in Docker, S3-compatible API, swappable for S3 in production). The TDs below decide **how** it is used. The genuinely open stack choice is the queue (`Message Queue — TBD` in the architecture diagram), covered by TD-04.

---

## TD-01: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API and the worker must talk to an S3-compatible endpoint (MinIO locally, S3 in production): create/complete/abort multipart uploads, presign part/GET URLs, `HeadObject`, `PutObject` for thumbnails. The library shapes portability between MinIO and S3 and how presigned URLs are produced.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official, modular AWS client; every S3 operation is a `Command`; `getSignedUrl(client, command, { expiresIn })` presigns any command (including `UploadPartCommand` and `GetObjectCommand`). Works against MinIO with `endpoint` + `forcePathStyle: true`.
- **Pros:** Same code runs against MinIO and real S3 (production swap is config-only). First-class TypeScript types. Presigns every operation the upload flow needs. Largest ecosystem/doc surface.
- **Cons:** Verbose (one command class per call). Recent SDK versions compute request checksums by default (`requestChecksumCalculation: WHEN_SUPPORTED`), which must be relaxed to `WHEN_REQUIRED` so presigned part URLs do not embed checksum headers the browser cannot reproduce.

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own S3-compatible client with a higher-level API (`presignedUrl`, `presignedGetObject`, `statObject`, `putObject`).
- **Pros:** Concise API, good MinIO-oriented docs, also speaks to AWS S3.
- **Cons:** Multipart-with-presigned-parts is not a first-class helper (requires the generic `presignedUrl` with manual `uploadId`/`partNumber` query params). Vendor-named dependency for a stack whose production target is S3. Smaller ecosystem around NestJS.

### Option C: Community NestJS S3 wrapper module (e.g., `nestjs-s3`)
- Thin Nest module that registers an AWS SDK v3 client as an injectable provider.
- **Pros:** Saves a few lines of provider wiring.
- **Cons:** Extra third-party layer over Option A with no capability gain; the project already wires providers via `registerAs` configs (Phase 01 TD-03), so the wrapper duplicates an existing pattern.

**Recommendation:** **Option A (AWS SDK v3)** — the production target is S3 and the dev target is MinIO; the official SDK is the only option where both are first-class and every operation of the upload flow (TD-05) can be presigned with the same API. The checksum default must be set to `WHEN_REQUIRED` on the client used for presigning.

**Decision:** _[pending]_

---

## TD-02: Storage Endpoint Topology for Presigned URLs (internal vs public)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Inside Docker the API and worker reach MinIO by its Compose service name (`CLAUDE.md` → Docker Networking: never `localhost`). But presigned URLs are consumed by clients **outside** the Compose network (browser, `curl` on the host), which cannot resolve that service name. A SigV4 signature covers the `Host`, so a URL signed for the internal host cannot simply be rewritten afterwards. This is a cross-component contract (env schema + `compose.yaml` + `.env.example` + storage provider).

**Options:**

### Option A: Two endpoints — internal for server-side calls, public for client-facing presigning
- `S3_ENDPOINT` (e.g., `http://minio:9000`) is used for every network call made by API/worker; `S3_PUBLIC_ENDPOINT` (e.g., `http://localhost:9000`) configures a second client used **only** to sign URLs handed to external clients (signing is a local computation — no network call to the public host). The worker signs its own reads with the internal endpoint.
- **Pros:** Respects the Docker networking rule; signatures are valid for the host the client actually calls; production maps cleanly (internal VPC endpoint vs public S3/CDN host). Pure configuration, no extra container.
- **Cons:** Two clients/configs to keep coherent; tests must assert which client signs which URL.

### Option B: Single endpoint reachable from both sides
- Use one hostname valid inside and outside Docker (e.g., `host.docker.internal`, or adding `minio` to the host's `hosts` file).
- **Pros:** One client, one env var.
- **Cons:** OS-dependent (`host.docker.internal` behaves differently on Linux), requires manual host setup, and routes container-to-container traffic through the host — contradicts the project's Docker networking rule.

### Option C: Reverse proxy in front of storage
- An extra proxy (e.g., Nginx) exposes storage under a stable public path and forwards to `minio:9000`.
- **Pros:** Single public origin; can unify with a future CDN.
- **Cons:** New container and config; must preserve the signed `Host` header exactly or SigV4 validation fails; more moving parts for no Phase 03 capability gain.

**Recommendation:** **Option A (internal + public endpoints)** — it is the only option that keeps service-to-service traffic on Compose service names while still issuing URLs the client can reach, with zero extra infrastructure. Env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, validated by the existing Joi schema (Phase 01 TD-02).

**Decision:** _[pending]_

---

## TD-03: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Video files and thumbnails need a storage layout that keeps keys collision-free, supports the access policy chosen in TD-10, and lets incomplete uploads be cleaned. The layout is referenced by the API (upload keys), the worker (thumbnail key), and the Compose bootstrap (bucket creation).

**Options:**

### Option A: Single private bucket, per-video prefix
- One bucket (name from `S3_BUCKET`), private (no anonymous read). Keys derived from the internal video UUID: `videos/{videoId}/source` (original upload) and `videos/{videoId}/thumbnail.jpg`. Every external access goes through presigned URLs.
- **Pros:** One bucket to provision and secure; keys are unique by construction (UUID) and independent of the public URL id (TD-09) and of the title (editable in Phase 04); deleting a video = deleting one prefix.
- **Cons:** Thumbnails also need presigned URLs (no direct public link).

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- Original files in a private bucket; thumbnails in a bucket with anonymous read.
- **Pros:** Thumbnails get stable, cacheable public URLs.
- **Cons:** Two buckets + two policies to provision; thumbnails of draft/unlisted videos (Phase 04) become publicly enumerable by URL; splits a video's assets across buckets.

### Option C: Single public-read bucket
- Everything readable anonymously; URLs are plain object URLs.
- **Pros:** Simplest delivery.
- **Cons:** Any draft becomes publicly downloadable once its key is known; no way to enforce Phase 04 visibility (unlisted) or ownership rules later.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/…`)** — it keeps every asset behind the API's authorization decision (needed for drafts now and unlisted videos in Phase 04) with a single provisioning step. The bucket is created by a one-shot `minio/mc` init service in `compose.yaml` (`mc mb --ignore-existing`). Incomplete multipart uploads are reclaimed by MinIO's stale-upload expiry (`api stale_uploads_expiry`, default 24h); on AWS S3 the equivalent is an `AbortIncompleteMultipartUpload` lifecycle rule.

**Decision:** _[pending]_

---

## TD-04: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the message queue as `TBD`. The API publishes one processing job per uploaded video; the worker consumes it, runs FFmpeg (minutes for large files), and must survive transient failures with retries. This is the phase's main stack decision; it adds a new Compose service and env keys.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue with an official NestJS integration: `BullModule.forRoot`/`registerQueue` on the producer, `@Processor()` + `WorkerHost.process()` on the consumer. Errors thrown in `process()` fail the job and trigger retries per `attempts`/`backoff`.
- **Pros:** Official Nest module (same pattern as the rest of the stack). Built-in retries with exponential backoff, `UnrecoverableError` to skip retries on permanent failures, per-job `jobId` for idempotent enqueue, concurrency control, delayed jobs. Redis is a small, single-purpose container.
- **Cons:** New infrastructure (Redis) to run and persist (AOF recommended so queued jobs survive restarts). Redis-specific; not a general-purpose message broker.

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- Dedicated AMQP broker; API publishes messages, worker consumes with manual ack.
- **Pros:** Mature broker, strong delivery guarantees, routing flexibility, good for future fan-out (e.g., multiple consumers per event).
- **Cons:** Retries with backoff and dead-lettering must be built from exchanges/TTL queues; heavier container and management surface; the Nest RMQ transport is an RPC/event abstraction, not a job queue (no job state, attempts or progress tracking out of the box).

### Option C: PostgreSQL-backed queue (`pg-boss`)
- Jobs stored in tables of the existing PostgreSQL; workers poll/lock with `SKIP LOCKED`.
- **Pros:** No new infrastructure; jobs can be enqueued in the same transaction as the video status change (transactional outbox for free).
- **Cons:** Puts queue polling load on the primary database; no official NestJS module; diverges from the target architecture, which models the queue as its own container.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option with an official NestJS integration that also provides job-queue semantics (attempts, backoff, unrecoverable errors, idempotent `jobId`) out of the box, which TD-11's failure policy depends on; Redis is a lightweight container that matches the separate "Message Queue" node of the architecture. Use `jobId = videoId` so a repeated completion never enqueues duplicate work. Env keys: `REDIS_HOST`, `REDIS_PORT`.

**Decision:** _[pending]_

---

## TD-05: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must be uploaded without holding the API (no buffering, no long-lived request occupying the API). The protocol defines a handshake that lives on both sides: backend endpoints/limits and the client's chunking/parallelism. AWS documents that a single PUT accepts at most 5 GB and that multipart uploads accept up to 10,000 parts of 5 MiB–5 GiB each.

**Options:**

### Option A: Direct-to-storage S3 multipart upload with presigned part URLs
- API creates the multipart upload and returns `uploadId`, part size and part count; the client requests presigned `UploadPart` URLs and `PUT`s each part **directly to storage** (in parallel, retrying individual parts); the client then calls the API to complete with the list of `{partNumber, ETag}`.
- **Pros:** Zero video bytes cross the API (only small JSON calls) — the API's performance is independent of file size. Parallel and retryable per part; resumable by re-requesting URLs for missing parts. Native S3 feature, identical on MinIO and S3.
- **Cons:** More complex client (chunking, ETag collection). Requires storage CORS to expose the `ETag` header for browser clients (Phase 05 concern). Part URLs expire, so long uploads need URLs issued on demand.

### Option B: tus resumable protocol through the API (`@tus/server` + `@tus/s3-store`)
- The API mounts a tus server; the client uses a tus client to `PATCH` chunks to the API, which streams them into an S3 multipart upload.
- **Pros:** Open resumable-upload standard with mature clients; resume semantics are part of the protocol.
- **Cons:** Every byte of the 10GB passes through the API process (network and CPU on the API for the whole upload) — contradicts "sem impacto na performance". No official NestJS integration (manual mounting on the Express adapter). Extra dependencies.

### Option C: Single presigned PUT URL
- API presigns one `PutObject`; the client uploads the whole file in one request.
- **Pros:** Simplest possible flow.
- **Cons:** S3 caps a single PUT at 5 GB — cannot meet the 10GB requirement. No resume: a network failure restarts the entire upload.

### Option D: `multipart/form-data` streamed through the API to storage
- The API receives the form upload and pipes it to storage (e.g., `@aws-sdk/lib-storage`).
- **Pros:** Conventional form upload; client is trivial.
- **Cons:** The full file flows through the API on a single long request; no resume; one slow upload holds a connection and bandwidth of the API — the anti-pattern the phase must avoid.

**Recommendation:** **Option A (presigned S3 multipart, direct to storage)** — it is the only option where the API never touches the video bytes and that supports 10GB natively on both MinIO and S3. Parameters: maximum size **10 GiB** (10 × 1024³ bytes) declared at initiation and verified at completion (`HeadObject`); server-defined part size **64 MiB** (≤ 160 parts for 10 GiB, well inside the 10,000-part limit and above the 5 MiB minimum); declared content type restricted to `video/*`; part URLs issued on demand with a bounded TTL.

**Decision:** _[pending]_

---

## TD-06: Draft Pre-registration and Upload Completion Signal

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video must exist as a draft as soon as the upload starts, and processing must start automatically when the upload ends. With a direct-to-storage upload (TD-05), the API does not see the bytes, so something must signal "upload finished" and trigger the job. The choice defines an endpoint (or not) on both sides. Depends on TD-04 and TD-05.

**Options:**

### Option A: Explicit completion call to the API
- Pre-registration: the same request that initiates the multipart upload inserts the video row (status `draft`, owner = caller's channel). Completion: the client calls the API with the parts list; the API runs `CompleteMultipartUpload`, verifies the object (`HeadObject` size/type), moves the video to `processing` and enqueues the job.
- **Pros:** Single authoritative path through the API — ownership, size checks and status transitions stay in the service layer. Provider-agnostic (same on MinIO and S3). Easy to test end-to-end with the real Compose services. Completion can be idempotent (repeated calls return the current state).
- **Cons:** If the client never calls completion, the video stays `draft` and the multipart is later expired by storage (TD-03).

### Option B: Storage event notification
- The client completes the multipart directly against storage (presigned `CompleteMultipartUpload`); MinIO publishes `s3:ObjectCreated:CompleteMultipartUpload` to Redis/AMQP, which triggers processing.
- **Pros:** Processing starts even if the client crashes right after completing; the API is not on the completion path.
- **Cons:** Provider-specific wiring (MinIO targets via `mc event add` vs S3 → SQS/EventBridge in production); size/type validation and the `draft → processing` transition move out of the API; harder to test and to keep in sync with the queue chosen in TD-04.

### Option C: Polling for finished uploads
- A scheduled job lists in-progress uploads/objects and starts processing when the object appears.
- **Pros:** No client cooperation needed.
- **Cons:** Latency equal to the poll interval, constant storage calls, extra scheduler component.

**Recommendation:** **Option A (pre-register on initiation + explicit completion endpoint)** — it keeps validation, ownership and the status machine (TD-11) inside the API, works identically on MinIO and S3, and is directly testable with the Compose stack; the abandoned-upload case is already bounded by storage-side expiry (TD-03).

**Decision:** _[pending]_

---

## TD-07: Video Worker Runtime

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate "Video Worker (FFmpeg)" container that consumes jobs, reads/writes storage and updates the database. FFmpeg is CPU-heavy; running it inside the API process would degrade request handling. The worker needs the same entities, config and storage access as the API.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- A second bootstrap (`NestFactory.createApplicationContext` on a worker module — no HTTP server) registers only the BullMQ processor; Compose runs it as its own service from the same image. The dev image installs FFmpeg so both the worker and the test runner (tests execute inside `nestjs-api`) have `ffprobe`/`ffmpeg`.
- **Pros:** Reuses entities, repositories, config (`registerAs`) and the storage provider — no duplication. Independent process/container: FFmpeg load never touches the API. Single lint/tsc/test toolchain.
- **Cons:** The image carries FFmpeg even for the API service (larger dev image); module boundaries must keep worker-only providers out of the API module.

### Option B: Processor inside the API process
- Register the BullMQ processor in the API's `AppModule`; the same process serves HTTP and runs FFmpeg.
- **Pros:** Simplest wiring; one service.
- **Cons:** CPU-bound FFmpeg competes with HTTP handling — contradicts "sem impacto na performance" and the separate worker container in the architecture; cannot scale workers independently.

### Option C: Independent worker subproject
- New `video-worker/` package (own `package.json`, possibly another language) consuming the queue.
- **Pros:** Full isolation; free choice of runtime.
- **Cons:** Duplicates entities, DB access, storage config and env validation; second toolchain to satisfy the Definition of Done; job payload contract must be kept in sync across codebases.

**Recommendation:** **Option A (same codebase, separate entrypoint/service)** — it delivers the process isolation the architecture requires while reusing every existing module and keeping one toolchain for tests, `tsc` and lint.

**Decision:** _[pending]_

---

## TD-08: Metadata Extraction and Thumbnail Generation Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration/metadata and extract one frame from files up to 10GB stored in object storage. Two sub-choices are coupled: how FFmpeg is invoked from Node, and how it accesses the input (copy 10GB locally vs read remotely).

**Options:**

### Option A: Invoke system `ffprobe`/`ffmpeg` directly via `child_process.execFile`, reading the input from a presigned URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` returns JSON parsed into typed metadata; `ffmpeg -ss <offset> -i <url> -frames:v 1 …` writes one JPEG to a temp file, then uploaded with `PutObject`. The URL is a short-lived presigned GET on the **internal** endpoint (TD-02); FFmpeg's HTTP input uses range requests, so only the needed bytes are read. Binaries come from the image's OS package.
- **Pros:** No wrapper dependency; `execFile` (no shell) avoids injection; JSON output is stable and fully typed on our side. No 10GB local copy or disk-space requirement in the worker.
- **Cons:** Must handle process exit codes/stderr ourselves; input seeking over HTTP depends on the storage honoring `Range` (S3/MinIO do).

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the same binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Familiar API, many examples.
- **Cons:** Deprecated on npm ("Package no longer supported") and archived upstream — unmaintained dependency for a core path.

### Option C: Bundled static binaries via npm (`ffmpeg-static` / `ffprobe-static`) + local download of the file
- Binaries shipped through `node_modules`; the worker downloads the object to disk before probing.
- **Pros:** No OS package in the image.
- **Cons:** Platform-specific binaries fetched at install time; downloading up to 10GB per job needs worker disk sized for the largest file and multiplies processing time.

**Recommendation:** **Option A (system FFmpeg via `execFile`, input from presigned internal URL)** — no unmaintained wrapper, no 10GB copy, and the parsed `ffprobe` JSON is fully typed under the project's strict TS rules. Policy: thumbnail frame at 10% of the duration (avoids black opening frames; `0s` when duration is unknown), JPEG scaled to 1280px width; persisted metadata = duration (seconds), width, height, video codec, audio codec, container format, bitrate, size.

**Decision:** _[pending]_

---

## TD-09: Unique Public Video Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, stable identifier used in URLs (API routes now; frontend watch page in Phase 05). It must never collide and should not change when the title is edited (Phase 04). It is a contract shared by backend routes and frontend links.

**Options:**

### Option A: Expose the UUID primary key
- URLs use the row's UUID (`/videos/3f2c…`).
- **Pros:** Zero extra column or code; uniqueness guaranteed.
- **Cons:** 36-character URLs; exposes the internal PK (and storage prefix, TD-03) to clients.

### Option B: Random short id generated with `node:crypto`, unique column + retry on collision
- `crypto.randomBytes(8)` → 11-char base64url string (64 bits) stored in a dedicated `public_id` column with a unique index; on unique violation, regenerate (same SAVEPOINT retry pattern already used for nicknames in Phase 02 TD-10 / `typeorm-queries.md`).
- **Pros:** Short, URL-safe, YouTube-like ids; database-enforced uniqueness ("sem conflito"); no new dependency; decouples public URL from internal PK and storage keys.
- **Cons:** Extra column/index and a retry path (collision probability is negligible but handled).

### Option C: `nanoid` library
- Same as B, using `nanoid` for generation.
- **Pros:** Configurable alphabet/length in one call.
- **Cons:** New dependency for what `node:crypto` already provides; uniqueness still needs the DB index + retry.

### Option D: Slug derived from the title + suffix
- e.g., `meu-video-x7k2`.
- **Pros:** Human-readable URLs.
- **Cons:** The title is not known/stable at pre-registration and becomes editable in Phase 04 — URLs would change or drift from the title.

**Recommendation:** **Option B (crypto short id, unique column + retry)** — it meets "sem conflito" with a database guarantee, keeps URLs short and stable across title edits, and reuses a collision-retry pattern the project already established, without adding dependencies. The UUID stays as internal PK and storage-key root.

**Decision:** _[pending]_

---

## TD-10: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP range requests → `206 Partial Content`), and users must be able to download the file. The architecture already draws `Frontend → Object Storage: Streams (HTTPS)`. The delivery path decides whether video bytes go through the API and what the frontend player/download button will call (Phase 05).

**Options:**

### Option A: API authorizes, storage serves via presigned GET URLs
- `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download` check authorization and answer `302` to a short-lived presigned GET URL; storage serves `Range` requests natively (`206`). Download uses the same mechanism with `response-content-disposition=attachment; filename=…` (S3 allows this override only on signed requests).
- **Pros:** Zero video bytes through the API; native range/seek support; matches the architecture's direct Frontend→Storage stream; the API still controls who gets a URL (needed for drafts now, unlisted in Phase 04).
- **Cons:** URLs expire (the player re-hits the endpoint for a fresh one); storage must be reachable from the client (TD-02).

### Option B: API proxies bytes with Range support
- The API reads the `Range` header, calls `GetObject` with that range and pipes the body back as `206` (`StreamableFile`).
- **Pros:** Storage never exposed; stable URLs; full control over headers.
- **Cons:** Every byte of every view crosses the API — API load scales with audience, contradicting the no-impact goal; more code (range parsing, headers, errors).

### Option C: HLS adaptive streaming (transcode to segments + playlist)
- Worker transcodes to HLS renditions; player fetches `.m3u8` and segments.
- **Pros:** Adaptive bitrate, broad player support, CDN-friendly.
- **Cons:** Transcoding is not a Phase 03 capability (only metadata extraction); multiplies processing time and storage for 10GB inputs; download still needs the original.

**Recommendation:** **Option A (presigned GET + `302`)** — it satisfies streaming via native `Range`/`206` and download via `Content-Disposition` without routing video bytes through the API, exactly as the architecture models it; HLS remains a possible future evolution, not a Phase 03 need. Stream/download are only available when the video is `ready` (TD-11).

**Decision:** _[pending]_

---

## TD-11: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video moves from pre-registration to playable, and processing can fail (corrupt file, FFmpeg error, storage hiccup). The status model is read by the API (what operations are allowed), written by the worker, and will be extended in Phase 04 ("Fluxo de rascunho → publicação"). Depends on TD-04 (retry features) and TD-06 (where transitions happen).

**Options:**

### Option A: Single `status` enum `draft → processing → ready | failed`, retries in the queue, terminal `failed` with reason
- `draft` = pre-registered, upload not completed; `processing` = upload completed and job enqueued; `ready` = metadata + thumbnail persisted; `failed` = processing gave up (reason stored in `processing_error`). Only forward transitions. Jobs retry transient errors (e.g., 3 attempts, exponential backoff); invalid media raises a non-retryable error; the processor is idempotent (re-running overwrites the same thumbnail key/metadata) and marks `failed` only after the last attempt.
- **Pros:** One column that directly expresses the phase's lifecycle; simple queries and guards (`ready` gates stream/download); failure is visible in the database with a reason.
- **Cons:** Phase 04's editorial publication must be modeled as a separate field (visibility/publication), otherwise "draft" would carry two meanings.

### Option B: Two orthogonal fields from the start — media `status` + `publication` state
- `status`: `uploading → processing → ready | failed`; `publication`: `draft` (only value in Phase 03, `published` added in Phase 04).
- **Pros:** Separates media lifecycle from editorial state up front; no reinterpretation in Phase 04.
- **Cons:** Introduces a Phase 04 concept (publication) with a single possible value now; the phase's lifecycle reads across two columns instead of one.

**Recommendation:** **Option A (single `status` enum with queue retries and terminal `failed`)** — it maps one-to-one to the phase's described lifecycle (rascunho → processando → pronto/erro), is the simplest state to guard and test, and leaves Phase 04 free to add publication/visibility as its own field without changing these states. Retry policy: 3 attempts, exponential backoff; non-retryable media errors fail immediately.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object storage client library | **A** (AWS SDK v3: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) | _[pending]_ |
| TD-02 | Backend | Storage endpoint topology for presigned URLs | **A** (internal endpoint for calls + public endpoint for client-facing signing) | _[pending]_ |
| TD-03 | Backend | Bucket and object key layout | **A** (single private bucket, `videos/{videoId}/source` + `thumbnail.jpg`) | _[pending]_ |
| TD-04 | Backend | Background processing queue technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | _[pending]_ |
| TD-05 | Cross-layer | Upload protocol for files up to 10GB | **A** (presigned S3 multipart, direct to storage, 64 MiB parts, 10 GiB max) | _[pending]_ |
| TD-06 | Cross-layer | Draft pre-registration and upload completion signal | **A** (row created on initiation + explicit completion endpoint) | _[pending]_ |
| TD-07 | Backend | Video worker runtime | **A** (same codebase, separate entrypoint and Compose service) | _[pending]_ |
| TD-08 | Backend | Metadata extraction and thumbnail generation | **A** (system `ffprobe`/`ffmpeg` via `execFile`, input from presigned internal URL) | _[pending]_ |
| TD-09 | Cross-layer | Unique public video identifier | **B** (`node:crypto` 11-char id, unique column + retry) | _[pending]_ |
| TD-10 | Cross-layer | Streaming and download delivery | **A** (API authorizes + `302` to presigned GET; storage serves `Range`/`206`) | _[pending]_ |
| TD-11 | Backend | Video status lifecycle and failure handling | **A** (`draft → processing → ready \| failed`, 3 retries, terminal `failed` with reason) | _[pending]_ |

---

## Notes for downstream pipeline

- **Dependency chain:** TD-01 → TD-02 (two clients of the chosen SDK) → TD-03/TD-05/TD-10 (all URLs are presigned by those clients). TD-04 → TD-06 (enqueue on completion) → TD-11 (retries/terminal failure rely on the queue's attempts/backoff and non-retryable errors). TD-07 → TD-08 (FFmpeg installed in the image the worker runs from). If TD-04 swings away from BullMQ, revisit TD-11's retry wording; if TD-05 swings away from presigned multipart, TD-06 Option A's completion payload (parts + ETags) changes.
- **Not decided here (left to planning):** the authorization rule for stream/download while videos are not yet public — visibility (public/unlisted) is Phase 04 and anonymous viewing is Phase 05, so Phase 03 needs an explicit rule in the plan's Authorization Matrix; the exact data model, endpoint paths, error codes and job payload (Technical Specifications of the plan); cleanup of videos left in `draft` after an abandoned upload (storage-side expiry already reclaims the bytes — TD-03).
- **Compose surface implied by the recommendations:** `minio` (+ one-shot `minio/mc` bucket bootstrap), `redis` (AOF persistence), `video-worker` (same image/codebase as `nestjs-api`, different command). The dev image gains FFmpeg. All service-to-service hosts use Compose service names; only `S3_PUBLIC_ENDPOINT` points at a host-reachable address.
- **New dependencies implied by the recommendations** (to be pinned via Context7 in `/plan-resolve` → `library-refs.md`): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq`, `@nestjs/bullmq`. FFmpeg is an OS package, not an npm dependency.
- **Frontend:** no implementation in Phase 03. The Cross-layer contracts (TD-05 handshake, TD-06 completion, TD-09 id, TD-10 `302` delivery) are the inputs Phase 05 will consume; browser uploads additionally require storage CORS exposing `ETag`.

Sources consulted during research:

- [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — 10,000 parts, 5 MiB–5 GiB per part (no minimum for the last part).
- [Amazon S3 — Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — single PUT limited to 5 GB; multipart for larger objects.
- [Amazon S3 API — GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) — `Range` header; `response-content-disposition` override only on signed requests.
- [AWS SDK for JavaScript v3 — `@aws-sdk/s3-request-presigner`](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md) — `getSignedUrl` for any S3 command; default `expiresIn` 900s; checksum calculation behavior on presigned `UploadPart`.
- [NestJS Bull/BullMQ module (`@nestjs/bullmq`)](https://github.com/nestjs/bull) — `BullModule.forRoot`, `@Processor` + `WorkerHost`, failed jobs retried per `attempts`/`backoff`.
- [BullMQ documentation](https://docs.bullmq.io) — job options, retries, `UnrecoverableError`.
- [MinIO — Publish events to Redis/AMQP](https://github.com/minio/docs/blob/main/source/administration/monitoring/publish-events-to-redis.rst) and [`mc event add` supported events](https://github.com/minio/docs/blob/main/source/reference/minio-mc/mc-event-add.rst) — `s3:ObjectCreated:CompleteMultipartUpload` notifications (TD-06 Option B).
- [pg-boss](https://github.com/timgit/pg-boss) — PostgreSQL-backed queue (TD-04 Option C).
- [fluent-ffmpeg on npm](https://npmjs.com/package/fluent-ffmpeg) — deprecated, "Package no longer supported" (TD-08 Option B).
- [tus Node.js server (`@tus/server`, `@tus/s3-store`)](https://tus.io/blog/2023/09/04/tus-node-server-v100) and [`@tus/s3-store`](https://www.npmjs.org/package/@tus/s3-store) — tus server with S3 multipart backend (TD-05 Option B).
