# RefHub Backend — Inbox API Design

**Date:** 2026-09-12
**Status:** Draft
**Scope:** New `/api/v1/inbox` route family, backing refhub.io's paper-inbox feature (refhub.io#219) for CLI/agent access. Phase 1 of 2 — CLI (`refhub-cli`) and skill (`refhub-skill`) coverage are a follow-up phase, checkpointed after this ships.

---

## Goals

refhub.io shipped a "paper inbox" (#219): capture a reference before you know which vault it belongs in, then triage it later — accept into a vault with tags, reject, merge with a detected duplicate, or postpone. Today this is implemented purely against Supabase directly from the web client (RLS-gated), with no equivalent in this API. `refhub-cli` and `refhub-skill` therefore have no way to capture something into a user's inbox or triage it on their behalf — filed as [.netlify#39](https://github.com/refhub-io/.netlify/issues/39), [refhub-cli#20](https://github.com/refhub-io/refhub-cli/issues/20), [refhub-skill#14](https://github.com/refhub-io/refhub-skill/issues/14).

This spec covers the backend route family only. It closes .netlify#39.

## Design principles

Same as the existing [V2 API design](2026-04-09-refhub-v2-api-design.md):

1. **Additive only** — new routes and a new route module; nothing existing changes shape.
2. **Backward compatible** — no scope changes; reuses `vaults:read`/`vaults:write`.
3. **No new DB migration for the table** — `inbox_items` already exists (refhub.io migration `20260905000000_paper_inbox.sql`), with RLS already fine (owner-only, standard `auth.uid() = user_id` policies). It is untouched here.
4. **One new DB migration for the accept path** — see "Accept must be atomic" below.
5. **Hard deletes only** — matches the rest of V2; no soft-delete concept for inbox items.

---

## Why inbox routes live outside `/vaults/:vaultId/...`

Every other V2 route family is vault-scoped because the underlying data always belongs to a vault. `inbox_items` doesn't — it belongs to the *user account*, with no vault at all until the `accept` action creates one. Nesting these routes under `/vaults/:vaultId/inbox` would be actively misleading (which vault would a *pending* item be under?). They're structured as a new top-level family instead:

```
GET    /api/v1/inbox                capture buffer for the caller
POST   /api/v1/inbox
POST   /api/v1/inbox/:id/accept
POST   /api/v1/inbox/:id/reject
POST   /api/v1/inbox/:id/merge
POST   /api/v1/inbox/:id/postpone
DELETE /api/v1/inbox/:id
```

This mirrors how `/keys` and `/google-drive` already sit outside the vault tree for the same reason (account-scoped, not vault-scoped) — except inbox routes authenticate via API key like `/vaults/...`/`/items/...` do, not via session JWT like `/keys` does, since this is squarely an agent/CLI-facing capture-and-triage surface, not an account-management one.

## Auth & scopes

No new scope. Reusing the existing two:

| Operation | Required scope | Vault permission check |
|---|---|---|
| `GET /inbox` | `vaults:read` | none — account-scoped |
| `POST /inbox` (capture) | `vaults:write` | none — account-scoped |
| `POST /inbox/:id/accept` | `vaults:write` | `resolveVaultAccess(..., 'editor')` on `target_vault_id` |
| `POST /inbox/:id/reject` | `vaults:write` | none |
| `POST /inbox/:id/merge` | `vaults:write` | none |
| `POST /inbox/:id/postpone` | `vaults:write` | none |
| `DELETE /inbox/:id` | `vaults:write` | none |

A new scope was considered and rejected: capture/triage is a natural extension of "can write to my vaults" (everything but reject/postpone/delete eventually produces a vault write), not a distinct trust tier the way `vaults:admin` (vault lifecycle, sharing) is.

Every handler additionally scopes its Supabase query by `.eq('user_id', principal.userId)` — there is no cross-account access path here at all, unlike vault routes where sharing exists.

---

## Endpoints

### `GET /api/v1/inbox`

List the caller's pending inbox items.

- Query params: `?limit=` (default 50, max 200), `?page=`.
- Returns only `status = 'pending'` items, ordered by `sort_order asc, created_at asc` — matching the web app's own `useInbox` query exactly. Accepted/rejected/merged items aren't listed anywhere via this API; there's no history view in scope (only `refhub.io`'s own DB access could show one today).
- Response:
  ```json
  {
    "data": [
      {
        "id": "...", "status": "pending", "source_type": "doi", "source_ref": "10.1000/xyz",
        "parsed_fields": { "title": "...", "authors": ["..."], "year": 2024 },
        "suggested_vault_id": null, "suggested_tag_ids": null,
        "duplicate_of_publication_id": null, "filed_publication_id": null,
        "sort_order": 0, "created_at": "...", "updated_at": "..."
      }
    ],
    "meta": { "request_id": "...", "page": 1, "limit": 50 }
  }
  ```

