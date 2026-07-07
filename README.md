# refhub api v1

> // netlify_functions backend for refhub.io

versioned api backend for api-key access to refhub vaults. single function entrypoint dispatched by path segment. reads and writes the existing refhub data model directly — no parallel store.

---

## // routes

### management routes — supabase session jwt

These routes are for the logged-in RefHub frontend and reject `rhk_...` API keys.

```
GET    /api/v1/keys
POST   /api/v1/keys
POST   /api/v1/keys/:keyId/revoke
DELETE /api/v1/keys/:keyId

POST   /api/v1/recommendations       ← semantic scholar similar papers
POST   /api/v1/references            ← semantic scholar cited papers
POST   /api/v1/citations             ← semantic scholar citing papers
POST   /api/v1/lookup                ← semantic scholar DOI/title → paper id
POST   /api/v1/doi-metadata          ← semantic scholar DOI metadata enrichment
POST   /api/v1/search                ← semantic scholar topic/paper search

GET    /api/v1/google-drive
POST   /api/v1/google-drive/connect
POST   /api/v1/google-drive/folder
DELETE /api/v1/google-drive
GET    /api/v1/google-drive/callback  ← oauth callback, no bearer token
POST   /api/v1/google-drive/vaults/:vaultId/items/:itemId/pdf
POST   /api/v1/google-drive/vaults/:vaultId/items/:itemId/pdf/session
POST   /api/v1/google-drive/vaults/:vaultId/items/:itemId/pdf/complete
POST   /api/v1/publications/:publicationId/pdf/session
POST   /api/v1/publications/:publicationId/pdf/complete

GET    /api/v1/audit
```

### data routes — `rhk_...` api key

```
GET    /api/v1/vaults
POST   /api/v1/vaults
GET    /api/v1/vaults/:vaultId
PATCH  /api/v1/vaults/:vaultId
DELETE /api/v1/vaults/:vaultId
PATCH  /api/v1/vaults/:vaultId/visibility
GET    /api/v1/vaults/:vaultId/shares
POST   /api/v1/vaults/:vaultId/shares
PATCH  /api/v1/vaults/:vaultId/shares/:shareId
DELETE /api/v1/vaults/:vaultId/shares/:shareId
GET    /api/v1/vaults/:vaultId/items
POST   /api/v1/vaults/:vaultId/items
PATCH  /api/v1/vaults/:vaultId/items/:itemId
DELETE /api/v1/vaults/:vaultId/items/:itemId
POST   /api/v1/vaults/:vaultId/items/upsert
POST   /api/v1/vaults/:vaultId/items/import-preview
POST   /api/v1/vaults/:vaultId/items/:itemId/pdf
POST   /api/v1/vaults/:vaultId/items/:itemId/pdf/session
POST   /api/v1/vaults/:vaultId/items/:itemId/pdf/complete
GET    /api/v1/vaults/:vaultId/tags
POST   /api/v1/vaults/:vaultId/tags
PATCH  /api/v1/vaults/:vaultId/tags/:tagId
DELETE /api/v1/vaults/:vaultId/tags/:tagId
POST   /api/v1/vaults/:vaultId/tags/attach
POST   /api/v1/vaults/:vaultId/tags/detach
GET    /api/v1/vaults/:vaultId/relations
POST   /api/v1/vaults/:vaultId/relations
PATCH  /api/v1/vaults/:vaultId/relations/:relationId
DELETE /api/v1/vaults/:vaultId/relations/:relationId
POST   /api/v1/vaults/:vaultId/import/doi
POST   /api/v1/vaults/:vaultId/import/bibtex
POST   /api/v1/vaults/:vaultId/import/url
GET    /api/v1/vaults/:vaultId/search
GET    /api/v1/vaults/:vaultId/stats
GET    /api/v1/vaults/:vaultId/changes
GET    /api/v1/vaults/:vaultId/export
GET    /api/v1/vaults/:vaultId/audit
GET    /api/v1/extension/google-drive-status
POST   /api/v1/pdf-metadata
```

---

## // structure

```
.netlify/
  functions/
    api-v1.js          ← versioned router and handlers
  src/
    auth.js            ← api-key parsing, hashing, verification, scope checks
    config.js          ← required env vars and runtime knobs
    export.js          ← json and bibtex export helpers
    http.js            ← shared http/error/json helpers
    google-drive.js    ← google oauth, drive folder, pdf upload helpers
    semantic-scholar.js← semantic scholar proxy normalization/helpers
    bibtex.js          ← bibtex parsing/serialization helpers
    routes/            ← v2 vaults/items/tags/relations/search/import/audit handlers
  netlify.toml         ← redirects and function settings
  package.json
```

