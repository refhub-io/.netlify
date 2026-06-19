# RefHub Backend V2 Roadmap

This document maps the next backend/API expansion needed to make RefHub a strong substrate for agentic workflows, not just a thin remote wrapper around the current frontend.

## Goals

V2 should make the backend:

- expressive enough for real automation
- safe enough for unattended agent execution
- explicit enough that scopes and vault permissions stay understandable
- efficient enough that agents do not need full-vault downloads for every task

## Design principles

1. **API first** — backend contract is canonical; frontend and skills should follow it.
2. **Scope + vault permission + vault restriction** — all three matter.
3. **Safe automation primitives** — dry-runs, idempotency, partial-failure reporting.
4. **Structure is first-class** — tags and relations should not be hacks hidden inside item writes.
5. **Incremental sync beats full export loops** where practical.

---

## Track 1 — Permission model expansion

Current scopes are intentionally small:

- `vaults:read`
- `vaults:write`
- `vaults:export`

That is good for v1, but too coarse for growth.

### V2 candidate scopes

#### Core
- `vaults:create`
- `vaults:read`
- `vaults:write`
- `vaults:export`
- `vaults:admin`

#### Structure
- `tags:read`
- `tags:write`
- `relations:read`
- `relations:write`

#### Optional later
- `items:delete`
- `shares:read`
- `shares:write`
- `audit:read`
- `imports:create`
- `sync:read`

### Permission semantics

- read-like scopes still require vault `viewer` access
- write-like scopes still require vault `editor` access
- admin-like scopes should require `owner` or explicit admin-equivalent access
- `vaults:create` is account-level and not tied to an existing vault
- API-key vault restrictions still narrow *where* a key may operate

### Deliverables
- scope matrix doc
- scope validation in backend
- backward-compat story for existing keys
- examples in API docs

---

## Track 2 — Vault lifecycle endpoints

### Needed capabilities
- create vault
- update vault metadata
- archive/unarchive vault
- delete vault (or soft-delete)
- duplicate/clone vault
- list collaborators / permission state
- manage sharing

### Why it matters
Agents often need to create a task- or project-specific workspace, fill it, organize it, and hand it off. Without vault lifecycle support, automation always stalls at setup/handoff.

### Proposed endpoint family
- `POST /api/v1/vaults`
- `PATCH /api/v1/vaults/:vaultId`
- `POST /api/v1/vaults/:vaultId/archive`
- `POST /api/v1/vaults/:vaultId/unarchive`
- `DELETE /api/v1/vaults/:vaultId`
- `GET /api/v1/vaults/:vaultId/shares`
- `POST /api/v1/vaults/:vaultId/shares`
- `PATCH /api/v1/vaults/:vaultId/shares/:shareId`
- `DELETE /api/v1/vaults/:vaultId/shares/:shareId`

---

## Track 3 — Item lifecycle and bulk operations

### Needed capabilities
- create one or many items
- partial update / patch
- delete item
- restore soft-deleted item
- merge duplicate items
- move/copy items between vaults
- bulk upsert
- duplicate-detection preview

### Automation requirements
- dry-run support
- idempotency keys
- stable duplicate warnings
- explicit per-item failure reporting
- true transaction semantics for bulk operations where possible

### Proposed additions
- `DELETE /api/v1/vaults/:vaultId/items/:itemId`
- `POST /api/v1/vaults/:vaultId/items/merge`
- `POST /api/v1/vaults/:vaultId/items/upsert`
- `POST /api/v1/vaults/:vaultId/items/import-preview`

---

## Track 4 — Tags as a first-class API

### Needed capabilities
- list tags
- create tag
- update tag name/color
- reparent tag / hierarchy edits
- delete tag
- attach/detach tags from items
- bulk retag

