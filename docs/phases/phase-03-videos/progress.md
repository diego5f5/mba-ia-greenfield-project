# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/11 completed

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
- **Status:** completed
- **Tests:** 54 passing (`videos.service.spec`, `videos.service.integration-spec`, `videos.module.spec`, `storage.service.integration-spec`) + 52 e2e de regressão (app/swagger/auth, que agora sobem o `AppModule` com a conexão Redis)
- **Observations:**
  - **Correção de dependência 1 — `ioredis`:** o `bullmq` 6 declara `ioredis` como peer dependency *opcional*, então o `npm install bullmq` não o instala e qualquer `Queue` falha com `BullMQ could not load the optional 'ioredis' package`. Foi adicionado `ioredis@5.11.1` (exato; linha 5, mais recente com ≥2 semanas) como dependência direta. O `library-refs.md` da fase não registrava isso.
  - **Correção de dependência 2 — `@nestjs/bullmq`:** a versão 12.0.0 fixada no plano (SI-03.1) é ESM-only (`"type": "module"`) e o Jest CommonJS do projeto não consegue carregá-la (`SyntaxError: Unexpected token 'export'` em todas as suítes que importam `AppModule`). Trocada por `@nestjs/bullmq@11.0.5` (CommonJS; aceita `bullmq ^6` e `@nestjs/core ^11`; mesma API). `library-refs.md` atualizado com as duas pinagens e a justificativa; o texto do plano (`phase-03-videos.md`, SI-03.1) foi mantido como está — o desvio fica registrado aqui e no `library-refs.md`.
  - **Falha no enfileiramento (fora do plano):** se `queue.add` falhar (ex.: Redis fora do ar) depois da transição `draft → processing`, o vídeo ficaria preso em `processing` sem job, e uma nova chamada de conclusão seria no-op. O serviço agora o marca `failed` com `processing_error = 'ENQUEUE_FAILED: <causa>'` e relança o erro. Coberto por teste unitário.
  - **Corrida entre conclusões simultâneas:** a transição usa `UPDATE ... WHERE status = 'draft'` (claim condicional) e, se o storage rejeitar a conclusão porque outra chamada já a concluiu, o serviço relê o vídeo e devolve o estado atual com `transitioned: false` em vez de `INVALID_UPLOAD_PARTS`. Ambos os ramos têm teste unitário.
  - **Teste de integração × worker:** os testes não afirmam `status` no banco depois da conclusão, porque o serviço `video-worker` (SI-03.7) vai consumir jobs na mesma stack; a transição é verificada pelo retorno do serviço e pela presença do job (nome, payload `{ videoId }`, `jobId` = `videos.id`, `attempts: 3`). Os jobs criados pelos testes são removidos no `afterEach`.
  - **"A API não consome jobs":** verificado manualmente — com só o `nestjs-api` rodando, um job publicado na fila `video-processing` permaneceu `waiting` com 0 workers conectados. `VideosModule` não registra nenhum `@Processor`.
  - `VIDEO_PROCESSING_QUEUE_JOB_OPTIONS` (`attempts: 3`, backoff exponencial de 5000 ms, sem `removeOnComplete`/`removeOnFail`) fica em `videos.constants.ts` e é conferido por `videos.module.spec.ts` via `queue.defaultJobOptions`.

### SI-03.6 — MediaProbeService: extração de metadados e thumbnail com ffprobe/ffmpeg
- **Status:** completed
- **Tests:** 15 passing (`src/media/media-probe.service.spec.ts`, `src/media/media-probe.service.integration-spec.ts`); suíte completa 232 + 52 e2e, `tsc` e `lint` limpos
- **Observations:**
  - **Erro de infraestrutura × mídia inválida:** só o código de saída numérico do `ffprobe` (≠ 0) vira `InvalidMediaError`. `ENOENT` (binário ausente) e timeout propagam como erro comum, para o worker (SI-03.7) poder tentar de novo em vez de marcar o vídeo como inválido.
  - **Sem vazar a URL pré-assinada:** a mensagem do `InvalidMediaError` não inclui o stderr do `ffprobe` (pode conter a URL assinada) porque o worker a persistirá em `processing_error`.
  - **Thumbnail:** a pasta temporária vem de `mkdtemp` em `os.tmpdir()` e é removida com `rm -r` em `finally`; o offset é formatado com 3 casas (`5.000`). Vídeos menores que 1280px são ampliados (`scale=1280:-2`), como o plano pede.
  - `MediaProbeService` não depende do `StorageService`: recebe só a URL. O teste de integração sobe a fixture no MinIO e passa uma URL interna pré-assinada.
  - `src/test/video-fixture.ts` usa `-movflags +faststart` para o `ffprobe` ler o MP4 por poucos range requests.

