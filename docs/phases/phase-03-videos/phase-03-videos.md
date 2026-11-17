---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T09:26:30-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-17T09:25:52-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T09:24:06-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-16T21:45:45-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB direto ao object storage sem impacto na performance da API, com pré-cadastro automático como rascunho, processamento automático em segundo plano por fila e worker (extração de duração e metadados e geração de thumbnail a partir de um frame), URL única sem conflito por vídeo, reprodução via streaming e download pelo usuário — com object storage, fila e worker rodando no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração de storage/fila e serviços MinIO/Redis no Compose

**Description:** Instala as bibliotecas fixadas da fase, adiciona FFmpeg à imagem de desenvolvimento, cria os namespaces de configuração `storage` e `queue` e sobe MinIO (com bucket provisionado) e Redis no `compose.yaml` — infraestrutura sem comportamento de domínio.

**Technical actions:**

1. Instalar dentro do container `nestjs-api`, com versão exata (`npm install --save-exact`), `@aws-sdk/client-s3@3.1161.0`, `@aws-sdk/s3-request-presigner@3.1161.0`, `bullmq@6.5.4` e `@nestjs/bullmq@12.0.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`; versões em `library-refs.md`)
2. Atualizar `nestjs-project/Dockerfile.dev` para instalar o pacote Debian `ffmpeg` (fornece `ffprobe` e `ffmpeg`) junto de `procps curl` — a mesma imagem serve `nestjs-api` (onde os testes rodam) e o futuro `video-worker` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
3. Adicionar ao `nestjs-project/compose.yaml`: `minio` (imagem `minio/minio` com tag fixa, `server /data --console-address ":9001"`, portas `9000`/`9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` interpolados de `S3_ACCESS_KEY`/`S3_SECRET_KEY`, volume `minio-data`, healthcheck `mc ready local`); `minio-init` (imagem `minio/mc`, one-shot: `mc alias set` em `http://minio:9000` + `mc mb --ignore-existing local/$S3_BUCKET`, `depends_on: minio: service_healthy`); `redis` (imagem `redis` com tag fixa, `redis-server --appendonly yes`, volume `redis-data`, healthcheck `redis-cli ping`); e em `nestjs-api.depends_on` adicionar `minio-init: service_completed_successfully` e `redis: service_healthy` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
4. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`; e `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST`, `REDIS_PORT`; carregar ambos em `ConfigModule.forRoot({ load: [...] })` do `AppModule` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`, `phase-01-configuracao-base/TD-03`)
5. Estender `src/config/env.validation.ts` (Joi): `S3_ACCESS_KEY`, `S3_SECRET_KEY` obrigatórios; `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_BUCKET` (default `streamtube-videos`), `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`); atualizar `.env.example` com as mesmas chaves, usando nomes de serviço do Compose para hosts internos (per `phase-01-configuracao-base/TD-02`, `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves de storage/fila) | Integration: obrigatórias rejeitam ausência; defaults aplicados para endpoints, bucket e Redis | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy`, `minio-init` encerra com código 0 e `nestjs-api` em execução
- `docker compose exec minio mc ls local/streamtube-videos` lista o bucket (vazio) criado pelo `minio-init`; reexecutar `minio-init` não falha (bucket já existente)
- `docker compose exec redis redis-cli CONFIG GET appendonly` retorna `yes`
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com código 0
- Iniciar a aplicação sem `S3_ACCESS_KEY` falha no bootstrap com erro de validação Joi — a aplicação não sobe

---

### SI-03.2 — StorageModule: cliente S3 para MinIO com endpoints interno e público

**Description:** Cria o módulo de infraestrutura `StorageModule`, único ponto do código que fala com o object storage, encapsulando multipart upload, verificação de objetos e assinatura de URLs com dois clientes (interno para chamadas de rede, público para URLs entregues a clientes externos).

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.service.ts` — `StorageService` instancia dois `S3Client` a partir de `ConfigType<typeof storageConfig>`: interno (`endpoint = S3_ENDPOINT`) e público (`endpoint = S3_PUBLIC_ENDPOINT`), ambos com `forcePathStyle: true`, `region`, `credentials` e `requestChecksumCalculation: 'WHEN_REQUIRED'`; o módulo exporta `StorageService` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Implementar operações de rede pelo cliente interno: `createMultipartUpload(key, contentType): Promise<string>` (retorna `UploadId`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key): Promise<{ contentLength: number; contentType: string } | null>` (`null` em `NotFound`), `putObject(key, body, contentType)` e `deleteObject(key)` — bucket sempre de `S3_BUCKET` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)
3. Implementar assinatura via `getSignedUrl`: `presignUploadPart(key, uploadId, partNumber, expiresIn)` com o cliente público; `presignGetObject(key, { expiresIn, endpoint: 'public' | 'internal', responseContentType?, responseContentDisposition? })` escolhendo o cliente pelo parâmetro (público para stream/download/thumbnail; interno para o worker) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
4. Criar `src/storage/storage.errors.ts` com `MultipartUploadRejectedError` (erro de infraestrutura, não `DomainException`) lançado por `completeMultipartUpload` quando o S3 responde `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` ou `NoSuchUpload`; demais erros propagam sem tratamento (per `nestjs-services.md` — nunca engolir erros)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real do Compose): multipart completo via URL de parte pré-assinada + `fetch` PUT, `headObject` com tamanho correto e `null` para chave inexistente, `presignGetObject` com header `Range` respondendo `206`, `ResponseContentDisposition` refletido no `Content-Disposition`, `completeMultipartUpload` com ETag inválido lançando `MultipartUploadRejectedError` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com `ConfigModule` global carregando `storageConfig` | `src/storage/storage.module.spec.ts` |

Nos testes, que rodam dentro do container `nestjs-api`, `S3_PUBLIC_ENDPOINT` é sobrescrito com o valor de `S3_ENDPOINT` — o teste é um cliente interno à rede do Compose, e `localhost:9000` não é alcançável de dentro do container.

**Dependencies:** SI-03.1 — MinIO no Compose, libs AWS SDK instaladas e `storageConfig` existente

**Acceptance criteria:**

- Um objeto enviado em 2 partes por URLs pré-assinadas e concluído por `completeMultipartUpload` fica disponível com `ContentLength` igual à soma das partes
- Uma URL de `presignUploadPart` gerada pelo cliente público contém o host de `S3_PUBLIC_ENDPOINT`; uma de `presignGetObject({ endpoint: 'internal' })` contém o host de `S3_ENDPOINT`
- `GET` em uma URL de `presignGetObject` com `Range: bytes=0-99` retorna `206` com exatamente 100 bytes
- `completeMultipartUpload` com uma lista de partes cujo ETag não confere lança `MultipartUploadRejectedError` e não cria o objeto

---

### SI-03.3 — Entidade Video, migration CreateVideos e VideosModule

