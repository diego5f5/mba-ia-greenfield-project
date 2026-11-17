---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-delivery.e2e-spec.ts
---

# Consulta, streaming e download de vídeos (GET /videos/{public_id}, /stream, /download) — Test Plan

## Application Overview

Depois do upload, o dono acompanha o ciclo `draft → processing → ready | failed` por `GET /videos/{public_id}` e consome o vídeo por duas rotas que **redirecionam** (`302`) para URLs pré-assinadas do MinIO: `/stream` (o storage atende `Range` com `206 Partial Content`, então a reprodução não exige baixar o arquivo inteiro) e `/download` (força `Content-Disposition: attachment` com o nome original). Ambas só liberam a URL quando o vídeo está `ready` (`409 VIDEO_NOT_READY` antes disso) e apenas para o dono (`404 VIDEO_NOT_FOUND` para os demais). Este spec cobre o fluxo ponta a ponta com infraestrutura real: API → MinIO → fila Redis → worker com FFmpeg → banco. Contratos em `docs/phases/phase-03-videos/phase-03-videos.md` → `### API Contracts`.

## Test Scenarios

### 1. Fluxo completo: upload → processamento automático → consulta, streaming e download

**Setup:** `beforeAll` sobrescreve `process.env.S3_PUBLIC_ENDPOINT` com o valor de `S3_ENDPOINT` (teste interno à rede do Compose), compila `AppModule` e cria a app aplicando os `ValidationPipe`/filtros globais do `main.ts`; cria também o contexto do worker com `NestFactory.createApplicationContext(WorkerModule)` para que o job `process-video` seja consumido no próprio teste (o serviço `video-worker` do Compose, se estiver rodando, executa o mesmo código sobre o mesmo banco e não altera o resultado); gera a fixture MP4 de 3 s com `src/test/video-fixture.ts`; dois usuários confirmados (`owner`, `other`) fazem login. `beforeEach` executa `cleanAllTables`. Helper do spec: `uploadVideo(token, buffer)` executa `POST /videos` → `POST .../upload/parts` → `PUT` da parte no MinIO → `POST .../upload/completion` e devolve o `public_id`; `waitForStatus(public_id, status)` faz polling de `GET /videos/{public_id}` a cada 500 ms por até 60 s. `afterAll` fecha app e contexto do worker.

#### 1.1. consulta-mostra-video-ready-com-metadados-e-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. `uploadVideo(owner, fixture)` e, logo após a conclusão, GET /videos/{public_id} (owner)
    - expect: status `200` com `status` igual a `"processing"` ou `"ready"`
  2. `waitForStatus(public_id, "ready")`
    - expect: GET /videos/{public_id} retorna `200` com `status: "ready"`, `duration_seconds` entre 2.9 e 3.1, `metadata.width: 320`, `metadata.height: 240`, `metadata.video_codec: "h264"`
    - expect: `thumbnail_url` não nulo; `GET` nessa URL responde `200` com `Content-Type: image/jpeg`

#### 1.2. stream-redireciona-para-storage-com-suporte-a-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. Com o vídeo `ready`, GET /videos/{public_id}/stream (owner) sem seguir redirects
    - expect: status `302` com header `Location` apontando para o host do storage e o caminho do objeto `videos/{id}/source`
  2. `fetch(Location, { headers: { Range: 'bytes=0-1023' } })`
    - expect: status `206 Partial Content`, corpo com exatamente 1024 bytes e header `Content-Range: bytes 0-1023/<tamanho da fixture>`
    - expect: `Content-Type` igual ao `content_type` declarado no upload (`video/mp4`)

#### 1.3. download-redireciona-com-content-disposition-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. Com o vídeo `ready` (enviado com `file_name: "aula de vídeo.mp4"`), GET /videos/{public_id}/download (owner) sem seguir redirects
    - expect: status `302` com header `Location` para o storage
  2. `fetch(Location)`
    - expect: status `200` com corpo de tamanho igual ao da fixture
    - expect: header `Content-Disposition` começando com `attachment` e contendo `filename*=UTF-8''aula%20de%20v%C3%ADdeo.mp4`

### 2. Regras de disponibilidade e de acesso

**Setup:** mesmo do grupo 1; os cenários usam um vídeo criado e concluído pelo `owner` e, quando indicado, verificado antes de o worker terminar (consulta imediata após a conclusão) ou mantido em `draft` (sem chamar a conclusão).

#### 2.1. stream-e-download-recusados-antes-de-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. Criar um vídeo com `POST /videos` (owner) sem concluir o upload — permanece `draft`
    - expect: GET /videos/{public_id} retorna `status: "draft"`
  2. GET /videos/{public_id}/stream (owner)
    - expect: status `409` com `error: "VIDEO_NOT_READY"`
  3. GET /videos/{public_id}/download (owner)
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 2.2. outro-usuario-recebe-404-nas-tres-rotas

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. `uploadVideo(owner, fixture)` e `waitForStatus(public_id, "ready")`
    - expect: vídeo `ready`
  2. GET /videos/{public_id}, GET /videos/{public_id}/stream e GET /videos/{public_id}/download com `Authorization: Bearer <other>`
    - expect: as três respondem `404` com `error: "VIDEO_NOT_FOUND"` e nenhuma contém header `Location`
  3. GET /videos/{public_id_inexistente} (owner) com um `public_id` de 11 caracteres que não existe
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"` — mesma resposta do não-dono (nada é revelado)

#### 2.3. rotas-exigem-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-17T12:39:09Z

**Steps:**
  1. GET /videos/{public_id}, GET /videos/{public_id}/stream e GET /videos/{public_id}/download sem header `Authorization`
    - expect: as três respondem `401`