all `/api/v1/*` traffic is routed to `/.netlify/functions/api-v1` via `netlify.toml`.

---

## // auth

two modes — never mix them.

**api key** (all data routes):
```
Authorization: Bearer rhk_<publicId>_<secret>
X-API-Key: rhk_<publicId>_<secret>
```

**session jwt** (management routes only):
```
Authorization: Bearer <supabase-session-jwt>
```

sending an api key to a management route returns `401 refhub_api_key_not_supported`.

key storage rules:
- only `key_hash` is stored — plaintext key material is never reconstructed
- `key_prefix` stores `rhk_<publicId>` for lookup
- `scopes` is a text array
- optional vault restrictions live in `api_key_vaults`
- `last_used_at` updated best-effort
- request outcomes written best-effort to `api_request_audit_logs`

---

## // scopes

| scope | grants |
|---|---|
| `vaults:read` | list/read vaults, search, stats, changes, audit |
| `vaults:write` | add/update/delete items, tags, relations, import |
| `vaults:export` | export vault as json or bibtex |
| `vaults:admin` | create/update/delete vaults, visibility, shares |

---

## // env vars

required:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
REFHUB_API_KEY_PEPPER          ← used when hashing presented keys before comparison
```

optional:

```
SEMANTIC_SCHOLAR_API_KEY       ← recommended for stable upstream rate limits
SEMANTIC_SCHOLAR_RATE_LIMIT_MAX_REQUESTS ← per-user request cap, defaults to 60
SEMANTIC_SCHOLAR_RATE_LIMIT_WINDOW_MS    ← rate-limit window, defaults to 60000
SEMANTIC_SCHOLAR_TIMEOUT_MS              ← upstream timeout, defaults to 8000
REFHUB_API_MAX_BULK_ITEMS      ← defaults to 50
REFHUB_API_MAX_BODY_BYTES      ← defaults to 52428800
REFHUB_API_ALLOWED_ORIGINS     ← comma-separated browser origins; defaults to https://refhub.io plus localhost dev ports 3000, 5173, 8080, and 8081
REFHUB_API_AUDIT_DISABLED      ← defaults to false
```

google drive (only when using drive storage flow):

```
GOOGLE_DRIVE_CLIENT_ID
GOOGLE_DRIVE_CLIENT_SECRET
GOOGLE_DRIVE_REDIRECT_URI
GOOGLE_DRIVE_STATE_SECRET
GOOGLE_DRIVE_TOKEN_SECRET
GOOGLE_DRIVE_FOLDER_NAME       ← defaults to "refhub"
GOOGLE_DRIVE_MAX_UPLOAD_BYTES  ← defaults to 26214400
```

for local dev, the backend loads from `.env.local` then `.env` before `process.env`.

---

## // data model

reads and writes existing tables — no parallel api store:

```
vaults
vault_shares
vault_publications
publications
tags
publication_tags
publication_relations
```

write flow for new items:
1. insert canonical row in `publications`
2. insert vault-specific copy in `vault_publications`
3. attach `publication_tags` against `vault_publication_id`

---

## // security

the function uses the supabase service-role key — rls is not the primary enforcement layer for this path. access control is enforced in-function by:

- api-key hash verification
- scope checks
- explicit vault restriction checks via `api_key_vaults`
- owner/share permission checks before read, write, or export

if this backend moves away from the service-role key, keep these checks and validate rls separately.

---

## // endpoint contracts

### `GET /api/v1/keys`

auth: supabase session jwt. returns api keys owned by the authenticated user.

```json
{
  "data": [
    {
      "id": "uuid",
      "label": "research_sync_bot",
      "description": "local sync job",
      "key_prefix": "rhk_a1b2c3d4e5f6",
      "scopes": ["vaults:read"],
      "expires_at": null,
      "revoked_at": null,
      "last_used_at": null,
      "created_at": "2026-03-24T08:30:00Z",
      "vault_ids": ["uuid"]
    }
  ],
  "meta": { "request_id": "uuid" }
}
```

### `POST /api/v1/keys`

auth: supabase session jwt.

```json
{
  "label": "research_sync_bot",
  "description": "local sync job",
  "scopes": ["vaults:read", "vaults:write"],
  "expires_at": "2026-06-22T08:30:00.000Z",
  "vault_ids": ["uuid"]
}
```

rules:
- `label` required
- `scopes` must be a non-empty subset of valid scopes
- `expires_at` optional; must be a future iso-8601 timestamp when present
- `vault_ids` optional; every vault must be accessible to the authenticated user
- response returns plaintext key once as `secret` — only the hash is stored

### `POST /api/v1/keys/:keyId/revoke` · `DELETE /api/v1/keys/:keyId`

auth: supabase session jwt. revokes a key owned by the authenticated user. record is soft-revoked via `revoked_at` — not deleted from storage.

### `POST /api/v1/recommendations` · `POST /api/v1/references` · `POST /api/v1/citations`

auth: supabase session jwt only — api keys explicitly rejected.

proxies semantic scholar server-side. applies lightweight per-user rate limiting; may return `429 rate_limit_exceeded`. upstream failures returned as sanitized errors.

```json
{ "paper_id": "DOI:10.1101/2020.02.20.958025", "limit": 10 }
```

- `paper_id` required — semantic scholar paper id or `DOI:<doi>`
- `limit` optional, `1`–`25`
- successful responses cached briefly in-process to reduce duplicate upstream calls

response shape (recommendations · references · citations):

```json
{
  "data": [
    {
      "paper_id": "52cdb6ed946dfed25113bd194d5e2bb843c66331",
      "external_ids": { "DOI": "10.1101/2020.11.04.367797" },
      "title": "example paper",
      "abstract": "...",
      "year": 2020,
      "venue": "bioRxiv",
      "url": "https://www.semanticscholar.org/paper/...",
      "citation_count": 42,
      "open_access_pdf_url": "https://...",
      "authors": [{ "author_id": "12345", "name": "example author" }]
    }
  ],
  "meta": { "request_id": "uuid", "paper_id": "DOI:10.1101/...", "limit": 10 }
}
```

`POST /api/v1/citations` — same request/response shape as references; returns papers citing the seed paper.

### `POST /api/v1/lookup`

auth: supabase session jwt only — api keys explicitly rejected.

resolves a DOI or title to a Semantic Scholar paper id. DOI lookups are normalized to `DOI:<doi>` locally; title lookups proxy Semantic Scholar paper search.

```json
{ "doi": "10.1145/3544548.3580907" }
```

```json
{ "title": "attention is all you need" }
```

response:

```json
{
  "data": { "paper_id": "DOI:10.1145/3544548.3580907" },
  "meta": { "request_id": "uuid", "query_type": "doi" }
}
```

### `POST /api/v1/search`

auth: supabase session jwt only — api keys explicitly rejected.

server-side Semantic Scholar topic/paper search for empty-vault discovery. Uses Semantic Scholar `/graph/v1/paper/search/bulk` with compact paper fields and `citationCount:desc` sorting. Applies the same per-user Semantic Scholar rate limit, timeout, cache, stale-cache fallback on upstream 429, and sanitized error shape as the other Semantic Scholar routes.

```json
{ "query": "visual analytics provenance", "limit": 25 }
```

- `query` required, minimum 2 characters
- `limit` optional, `1`–`25`
- successful responses use the normalized paper shape shown above
- `SEMANTIC_SCHOLAR_API_KEY` is optional but recommended; unauthenticated Semantic Scholar traffic uses a shared public pool and can return upstream `429`

### `POST /api/v1/doi-metadata`

auth: supabase session jwt only — api keys explicitly rejected.

resolves a DOI against semantic scholar and returns structured metadata. applies per-user rate limiting; may return `429 rate_limit_exceeded`. results cached briefly in-process.

```json
{ "doi": "10.1145/3544548.3580907" }
```

- `doi` required — bare doi string (no `https://doi.org/` prefix)