Vault/tag suggestion and duplicate detection (`inboxSuggestions.ts`/`inboxDedup.ts` in refhub.io) stay **client-side, not ported here** — they're pure functions over the caller's full library, and porting them would mean either the CLI/agent re-fetching the whole library to run them locally (defeats the point of an API) or duplicating non-trivial scoring logic in two languages/runtimes. A CLI/agent using this API sees `suggested_vault_id`/`suggested_tag_ids`/`duplicate_of_publication_id` as `null` unless the *web app* already scored that item (they're columns on the same row, so a value written by one client is visible to the other) — CLI/agent triage picks a vault/tags explicitly rather than relying on a suggestion. Worth revisiting if agent-side scoring turns out to matter in practice.

### `POST /api/v1/inbox`

Capture one item. Mirrors `InboxCaptureForm`'s three tabs (doi/bibtex/manual — the web app's own capture surface was deliberately narrowed to these three in #219; see that PR for why arXiv/S2-URL/PDF aren't included).

- Body: `{ source_type: 'doi' | 'bibtex' | 'manual', source_ref: string, parsed_fields?: object }`
- For `doi`: if `parsed_fields` is omitted, the server fetches metadata the same way `import/doi` already does (reuses that existing code path) and degrades to `{ title: source_ref }` on lookup failure — never blocks capture, matching the web app's behavior.
- For `bibtex`: `source_ref` is the raw BibTeX string; reuses `src/bibtex.js`'s existing parser. A multi-entry BibTeX string creates multiple inbox items in one call — response `data` is an array in that case, a single object otherwise (matches `import/bibtex`'s existing `{created: [...], skipped: [...]}` precedent for shape, adapted: no "skipped" concept for inbox capture since there's no in-vault duplicate check at capture time).
- For `manual`: `parsed_fields.title` is required.
- Response: `201` with the created item (or array of items, for multi-entry bibtex).

### `POST /api/v1/inbox/:id/accept`

- Body: `{ vault_id: string, tag_ids?: string[] }`
- Requires editor permission on `vault_id` (`resolveVaultAccess`).
- Calls the new `accept_inbox_item` Postgres function (see below) — one atomic operation.
- On success: `200` with `{ vault_publication_id, publication_id }`.
- Tag IDs not belonging to `vault_id` are silently dropped (validated inside the function), matching the fix just shipped in refhub.io#219 for the same scenario in the web app.
- If the item is already non-`pending` (already accepted/rejected/merged elsewhere — e.g. the web app did it first): `409 item_not_pending`.

### `POST /api/v1/inbox/:id/reject`

- No body.
- Sets `status = 'rejected'`. `200` with `{ id }`.

### `POST /api/v1/inbox/:id/merge`

- No body.
- Requires `duplicate_of_publication_id` to already be set on the item — mirrors the guard just added to refhub.io's `useInbox.mergeItem` (refhub.io#219 review fix): merging with no known duplicate target would silently discard the item. `409 no_duplicate_target` if null.
- Sets `status = 'merged'`, `filed_publication_id = duplicate_of_publication_id`. `200` with `{ id, filed_publication_id }`.

### `POST /api/v1/inbox/:id/postpone`

- No body.
- Bumps `sort_order` to `max(sort_order) + 1` across the caller's pending items (same logic as the web app's `postponeItem`), sending it to the back of the queue. `200` with `{ id, sort_order }`.

