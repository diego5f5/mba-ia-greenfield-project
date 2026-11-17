# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio mc ready local` — expect `The cluster 'local' is ready`; the one-shot `minio-init` must show `Exited (0)` (it creates the bucket)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `WorkerModule dependencies initialized` and no errors (it is a background consumer, not the HTTP server, so it starts with the infrastructure)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage, API on `9000`, console on `9001` (credentials from `S3_ACCESS_KEY`/`S3_SECRET_KEY`)
- `minio-init` — one-shot job that creates the `S3_BUCKET` bucket (idempotent)
- `redis` — Redis 7 with AOF, port `6379`; backs the BullMQ queue
- `video-worker` — NestJS application context without HTTP that consumes the `video-processing` queue (`npm run start:worker:dev`); builds into `dist-worker/` so it never touches the API's `dist/`
- `mailpit` — local SMTP (`1025`) and web UI (`8025`)

If your local `compose.override.yaml` mounts a `node_modules` volume on `nestjs-api`, mount the same volume on `video-worker`; otherwise the worker reads the host's bind-mounted `node_modules`, which is very slow on Windows.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify MinIO and Redis are ready
docker compose exec minio mc ready local
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos, Storage & Queue

Video bytes never cross the API: the client uploads straight to the object storage with presigned URLs and plays/downloads through redirects to presigned URLs. The API only keeps state and enqueues work.

- `src/videos/` — `VideosModule`: `VideosController` (owner-only endpoints below), `VideosService` (all business rules), `Video` entity, DTOs, and `VideoProcessingProcessor` (the queue consumer; registered **only** in the worker, never in `VideosModule`)
- `src/storage/` — `StorageModule`/`StorageService`: the single gateway to the S3-compatible storage (multipart upload, `HeadObject`, `PutObject`, presigned URLs)
- `src/media/` — `MediaModule`/`MediaProbeService`: wraps the system `ffprobe`/`ffmpeg` binaries (metadata and thumbnail) through `execFile`, without a shell
- `src/worker.ts` + `src/worker.module.ts` — entrypoint and root module of the video worker (`NestFactory.createApplicationContext`, no HTTP); runs as the `video-worker` Compose service

**Endpoints** (all authenticated, owner-only; another user's video answers `404 VIDEO_NOT_FOUND`): `POST /videos`, `POST /videos/:public_id/upload/parts`, `POST /videos/:public_id/upload/completion` (202 on the first call, 200 on repeats), `GET /videos/:public_id`, `GET /videos/:public_id/stream` and `GET /videos/:public_id/download` (302 redirects; `409 VIDEO_NOT_READY` until the video is `ready`).

**Lifecycle:** `draft → processing → ready | failed`. Completing the upload moves the video to `processing` and adds a `process-video` job (`jobId` = `videos.id`, 3 attempts, exponential backoff) to the BullMQ queue `video-processing`. The worker probes the file, uploads `videos/{id}/thumbnail.jpg` and sets `ready`; an unreadable file (`InvalidMediaError` → `UnrecoverableError`) or exhausted retries set `failed` with `processing_error`.

**Environment variables:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT` (see `.env.example`). Hosts are Compose service names (`minio`, `redis`) — the **only** non-Compose host is `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`), used just to sign URLs handed to clients outside the Docker network. Tests that fetch presigned URLs from inside the container set `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`.

**Gotchas:**
- Run the e2e suites with `npm run test:e2e -- --runInBand`; they share one database and fail when run in parallel.
- With `video-worker` running, any video left in `processing` by a test is consumed and moved to `failed` (test bytes are not real video); tests must not assert the database `status` after completing an upload unless they control the worker.
- `openapi.json` is generated: after changing a controller or DTO run `docker compose exec nestjs-api npm run openapi:export` and commit the result.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
