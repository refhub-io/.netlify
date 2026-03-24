# RefHub API v1 — Usage Guide

This document explains how to use the deployed RefHub API v1 backend for:

- API key management
- listing and reading vaults
- adding and updating items
- exporting vault contents
- understanding scopes and access restrictions

Base production URL:

```text
https://refhub-api.netlify.app
```

Versioned API root:

```text
https://refhub-api.netlify.app/api/v1
```

---

## Authentication model

The API has **two authentication modes**.

### 1) Management routes — Supabase session JWT
Use a normal authenticated Supabase user session JWT for:

- listing keys
- creating keys
- revoking keys

Send it as:

```http
Authorization: Bearer <supabase-session-jwt>
```

### 2) Data routes — RefHub API key
Use a generated RefHub API key for:

- listing vaults
- reading vault contents
- adding items
- updating items
- exporting vault data

Send it as either:

```http
Authorization: Bearer rhk_<publicId>_<secret>
```

or:

```http
X-API-Key: rhk_<publicId>_<secret>
```

---

## Scopes

API keys support exactly these scopes:

- `vaults:read`
- `vaults:write`
- `vaults:export`

### Scope meanings

- `vaults:read`
  - list accessible vaults
  - read a specific vault and its contents
- `vaults:write`
  - add items to a vault
  - update existing items in a vault
- `vaults:export`
  - export vault contents as JSON or BibTeX

There are **no item-level scope names** such as `items:write`.
Item writes are covered by `vaults:write`.

---

## Management routes

These routes require a **Supabase session JWT**.

### List API keys

```bash
curl -s \
  -H "Authorization: Bearer $JWT" \
  https://refhub-api.netlify.app/api/v1/keys
```

Example response:

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

### Create API key

```bash
curl -s \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  https://refhub-api.netlify.app/api/v1/keys \
  -d '{
    "label": "my-sync-bot",
    "scopes": ["vaults:read", "vaults:write"]
  }'
```

Example request body:

```json
{
  "label": "my-sync-bot",
  "description": "Local import/sync job",
  "scopes": ["vaults:read", "vaults:write"],
  "expires_at": "2026-06-01T00:00:00Z",
  "vault_ids": ["vault-uuid"]
}
```

Rules:

- `label` is required and must be non-empty
- `scopes` is required and must be a non-empty array
- allowed scopes are only:
  - `vaults:read`
  - `vaults:write`
  - `vaults:export`
- `description` is optional
- `expires_at` is optional, but if present must be a future ISO-8601 timestamp
- `vault_ids` is optional; if provided, each vault must already be accessible to the authenticated user

Example success response:

```json
{
  "data": {
    "id": "58496e90-afaa-4bee-8c49-eb38bf224b67",
    "label": "test-key",
    "description": null,
    "key_prefix": "rhk_ad24e7d51571",
    "scopes": ["vaults:read"],
    "expires_at": null,
    "revoked_at": null,
    "last_used_at": null,
    "created_at": "2026-03-24T15:22:49.258562+00:00",
    "vault_ids": []
  },
  "secret": "rhk_ad24e7d51571_...",
  "meta": {
    "request_id": "294168c2-3ffa-4212-8500-c464f482d7ab"
  }
}
```

### Important: one-time secret

The plaintext API key is returned **once** as `secret` during creation.
Only the hash is stored.
If the client loses the secret, create a new key.

### Revoke API key

Primary revoke route:

```bash
curl -s \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  https://refhub-api.netlify.app/api/v1/keys/<KEY_ID>/revoke
```

Alias route:

```bash
curl -s \
  -X DELETE \
  -H "Authorization: Bearer $JWT" \
  https://refhub-api.netlify.app/api/v1/keys/<KEY_ID>
```

Revocation is soft-delete style: the record remains, but `revoked_at` is set and the key can no longer authenticate.

---

## Data routes

These routes require a **RefHub API key**.

Set one in your shell for examples:

```bash
export RHK='rhk_<publicId>_<secret>'
```

### List accessible vaults

Requires scope: `vaults:read`

```bash
curl -s \
  -H "Authorization: Bearer $RHK" \
  https://refhub-api.netlify.app/api/v1/vaults
```

Example response:

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

### Read one vault

Requires scope: `vaults:read`

```bash
curl -s \
  -H "Authorization: Bearer $RHK" \
  https://refhub-api.netlify.app/api/v1/vaults/<VAULT_ID>
```

Response includes:

- vault metadata
- `vault_publications`
- vault `tags`
- `publication_tags`
- `publication_relations`

### Add items to a vault

Requires scope: `vaults:write`

Also requires the key owner to have at least **editor** access to the vault.

```bash
curl -s \
  -X POST \
  -H "Authorization: Bearer $RHK" \
  -H "Content-Type: application/json" \
  https://refhub-api.netlify.app/api/v1/vaults/<VAULT_ID>/items \
  -d '{
    "items": [
      {
        "title": "Attention Is All You Need",
        "authors": ["Ashish Vaswani", "Noam Shazeer"],
        "year": 2017,
        "publication_type": "article",
        "doi": "10.48550/arXiv.1706.03762"
      }
    ]
  }'
```

You can also attach existing vault tags:

```json
{
  "items": [
    {
      "title": "Some Paper",
      "authors": ["A. Author"],
      "tag_ids": ["tag-uuid-1", "tag-uuid-2"]
    }
  ]
}
```