**Description:** Cria a tabela `videos` ligada ao canal com o ciclo de status da fase, via entidade TypeORM e migration versionada, e registra o `VideosModule` vazio no `AppModule`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos, tipos e constraints exatamente como em `### Data Model → Video` (enum TS `VideoStatus` = `draft | processing | ready | failed` mapeado para `videos_status_enum`; `file_size_bytes` `bigint` com transformer `string → number`; `metadata` `jsonb`; `@ManyToOne(() => Channel, (channel) => channel.videos)` + `@JoinColumn({ name: 'channel_id' })`; `@Index()` em `channel_id`) (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts` — os dois lados da relação, sem mudança de schema em `channels` (per `nestjs-entities.md`)
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` — cria `videos_status_enum`, a tabela, o índice único de `public_id`, o índice de `channel_id` e a FK para `channels`; `down()` desfaz em ordem reversa (per `typeorm-migrations.md`)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule` (per `nestjs-modules.md`)
5. Atualizar `src/test/create-test-data-source.ts` (`cleanAllTables` apaga `videos` antes de `channels`) e `src/database/migrations.integration-spec.ts` (inclui `CreateVideos` na lista de migrations, `videos` nas tabelas gerenciadas e `videos_status_enum` nos tipos removidos no `beforeAll`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único (violação 23505), FK para `channels` (canal inexistente rejeitado), `status` default `draft`, `file_size_bytes` de 10 GiB lido como `number`, `metadata` jsonb round-trip | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplicar todas cria `videos`; reverter a última remove `videos` e o enum; `afterAll` restaura o schema | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — ambiente com Postgres e Compose atualizado (a entidade não depende das libs novas)

**Acceptance criteria:**

- `npm run migration:run` em banco migrado até a Fase 02 cria a tabela `videos` com o enum `videos_status_enum (draft, processing, ready, failed)`
- Inserir dois vídeos com o mesmo `public_id` — o segundo falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente — falha com violação de FK
- Um vídeo inserido sem `status` é persistido como `draft`
- `npm run migration:revert` remove a tabela `videos` e o tipo `videos_status_enum` sem afetar `users`, `channels` e tabelas de tokens

---

### SI-03.4 — Pré-cadastro do vídeo como rascunho e URLs pré-assinadas das partes

**Description:** Implementa no `VideosService` o início do upload (pré-cadastro `draft` + criação do multipart com URL única) e a emissão sob demanda das URLs das partes, com a regra de propriedade por canal — sem nenhum byte de vídeo passando pela API.

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId): Promise<Channel | null>` em `src/channels/channels.service.ts` (o canal é do domínio `channels`; `VideosModule` importa `ChannelsModule`, que passa a exportar `ChannelsService` se ainda não exporta) e criar `src/videos/videos.constants.ts` (`as const`): `VIDEO_PART_SIZE_BYTES = 67108864`, `VIDEO_MAX_FILE_SIZE_BYTES = 10737418240`, `VIDEO_URL_TTL_SECONDS = 3600`, `VIDEO_MAX_PARTS_PER_REQUEST = 100`, `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
2. Criar `src/videos/public-id.util.ts` — `generatePublicId()` = `randomBytes(8).toString('base64url')` (11 caracteres) e as exceções `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `UploadNotInProgressException` (`UPLOAD_NOT_IN_PROGRESS`, 409) e `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) em `src/common/exceptions/domain.exception.ts`, conforme `### Error Catalog` (per `phase-03-videos/TD-09`, `phase-02-auth/TD-07`)
3. Criar os DTOs `src/videos/dto/create-video.dto.ts` (`file_name`, `file_size`, `content_type`, `title?` com as regras de `#### Validation Rules — Video upload`), `src/videos/dto/request-upload-parts.dto.ts` (`part_numbers`), `src/videos/dto/video-response.dto.ts` (`VideoResponse` com `@ApiProperty` explícito) e `src/videos/dto/create-video-response.dto.ts` (`VideoResponse` + `upload: { part_size, part_count }`) (per `phase-02-auth/TD-06`, `openapi-docs-nestjs/TD-01`)
4. Implementar `VideosService.createVideo(userId, dto)`: resolve o canal do usuário; gera `id = randomUUID()` e `source_key = videos/{id}/source`; chama `StorageService.createMultipartUpload`; insere o vídeo (`status: draft`, `title` = `dto.title` ou `file_name` sem extensão truncado em 100, `upload_id`) gerando `public_id` com até 5 tentativas em violação de unicidade (SAVEPOINT por tentativa, per `typeorm-queries.md`); se a inserção falhar, compensa com `abortMultipartUpload` e relança o erro; retorna `VideoResponse` + `upload.part_count = ceil(file_size / VIDEO_PART_SIZE_BYTES)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`, `validation.md` → AMB-2 resolution)
5. Implementar `VideosService.requestUploadPartUrls(userId, publicId, partNumbers)`: carrega o vídeo do canal do usuário (inexistente ou de outro dono → `VideoNotFoundException`); `status !== draft` → `UploadNotInProgressException`; parte `> part_count` → `InvalidUploadPartsException`; retorna `{ parts: [{ part_number, url }], expires_in: VIDEO_URL_TTL_SECONDS }` com `StorageService.presignUploadPart` (per `phase-03-videos/TD-05`, `validation.md` → AMB-1 resolution)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: 11 caracteres, alfabeto base64url (`[A-Za-z0-9_-]`), valores distintos em chamadas sucessivas | `src/videos/public-id.util.spec.ts` |
| `VideosService` (início + partes) | Unit (repositório/storage/channels mockados): título padrão a partir do nome do arquivo, retry em colisão de `public_id`, compensação `abortMultipartUpload` quando o insert falha, `VIDEO_NOT_FOUND` para não-dono, `UPLOAD_NOT_IN_PROGRESS` fora de `draft`, `INVALID_UPLOAD_PARTS` acima de `part_count` | `src/videos/videos.service.spec.ts` |
| `VideosService` (início + partes) | Integration (Postgres + MinIO reais): vídeo persistido como `draft` com `upload_id` e `source_key` corretos; URLs de partes aceitam `PUT` no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário e `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService` para multipart e assinatura; SI-03.3 — entidade `Video` e `VideosModule`

**Acceptance criteria:**

- `createVideo` com `file_size` de 10 GiB e sem `title` persiste um vídeo `draft` cujo `title` é o nome do arquivo sem extensão e retorna `upload.part_count = 160`
- Duas chamadas de `createVideo` geram `public_id` distintos de 11 caracteres e `source_key` no formato `videos/{id}/source`
- Quando a inserção do vídeo falha após o multipart ter sido criado, o multipart é abortado no MinIO e nenhum vídeo fica persistido
- `requestUploadPartUrls` de um usuário que não é dono do vídeo lança `VIDEO_NOT_FOUND`, mesmo que o `public_id` exista
- `requestUploadPartUrls` para um vídeo `processing` lança `UPLOAD_NOT_IN_PROGRESS`; com parte `161` em um vídeo de 160 partes lança `INVALID_UPLOAD_PARTS`
- Cada URL retornada por `requestUploadPartUrls` aceita um `PUT` de bytes crus no MinIO e responde com header `ETag`

---

### SI-03.5 — Conclusão do upload e publicação do job na fila BullMQ