### Proposed endpoints
- `GET /api/v1/vaults/:vaultId/tags`
- `POST /api/v1/vaults/:vaultId/tags`
- `PATCH /api/v1/vaults/:vaultId/tags/:tagId`
- `DELETE /api/v1/vaults/:vaultId/tags/:tagId`
- `POST /api/v1/vaults/:vaultId/tags/attach`
- `POST /api/v1/vaults/:vaultId/tags/detach`

### Why it matters
Agent workflows naturally classify papers/items. If tags are not first-class, every automation becomes a brittle metadata workaround.

---

## Track 5 — Relations / graph operations

### Needed capabilities
- list relations
- create relation
- update relation
- delete relation
- bulk relation import
- relation query by type/source/target

### Proposed endpoints
- `GET /api/v1/vaults/:vaultId/relations`
- `POST /api/v1/vaults/:vaultId/relations`
- `PATCH /api/v1/vaults/:vaultId/relations/:relationId`
- `DELETE /api/v1/vaults/:vaultId/relations/:relationId`

### Why it matters
This is what turns RefHub from bibliography storage into structured research memory.

---

## Track 6 — Search, filtering, and lightweight query surfaces

### Needed capabilities
- full-text search
- fielded filtering (author, year, DOI, tag, type)
- pagination and sorting
- saved queries
- cheap summary/count endpoints
- “changed since” feed

### Proposed endpoints
- `GET /api/v1/vaults/:vaultId/search`
- `GET /api/v1/vaults/:vaultId/items?tag=...&author=...&year=...`
- `GET /api/v1/vaults/:vaultId/stats`
- `GET /api/v1/vaults/:vaultId/changes?since=...`

### Why it matters
Agents should not have to download an entire vault just to answer a narrow question.

---

## Track 7 — Import, enrichment, and sync

### Needed capabilities
- DOI import
- BibTeX import
- URL-based import
- bulk candidate import
- metadata normalization
- optional enrichment hooks (Crossref/S2/OpenAlex later)
- incremental sync/export cursors

### Proposed endpoints
- `POST /api/v1/vaults/:vaultId/import/doi`
- `POST /api/v1/vaults/:vaultId/import/bibtex`
- `POST /api/v1/vaults/:vaultId/import/url`
- `GET /api/v1/vaults/:vaultId/export?since=...`
- `GET /api/v1/vaults/:vaultId/sync`

### Why it matters
This is how RefHub plugs into ingestion pipelines and external agent memory loops.

---

## Track 8 — Audit, provenance, and observability

### Needed capabilities
- who changed what and when
- actor attribution (user / API key / automation label)
- item revision history
- bulk operation summaries
- audit query endpoints for owners/admins

### Proposed endpoints
- `GET /api/v1/audit`
- `GET /api/v1/vaults/:vaultId/audit`
- `GET /api/v1/vaults/:vaultId/items/:itemId/history`

### Why it matters
Automation without provenance becomes untrustworthy very quickly.

---

## Track 9 — Webhooks / events

### Events worth exposing
- item created
- item updated
- tag changed
- relation changed
- vault created
- share changed
- import completed
- key revoked

### Why it matters
This enables event-driven agents instead of expensive polling loops.

---

## Suggested sequencing

### Phase A — high leverage
1. expanded scope model
2. vault create/update
3. tag CRUD
4. relation CRUD
5. search/filter endpoints

### Phase B — agent primitives
6. import preview + safer bulk operations
7. delete/merge/upsert flows
8. audit/history endpoints
9. collaborator/sharing endpoints

### Phase C — ecosystem fit
10. incremental sync feeds
11. event/webhook layer
12. richer analytics/query surfaces

---

## Definition of done for V2

V2 is successful when an external agent can:

- create a vault
- ingest and organize items safely
- classify with tags and relations
- search/filter without full dumps
- sync/export incrementally
- operate under narrow API keys
- leave a trustworthy audit trail

If those are in place, RefHub becomes a realistic backend for broad agentic workflows rather than a frontend-first app with a few remote endpoints.
