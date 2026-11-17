---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T09:15:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T09:01:33-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download a video in Phase 03 (visibility is Phase 04, anon Phase 05)"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Video title/metadata at automatic pre-registration not specified"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Fate of drafts whose upload is never completed is not specified"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Object Storage Client Library"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Storage Endpoint Topology for Presigned URLs"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Background Processing Queue Technology"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Upload Protocol for Files up to 10GB"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Draft Pre-registration and Upload Completion Signal"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Metadata Extraction and Thumbnail Generation Approach"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Unique Public Video Identifier"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Video Status Lifecycle and Processing Failure Handling"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI not in scope for this phase — no `## UI Inventory` in context.md.)_

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Who may stream/download a video in Phase 03. **Clarification (user, 2026-11-17):** only the **owner** (the channel that uploaded the video) may obtain the stream and download URLs in Phase 03; every other caller is denied. Phase 04 (visibility) and Phase 05 (anonymous viewing) may widen this rule. Applies to the delivery endpoints of `phase-03-videos/TD-10`.
- **AMB-2** _(resolved_by clarification)_ — Video title at automatic pre-registration. **Clarification (user, 2026-11-17):** the title is an **optional** input of the upload-initiation request; when omitted it defaults to the original filename without its extension. Editing title/description remains Phase 04. The download filename (`phase-03-videos/TD-10`) derives from the stored original filename.
- **AMB-3** _(resolved_by clarification)_ — Fate of drafts whose upload is never completed. **Clarification (user, 2026-11-17):** the row stays as `draft` indefinitely in Phase 03 — no abort endpoint, no scheduled cleanup; the orphan multipart bytes are reclaimed by storage-side expiry (`phase-03-videos/TD-03`). Draft cleanup/deletion is left to the management panel of a later phase (Phase 04+).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: A (AWS SDK v3: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: A (internal endpoint for calls + public endpoint for client-facing signing).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: A (single private bucket, per-video prefix).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: A (BullMQ on Redis via `@nestjs/bullmq`).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: A (direct-to-storage S3 multipart upload with presigned part URLs).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: A (pre-register on initiation + explicit completion endpoint).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: A (same codebase, separate entrypoint and Compose service).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: A (system `ffprobe`/`ffmpeg` via `execFile`, input from presigned internal URL).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: B (`node:crypto` short id, unique column + retry on collision).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided: A (API authorizes + `302` to presigned GET; storage serves `Range`/`206`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: A (single status enum with queue retries and terminal `failed`).