Notes:

- request body must contain a non-empty `items` array
- each item must include a `title`
- `tag_ids` must already exist in the target vault
- the backend does not create tags implicitly
- requests larger than `REFHUB_API_MAX_BODY_BYTES` are rejected
- true database atomicity is not guaranteed yet; current logic prevalidates and attempts rollback on downstream failure

### Update an item

Requires scope: `vaults:write`

Also requires the key owner to have at least **editor** access to the vault.

```bash
curl -s \
  -X PATCH \
  -H "Authorization: Bearer $RHK" \
  -H "Content-Type: application/json" \
  https://refhub-api.netlify.app/api/v1/vaults/<VAULT_ID>/items/<ITEM_ID> \
  -d '{
    "notes": "Updated through API",
    "year": 2026
  }'
```

If `tag_ids` is provided, it replaces the current tag set on the item.

### Export a vault as JSON

Requires scope: `vaults:export`

```bash
curl -s \
  -H "Authorization: Bearer $RHK" \
  "https://refhub-api.netlify.app/api/v1/vaults/<VAULT_ID>/export?format=json"
```

### Export a vault as BibTeX

Requires scope: `vaults:export`

```bash
curl -s \
  -H "Authorization: Bearer $RHK" \
  "https://refhub-api.netlify.app/api/v1/vaults/<VAULT_ID>/export?format=bibtex"
```

Supported export formats:

- `json`
- `bibtex`

---

## Vault restrictions

API keys can optionally be restricted to specific vault IDs at creation time:

```json
{
  "label": "single-vault-sync",
  "scopes": ["vaults:read", "vaults:write"],
  "vault_ids": ["vault-uuid-1"]
}
```

This narrows what the key can access even if the owning user has access to more vaults.

This is useful for:

- automation jobs
- local tools
- per-integration blast-radius reduction
- read-only or single-vault clients

---

## Access model

The API key inherits the authenticated user’s access model, then narrows further if `vault_ids` restrictions are applied.

A key can only operate on vaults the owning user can already access through:

- ownership
- explicit shares
- public viewer access (read/export routes only, when the backend allows viewer access)

Write operations require stronger permission checks than read operations.

---

## Common key patterns

### Read-only sync bot

```json
{
  "label": "obsidian-sync",
  "scopes": ["vaults:read"]
}
```

### Read/write importer

```json
{
  "label": "paper-importer",
  "scopes": ["vaults:read", "vaults:write"]
}
```

### Export-only integration

```json
{
  "label": "bibtex-export",
  "scopes": ["vaults:export"]
}
```

### Single-vault restricted key

```json
{
  "label": "local-reading-list",
  "scopes": ["vaults:read", "vaults:write"],
  "vault_ids": ["<VAULT_ID>"]
}
```

---

## Recommended manual test flow

1. Create a key using a Supabase session JWT
2. Copy the returned one-time `secret`
3. Use the generated key on `GET /api/v1/vaults`
4. Read a specific vault using `GET /api/v1/vaults/<VAULT_ID>`
5. Add an item using `POST /api/v1/vaults/<VAULT_ID>/items`
6. Export using `GET /api/v1/vaults/<VAULT_ID>/export?format=json`
7. Revoke the key
8. Confirm the revoked key no longer works

---

## Typical error cases

### Invalid scopes

```json
{
  "error": {
    "code": "invalid_scopes",
    "message": "Scopes must be one of vaults:read, vaults:write, vaults:export"
  }
}
```

Cause:

- invalid scope names
- empty scopes array
- missing scopes array

### Missing bearer token

Management routes without JWT:

```json
{
  "error": {
    "code": "missing_bearer_token",
    "message": "Bearer token is required"
  }
}
```

### Invalid API key format

```json
{
  "error": {
    "code": "invalid_api_key_format",
    "message": "API key format is invalid"
  }
}
```

### Revoked key

```json
{
  "error": {
    "code": "revoked_api_key",
    "message": "API key has been revoked"
  }
}
```

### Missing database migration

If backend code is deployed before the API key migration is applied, the backend may log errors like:

```text
Could not find the table 'public.api_keys' in the schema cache
```

Apply the API key migration to the target Supabase project before using management routes.

---

## Local development notes

With `netlify dev`, the backend runs locally at:

```text
http://localhost:8888
```

Because `netlify.toml` redirects `/api/v1/*` to the function entrypoint, local routes are:

```text
http://localhost:8888/api/v1/keys
http://localhost:8888/api/v1/vaults
```

The site root (`http://localhost:8888/`) is not the API.

---

## Frontend integration notes

Current frontend API-key management integration should target the management endpoint under `/api/v1/keys`.

If frontend and backend are served from different origins in production, backend CORS must explicitly allow the frontend origin.

Example live frontend origin:

```text
https://refhub.io
```

---

## Required backend environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REFHUB_API_KEY_PEPPER`

Optional:

- `REFHUB_API_MAX_BULK_ITEMS`
- `REFHUB_API_MAX_BODY_BYTES`
- `REFHUB_API_AUDIT_DISABLED`

---

## Security notes

- Treat created API keys as secrets
- The plaintext `secret` is returned once at creation time
- Revoke any key that was exposed in logs, screenshots, or chat
- Prefer narrow scopes and vault restrictions whenever possible
- Do not embed service-role keys in frontend code