### SI-03.7 — Worker de vídeo: processor BullMQ, entrypoint próprio e serviço video-worker no Compose
- **Status:** completed
- **Tests:** 17 passing (`video-processing.processor.spec`, `video-processing.processor.integration-spec`, `worker.module.spec`); suíte completa 249 + 52 e2e, `tsc` e `lint` limpos
- **Observations:**
  - **Build separado (`tsconfig.worker.json`, fora do plano):** o worker compila para `dist-worker/`. Com o `dist/` compartilhado, o `nest start --watch` do `video-worker` e o do `nestjs-api` (`deleteOutDir: true`) apagariam a saída um do outro. Os scripts `start:worker`/`start:worker:dev` usam `-p tsconfig.worker.json`; `/dist-worker` entrou no `.gitignore`.
  - **Entidades explícitas no `WorkerModule`:** `Video` referencia `Channel` → `User`, e sem os módulos da API o `autoLoadEntities` não registraria o grafo inteiro. O módulo lista `User`, `Channel`, `RefreshToken`, `VerificationToken` e `Video`.
  - **Transições condicionais:** tanto o update para `ready` quanto o handler `failed` usam `WHERE status = 'processing'`, então uma falha tardia nunca sobrescreve um vídeo já `ready`. Há teste de integração para isso.
  - **Redelivery:** reentregar o job de um vídeo `ready` não toca o registro (`updated_at` e `processed_at` iguais) nem a thumbnail; coberto por teste de integração.
  - **Verificação ponta a ponta:** com o serviço `video-worker` real rodando, um vídeo enviado pelo `VideosService` (createVideo → parte → completeUpload) foi de `processing` a `ready` em ~1,4 s, com duração 3, metadados corretos e `thumbnail.jpg` (`image/jpeg`) no MinIO. Foi um spec temporário, removido depois.
  - **Não verificado:** o critério "parar o worker com jobs pendentes e subir de novo" não foi exercitado manualmente; a persistência depende do Redis com AOF (SI-03.1) e do comportamento padrão do BullMQ.
  - **Ambiente local:** o `compose.override.yaml` (não versionado) só montava o volume `node_modules` no `nestjs-api`; sem o mesmo volume no `video-worker` o `nest start` ficou parado lendo o `node_modules` do bind mount do Windows. Adicionei o volume ao serviço no override local — quem clonar o repositório precisa do mesmo ajuste no próprio override.
  - `worker.module.spec.ts` abre conexões reais (Postgres/Redis), então pela regra do `CLAUDE.md` seria `*.integration-spec.ts`; mantive o nome do plano, como o `videos.module.spec.ts` já faz.
  - Os testes de integração das SIs anteriores criam vídeos em `processing` com bytes que não são vídeo; com o `video-worker` no ar eles passam a `failed` (esperado, e esses testes não afirmam `status`).

### SI-03.8 — Consulta do vídeo e URLs de streaming e download
- **Status:** completed
- **Tests:** 27 novos (`videos.service.spec`, `videos.service.integration-spec`, `content-disposition.util.spec`); suíte completa 276 + 52 e2e, `tsc` e `lint` limpos
- **Observations:**
  - **Já existia da SI-03.4:** `findOwnedVideo` e o mapeamento `toResponse` (com `thumbnail_url`) foram entregues lá porque `createVideo` os exige, então esta SI só acrescentou `getVideo`, `getStreamUrl`, `getDownloadUrl` e o helper privado `findReadyOwnedVideo`, que concentra a regra "dono + `ready`".
  - **Ordem das verificações:** a propriedade é checada antes do status, então um não-dono recebe `VIDEO_NOT_FOUND` mesmo para vídeo em `processing`, sem revelar o estado de vídeos alheios.
  - **`Content-Disposition` em `content-disposition.util.ts`:** extraído do service para ter teste próprio. Além do pedido no plano (fallback ASCII para não imprimíveis e aspas), o fallback também troca a barra invertida, e o `filename*` codifica `' ( ) *`, que o `encodeURIComponent` deixa passar mas a RFC 5987 não aceita. CR/LF viram `_` no fallback e `%0D%0A` no `filename*` (testado contra injeção de cabeçalho).
  - **`VideoNotReadyException`** (`VIDEO_NOT_READY`, 409) adicionada em `domain.exception.ts`.
  - **Integração:** os vídeos `ready` são semeados direto no banco com objetos reais no MinIO (sem passar pelo worker). Verificado: stream com `Range: bytes=0-1023` → 206, 1024 bytes, `Content-Range` e `Content-Type` do vídeo; download → 200 com `attachment` e o nome acentuado em `filename*`; thumbnail → 200 `image/jpeg`; as três URLs usam o host de `S3_PUBLIC_ENDPOINT` e `X-Amz-Expires=3600`.
  - Nenhum vídeo semeado entra na fila, então o `video-worker` no ar não interfere.

