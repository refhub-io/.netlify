# RefHub Backend V2 API Design

**Date:** 2026-04-09  
**Status:** Approved  
**Scope:** Tracks 1–8 of V2_ROADMAP.md. Webhooks, vault archiving, soft-delete, and item revision history are explicitly deferred to a future cycle.

---

## Goals

Extend the RefHub API to support agentic workflows without breaking any existing behavior. Every existing API key, route, and response shape continues to work identically after V2 ships.

---

## Design principles

1. **Additive only** — new routes and scopes are added; nothing existing is removed or changed.
2. **Backward compatible** — existing keys with `vaults:read/write/export` continue to work exactly as before.
3. **Vault-level `updated_at` on all writes** — every write handler touches `vaults.updated_at` via an application-level UPDATE, relying on the existing `update_vaults_updated_at` DB trigger.
4. **Hard deletes only** — no soft-delete or restore. Deleted items, vaults, tags, and relations are gone permanently.
5. **No new DB migrations for core tracks** — all required tables already exist in the schema. The only DB-adjacent change is the application-level vault `updated_at` touch pattern.

---

## Architecture & module structure

New route logic lives in `src/routes/`. Existing code in `functions/api-v1.js` is untouched — a future modularization audit will migrate it separately.

```
functions/
  api-v1.js                  ← existing dispatcher; gains new route dispatch blocks only
src/
  auth.js                    ← gains new scope constants only
  config.js                  ← untouched
  export.js                  ← untouched
  http.js                    ← untouched
  google-drive.js            ← untouched
  semantic-scholar.js        ← untouched
  routes/
    vaults.js                ← Track 2: vault lifecycle + sharing + visibility
    items.js                 ← Track 3: item delete + bulk upsert + import-preview
    tags.js                  ← Track 4: tag CRUD + attach/detach
    relations.js             ← Track 5: relation CRUD
    search.js                ← Track 6: search, filter, stats, changes feed
    import.js                ← Track 7: DOI/BibTeX/URL import
    audit.js                 ← Track 8: audit read endpoints
```

### Dispatcher pattern

`api-v1.js` gains new dispatch blocks at the top of the API key route section, before the existing route matches. Each block checks the route pattern and delegates to the relevant module. No existing handler is moved, renamed, or modified.

```js
// New dispatch blocks (added before existing route matches)
if (route[0] === 'vaults' && isVaultLifecycleRoute(route, method))  → routes/vaults.js
if (route[0] === 'vaults' && isItemsRoute(route, method))           → routes/items.js
if (route[0] === 'vaults' && isTagsRoute(route, method))            → routes/tags.js
if (route[0] === 'vaults' && isRelationsRoute(route, method))       → routes/relations.js
if (route[0] === 'vaults' && isSearchRoute(route, method))          → routes/search.js
if (route[0] === 'vaults' && isImportRoute(route, method))          → routes/import.js
if (route[0] === 'audit')                                           → routes/audit.js
// ... existing route matches follow unchanged
```

---

## Track 1 — Scope model expansion

### Revised scope set (4 total, up from 3)

```js
export const API_SCOPES = {
  // Existing — behavior unchanged
  READ:   'vaults:read',    // read vaults, items, tags, relations
  WRITE:  'vaults:write',   // write items, tags, relations
  EXPORT: 'vaults:export',  // export vault contents

  // New
  ADMIN:  'vaults:admin',   // create vaults, delete vaults, manage shares and visibility
};
```

### Scope implications

| Operation | Required scope | Min vault permission |
|---|---|---|
| Read vault / items / tags / relations | `vaults:read` | viewer |
| Write items / tags / relations | `vaults:write` | editor |
| Export vault | `vaults:export` | viewer |
| Create vault | `vaults:admin` | — (account-level) |
| Update vault metadata / visibility | `vaults:admin` | owner |
| Delete vault | `vaults:admin` | owner |
| Manage shares | `vaults:admin` | owner |
| Read audit logs | any valid API key | — (own logs only) |

Tags read/write are implied by `vaults:read`/`vaults:write` — no separate scope check.  
Relations read/write are implied by `vaults:read`/`vaults:write` — no separate scope check.  
`vaults:create` and vault delete are both implied by `vaults:admin`.

### Backward compatibility

- `normalizeRequestedScopes()` in `api-v1.js` is updated to accept `vaults:admin`.
- The DB `api_keys.scopes` check constraint is `cardinality > 0` only — no migration needed.
- Existing keys with only `vaults:read/write/export` are unaffected.

### Frontend changes

