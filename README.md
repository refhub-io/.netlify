# refhub api v1

> // netlify_functions backend for refhub.io

versioned api backend for api-key access to refhub vaults. single function entrypoint dispatched by path segment. reads and writes the existing refhub data model directly — no parallel store.

---

## // routes

### management routes — supabase session jwt

```
GET    /api/v1/keys
POST   /api/v1/keys
POST   /api/v1/keys/:keyId/revoke
DELETE /api/v1/keys/:keyId
POST   /api/v1/recommendations     ← semantic scholar (jwt only)
POST   /api/v1/references          ← semantic scholar (jwt only)
POST   /api/v1/citations           ← semantic scholar (jwt only)
GET    /api/v1/audit
POST   /api/v1/lookup
GET/POST/DELETE /api/v1/google-drive
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
REFHUB_API_MAX_BULK_ITEMS      ← defaults to 50
REFHUB_API_MAX_BODY_BYTES      ← defaults to 262144
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

scope: `vaults:read`. returns vault metadata + `vault_publications` + vault-scoped `tags` + `publication_tags` + `publication_relations`.

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