```json
{
  "data": {
    "title": "example paper",
    "authors": ["author one", "author two"],
    "year": 2023,
    "journal": "CHI",
    "doi": "10.1145/3544548.3580907",
    "url": "https://doi.org/10.1145/3544548.3580907",
    "abstract": "...",
    "type": "inproceedings"
  },
  "meta": { "request_id": "uuid", "doi": "10.1145/3544548.3580907" }
}
```

`data` is `null` when the DOI is not found in semantic scholar. `type` is one of `article` · `inproceedings` · `book` · `thesis` · `report`.

### Google Drive routes

auth: supabase session jwt only unless noted.

- `GET /api/v1/google-drive` — linked status, folder status, folder id/name.
- `POST /api/v1/google-drive/connect` — returns a Google OAuth `authorization_url`; accepts optional `return_to`.
- `GET /api/v1/google-drive/callback` — OAuth callback target, no bearer token; redirects back to the configured RefHub UI.
- `POST /api/v1/google-drive/folder` — ensure/recreate the managed Drive folder.
- `DELETE /api/v1/google-drive` — disconnect stored Drive credentials and best-effort revoke the refresh token.
- `GET /api/v1/extension/google-drive-status` — compact status shape for the browser extension/data route auth path.

### PDF metadata and upload routes