**Description:** Conecta a API à fila Redis/BullMQ como produtora e implementa a conclusão do upload: completa o multipart, verifica o objeto montado, transiciona `draft → processing` e enfileira `process-video` de forma idempotente.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` no `AppModule` (conexão `{ host, port }` de `ConfigType<typeof queueConfig>`) e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } })` no `VideosModule` — sem `removeOnComplete`/`removeOnFail` para preservar a deduplicação por `jobId` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`; API em `library-refs.md → @nestjs/bullmq`)
2. Criar `src/videos/dto/complete-upload.dto.ts` (`parts: [{ part_number, etag }]`, regras de `#### Validation Rules — Video upload`, `@ValidateNested` + `@Type`) e a exceção `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422) em `src/common/exceptions/domain.exception.ts` (per `phase-02-auth/TD-07`)
3. Implementar `VideosService.completeUpload(userId, publicId, parts)`: carrega o vídeo do dono (senão `VideoNotFoundException`); se `status !== draft`, retorna `{ video, transitioned: false }` sem efeitos colaterais; chama `StorageService.completeMultipartUpload` (mapeando `MultipartUploadRejectedError` → `InvalidUploadPartsException`, vídeo permanece `draft`) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
4. Ainda em `completeUpload`: `headObject(source_key)`; se `contentLength ≠ file_size_bytes` ou `> VIDEO_MAX_FILE_SIZE_BYTES`, apaga o objeto, persiste `status: failed`, `processing_error: 'UPLOAD_SIZE_MISMATCH'`, `upload_id: null`, `processed_at: now()` e lança `UploadSizeMismatchException`; caso contrário persiste `status: processing`, `upload_id: null` e, após o update confirmado, chama `queue.add(PROCESS_VIDEO_JOB, { videoId: id }, { jobId: id })`; retorna `{ video, transitioned: true }` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`, `### Events/Messages`)
5. Injetar a fila em `VideosService` com `@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly videoProcessingQueue: Queue` e garantir que o `VideosModule` **não** registra nenhum `@Processor` (a API é apenas produtora) (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (storage/fila/repositório mockados): chamada repetida fora de `draft` sem efeitos, `MultipartUploadRejectedError` → `INVALID_UPLOAD_PARTS` mantendo `draft`, tamanho divergente → `failed` + objeto apagado + `UPLOAD_SIZE_MISMATCH`, sucesso → `processing` + `queue.add` com `jobId = videoId` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis reais): upload real em partes concluído → vídeo `processing` e job `process-video` presente na fila com id = `videos.id`; segunda chamada não cria novo job | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `BullModule.registerQueue` e `BullModule.forRootAsync` (Redis do Compose) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4 — vídeo `draft` com multipart iniciado e regras de propriedade

**Acceptance criteria:**

- Concluir um upload cujas partes somam o `file_size` declarado deixa o vídeo `processing` com `upload_id` nulo e cria na fila `video-processing` um job `process-video` com payload `{ videoId }` e id igual ao `videos.id`
- Concluir novamente o mesmo vídeo não chama o storage, não altera o registro e não cria um segundo job
- Concluir com um ETag inválido resulta em `INVALID_UPLOAD_PARTS` e o vídeo continua `draft`, permitindo nova tentativa com a lista correta
- Concluir um upload cujo objeto montado tem tamanho diferente do declarado resulta em `UPLOAD_SIZE_MISMATCH`, vídeo `failed` com `processing_error = 'UPLOAD_SIZE_MISMATCH'` e objeto `videos/{id}/source` removido do MinIO
- O processo da API não consome jobs: com apenas `nestjs-api` rodando, o job permanece em espera na fila

---

### SI-03.6 — MediaProbeService: extração de metadados e thumbnail com ffprobe/ffmpeg

**Description:** Cria o `MediaModule`, wrapper tipado dos binários do sistema `ffprobe`/`ffmpeg`, que lê o vídeo direto do storage por URL (range requests) para extrair duração/metadados e gerar o JPEG da thumbnail — sem wrapper npm e sem copiar o arquivo inteiro.

**Technical actions:**