- `API_KEY_SCOPES` in `src/lib/apiKeys.ts` gains `vaults:admin` entry.
- `ApiKeyManagementPanel.tsx` `selectedScopes` state gains the new checkbox.
- Warning label on `vaults:admin`: "Grants vault creation, deletion, and share management — use only for trusted automations."
- **TODO:** Add audit log viewer tab/section to the API Key management panel (deferred to frontend update cycle).

---

## Track 2 — Vault lifecycle (`src/routes/vaults.js`)

All endpoints require `vaults:admin` scope.

### Endpoints

```
POST   /api/v1/vaults                              create vault
PATCH  /api/v1/vaults/:vaultId                     update vault metadata
DELETE /api/v1/vaults/:vaultId                     delete vault (hard delete)
PATCH  /api/v1/vaults/:vaultId/visibility          set vault visibility
GET    /api/v1/vaults/:vaultId/shares              list collaborators
POST   /api/v1/vaults/:vaultId/shares              add collaborator
PATCH  /api/v1/vaults/:vaultId/shares/:shareId     update collaborator role
DELETE /api/v1/vaults/:vaultId/shares/:shareId     remove collaborator
```

### Create vault — `POST /api/v1/vaults`

- Scope: `vaults:admin`. No vault restriction check (account-level).
- Body: `{ name, description?, color?, visibility?, category?, abstract? }`
- `visibility` defaults to `private`.
- Returns the created vault row.

### Update vault metadata — `PATCH /api/v1/vaults/:vaultId`

- Scope: `vaults:admin` + owner permission.
- Body: any subset of `{ name, description, color, category, abstract }`.
- Does **not** accept `visibility` or `public_slug` — use the dedicated visibility endpoint for those.
- Bumps `vaults.updated_at` via the application-level touch.

### Delete vault — `DELETE /api/v1/vaults/:vaultId`

- Scope: `vaults:admin` + owner permission.
- Hard delete. DB foreign key cascades remove `vault_publications`, `tags`, `vault_shares`, `api_key_vaults` entries. No undo.
- Returns `204 No Content`.

### Set visibility — `PATCH /api/v1/vaults/:vaultId/visibility`

- Scope: `vaults:admin` + owner permission.
- Body: `{ visibility: 'private' | 'protected' | 'public', public_slug?: string }`
- Rules:
  - `public` requires `public_slug` (lowercase alphanumeric + hyphens, unique across all vaults).
  - `private` clears `public_slug`.
  - `protected` leaves `public_slug` unchanged.
- Returns the updated vault.

### Share management — `/api/v1/vaults/:vaultId/shares`

- Scope: `vaults:admin` + owner permission on the vault.
- **Auto-upgrade:** When adding a share to a `private` vault, the vault is automatically upgraded to `protected`.
- `POST` body: `{ email?, user_id?, role }` where role is `viewer | editor | owner`.
- `PATCH` body: `{ role }`.
- `DELETE` returns `204 No Content`.
- Uses `vault_shares` table directly.

---

## Track 3 — Item lifecycle (`src/routes/items.js`)

Existing `POST /vaults/:vaultId/items` (add) and `PATCH /vaults/:vaultId/items/:itemId` (update) remain in `api-v1.js` unchanged.

### New endpoints

```
DELETE /api/v1/vaults/:vaultId/items/:itemId          hard delete item
POST   /api/v1/vaults/:vaultId/items/upsert           bulk upsert by DOI or title+year
POST   /api/v1/vaults/:vaultId/items/import-preview   dry-run duplicate check
```

### Delete item — `DELETE /api/v1/vaults/:vaultId/items/:itemId`

- Scope: `vaults:write` + editor permission.
- Hard deletes from `vault_publications`. Cascades `publication_tags`.
- The underlying `publications` row is **not** deleted (may be referenced by other vaults via `original_publication_id`).
- Bumps `vaults.updated_at`.
- Returns `204 No Content`.

### Bulk upsert — `POST /api/v1/vaults/:vaultId/items/upsert`

- Scope: `vaults:write` + editor permission.
- Body: `{ items: [...], idempotency_key?: string }`
- Match strategy: DOI match first, then title+year match.
- Per-item result: `{ action: 'created' | 'updated' | 'skipped', id, ... }`
- Idempotency: if `idempotency_key` was seen within 24h, return previous result without re-executing. Stored in an in-memory map (same pattern as Semantic Scholar cache).
- Bumps `vaults.updated_at` on any create or update.

### Import preview — `POST /api/v1/vaults/:vaultId/items/import-preview`

- Scope: `vaults:read`. Writes nothing.
- Same body and response shape as upsert. Dry-run only.
- Useful for agents showing the user what would change before committing.

---

## Track 4 — Tags (`src/routes/tags.js`)

Tags already exist in the DB. These endpoints make them independently manageable rather than only accessible through the full vault read.

