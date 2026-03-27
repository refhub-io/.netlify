# RefHub API v1

## Scope

This `.netlify` package is the initial Netlify Functions backend scaffold for API-key access to RefHub vaults.

It is intentionally narrow for v1:

Management routes authenticated with a Supabase session JWT:

- `GET /api/v1/keys`
- `POST /api/v1/keys`
- `POST /api/v1/keys/:keyId/revoke`
- `DELETE /api/v1/keys/:keyId`
- `POST /api/v1/recommendations`
- `POST /api/v1/references`
- `POST /api/v1/citations`

Data routes authenticated with `rhk_...` API keys:

- `GET /api/v1/vaults`
- `GET /api/v1/vaults/:vaultId`
- `POST /api/v1/vaults/:vaultId/items`
- `PATCH /api/v1/vaults/:vaultId/items/:itemId`
- `GET /api/v1/vaults/:vaultId/export`

No vault-creation endpoint is included.

## Versioned routing

`netlify.toml` routes all `/api/v1/*` traffic to a single function entrypoint:

- `/.netlify/functions/api-v1`

The handler dispatches by path segment so the backend can stay small while the contract stays versioned.

## Folder layout

```text
.netlify/
  functions/
    api-v1.js            # versioned router and handlers
  src/
    auth.js              # API-key parsing, hashing, verification, scope checks
    config.js            # required env vars and runtime knobs
    export.js            # JSON and BibTeX export helpers
    http.js              # shared HTTP/error/JSON helpers
  netlify.toml           # redirects and function settings
  package.json           # backend package metadata
  PROGRESS.md            # status snapshot for this scaffold
```

## Authentication split

`/api/v1/keys` is intentionally separate from the API-key-protected vault routes:

- management requests must send `Authorization: Bearer <supabase-session-jwt>`
- vault data requests continue to use `Authorization: Bearer rhk_<publicId>_<secret>` or `X-API-Key`
- management handlers verify the Supabase JWT first, then use the service-role client only for server-side CRUD after ownership checks
- API-key issuance stays server-side so plaintext key material never has to be reconstructed from stored data

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REFHUB_API_KEY_PEPPER`
- `SEMANTIC_SCHOLAR_API_KEY` optional, recommended for stable upstream rate limits
- `REFHUB_API_MAX_BULK_ITEMS` optional, defaults to `50`
- `REFHUB_API_MAX_BODY_BYTES` optional, defaults to `262144`
- `REFHUB_API_AUDIT_DISABLED` optional, defaults to `false`

`REFHUB_API_KEY_PEPPER` is used when hashing presented API keys before comparing them to the stored hash.

## API-key model

Keys are expected in one of these headers:

- `Authorization: Bearer rhk_<publicId>_<secret>`
- `X-API-Key: rhk_<publicId>_<secret>`

Storage rules:

- only `key_hash` is stored
- `key_prefix` stores `rhk_<publicId>` for lookup
- `scopes` is a text array
- optional vault restrictions live in `api_key_vaults`
- `last_used_at` is updated best-effort
- request outcomes are written best-effort to `api_request_audit_logs`

## Security assumptions

The Netlify function uses the Supabase service-role key, so database RLS is not the primary enforcement layer for this API path.

Access control is enforced in the function by:

- API-key hash verification
- scope checks
- explicit vault restriction checks through `api_key_vaults`
- owner/share permission checks before read, write, or export operations

If this backend later moves away from the service-role key, keep these checks and validate RLS separately.

## Existing RefHub data model reused

The backend reads and writes the existing tables instead of creating a parallel API store:

- `vaults`
- `vault_shares`
- `vault_publications`
- `publications`
- `tags`
- `publication_tags`
- `publication_relations`

For writes, v1 follows the current shared-vault pattern:

1. insert a canonical row in `publications`
2. insert the vault-specific copy in `vault_publications`
3. attach `publication_tags` against the `vault_publication_id`

## Endpoint contract

### `GET /api/v1/keys`

Authentication: Supabase session JWT

Returns API keys owned by the authenticated user.

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "label": "research_sync_bot",
      "description": "Local sync job",
      "key_prefix": "rhk_a1b2c3d4e5f6",
      "scopes": ["vaults:read"],
      "expires_at": null,
      "revoked_at": null,
      "last_used_at": null,
      "created_at": "2026-03-24T08:30:00Z",
      "vault_ids": ["uuid"]
    }
  ],
  "meta": {
    "request_id": "uuid"
  }
}
```

### `POST /api/v1/keys`

Authentication: Supabase session JWT

Request body:

```json
{
  "label": "research_sync_bot",
  "description": "Local sync job",
  "scopes": ["vaults:read", "vaults:write"],
  "expires_at": "2026-06-22T08:30:00.000Z",
  "vault_ids": ["uuid"]
}
```

Rules:

- `label` is required
- `scopes` must be a non-empty subset of `vaults:read`, `vaults:write`, `vaults:export`
- `expires_at` is optional but must be a future ISO-8601 timestamp when present
- `vault_ids` is optional; when present every vault must already be accessible to the authenticated user through ownership or sharing
- response returns the plaintext key once as `secret`; only the hash is stored

### `POST /api/v1/keys/:keyId/revoke`

Authentication: Supabase session JWT

Revokes a key owned by the authenticated user and returns the updated record.

### `DELETE /api/v1/keys/:keyId`