### `DELETE /api/v1/inbox/:id`

- Hard delete, any status. Exists for cleanup (a captured-then-abandoned item, or an integration test tearing down its own fixtures) — the web app has no equivalent UI action; rejecting is its "get rid of this" path. `200` with `{ id }`.

All mutating endpoints scope every query by `id` **and** `user_id` — a request for another user's item id returns `404 inbox_item_not_found`, not `403`, to avoid confirming the id exists.

---

## Accept must be atomic

The web app's own accept flow (`Inbox.tsx`'s `handleAccept`) does three separate writes — insert into `publications`, `copy_publication_to_vault` RPC, then an `inbox_items` status update — with no rollback on partial failure. That gap is filed as refhub.io#225 and explicitly **not** fixed there in this work (needs a design decision, not a quick patch). Since this API is new, it ships the fix from day one instead of adding a second copy of the same gap.

### `accept_inbox_item` (new Postgres function, refhub.io migration)

```sql
CREATE OR REPLACE FUNCTION public.accept_inbox_item(
  p_inbox_item_id uuid,
  p_target_vault_id uuid,
  p_tag_ids uuid[],
  p_user_id uuid
) RETURNS TABLE(vault_publication_id uuid, publication_id uuid)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_item inbox_items%ROWTYPE;
  v_new_pub_id uuid;
  v_new_vault_pub_id uuid;
BEGIN
  SELECT * INTO v_item FROM inbox_items
    WHERE id = p_inbox_item_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inbox item not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_item.status <> 'pending' THEN
    RAISE EXCEPTION 'inbox item is not pending' USING ERRCODE = 'check_violation';
  END IF;

  -- parsed_fields -> publications row. Exact column list finalized during
  -- implementation against Partial<Publication>'s actual field set;
  -- jsonb_populate_record against publications' own row type is the
  -- likely mechanism, with user_id overridden explicitly.
  INSERT INTO publications (user_id, title, authors, year, journal, doi, url,
      abstract, pdf_url, publication_type, bibtex_key)
  SELECT p_user_id,
      v_item.parsed_fields->>'title',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_item.parsed_fields->'authors')), '{}'),
      (v_item.parsed_fields->>'year')::int,
      v_item.parsed_fields->>'journal',
      v_item.parsed_fields->>'doi',
      v_item.parsed_fields->>'url',
      v_item.parsed_fields->>'abstract',
      v_item.parsed_fields->>'pdf_url',
      COALESCE(v_item.parsed_fields->>'publication_type', 'article'),
      v_item.parsed_fields->>'bibtex_key'
  RETURNING id INTO v_new_pub_id;

  v_new_vault_pub_id := copy_publication_to_vault(v_new_pub_id, p_target_vault_id, p_user_id);

  IF p_tag_ids IS NOT NULL AND cardinality(p_tag_ids) > 0 THEN
    INSERT INTO publication_tags (vault_publication_id, publication_id, tag_id)
    SELECT v_new_vault_pub_id, NULL, t.id
    FROM tags t
    WHERE t.id = ANY(p_tag_ids) AND t.vault_id = p_target_vault_id;
  END IF;

  UPDATE inbox_items
    SET status = 'accepted', filed_publication_id = v_new_pub_id
    WHERE id = p_inbox_item_id;

  UPDATE vaults SET updated_at = now() WHERE id = p_target_vault_id;

  RETURN QUERY SELECT v_new_vault_pub_id, v_new_pub_id;
END;
$$;
```