### SI-03.9 — Endpoints de upload: POST /videos, POST /videos/{public_id}/upload/parts e POST /videos/{public_id}/upload/completion
- **Status:** completed
- **Tests:** 8 e2e (`test/videos-upload.e2e-spec.ts`, escrito a partir de `specs/videos-upload.plan.md`); suíte unitária/integração 276 e e2e 60 (todas as suítes), `tsc` e `lint` limpos
- **Observations:**
  - **Controller fino:** `VideosController` só delega ao `VideosService`; a única decisão é de transporte — `completion` responde 202 quando `transitioned` e 200 caso contrário, via `@Res({ passthrough: true })`. Registrado em `VideosModule`; sem `@Public()`, com `@ApiBearerAuth('access-token')`.
  - **OpenAPI:** cada rota documenta o sucesso (`type` com os DTOs de resposta) e todos os erros previstos com `ApiErrorEnvelope`; o e2e confere os status e a referência ao envelope contra `buildSwaggerDocument(app)`. O arquivo `openapi.json` exportado não foi regenerado nesta SI (fica para a SI-03.11).
  - **`GET /videos/{public_id}` ficou para a SI-03.10:** o plano lista a rota no contrato desta SI, mas as tasks e o escopo dela a atribuem à SI-03.10; não implementei para não misturar escopos.
  - **`message` de validação é uma lista** (`["file_size must not be greater than 10737418240"]`), então o e2e junta as mensagens antes de procurar o nome do campo.
  - **e2e precisa de `--runInBand`:** o script `test:e2e` do `package.json` não traz a flag, e com 4 suítes compartilhando o banco rodar em paralelo falhou (9 testes, em `auth` e `videos-upload`, por contaminação entre suítes). Com `npm run test:e2e -- --runInBand` as 4 passam, como o `CLAUDE.md` exige. Sugestão de tarefa separada: colocar `--runInBand` no script.
  - Com o `video-worker` no ar, o job criado pelo e2e é consumido e o vídeo (bytes que não são vídeo) vira `failed`; o teste só afirma o job na fila (que permanece, pois não há `removeOnComplete`) e a resposta HTTP.

### SI-03.10 — Endpoints de consulta, streaming e download: GET /videos/{public_id}, /stream e /download
- **Status:** completed
- **Tests:** 6 e2e (`test/videos-delivery.e2e-spec.ts`, escrito a partir de `specs/videos-delivery.plan.md`); suíte unitária/integração 276 e e2e 66 (5 suítes, com `--runInBand`), `tsc` e `lint` limpos
- **Observations:**
  - **Redirecionamento dinâmico:** `stream` e `download` usam `@Redirect()` e devolvem `{ url, statusCode: 302 }`; o `Location` é a URL pré-assinada do `VideosService`. Os três handlers só delegam ao service. A resposta 302 está documentada com o header `Location` e os erros 401/404/409 com `ApiErrorEnvelope`.
  - **Fluxo completo verificado de ponta a ponta:** o e2e sobe a API e um contexto do `WorkerModule` no próprio teste (mesmo código do `video-worker`), envia a fixture MP4 pelas URLs de parte direto ao MinIO, conclui o upload e espera o vídeo ficar `ready` (~1 s). Confirmado: duração ≈ 3 s, 320x240 `h264`, thumbnail `image/jpeg`; o `Location` do stream responde 206 a `Range: bytes=0-1023` com `Content-Range` e `video/mp4`; o do download responde 200 com o arquivo inteiro e `attachment` com `filename*=UTF-8''aula%20de%20v%C3%ADdeo.mp4`.
  - **Dois consumidores na mesma fila:** com o serviço `video-worker` do Compose no ar, o worker do teste e o do Compose disputam o job; o resultado é o mesmo porque o processor é idempotente (só age em `processing` e os updates são condicionais).
  - **Mesma resposta para não-dono e id inexistente:** as três rotas devolvem `404 VIDEO_NOT_FOUND` sem header `Location`.
  - O e2e remove do MinIO os objetos de cada vídeo criado (`afterEach`), já que o `cleanAllTables` só limpa o banco.

### SI-03.11 — Contrato OpenAPI exportado e documentação de IA (CLAUDE.md) da fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
