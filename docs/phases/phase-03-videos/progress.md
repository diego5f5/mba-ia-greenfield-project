# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/11 completed

### SI-03.1 — Infra: dependências, configuração de storage/fila e serviços MinIO/Redis no Compose
- **Status:** completed
- **Tests:** 8 passing (`src/config/env.validation.integration-spec.ts`)
- **Observations:**
  - **Imagem MinIO:** `minio/minio`/`minio/mc` não existem mais no Docker Hub e `quay.io/minio/*` exige login (MinIO parou de publicar a imagem comunitária em out/2025). Com aprovação do usuário, o Compose usa `cgr.dev/chainguard/minio` (mesmo binário MinIO, gratuito) fixado por digest sha256, já que só a tag `latest` é pública. A imagem traz `mc` e `sh`, então o healthcheck (`mc ready local`, alias via `MC_HOST_local`) e o `minio-init` usam a mesma imagem — não foi preciso a imagem `minio/mc` citada no plano.
  - **Supply chain:** o digest fixado corresponde ao MinIO `RELEASE.2026-11-16`, mais novo que a política de "≥2 semanas" usada para as libs npm; não há tag mais antiga gratuita disponível na Chainguard. Redis fixado em `redis:7.4.12-alpine`.
  - **Portas extras publicadas:** `minio` 9000/9001 (necessário para o `S3_PUBLIC_ENDPOINT=http://localhost:9000` usado pelo navegador/curl no host) e `redis` 6379 (inspeção local).
  - **Fora de escopo (pendência já anotada):** `.env.example` mantém `MAIL_FROM` sem aspas, o que quebra o parser do Compose para quem copia o arquivo; correção fica para uma tarefa separada.

### SI-03.2 — StorageModule: cliente S3 para MinIO com endpoints interno e público
- **Status:** completed
- **Tests:** 8 passing (`src/storage/storage.module.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:**
  - `responseChecksumValidation: 'WHEN_REQUIRED'` também foi definido (além do `requestChecksumCalculation` pedido pelo TD-01) para que downloads parciais (`Range`) não disparem validação de checksum do objeto inteiro.
  - `StorageService` implementa `OnModuleDestroy` para destruir os dois `S3Client` (evita sockets abertos segurando o Jest).
  - Teste de integração: `fetch` com corpo `Buffer` não compila com os tipos atuais de `BodyInit`; o corpo é convertido para `Uint8Array`.

### SI-03.3 — Entidade Video, migration CreateVideos e VideosModule
- **Status:** completed
- **Tests:** 88 passing em 15 suítes (novos: `video.entity.integration-spec.ts`, `videos.module.spec.ts`, `migrations.integration-spec.ts` estendido; regressão das 10 suítes existentes que listam entidades)
- **Observations:**
  - Migration gerada pela CLI (`1794920038153-CreateVideos.ts`) e aplicada; o SQL gerado confere com o Data Model do plano (enum, tabela, UNIQUE em `public_id`, índice e FK em `channel_id`). Passou por `prettier` como os demais arquivos do projeto.
  - `file_size_bytes` é `bigint`; o `pg` devolve string, então a entidade usa um `ValueTransformer` para expor `number` (10 GiB cabe em `Number.MAX_SAFE_INTEGER`). Coberto por teste com 10 GiB.
  - `VideosModule` (nesta SI) só importa `TypeOrmModule.forFeature([Video])` e já está no `AppModule`; providers/controller chegam nas SIs seguintes.
  - Todas as listas `ALL_ENTITIES` dos testes existentes ganharam `Video`, porque `Channel` agora referencia `Video` (relação `@OneToMany`) e o TypeORM exige a entidade registrada em qualquer DataSource que carregue `Channel`.
  - Um script meu de inserção de import quebrou 10 arquivos de teste (arquivos CRLF; a busca por `;\n` falhou e o import caiu no início da primeira linha). Detectado pelo subagent de testes, corrigido e revalidado (88 testes verdes) antes do commit — nada disso chegou ao histórico.

### SI-03.4 — Pré-cadastro do vídeo como rascunho e URLs pré-assinadas das partes
- **Status:** completed
- **Tests:** 45 passing (`public-id.util.spec`, `videos.service.spec`, `videos.service.integration-spec`, `videos.module.spec`, `pg-errors.util.spec`, `channels.service.integration-spec` + `channels.service.spec` de regressão)
- **Observations:**
  - **Desvio do plano (SAVEPOINT):** o plano pedia SAVEPOINT por tentativa no retry de `public_id`. Como o `INSERT` não roda dentro de transação, a violação de unicidade não deixa nada "abortado" e o retry simples basta — o SAVEPOINT de `typeorm-queries.md` só se aplica dentro de `dataSource.transaction`. O retry (até 5 tentativas, cada uma com novo `public_id`) está coberto por teste unitário, e a falha de todas as tentativas aborta o multipart.
  - **Helper compartilhado:** `isPgUniqueViolationOnColumn` foi para `src/common/database/pg-errors.util.ts` (com spec). `ChannelsService` ainda tem uma cópia privada equivalente — migrá-la para o helper é refactor fora de escopo (sugestão para tarefa separada).
  - **Propriedade em uma query só:** `findOwnedVideo` usa `where: { public_id, channel: { user_id } }`, então vídeo inexistente e vídeo de outro dono produzem o mesmo `VIDEO_NOT_FOUND`. O método e o `toResponse` (inclui `thumbnail_url` presignada quando há `thumbnail_key`) já ficaram prontos aqui porque `createVideo` os exige; SI-03.8 apenas os reutiliza em `getVideo`.
  - Usuário sem canal em `createVideo` lança `Error` genérico (500) sem criar multipart: todo usuário ganha canal no cadastro, então a ausência é inconsistência de dados, não erro de domínio do catálogo.
  - Compensação: se o `INSERT` falha, o multipart é abortado; se o próprio aborto falhar, o erro é logado e o erro **original** é relançado. Teste de integração confirma o aborto real (PUT numa URL daquele `upload_id` passa a responder `404`).
  - Nomes dos DTOs de resposta: `VideoResponseDto`, `CreateVideoResponseDto`, `UploadPartUrlsResponseDto` (convenção `*Dto` do projeto; o plano os chama `VideoResponse`).

### SI-03.5 — Conclusão do upload e publicação do job na fila BullMQ
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — MediaProbeService: extração de metadados e thumbnail com ffprobe/ffmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Worker de vídeo: processor BullMQ, entrypoint próprio e serviço video-worker no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Consulta do vídeo e URLs de streaming e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoints de upload: POST /videos, POST /videos/{public_id}/upload/parts e POST /videos/{public_id}/upload/completion
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoints de consulta, streaming e download: GET /videos/{public_id}, /stream e /download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Contrato OpenAPI exportado e documentação de IA (CLAUDE.md) da fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