### Endpoints

```
GET    /api/v1/vaults/:vaultId/tags                list all tags for vault
POST   /api/v1/vaults/:vaultId/tags                create tag
PATCH  /api/v1/vaults/:vaultId/tags/:tagId         update tag
DELETE /api/v1/vaults/:vaultId/tags/:tagId         delete tag
POST   /api/v1/vaults/:vaultId/tags/attach         attach tags to an item
POST   /api/v1/vaults/:vaultId/tags/detach         detach tags from an item
```

### Scope requirements

- `GET`: `vaults:read` + viewer permission.
- `POST`, `PATCH`, `DELETE`, `attach`, `detach`: `vaults:write` + editor permission.

### Create tag — `POST /api/v1/vaults/:vaultId/tags`

- Body: `{ name, color?, parent_id? }`
- Sets `vault_id` from route, `user_id` from principal.
- `depth` computed from parent chain (parent.depth + 1). Existing `trigger_update_tag_depth` DB trigger handles this automatically.
- Bumps `vaults.updated_at`.

### Update tag — `PATCH /api/v1/vaults/:vaultId/tags/:tagId`

- Body: `{ name?, color?, parent_id? }`
- Reparenting: guards against circular parent references before updating.
- `depth` recalculated by the existing DB trigger on `parent_id` change.
- Bumps `vaults.updated_at`.

### Delete tag — `DELETE /api/v1/vaults/:vaultId/tags/:tagId`

- Cascades: removes all `publication_tags` rows referencing this tag.
- Child tags: `parent_id` set to the deleted tag's `parent_id` (bubbles up, no orphans).
- Bumps `vaults.updated_at`.
- Returns `204 No Content`.

### Attach — `POST /api/v1/vaults/:vaultId/tags/attach`

- Body: `{ item_id, tag_ids: [] }`
- Idempotent — no duplicate `publication_tags` rows.
- Validates all `tag_ids` belong to this vault before inserting.
- Bumps `vaults.updated_at`.

### Detach — `POST /api/v1/vaults/:vaultId/tags/detach`

- Body: `{ item_id, tag_ids: [] }`
- Silently ignores tag IDs not currently attached.
- Bumps `vaults.updated_at`.

---

## Track 5 — Relations (`src/routes/relations.js`)

Relations already exist in the DB (`publication_relations`). These endpoints make them independently manageable.

### Endpoints

```
GET    /api/v1/vaults/:vaultId/relations                 list relations
POST   /api/v1/vaults/:vaultId/relations                 create relation
PATCH  /api/v1/vaults/:vaultId/relations/:relationId     update relation type
DELETE /api/v1/vaults/:vaultId/relations/:relationId     delete relation
```

### Scope requirements

- `GET`: `vaults:read` + viewer permission.
- `POST`, `PATCH`, `DELETE`: `vaults:write` + editor permission.

### List relations — `GET /api/v1/vaults/:vaultId/relations`

- Query params: `?source_id=`, `?target_id=`, `?type=`
- Returns relations where either endpoint belongs to an item in this vault.

### Create relation — `POST /api/v1/vaults/:vaultId/relations`

- Body: `{ publication_id, related_publication_id, relation_type? }`
- `relation_type` defaults to `"related"`.
- Guards against self-reference (DB constraint `no_self_reference` already exists).
- Idempotent: if the same pair already exists, returns the existing record with `200` rather than a `409`.
- Only the `relation_type` is mutable after creation.
- Bumps `vaults.updated_at`.

### Update relation — `PATCH /api/v1/vaults/:vaultId/relations/:relationId`

- Body: `{ relation_type }`
- Only `relation_type` is mutable.
- Bumps `vaults.updated_at`.

### Delete relation — `DELETE /api/v1/vaults/:vaultId/relations/:relationId`

- Hard delete. No cascade side-effects.
- Bumps `vaults.updated_at`.
- Returns `204 No Content`.

---

## Track 6 — Search, filtering & stats (`src/routes/search.js`)

All require `vaults:read` + viewer permission.

### Endpoints

```
GET /api/v1/vaults/:vaultId/search     full-text + field search
GET /api/v1/vaults/:vaultId/stats      item / tag / relation counts + last updated
GET /api/v1/vaults/:vaultId/changes    items changed since a timestamp
```

### Search — `GET /api/v1/vaults/:vaultId/search`

Query params: `?q=`, `?author=`, `?year=`, `?doi=`, `?tag_id=`, `?type=`, `?page=`, `?limit=` (default 20, max 100).

- `q` does case-insensitive substring match (`ILIKE`) across `title`, `abstract`, `authors`.
- Field filters are ANDed.
- Returns paginated `vault_publications` with their `tag_ids` attached.
- No full-text index required — Postgres `ILIKE` is sufficient for vault-scoped queries.