1. Criar `src/media/media.module.ts` + `src/media/media-probe.service.ts` exportando `MediaProbeService`; os binários são invocados com `execFile` de `node:child_process` (promisificado, sem shell, com `maxBuffer` adequado e timeout), nunca com `exec` ou interpolação de string (per `phase-03-videos/TD-08`)
2. Implementar `probe(inputUrl): Promise<MediaProbeResult>` executando `ffprobe -v error -print_format json -show_format -show_streams <url>` e mapeando para `{ duration_seconds: number | null, metadata: { width, height, video_codec, audio_codec, container_format, bit_rate, size_bytes } }` conforme `### Events/Messages → Processing steps` (primeiro stream `codec_type: video`; primeiro `audio` ou `null`; campos numéricos convertidos de string), com tipos explícitos para o JSON do ffprobe (per `phase-03-videos/TD-08`, `typescript-strict.md`)
3. Criar `src/media/media.errors.ts` com `InvalidMediaError`, lançado quando o `ffprobe` sai com código ≠ 0 ou quando não há stream de vídeo — erro de infraestrutura que o worker converte em falha não recuperável (per `phase-03-videos/TD-11`)
4. Implementar `extractThumbnail(inputUrl, durationSeconds): Promise<Buffer>`: offset = 10% de `durationSeconds` (0 quando `null`), `ffmpeg -ss <offset> -i <url> -frames:v 1 -vf scale=1280:-2 -q:v 3 -y <tmp>.jpg` em diretório temporário de `os.tmpdir()`, lê o arquivo e o remove em `finally` (per `phase-03-videos/TD-08`)
5. Criar o helper de teste `src/test/video-fixture.ts` que gera um MP4 curto em runtime com `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=duration=3 -c:v libx264 -c:a aac` (sem arquivo binário versionado) e um arquivo inválido (bytes aleatórios), reutilizado pelos testes de worker e E2E

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Unit (`execFile` mockado): mapeamento do JSON do ffprobe (vídeo sem áudio → `audio_codec: null`, strings numéricas convertidas), cálculo do offset de 10% e offset 0 com duração `null`, `InvalidMediaError` em saída sem stream de vídeo | `src/media/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration (ffprobe/ffmpeg reais + MinIO): fixture de 3 s servida por URL pré-assinada interna → duração ≈ 3, 320x240, `h264`/`aac`; thumbnail JPEG válido (assinatura `FF D8`) com 1280px de largura; arquivo inválido → `InvalidMediaError` | `src/media/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService.presignGetObject({ endpoint: 'internal' })` para servir a fixture nos testes (FFmpeg vem da imagem atualizada em SI-03.1)

**Acceptance criteria:**

- `probe` de um MP4 de 3 s, 320x240, H.264 + AAC servido pelo MinIO retorna `duration_seconds` entre 2.9 e 3.1, `width: 320`, `height: 240`, `video_codec: 'h264'` e `audio_codec: 'aac'`
- `probe` de um arquivo sem stream de vídeo (bytes aleatórios) lança `InvalidMediaError`
- `extractThumbnail` do mesmo vídeo retorna um JPEG de 1280px de largura com proporção preservada
- Nenhum arquivo temporário permanece em `os.tmpdir()` após `extractThumbnail`, inclusive quando o `ffmpeg` falha

---

### SI-03.7 — Worker de vídeo: processor BullMQ, entrypoint próprio e serviço video-worker no Compose

**Description:** Entrega o worker de vídeo como processo separado (mesmo código, contexto Nest sem HTTP) que consome `process-video`, extrai duração/metadados, gera a thumbnail e leva o vídeo a `ready` ou `failed`, rodando como serviço `video-worker` no Compose.

**Technical actions:**

1. Criar `src/videos/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` executa os passos 1–5 de `### Events/Messages → Processing steps`: ignora vídeo inexistente ou fora de `processing`; URL interna via `StorageService.presignGetObject({ endpoint: 'internal' })`; `MediaProbeService.probe` + `extractThumbnail`; `StorageService.putObject('videos/{id}/thumbnail.jpg', jpeg, 'image/jpeg')`; um único update para `ready` com `duration_seconds`, `metadata`, `thumbnail_key`, `processing_error: null`, `processed_at` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
2. No processor, converter `InvalidMediaError` em `UnrecoverableError` do `bullmq` e implementar `@OnWorkerEvent('failed')`: quando o erro é `UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts`, persistir `status: failed`, `processing_error: <mensagem>`, `processed_at: now()`; falhas intermediárias apenas registram log (catch-and-log permitido em handler de background, per `nestjs-services.md`) (per `phase-03-videos/TD-11`; API em `library-refs.md → bullmq`)
3. Criar `src/worker.module.ts` (`ConfigModule` global com os mesmos namespaces e `validationSchema` do `AppModule`, `TypeOrmModule.forRootAsync`, `BullModule.forRootAsync`, `BullModule.registerQueue`, `TypeOrmModule.forFeature([Video])`, `StorageModule`, `MediaModule`, provider `VideoProcessingProcessor`) e `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`) — o processor existe **somente** neste módulo (per `phase-03-videos/TD-07`, `phase-01-configuracao-base/TD-01`)
4. Adicionar em `nestjs-project/package.json` os scripts `start:worker` (`nest start --entryFile worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`), e no `compose.yaml` o serviço `video-worker` (mesmo `build`/`Dockerfile.dev` e volumes do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on`: `db` healthy, `redis` healthy, `minio-init` completed) — sem porta publicada (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit (repositório/storage/media mockados): vídeo fora de `processing` é ignorado, `InvalidMediaError` vira `UnrecoverableError`, handler `failed` só marca `failed` na última tentativa ou em erro irrecuperável | `src/videos/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration (Postgres + MinIO + FFmpeg reais, `process()` chamado com um `Job` real): fixture válida → `ready` com duração, metadados e `videos/{id}/thumbnail.jpg` existente no MinIO; fixture inválida → `UnrecoverableError` e, via handler `failed`, vídeo `failed` com `processing_error` | `src/videos/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do contexto do worker (resolve `VideoProcessingProcessor` com todas as dependências) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.5 — job `process-video` publicado e fila registrada; SI-03.6 — `MediaProbeService`

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` em execução, sem porta HTTP exposta, conectado ao Redis e ao Postgres (log de inicialização sem erros)
- Concluir o upload de um vídeo válido leva o vídeo de `processing` a `ready` sem nenhuma ação adicional do cliente, com `duration_seconds`, `metadata` e `thumbnail_key = videos/{id}/thumbnail.jpg` preenchidos
- O objeto `videos/{id}/thumbnail.jpg` existe no MinIO com `Content-Type: image/jpeg` após o processamento
- Concluir o upload de um arquivo que não é vídeo leva o vídeo a `failed` com `processing_error` preenchido, sem consumir as 3 tentativas
- Reentregar o mesmo job para um vídeo já `ready` não altera o registro nem gera nova thumbnail
- Parar o `video-worker` com jobs pendentes e subi-lo novamente processa os jobs que ficaram na fila (persistência AOF do Redis)

---

### SI-03.8 — Consulta do vídeo e URLs de streaming e download

**Description:** Implementa no `VideosService` a leitura do vídeo pelo dono (com URL da thumbnail) e a emissão das URLs pré-assinadas de streaming e download, liberadas apenas quando o vídeo está `ready`.

**Technical actions:**

1. Extrair em `VideosService` o método privado `findOwnedVideo(userId, publicId)` (canal do usuário + `public_id`; ausência ou outro dono → `VideoNotFoundException`) e reutilizá-lo nos métodos de SI-03.4/SI-03.5, mantendo a regra de propriedade em um único lugar (per `validation.md` → AMB-1 resolution, `nestjs-layer-separation.md`)
2. Implementar `VideosService.getVideo(userId, publicId): Promise<VideoResponse>` com mapeamento entidade → `VideoResponse` centralizado em um método único; `thumbnail_url` = `presignGetObject(thumbnail_key, { endpoint: 'public', expiresIn: VIDEO_URL_TTL_SECONDS })` quando `thumbnail_key` existe, senão `null` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
3. Criar a exceção `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) em `src/common/exceptions/domain.exception.ts` e implementar `VideosService.getStreamUrl(userId, publicId): Promise<string>` — `status !== ready` → `VideoNotReadyException`; senão `presignGetObject(source_key, { endpoint: 'public', expiresIn: VIDEO_URL_TTL_SECONDS, responseContentType: content_type })` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
4. Implementar `VideosService.getDownloadUrl(userId, publicId): Promise<string>` — mesma regra de `ready`; `responseContentDisposition` = `attachment; filename="{fallback ASCII}"; filename*=UTF-8''{encodeURIComponent(original_file_name)}` (fallback ASCII substitui caracteres fora de `[\x20-\x7E]` e aspas por `_`) (per `phase-03-videos/TD-10`, `validation.md` → AMB-2 resolution)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (leitura + entrega) | Unit (mocks): `VIDEO_NOT_FOUND` para não-dono, `VIDEO_NOT_READY` em `draft`/`processing`/`failed`, `thumbnail_url` nulo sem `thumbnail_key`, `Content-Disposition` com fallback ASCII e `filename*` para nome com acentos | `src/videos/videos.service.spec.ts` |
| `VideosService` (leitura + entrega) | Integration (Postgres + MinIO reais, vídeo `ready` semeado com objeto real): URL de stream responde `206` a `Range: bytes=0-1023` com `Content-Type` do vídeo; URL de download responde `200` com `Content-Disposition: attachment` e o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — `VideosService`, DTO `VideoResponse` e regra de propriedade

**Acceptance criteria:**

- `getVideo` de um vídeo `ready` retorna `thumbnail_url` cujo `GET` responde `200` com `Content-Type: image/jpeg`; de um vídeo `draft` retorna `thumbnail_url: null`
- `getStreamUrl` de um vídeo `processing` lança `VIDEO_NOT_READY`; de um vídeo de outro canal lança `VIDEO_NOT_FOUND`
- `GET` na URL de stream com `Range: bytes=0-1023` responde `206 Partial Content` com 1024 bytes e `Content-Range` — o cliente não precisa baixar o arquivo inteiro
- `GET` na URL de download responde com `Content-Disposition: attachment` contendo o `original_file_name` (incluindo acentos via `filename*`)
- URLs de stream, download e thumbnail usam o host de `S3_PUBLIC_ENDPOINT` e expiram em 3600 s

---

### SI-03.9 — Endpoints de upload: POST /videos, POST /videos/{public_id}/upload/parts e POST /videos/{public_id}/upload/completion

**Route:** POST /videos, POST /videos/{public_id}/upload/parts, POST /videos/{public_id}/upload/completion
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated; owner-only nas rotas com `{public_id}` (per `### Authorization Matrix`)

**Description:** Expõe o fluxo de upload via HTTP em um `VideosController` fino que delega ao `VideosService`, com contratos, códigos de status e documentação OpenAPI conforme `### API Contracts`.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos')` + `@Controller('videos')`, sem `@Public()` (rotas protegidas pelo guard JWT global), usuário via `@CurrentUser()` (`JwtPayload.sub`); registrar o controller no `VideosModule` (per `nestjs-controllers.md`, `phase-02-auth/TD-02`)
2. `POST /videos` → `@HttpCode(201)`, body `CreateVideoDto`, retorna `CreateVideoResponseDto` de `VideosService.createVideo` (per `### API Contracts → POST /videos`, `phase-03-videos/TD-06`)
3. `POST /videos/:public_id/upload/parts` → `@HttpCode(200)`, body `RequestUploadPartsDto`, retorna `{ parts, expires_in }` de `VideosService.requestUploadPartUrls` (per `### API Contracts → POST /videos/{public_id}/upload/parts`, `phase-03-videos/TD-05`)
4. `POST /videos/:public_id/upload/completion` → body `CompleteUploadDto`; responde `202` quando `transitioned: true` e `200` quando `false` (decisão de transporte via `@Res({ passthrough: true })` + `res.status(...)`, sem regra de negócio no controller), retornando `VideoResponse` (per `### API Contracts → POST /videos/{public_id}/upload/completion`, `phase-03-videos/TD-04`)
5. Documentar cada handler com `@ApiOperation` e `@ApiResponse` para o status de sucesso e para cada erro previsto (`400`, `401`, `404`, `409`, `422` conforme o endpoint), erros referenciando `getSchemaPath(ApiErrorEnvelope)` (per `openapi-docs-nestjs/TD-01`, `nestjs-controllers.md`)

**Tests:** _(empty — controller wiring; E2E scenarios (HTTP status, validation wiring, 401/404) are authored by /plan-test-specs in the spec file)_

**Dependencies:** SI-03.4 — `createVideo` e `requestUploadPartUrls`; SI-03.5 — `completeUpload` e fila registrada

**Acceptance criteria:**

- `POST /videos` autenticado com `{ file_name: "aula.mp4", file_size: 1048576, content_type: "video/mp4" }` retorna `201` com `public_id`, `status: "draft"`, `title: "aula"` e `upload: { part_size: 67108864, part_count: 1 }`
- `POST /videos` com `file_size` de 10737418241 ou `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos/{public_id}/upload/parts` com `{ part_numbers: [1] }` retorna `200` com uma URL que aceita o `PUT` da parte e devolve `ETag`
- `POST /videos/{public_id}/upload/completion` com as partes corretas retorna `202` com `status: "processing"`; repetir a chamada retorna `200` com o status atual
- `POST /videos/{public_id}/upload/parts` ou `.../upload/completion` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /api/docs-json` (Swagger habilitado) lista os três endpoints sob a tag `videos` com as respostas de erro documentadas

---

### SI-03.10 — Endpoints de consulta, streaming e download: GET /videos/{public_id}, /stream e /download

**Route:** GET /videos/{public_id}, GET /videos/{public_id}/stream, GET /videos/{public_id}/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Authenticated, owner-only (per `### Authorization Matrix`)

**Description:** Expõe no `VideosController` a consulta do vídeo e a entrega por redirecionamento `302` para URLs pré-assinadas, fechando o fluxo upload → processamento → streaming/download.

**Technical actions:**

1. `GET /videos/:public_id` → `@HttpCode(200)`, retorna `VideoResponse` de `VideosService.getVideo` (per `### API Contracts → GET /videos/{public_id}`, `phase-03-videos/TD-11`)
2. `GET /videos/:public_id/stream` → `@Redirect()` dinâmico retornando `{ url, statusCode: 302 }` com a URL de `VideosService.getStreamUrl` (per `### API Contracts → GET /videos/{public_id}/stream`, `phase-03-videos/TD-10`)
3. `GET /videos/:public_id/download` → mesmo mecanismo com `VideosService.getDownloadUrl` (per `### API Contracts → GET /videos/{public_id}/download`, `phase-03-videos/TD-10`)
4. Documentar os três handlers com `@ApiOperation` e `@ApiResponse` (`200` com `VideoResponse`; `302` com header `Location`; `401`, `404`, `409` referenciando `getSchemaPath(ApiErrorEnvelope)`) (per `openapi-docs-nestjs/TD-01`, `nestjs-controllers.md`)

**Tests:** _(empty — controller wiring; E2E scenarios (redirect, Range/206 via Location, 401/404/409, full upload→ready pipeline) are authored by /plan-test-specs in the spec file)_

**Dependencies:** SI-03.8 — `getVideo`, `getStreamUrl` e `getDownloadUrl`; SI-03.7 — worker que leva o vídeo a `ready`, necessário para o fluxo completo

**Acceptance criteria:**

- `GET /videos/{public_id}` pelo dono retorna `200` com o `status` atual; após o processamento, `status: "ready"`, `duration_seconds` e `thumbnail_url` preenchidos
- `GET /videos/{public_id}/stream` de um vídeo `ready` retorna `302` com `Location` para o storage; seguir o `Location` com `Range: bytes=0-1023` retorna `206 Partial Content`
- `GET /videos/{public_id}/download` de um vídeo `ready` retorna `302`; seguir o `Location` retorna o arquivo com `Content-Disposition: attachment` e o nome original
- `GET /videos/{public_id}/stream` ou `/download` de um vídeo ainda `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- Qualquer das três rotas chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`

---

### SI-03.11 — Contrato OpenAPI exportado e documentação de IA (CLAUDE.md) da fase de vídeos

**Description:** Atualiza o `openapi.json` exportado com os endpoints de vídeo e documenta no `CLAUDE.md` (raiz e `nestjs-project/`) o estado real do código após a fase — módulo de vídeos, endpoints, fila/worker e storage —, para que a fundação de IA não cite arquivos ou comportamentos inexistentes.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` (dentro do container) e versioná-lo junto do código (per `openapi-docs-nestjs/TD-02`)
2. Estender `src/openapi-export.integration-spec.ts` para afirmar que o documento exportado contém os seis paths de `### API Contracts` sob a tag `videos` (per `openapi-docs-nestjs/TD-01`)
3. Atualizar `nestjs-project/CLAUDE.md`: serviços `minio` (portas 9000/9001), `minio-init`, `redis` e `video-worker` em "Development Environment" e verificações de prontidão (`mc ready`, `redis-cli ping`, logs do worker) em "Environment Startup Verification"; nova seção "Videos, Storage & Queue" descrevendo `src/videos/`, `src/storage/`, `src/media/`, `src/worker.ts`, a fila `video-processing`, o ciclo `draft → processing → ready | failed`, as variáveis `S3_*`/`REDIS_*` e a regra de que `S3_PUBLIC_ENDPOINT` é o único host não-Compose (assina URLs para clientes externos) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
4. Atualizar o `CLAUDE.md` da raiz: na Architecture, Message Queue deixa de ser "TBD" e passa a "BullMQ on Redis"; Object Storage como MinIO local (S3-compatible); Video Worker como processo NestJS separado com FFmpeg; mencionar os endpoints `/videos` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`)
5. Atualizar `docs/diagrams/software-arch.mermaid` trocando `"TBD"` do `ContainerQueue(queue, ...)` por `"BullMQ / Redis"` e o `Container(worker, ...)` para refletir NestJS + FFmpeg (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Export OpenAPI | Integration: documento exportado contém `/videos`, `/videos/{public_id}`, `/videos/{public_id}/upload/parts`, `/videos/{public_id}/upload/completion`, `/videos/{public_id}/stream` e `/videos/{public_id}/download` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.7 — worker e Compose finais; SI-03.9 e SI-03.10 — todos os endpoints de vídeo existentes

**Acceptance criteria:**

- `nestjs-project/openapi.json` versionado contém os seis paths de vídeo com os códigos de resposta documentados em `### API Contracts`
- Todo arquivo, serviço do Compose, variável de ambiente e endpoint citado nas seções novas do `CLAUDE.md` (raiz e `nestjs-project/`) existe no código ao final da fase
- `docs/diagrams/software-arch.mermaid` não contém mais `"TBD"` para a fila
- Seguir apenas o `nestjs-project/CLAUDE.md` permite subir a stack completa (`docker compose up -d`) e verificar a prontidão de `db`, `minio`, `redis` e `video-worker`

---

## Technical Specifications

### Data Model

#### Video (table `videos`, SI-03.3)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated in the service (`randomUUID()`) before insert — also the root of the storage keys *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`)* |
| public_id | varchar(11) | unique, not null — 11-char base64url id from `crypto.randomBytes(8)`; used in every URL *(per `phase-03-videos/TD-09`)* |
| channel_id | uuid | FK → `channels.id`, not null — owner channel of the video |
| title | varchar(100) | not null — optional input at initiation, defaults to `original_file_name` without extension *(per `validation.md` → AMB-2 resolution)* |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` *(per `phase-03-videos/TD-11`)* |
| original_file_name | varchar(255) | not null — client-declared file name; source of the default title and of the download filename |
| content_type | varchar(100) | not null — client-declared MIME type, must match `video/*` *(per `phase-03-videos/TD-05`)* |
| file_size_bytes | bigint | not null — declared size, `1..10737418240` (10 GiB); mapped to `number` via column transformer (fits `Number.MAX_SAFE_INTEGER`) *(per `phase-03-videos/TD-05`)* |
| source_key | varchar(255) | not null — `videos/{id}/source` *(per `phase-03-videos/TD-03`)* |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; set at initiation, cleared (`NULL`) once the multipart is completed *(per `phase-03-videos/TD-05`)* |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, set when processing succeeds *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)* |
| duration_seconds | double precision | nullable — set by the worker from `ffprobe` `format.duration` *(per `phase-03-videos/TD-08`)* |
| metadata | jsonb | nullable — `{ width, height, video_codec, audio_codec, container_format, bit_rate, size_bytes }` from `ffprobe` *(per `phase-03-videos/TD-08`)* |
| processing_error | text | nullable — reason recorded when `status = failed` *(per `phase-03-videos/TD-11`)* |
| processed_at | timestamptz | nullable — set when the video reaches `ready` or `failed` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on change |

**Relations:** `Channel` has many `Video` (`@OneToMany` on `Channel.videos`, `@ManyToOne` + `@JoinColumn({ name: 'channel_id' })` on `Video.channel`).
**Indexes:** unique on `public_id`; b-tree on `channel_id`.
**Status transitions (only forward):** `draft → processing` (upload completed and verified, job enqueued); `draft → failed` (assembled object fails the size verification at completion); `processing → ready` (metadata + thumbnail persisted); `processing → failed` (last retry exhausted or non-retryable media error). `failed` and `ready` are terminal in this phase *(per `phase-03-videos/TD-11`)*. A `draft` whose upload is never completed stays `draft` (no cleanup in Phase 03 — per `validation.md` → AMB-3); its incomplete multipart bytes are reclaimed by storage-side expiry *(per `phase-03-videos/TD-03`)*.
**Migration:** `<timestamp>-CreateVideos.ts` creates `videos_status_enum`, the `videos` table, the unique index on `public_id`, the index on `channel_id` and the FK to `channels`; `down()` drops them in reverse order (generated via TypeORM CLI per `typeorm-migrations.md`).

#### Object storage layout (SI-03.1, SI-03.2)

| Key | Written by | Content |
|-----|------------|---------|
| `videos/{id}/source` | client, directly via presigned multipart part URLs | original uploaded file *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)* |
| `videos/{id}/thumbnail.jpg` | video worker (`PutObject`) | JPEG frame at 10% of the duration, scaled to 1280px width *(per `phase-03-videos/TD-08`)* |

Single private bucket named by `S3_BUCKET`, created by the one-shot `minio-init` Compose service (`mc mb --ignore-existing`); no anonymous read policy — every external access is a presigned URL *(per `phase-03-videos/TD-03`)*.

### API Contracts

All endpoints live under `@Controller('videos')` (`@ApiTags('videos')`), are protected by the global JWT guard (no `@Public()`), are owner-scoped (see Authorization Matrix) and identify the video by its `public_id` path parameter *(per `phase-03-videos/TD-09`)*. Video bytes never cross the API: uploads go straight to storage through presigned part URLs and playback/download redirect to presigned GET URLs *(per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)*. Every error uses the inherited envelope `{ statusCode, error, message }` *(per `phase-02-auth/TD-07`)*; a missing/invalid access token yields the guard's default `401` (`{ statusCode: 401, message: 'Unauthorized' }`) inherited from Phase 02.

**`VideoResponse` shape** (returned by several endpoints below; response DTO with explicit `@ApiProperty`, per `nestjs-dtos.md`):
- public_id: string — 11-char base64url
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- original_file_name: string
- content_type: string
- file_size_bytes: number
- duration_seconds: number | null
- metadata: `{ width, height, video_codec, audio_codec, container_format, bit_rate, size_bytes }` | null
- thumbnail_url: string | null — presigned GET URL on the public endpoint (TTL 3600 s), present only when `thumbnail_key` is set *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)*
- processing_error: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

---

#### POST /videos (SI-03.4)

Pre-registers the video as `draft` and starts the S3 multipart upload in the same request *(per `phase-03-videos/TD-06`)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- file_name: string, required — 1..255 characters
- file_size: integer, required — 1..10737418240 bytes (10 GiB) *(per `phase-03-videos/TD-05`)*
- content_type: string, required — must match `^video\/[\w.+-]+$` *(per `phase-03-videos/TD-05`)*
- title: string, optional — 1..100 characters; when omitted, `file_name` without its extension (truncated to 100) *(per `validation.md` → AMB-2 resolution)*

**Response 201:**
- `VideoResponse` (status `draft`) plus
- upload: `{ part_size: 67108864, part_count: number }` — `part_count = ceil(file_size / part_size)` (64 MiB parts, ≤ 160 parts for 10 GiB) *(per `phase-03-videos/TD-05`)*

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation (missing field, size above 10 GiB, non-`video/*` content type, title too long)
- 401: when the access token is missing or invalid

---

#### POST /videos/{public_id}/upload/parts (SI-03.5)

Issues presigned `UploadPart` URLs on demand for the requested part numbers, signed with the public endpoint client *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- part_numbers: integer[], required — 1..100 unique items, each `>= 1`

**Response 200:**
- parts: `[{ part_number: number, url: string }]` — one presigned `PUT` URL per requested part, in request order
- expires_in: 3600 (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the caller is not its owner
- 409 UPLOAD_NOT_IN_PROGRESS: when the video is no longer `draft` (upload already completed)
- 400 INVALID_UPLOAD_PARTS: when a requested part number is greater than the video's `part_count`
- 400 VALIDATION_ERROR: when `part_numbers` is missing, empty, has duplicates, more than 100 items or a value `< 1`
- 401: when the access token is missing or invalid

---

#### POST /videos/{public_id}/upload/completion (SI-03.6)

Completes the multipart upload, verifies the assembled object and moves the video to `processing`, enqueuing the `process-video` job *(per `phase-03-videos/TD-06`, `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)*. Idempotent: a repeated call on a video that already left `draft` performs no storage or queue operation.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: `[{ part_number: integer, etag: string }]`, required — 1..10000 items; `part_number >= 1`; `etag` non-empty (the `ETag` header returned by each part `PUT`)

**Response 202:** `VideoResponse` with `status: processing` — on the `draft → processing` transition.

**Response 200:** `VideoResponse` with the current status — when the video had already left `draft` (repeated call, no side effects).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the caller is not its owner
- 400 INVALID_UPLOAD_PARTS: when storage rejects `CompleteMultipartUpload` (missing part, wrong ETag, invalid order); the video stays `draft` so the client can fix the list and retry
- 422 UPLOAD_SIZE_MISMATCH: when the assembled object's size (`HeadObject.ContentLength`) differs from the declared `file_size` or exceeds 10 GiB; the object is deleted and the video moves to `failed` *(per `phase-03-videos/TD-05`)*
- 400 VALIDATION_ERROR: when the body fails validation
- 401: when the access token is missing or invalid

---

#### GET /videos/{public_id} (SI-03.9)

Returns the video and its processing state, so the uploader can follow `draft → processing → ready | failed` *(per `phase-03-videos/TD-11`)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** `VideoResponse`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the caller is not its owner
- 401: when the access token is missing or invalid

---

#### GET /videos/{public_id}/stream (SI-03.10)

Redirects to a presigned GET URL of the source object; storage serves `Range` requests with `206 Partial Content`, so playback never requires the full download *(per `phase-03-videos/TD-10`)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned `GetObject` URL on the public endpoint (TTL 3600 s), with `response-content-type` = the video's `content_type` *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-10`)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the caller is not its owner
- 409 VIDEO_NOT_READY: when the video status is not `ready` *(per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)*
- 401: when the access token is missing or invalid

---

#### GET /videos/{public_id}/download (SI-03.10)

Redirects to a presigned GET URL that forces a file download *(per `phase-03-videos/TD-10`)*.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned `GetObject` URL on the public endpoint (TTL 3600 s) with `ResponseContentDisposition` = `attachment; filename="{ascii fallback}"; filename*=UTF-8''{percent-encoded original_file_name}` *(per `phase-03-videos/TD-10`, `validation.md` → AMB-2 resolution)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the caller is not its owner
- 409 VIDEO_NOT_READY: when the video status is not `ready`
- 401: when the access token is missing or invalid

---

#### Validation Rules — Video upload

- `file_name`: required, string, 1..255 characters
- `file_size`: required, integer, `>= 1`, `<= 10737418240` (10 GiB)
- `content_type`: required, string, matches `^video\/[\w.+-]+$`
- `title`: optional, string, 1..100 characters
- `part_numbers`: required array, 1..100 unique integers, each `>= 1` (upper bound `part_count` enforced by the service → `INVALID_UPLOAD_PARTS`)
- `parts`: required array, 1..10000 items of `{ part_number: integer >= 1, etag: non-empty string }`
- `public_id` path parameter: unknown values resolve to `VIDEO_NOT_FOUND` (no format error surface)

### Authorization Matrix

"Owner" = the authenticated user whose channel (`channels.user_id = JWT sub`) owns the video (`videos.channel_id`). In Phase 03 only the owner may act on or obtain URLs for a video; any other authenticated caller receives `404 VIDEO_NOT_FOUND` so the existence of other channels' drafts is not revealed *(per `validation.md` → AMB-1 resolution)*. Phase 04 (visibility) and Phase 05 (anonymous viewing) may widen these rules. The ownership decision lives in `VideosService` (business rule), not in a guard or the controller (`nestjs-layer-separation.md`).

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (becomes the owner via own channel) | — |
| POST /videos/{public_id}/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/{public_id}/upload/completion | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{public_id} | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{public_id}/stream | ✗ (401) | ✗ (404) | ✓ (only when `ready`) |
| GET /videos/{public_id}/download | ✗ (401) | ✗ (404) | ✓ (only when `ready`) |

Presigned URLs returned by these endpoints are bearer capabilities for their TTL (part URLs and stream/download URLs: 3600 s); they are issued only after the ownership check above *(per `phase-03-videos/TD-10`)*.

### Error Catalog

**Error response format:** inherited from Phase 02 — `{ statusCode: number, error: string, message: string }`; validation errors use `error: "VALIDATION_ERROR"` with `message` as an array of field errors *(per `phase-02-auth/TD-07`)*. New codes are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`, mapped by the existing `DomainExceptionFilter`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/{public_id}...` endpoint when the `public_id` does not exist OR the caller is not the owner |
| UPLOAD_NOT_IN_PROGRESS | 409 | Upload is not in progress for this video | POST /videos/{public_id}/upload/parts when the video status is not `draft` |
| INVALID_UPLOAD_PARTS | 400 | Upload parts are invalid | POST .../upload/parts with a part number greater than `part_count`; POST .../upload/completion when storage rejects `CompleteMultipartUpload` (S3 `InvalidPart` / `InvalidPartOrder` / `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | POST .../upload/completion when `HeadObject.ContentLength` ≠ declared `file_size` or > 10 GiB (video → `failed`, object deleted) |
| VIDEO_NOT_READY | 409 | Video is not ready yet | GET .../stream or GET .../download when the video status is not `ready` |

Worker-side failures are not HTTP errors: they are recorded in `videos.processing_error` with `status = failed` (see Events/Messages) *(per `phase-03-videos/TD-11`)*.

### Events/Messages

#### Queue `video-processing` — job `process-video` (SI-03.6 producer, SI-03.8 consumer)

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` is the internal `videos.id` (never the `public_id`); the consumer reloads the row, so the payload carries no denormalized state. Queue name and job name live in `src/videos/videos.constants.ts` (`as const`, per `nestjs-common-conventions.md`).

**Producer:** `VideosService.completeUpload` in the API process, via `@InjectQueue(VIDEO_PROCESSING_QUEUE)` — enqueued only on the `draft → processing` transition, after the DB update is committed *(per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`)*.
**Consumer:** `VideoProcessingProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, `extends WorkerHost`) registered **only** in the worker application context (`src/worker.ts` → `WorkerModule`), running as the `video-worker` Compose service *(per `phase-03-videos/TD-07`)*.
**Trigger:** `POST /videos/{public_id}/upload/completion` succeeds the size verification.
**Delivery semantics:** at-least-once *(per `phase-03-videos/TD-04`)*:
- **Idempotent enqueue:** job option `jobId = videoId` — a repeated `add` for the same video is ignored by BullMQ (UUIDs contain no `:` and are not digit-only, as BullMQ requires). Completed/failed jobs are kept (no `removeOnComplete`/`removeOnFail`) so the id keeps deduplicating.
- **Idempotent processing:** the processor skips videos whose status is not `processing`; re-running overwrites the same `thumbnail_key` object and the same metadata columns, so a redelivered job produces the same final row.
- **Retries:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` as `defaultJobOptions` of the queue *(per `phase-03-videos/TD-11`)*.
- **Non-retryable failures:** `ffprobe` cannot read the file or the file has no video stream → the processor throws BullMQ `UnrecoverableError`, skipping remaining attempts *(per `phase-03-videos/TD-11`)*.
- **Terminal failure:** on `@OnWorkerEvent('failed')`, when the error is an `UnrecoverableError` or `job.attemptsMade >= job.opts.attempts`, the video is set to `status = failed`, `processing_error = <error message>`, `processed_at = now()`. Intermediate failures leave `status = processing` *(per `phase-03-videos/TD-11`)*. Catch-and-log without rethrow is allowed here because it is a background event handler (`nestjs-services.md`).

**Processing steps (consumer):**
1. Load the video by `videoId`; return early when not found or `status !== 'processing'`.
2. Presign a short-lived GET URL for `source_key` with the **internal** endpoint client and run `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile` (no shell) *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)*.
3. Map the JSON to `duration_seconds` (`format.duration`) and `metadata` (`width`, `height`, `video_codec` from the first video stream; `audio_codec` from the first audio stream or `null`; `container_format` = `format.format_name`; `bit_rate`; `size_bytes` = `format.size`).
4. Run `ffmpeg -ss <10% of duration, 0 when unknown> -i <url> -frames:v 1 -vf scale=1280:-2 -q:v 3 <tmp>.jpg` and upload it with `PutObject` to `videos/{id}/thumbnail.jpg` (`ContentType: image/jpeg`); delete the temp file in `finally` *(per `phase-03-videos/TD-08`)*.
5. Update the row in one statement: `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processing_error = NULL`, `processed_at = now()`.

---

## Dependency Map

```
SI-03.1 (root — libs, FFmpeg, configs, MinIO/Redis no Compose)
├── SI-03.2 — depends on SI-03.1 (MinIO + AWS SDK + storageConfig)
│   ├── SI-03.6 — depends on SI-03.2 (fixture servida por URL interna; FFmpeg da imagem de SI-03.1)
│   └── SI-03.4 — depends on SI-03.2 + SI-03.3 (multipart e assinatura sobre a entidade Video)
│       ├── SI-03.5 — depends on SI-03.4 (conclui o upload iniciado; publica o job)
│       │   └── SI-03.7 — depends on SI-03.5 + SI-03.6 (consome o job; usa MediaProbeService)
│       ├── SI-03.8 — depends on SI-03.4 (regra de propriedade e VideoResponse)
│       └── SI-03.9 — depends on SI-03.4 + SI-03.5 (rotas de upload sobre os métodos do serviço)
└── SI-03.3 — depends on SI-03.1 (ambiente atualizado)

SI-03.10 — depends on SI-03.8 + SI-03.7 (rotas de entrega; fluxo completo exige worker)
SI-03.11 — depends on SI-03.7 + SI-03.9 + SI-03.10 (OpenAPI e CLAUDE.md refletem o código final)
```

Ordem linearizada: SI-03.1 → SI-03.2, SI-03.3 (paralelos) → SI-03.4 → SI-03.5, SI-03.6, SI-03.8 (paralelos) → SI-03.7, SI-03.9 (paralelos) → SI-03.10 → SI-03.11

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração de storage/fila e serviços MinIO/Redis no Compose
- [ ] SI-03.2 — StorageModule: cliente S3 para MinIO com endpoints interno e público
- [ ] SI-03.3 — Entidade Video, migration CreateVideos e VideosModule
- [ ] SI-03.4 — Pré-cadastro do vídeo como rascunho e URLs pré-assinadas das partes
- [ ] SI-03.5 — Conclusão do upload e publicação do job na fila BullMQ
- [ ] SI-03.6 — MediaProbeService: extração de metadados e thumbnail com ffprobe/ffmpeg
- [ ] SI-03.7 — Worker de vídeo: processor BullMQ, entrypoint próprio e serviço video-worker no Compose
- [ ] SI-03.8 — Consulta do vídeo e URLs de streaming e download
- [ ] SI-03.9 — Endpoints de upload: POST /videos, POST /videos/{public_id}/upload/parts e POST /videos/{public_id}/upload/completion
- [ ] SI-03.10 — Endpoints de consulta, streaming e download: GET /videos/{public_id}, /stream e /download
- [ ] SI-03.11 — Contrato OpenAPI exportado e documentação de IA (CLAUDE.md) da fase de vídeos

**Phase deliverables (from `docs/project-plan.md`):**

- [ ] Upload de até 10GB funcional — multipart pré-assinado direto ao MinIO, sem bytes de vídeo na API
- [ ] Processamento automático do vídeo — duração, metadados e thumbnail gerados pelo `video-worker` via fila
- [ ] Streaming funcionando — `302` para URL pré-assinada com suporte a `Range`/`206`
- [ ] URLs únicas geradas — `public_id` de 11 caracteres com índice único
- [ ] Object storage (`minio` + `minio-init`), fila (`redis`) e worker (`video-worker`) sobem com `docker compose up -d`

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, including the worker entrypoint (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