`FOR UPDATE` on the initial select locks the row for the duration of the transaction, so two concurrent accept calls on the same item can't both succeed (the second sees `status <> 'pending'` once the first commits — or blocks briefly then sees it, depending on isolation level; default READ COMMITTED is fine here since the second call re-reads post-lock-release). The whole function runs in one transaction implicitly (a single plpgsql function body is one transaction unless it explicitly manages subtransactions) — any exception anywhere in the body rolls back everything, including the `publications` insert. This is the actual fix: no more orphaned publication rows on partial failure.

The route handler (`handleAcceptInboxItem`) calls this via `.rpc('accept_inbox_item', {...})`, checks vault access with `resolveVaultAccess` **before** calling it (so a caller without editor permission never reaches the function at all — belt-and-suspenders, since the function itself doesn't re-check permission), and maps a thrown exception to the right HTTP status (`P0002` → 404, `check_violation` → 409).

---

## Error handling

Standard V2 error envelope (`src/http.js`'s `errorResponse`), consistent with every existing route:

| Condition | Status | Code |
|---|---|---|
| Missing/wrong scope | 403 | `missing_scope` |
| Item not found / not owned | 404 | `inbox_item_not_found` |
| Item not pending (accept/reject/merge/postpone — `DELETE` is exempt, see below) | 409 | `item_not_pending` |
| Merge with no duplicate target | 409 | `no_duplicate_target` |
| Accept target vault: not found / no editor access | 404 / 403 | `vault_not_found` / `insufficient_vault_access` (existing `resolveVaultAccess` codes) |
| Invalid body | 400 | `invalid_body` |
| BibTeX parse yields zero entries | 400 | `invalid_bibtex` |

`reject`/`postpone` only make sense on a `pending` item (rejecting an already-accepted item is meaningless) — both get the same `409 item_not_pending` guard as accept/merge. `DELETE` is the one exception (works on any status, since its purpose is cleanup).

---

## Testing plan

Following this repo's existing per-route test convention (`tests/routes/inbox.test.js`, using `tests/helpers.js`'s mock builders):

- Scope-check rejection for each endpoint (missing `vaults:read`/`vaults:write`).
- `GET /inbox` — pagination, ordering, empty-list case.
- `POST /inbox` — doi (with and without lookup success), bibtex (single and multi-entry), manual (title required), each source type's degrade-gracefully path.
- `POST /inbox/:id/accept` — happy path (asserts all three effects: publication created, vault_publication created, inbox item status updated); insufficient vault permission; tag filtering (a tag_id from a different vault is silently dropped, not inserted); already-non-pending item → 409; item belonging to another user → 404.
- `POST /inbox/:id/merge` — happy path; no duplicate target → 409.
- `POST /inbox/:id/reject`, `/postpone` — happy path; non-pending → 409.
- `DELETE /inbox/:id` — works regardless of status; another user's item → 404.
- A migration-level test (or manual verification) that a forced failure partway through `accept_inbox_item` (e.g. an invalid `target_vault_id`) leaves **no** `publications` row behind — the actual regression test for the atomicity fix.

---

## Documentation & versioning

Per `CONTRIBUTING.md`: minor version bump (2.7.0 → 2.8.0, new additive endpoints), `CHANGELOG.md` entry in the same PR, `docs/API_USAGE.md` gains an "Inbox" section following its existing per-route-family format.

---

## Out of scope (this spec)

- **`refhub-cli`** — new `inbox` command group (`refhub inbox add/list/accept/reject/merge/postpone`), mirroring `import.ts`'s existing shape. Phase 2, after this ships and its shape is confirmed stable in practice.
- **`refhub-skill`** — corresponding skill operations, likely thin wrappers over the CLI/API. Phase 2, same checkpoint.
- **Agent-side suggestion/duplicate scoring** — noted above as a real gap (CLI/agent triage has no suggestion assist), deliberately deferred rather than porting `inboxSuggestions.ts`/`inboxDedup.ts` to this runtime speculatively.
- **Webhooks/event delivery for new inbox items** — would let an agent react to a newly-captured item without polling; not requested, not designed here.