`POST /api/v1/pdf-metadata` accepts `{ "source_url": "https://...pdf" }` plus optional `cookie_header`/`referer`, fetches the PDF server-side, and returns best-effort DOI/title/authors/year/journal metadata. It returns empty metadata with a `fetch_skipped` note when the source PDF is not server-accessible instead of throwing a hard 500.

`POST /api/v1/vaults/:vaultId/items/:itemId/pdf` uploads or fetches a PDF for a vault item and stores it in linked Google Drive. Body must be JSON with `source_url` plus optional `cookie_header`/`referer` — the backend fetches the PDF server-side (e.g. using institutional-access cookies), so this is not subject to any client-payload size limit. **Raw `application/pdf` request bodies are no longer accepted on this route** — any client that already holds the PDF bytes locally must use the resumable session flow below instead, regardless of file size. A raw PDF/octet-stream body sent here returns `410 raw_pdf_upload_removed`.

`POST /api/v1/vaults/:vaultId/items/:itemId/pdf/session` creates a Google Drive resumable upload session — the **only** way to upload PDF bytes a client already holds locally, for any file size. The client PUTs the PDF bytes directly to the returned `upload_url`, then calls `/pdf/complete`. When used from browsers, the API forwards the validated request `Origin` to Google when creating the session so browser-direct PUTs receive matching Drive CORS headers. If `REFHUB_API_ALLOWED_ORIGINS` is set explicitly (including on any deployed Netlify site, which does not inherit the code defaults from a local `.env`), include every dev/frontend origin you use, e.g. `http://localhost:8080` (this repo's actual frontend dev port) or `http://localhost:8081`; arbitrary origins are not reflected.

`POST /api/v1/vaults/:vaultId/items/:itemId/pdf/complete` records a client-completed Drive upload. Body must include `file_id`; `web_view_link` and `source_url` are optional.

All upload routes on this page return the stored Drive link as `driveUrl` in their response `data` (previously `pdfUrl`) — renamed to stop colliding in name with the unrelated `pdf_url` publication field (the publisher-hosted link). Matches the corresponding rename in the RefHub frontend, CLI, and skill clients.

Uploads via either PDF route only ever write to `publication_pdf_assets` — never to the item's own `pdf_url` column. `pdf_url` is bibliographic metadata (the publisher-hosted link, matching the RefHub frontend's `publisher_pdf` field) and is shared across every vault the underlying publication appears in; a Drive file is a storage asset scoped to the uploading user's own Drive account. Folding the two together would silently overwrite `pdf_url` and leak one user's private Drive link into a field every vault collaborator sees. Instead, item read responses (`GET /vaults/:vaultId`, `GET /vaults/:vaultId/items/:itemId`, and the refreshed row returned by `PATCH .../items/:itemId`) include a separate `drive_pdf_url` field — the same `stored_pdf_url` the frontend reads directly from `publication_pdf_assets` (vault-specific copy first, falling back to a same-publication asset from another vault), surfaced here for API-key clients that don't have direct Supabase access.

### Publication-level PDF upload

auth: supabase session jwt only. Uploads a PDF for a publication the authenticated user owns directly (not scoped to a specific vault item) and stores it in their linked Google Drive. Records the asset in `publication_pdf_assets`. Mirrors the vault-item resumable flow exactly — there is no raw-bytes variant of this route.

`POST /api/v1/publications/:publicationId/pdf/session` creates the resumable upload session.

`POST /api/v1/publications/:publicationId/pdf/complete` records a client-completed Drive upload. Body must include `file_id`; `web_view_link` and `source_url` are optional.