Authentication: Supabase session JWT

Alias for revoke to match clients that prefer `DELETE`. The record is soft-revoked by setting `revoked_at`; it is not deleted from storage.

### `POST /api/v1/recommendations`

Authentication: Supabase session JWT only

This route proxies Semantic Scholar paper recommendations server-side. RefHub API keys are explicitly rejected for this route so the frontend can use the normal logged-in session without exposing a Semantic Scholar key.

Request body:

```json
{
  "paper_id": "DOI:10.1101/2020.02.20.958025",
  "limit": 10
}
```

Rules:

- `paper_id` is required and should be a Semantic Scholar-compatible paper identifier such as a `paperId` or `DOI:<doi>`
- `limit` is optional and must be an integer from `1` to `25`
- the backend forwards the request to Semantic Scholar from the server and returns a lean normalized list for dialog use

Response shape:

```json
{
  "data": [
    {
      "paper_id": "52cdb6ed946dfed25113bd194d5e2bb843c66331",
      "external_ids": {
        "DOI": "10.1101/2020.11.04.367797"
      },
      "title": "Example paper",
      "abstract": "...",
      "year": 2020,
      "venue": "bioRxiv",
      "url": "https://www.semanticscholar.org/paper/...",
      "citation_count": 42,
      "open_access_pdf_url": "https://...",
      "authors": [
        {
          "author_id": "12345",
          "name": "Example Author"
        }
      ]
    }
  ],
  "meta": {
    "request_id": "uuid",
    "paper_id": "DOI:10.1101/2020.02.20.958025",
    "limit": 10
  }
}
```

### `POST /api/v1/references`

Authentication: Supabase session JWT only

This route proxies Semantic Scholar paper references server-side. It returns the papers cited by the seed paper and rejects RefHub API keys.

Request body:

```json
{
  "paper_id": "DOI:10.1101/2020.02.20.958025",
  "limit": 10
}
```

Rules:

- `paper_id` is required and should be a Semantic Scholar-compatible paper identifier such as a `paperId` or `DOI:<doi>`
- `limit` is optional and must be an integer from `1` to `25`
- the backend forwards the request to Semantic Scholar from the server and returns the same lean normalized paper shape as recommendations

Response shape:

```json
{
  "data": [
    {
      "paper_id": "52cdb6ed946dfed25113bd194d5e2bb843c66331",
      "external_ids": {
        "DOI": "10.1101/2020.11.04.367797"
      },
      "title": "Example paper",
      "abstract": "...",
      "year": 2020,
      "venue": "bioRxiv",
      "url": "https://www.semanticscholar.org/paper/...",
      "citation_count": 42,
      "open_access_pdf_url": "https://...",
      "authors": [
        {
          "author_id": "12345",
          "name": "Example Author"
        }
      ]
    }
  ],
  "meta": {
    "request_id": "uuid",
    "paper_id": "DOI:10.1101/2020.02.20.958025",
    "limit": 10
  }
}
```

### `POST /api/v1/citations`

Authentication: Supabase session JWT only

This route proxies Semantic Scholar paper citations server-side. It returns the papers citing the seed paper and rejects RefHub API keys.

Request body and response shape match `POST /api/v1/references`.

### `GET /api/v1/vaults`

Required scope: `vaults:read`

Returns vaults the API-key owner can access through ownership or explicit share, optionally narrowed by `api_key_vaults`.

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "AI Reading List",
      "visibility": "private",
      "permission": "owner",
      "item_count": 12,
      "updated_at": "2026-03-23T18:00:00Z"
    }
  ],
  "meta": {
    "request_id": "uuid"
  }
}
```

### `GET /api/v1/vaults/:vaultId`

Required scope: `vaults:read`

Returns one vault plus contents. v1 includes:

- vault metadata
- `vault_publications`
- vault-scoped `tags`
- `publication_tags` for those vault publications
- `publication_relations` that reference returned vault publications

### `POST /api/v1/vaults/:vaultId/items`

Required scope: `vaults:write`

Required vault permission: `editor`

Request body:

```json
{
  "items": [
    {
      "title": "Attention Is All You Need",
      "authors": ["Ashish Vaswani"],
      "year": 2017,
      "publication_type": "article",
      "doi": "10.48550/arXiv.1706.03762",
      "tag_ids": ["uuid"]
    }
  ]
}
```

Notes:

- bulk insert is supported to reduce chattiness
- `tag_ids` must already exist in the target vault
- v1 does not create tags implicitly
- requests above `REFHUB_API_MAX_BODY_BYTES` are rejected with `413`
- the handler pre-validates the full batch and attempts rollback on downstream insert failures, but true atomicity still requires a database transaction or RPC

### `PATCH /api/v1/vaults/:vaultId/items/:itemId`

Required scope: `vaults:write`

Required vault permission: `editor`

Request body is partial. If `tag_ids` is present it replaces the item's existing tag set.

### `GET /api/v1/vaults/:vaultId/export?format=json|bibtex`

Required scope: `vaults:export`

Required vault permission: `viewer`

Supported formats in this scaffold:

- `json`
- `bibtex`

## Audit logging

Each request attempts to write one audit row with:

- API key id
- owner user id
- vault id when known
- method and path
- response status
- request id
- latency
- caller IP and user agent

Audit logging is best-effort and must not block successful API responses.

If audit logging fails, the response still returns and the failure is emitted to function logs for follow-up.