### Stats — `GET /api/v1/vaults/:vaultId/stats`

Returns:
```json
{
  "item_count": 42,
  "tag_count": 8,
  "relation_count": 15,
  "last_updated": "<vaults.updated_at>"
}
```

`last_updated` reads directly from `vaults.updated_at` — reflects the last change to anything in the vault (items, tags, relations, metadata) via the application-level vault touch pattern.

### Changes feed — `GET /api/v1/vaults/:vaultId/changes`

Query param: `?since=<ISO timestamp>` (required).

Returns all `vault_publications` where `updated_at > since`. Enables incremental sync — agents don't need to re-download the full vault to detect what changed.

---

## Track 7 — Import (`src/routes/import.js`)

All require `vaults:write` + editor permission. All bump `vaults.updated_at` on success.

### Endpoints

```
POST /api/v1/vaults/:vaultId/import/doi     fetch DOI metadata → create item
POST /api/v1/vaults/:vaultId/import/bibtex  parse BibTeX → create one or many items
POST /api/v1/vaults/:vaultId/import/url     fetch URL metadata → create item
```

### DOI import — `POST /api/v1/vaults/:vaultId/import/doi`

- Body: `{ doi, tag_ids?: [] }`
- Calls existing `fetchSemanticScholarDoiMetadata()` internally.
- Maps Semantic Scholar response to a `vault_publication` row and inserts it.
- If DOI already exists in the vault: returns `409` with the existing item.
- Returns the created item on success.

### BibTeX import — `POST /api/v1/vaults/:vaultId/import/bibtex`

- Body: `{ bibtex, tag_ids?: [] }`
- Parses BibTeX string (single or multi-entry). Reuses the existing frontend BibTeX parser logic — a shared JS util will be extracted to `src/bibtex.js`.
- Skips entries where `bibtex_key` already exists in the vault.
- Returns `{ created: [...], skipped: [...] }`.

### URL import — `POST /api/v1/vaults/:vaultId/import/url`

- Body: `{ url, tag_ids?: [] }`
- Fetches Open Graph / meta tags from the URL.
- Best-effort: creates the item with whatever metadata is available (at minimum `title` + `url`).
- Returns the created item.

---

## Track 8 — Audit read endpoints (`src/routes/audit.js`)

No extra scope required — any valid API key can read its own owner's logs.

### Endpoints

```
GET /api/v1/audit                        all requests for this key's owner
GET /api/v1/vaults/:vaultId/audit        requests scoped to a specific vault
```

### Query params (both endpoints)

`?since=`, `?until=`, `?limit=` (default 50, max 200), `?page=`

### Data source

Reads from `api_request_audit_logs`, filtered by `owner_user_id = principal.userId`. The vault-scoped endpoint additionally filters by `vault_id`.

### Frontend TODO

The API Key management panel (`ApiKeyManagementPanel.tsx`) needs an audit log viewer — a tab or expandable section per key showing recent requests. Deferred to the frontend update cycle alongside the `vaults:admin` scope addition.

---

## Vault `updated_at` touch pattern

Every write handler (items, tags, relations, imports) runs this after the main operation:

```js
await supabase
  .from('vaults')
  .update({ updated_at: new Date().toISOString() })
  .eq('id', vaultId)
```

The existing `update_vaults_updated_at` DB trigger (`BEFORE UPDATE ON vaults`) fires and stamps `now()`. No new DB triggers or migrations required.

---

## Deferred (not in this cycle)

| Feature | Reason |
|---|---|
| Webhooks / event delivery | Requires new tables, delivery queue, retry logic — Phase C |
| Vault archiving | No frontend counterpart; no concrete use case yet |
| Item soft-delete / restore | Hard delete is sufficient; revision table would need new schema |
| Item revision history | No history table in current schema |
| Audit log viewer in frontend | Tracked as TODO above — frontend update cycle |

---

## Implementation sequence

1. Track 1 — Scope model (`auth.js` + frontend `apiKeys.ts`)
2. Track 2 — Vault lifecycle (`src/routes/vaults.js`)
3. Track 4 — Tags (`src/routes/tags.js`)
4. Track 5 — Relations (`src/routes/relations.js`)
5. Track 6 — Search/stats/changes (`src/routes/search.js`)
6. Track 3 — Item lifecycle (`src/routes/items.js`)
7. Track 7 — Import (`src/routes/import.js`)
8. Track 8 — Audit reads (`src/routes/audit.js`)
9. Dispatcher wiring in `api-v1.js`
10. Frontend: `vaults:admin` scope + audit log viewer TODO
