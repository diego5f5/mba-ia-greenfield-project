# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/11 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Pré-cadastro do vídeo como rascunho e URLs pré-assinadas das partes
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
