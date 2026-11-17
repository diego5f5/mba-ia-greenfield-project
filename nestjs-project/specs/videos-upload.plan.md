---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload.e2e-spec.ts
---

# Upload de vídeos (POST /videos, /upload/parts, /upload/completion) — Test Plan

## Application Overview

O fluxo de upload da Fase 03 é exposto por três rotas autenticadas do `VideosController`. `POST /videos` pré-cadastra o vídeo como `draft` e inicia um multipart upload no MinIO, devolvendo o `public_id` (URL única) e o plano de partes (64 MiB por parte). `POST /videos/{public_id}/upload/parts` emite URLs pré-assinadas de `UploadPart` sob demanda — o cliente envia os bytes **direto ao MinIO**, nunca pela API. `POST /videos/{public_id}/upload/completion` conclui o multipart, verifica o tamanho do objeto montado e leva o vídeo a `processing`, publicando o job `process-video` na fila `video-processing` (202 na transição, 200 em chamadas repetidas). Todas as rotas com `{public_id}` são exclusivas do dono do vídeo; outro usuário recebe `404 VIDEO_NOT_FOUND`. Contratos em `docs/phases/phase-03-videos/phase-03-videos.md` → `### API Contracts`.

## Test Scenarios

### 1. Iniciar o upload com pré-cadastro do vídeo como rascunho

**Setup:** `beforeAll` sobrescreve `process.env.S3_PUBLIC_ENDPOINT` com o valor de `S3_ENDPOINT` (o teste roda dentro da rede do Compose, onde `localhost:9000` não alcança o MinIO), compila `AppModule` via `Test.createTestingModule(...)`, cria a app aplicando os mesmos `ValidationPipe` e filtros globais do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o storage do throttler; dois usuários confirmados (`owner` e `other`) obtêm `access_token` via `POST /auth/login`; `afterAll` fecha a app.

#### 1.1. cria-video-draft-com-plano-de-partes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <owner>` e body `{ "file_name": "aula.mp4", "file_size": 1048576, "content_type": "video/mp4" }`
    - expect: status `201`
    - expect: body com `public_id` de 11 caracteres no alfabeto `[A-Za-z0-9_-]`, `status: "draft"`, `title: "aula"`, `original_file_name: "aula.mp4"`, `file_size_bytes: 1048576`, `thumbnail_url: null`
    - expect: body `upload` igual a `{ "part_size": 67108864, "part_count": 1 }`
  2. Consultar a tabela `videos` pelo `public_id` retornado
    - expect: linha com `status = 'draft'`, `upload_id` não nulo, `source_key = 'videos/{id}/source'` e `channel_id` igual ao canal do `owner`

#### 1.2. rejeita-tamanho-acima-de-10gib-e-tipo-nao-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. POST /videos (owner) com `file_size: 10737418241` e `content_type: "video/mp4"`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` citando `file_size`
  2. POST /videos (owner) com `file_size: 1048576` e `content_type: "image/png"`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` citando `content_type`
  3. Consultar a tabela `videos`
    - expect: nenhuma linha criada

#### 1.3. exige-autenticacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. POST /videos sem header `Authorization` e body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`

### 2. Enviar as partes direto ao storage e concluir o upload

**Setup:** mesmo do grupo 1; cada cenário cria o vídeo via `POST /videos` (owner) com um buffer de 1 MiB de bytes conhecidos (`file_size: 1048576`, `part_count: 1`).

#### 2.1. emite-url-de-parte-que-aceita-put-no-storage

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/parts (owner) com body `{ "part_numbers": [1] }`
    - expect: status `200`
    - expect: body `parts` com um item `{ part_number: 1, url }` e `expires_in: 3600`
  2. `fetch(url, { method: 'PUT', body: <buffer de 1 MiB> })` direto no MinIO (sem passar pela API)
    - expect: status `200` e header `ETag` presente

#### 2.2. conclui-upload-e-enfileira-processamento-de-forma-idempotente

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. Obter a URL da parte 1 e fazer o `PUT` do buffer, guardando o `ETag`
    - expect: `ETag` retornado
  2. POST /videos/{public_id}/upload/completion (owner) com `{ "parts": [{ "part_number": 1, "etag": "<ETag>" }] }`
    - expect: status `202` com `status: "processing"`
    - expect: na fila `video-processing` existe o job de id igual ao `videos.id`, nome `process-video` e payload `{ "videoId": "<videos.id>" }`
  3. Repetir a mesma chamada de conclusão
    - expect: status `200` com o status atual do vídeo
    - expect: a fila continua com um único job para esse vídeo

#### 2.3. rejeita-acesso-de-quem-nao-e-dono

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/parts com `Authorization: Bearer <other>` e `{ "part_numbers": [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. POST /videos/{public_id}/upload/completion com `Authorization: Bearer <other>` e uma lista de partes qualquer
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo do `owner` continua `draft` no banco

### 3. Documentação OpenAPI das rotas de upload

**Setup:** mesma app do grupo 1; o documento é construído com `buildSwaggerDocument(app)` (mesma função usada pelo `main.ts` e pelo `test/swagger.e2e-spec.ts`).

#### 3.1. rotas-de-upload-documentadas-sob-a-tag-videos

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. Construir o documento OpenAPI da app
    - expect: `paths['/videos'].post`, `paths['/videos/{public_id}/upload/parts'].post` e `paths['/videos/{public_id}/upload/completion'].post` existem com `tags` contendo `videos`
    - expect: `POST /videos` documenta `201`, `400` e `401`; `.../upload/parts` documenta `200`, `400`, `401`, `404` e `409`; `.../upload/completion` documenta `200`, `202`, `400`, `401`, `404` e `422`
    - expect: as respostas de erro referenciam o schema `ApiErrorEnvelope`