- publication must be owned by the authenticated user
- google drive must be linked for the account
- file size capped at `GOOGLE_DRIVE_MAX_UPLOAD_BYTES` (default 26 MB)

```json
{
  "data": {
    "attempted": true,
    "stored": true,
    "provider": "google_drive",
    "fileId": "1BcnjrInjOGsnM142vNlg4KNMriooAc9u",
    "folderId": "1-HxdtCdUxv03KEN-syenBc18fvnRl9EW",
    "folderName": "refhub",
    "driveUrl": "https://drive.google.com/file/d/.../view?usp=drivesdk",
    "sourceUrl": null
  },
  "meta": { "request_id": "uuid" }
}
```

errors: `404 publication_not_found` · `503 drive_not_linked` · `502 drive_upload_failed`.

**requires migration** `20260513000000_publication_pdf_assets_library_uploads.sql` — drops the NOT NULL constraint on `vault_publication_id` and adds the partial unique index `(publication_id, storage_provider) WHERE publication_id IS NOT NULL AND vault_publication_id IS NULL`.

### `GET /api/v1/vaults`

scope: `vaults:read`. returns vaults accessible through ownership or explicit share, narrowed by `api_key_vaults` when set.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "ai reading list",
      "visibility": "private",
      "permission": "owner",
      "item_count": 12,
      "updated_at": "2026-03-23T18:00:00Z"
    }
  ],
  "meta": { "request_id": "uuid" }
}
```

### `GET /api/v1/vaults/:vaultId`

scope: `vaults:read`. returns vault metadata + `vault_publications` + vault-scoped `tags` + `publication_tags` + `publication_relations`. Each publication in `vault_publications` also carries a `drive_pdf_url` field — see the note on the PDF upload routes above.

### V2 vault and organization routes

`POST /api/v1/vaults`, `PATCH /api/v1/vaults/:vaultId`, `DELETE /api/v1/vaults/:vaultId`, `PATCH /api/v1/vaults/:vaultId/visibility`, and `/shares` routes require `vaults:admin` or an authenticated management user with owner/admin access.

Tag, relation, search, stats, changes, import, and audit routes are implemented under `src/routes/*`. They use the same vault access resolver and scope model:

- read/search/stats/changes/audit: `vaults:read`
- add/update/delete items, tags, relations, imports: `vaults:write`
- export: `vaults:export`
- vault CRUD/visibility/shares: `vaults:admin`

### `POST /api/v1/vaults/:vaultId/items`

scope: `vaults:write` · permission: editor.

```json
{
  "items": [
    {
      "title": "attention is all you need",
      "authors": ["ashish vaswani"],
      "year": 2017,
      "publication_type": "article",
      "doi": "10.48550/arXiv.1706.03762",
      "tag_ids": ["uuid"]
    }
  ]
}
```

- bulk insert supported
- `tag_ids` must already exist in the vault — no implicit tag creation
- requests above `REFHUB_API_MAX_BODY_BYTES` rejected with `413`
- pre-validates full batch and attempts rollback on insert failure

### `PATCH /api/v1/vaults/:vaultId/items/:itemId`

scope: `vaults:write` · permission: editor. partial update. if `tag_ids` is present it replaces the full tag set.

bibliographic fields (everything in the publication field set except `notes`) are rolled up atomically to the canonical `publications` row and every sibling `vault_publications` copy of the same paper in other vaults — matching the RefHub frontend's own propagation rule. `notes` and `tag_ids` are vault-local and never propagate. The bibliographic rollup itself is all-or-nothing: on failure, none of its fields are applied anywhere and the response is `502 publication_rollup_failed` with the underlying database error in `details.postgres_message` — never a partial rollup reported as success. This atomicity guarantee covers only the rollup; `tag_ids` replacement is a separate step that runs after it and can succeed or fail independently (e.g. an invalid tag ID can leave a bibliographic change already applied while the tag update fails) — a request that touches both should check the response code rather than assume all-or-nothing across both concerns.

### `GET /api/v1/vaults/:vaultId/export?format=json|bibtex`

scope: `vaults:export` · permission: viewer. supported formats: `json` · `bibtex`.

---

## // audit logging

each request writes one audit row with:

```
api_key_id • owner_user_id • vault_id • method • path
response_status • request_id • latency • caller_ip • user_agent
```

best-effort — must not block successful api responses. failures emitted to function logs only.
