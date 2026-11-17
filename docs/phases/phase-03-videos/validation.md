---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 14
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T09:15:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T09:01:33-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Who may stream/download a video in Phase 03 (visibility is Phase 04, anon Phase 05)"
  - id: AMB-2
    status: open
    summary: "Video title/metadata at automatic pre-registration not specified"
  - id: AMB-3
    status: open
    summary: "Fate of drafts whose upload is never completed is not specified"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Object Storage Client Library"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Storage Endpoint Topology for Presigned URLs"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Bucket and Object Key Layout"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Background Processing Queue Technology"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Upload Protocol for Files up to 10GB"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Draft Pre-registration and Upload Completion Signal"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Video Worker Runtime"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Metadata Extraction and Thumbnail Generation Approach"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Unique Public Video Identifier"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Streaming and Download Delivery"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Video Status Lifecycle and Processing Failure Handling"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not say **who** may stream or download a video in this phase. The capability falls on a phase boundary: video visibility (público/unlisted) is Phase 04 ("Visibilidade do vídeo: público … ou unlisted") and anonymous viewing is Phase 05 ("Acesso anônimo à visualização de vídeos"), while every Phase 03 video is still a `draft` per "Pré-cadastro automático do vídeo como rascunho". `phase-03-videos/TD-10` only fixes the delivery mechanism (API authorizes, then `302` to a presigned URL) and gates on `ready`, not the authorization rule; the plan's Authorization Matrix cannot be written without it. Explicit choice: decide the Phase 03 access rule for `stream`/`download` — e.g., (a) owner only (the channel that uploaded it), (b) any authenticated user, (c) public once `ready` — keeping Phase 04/05 free to widen or narrow it later.
- **AMB-2** — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not specify which descriptive data the draft is created with. Title editing belongs to Phase 04 ("Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"), but the Phase 03 row still needs a title (and the download filename in `phase-03-videos/TD-10` derives from something). An implementer would have to ask "where does the title come from?". Explicit choice: (a) title is optional input on upload initiation, defaulting to the original filename without extension; (b) title is always derived from the original filename; (c) title is a required input on upload initiation.
- **AMB-3** — The upload flow implies an edge case not addressed anywhere: a video pre-registered as draft whose upload is never completed. `phase-03-videos/TD-03` reclaims the incomplete multipart bytes in storage (stale-upload expiry) and `phase-03-videos/TD-11` defines `draft` as "upload not completed", but nothing states what happens to the database row. Explicit choice: (a) keep the row as `draft` indefinitely in Phase 03 (cleanup/deletion deferred to the Phase 04 management panel); (b) add a scheduled cleanup that removes drafts older than the storage expiry window; (c) allow the uploader to abort/delete an in-progress upload via an endpoint.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Object Storage Client Library. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-2** — TD-02 pending — Storage Endpoint Topology for Presigned URLs (internal vs public). Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-3** — TD-03 pending — Bucket and Object Key Layout. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-4** — TD-04 pending — Background Processing Queue Technology. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-5** — TD-05 pending — Upload Protocol for Files up to 10GB. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-6** — TD-06 pending — Draft Pre-registration and Upload Completion Signal. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-7** — TD-07 pending — Video Worker Runtime. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-8** — TD-08 pending — Metadata Extraction and Thumbnail Generation Approach. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-9** — TD-09 pending — Unique Public Video Identifier. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-10** — TD-10 pending — Streaming and Download Delivery. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-11** — TD-11 pending — Video Status Lifecycle and Processing Failure Handling. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.

### UI Coverage Gaps

_None._ _(UI not in scope for this phase — no `## UI Inventory` in context.md.)_

## Resolved Issues

_No issues resolved yet._
