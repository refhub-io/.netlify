# Publication Bibliographic Rollup for `PATCH` Vault Items

**Date:** 2026-07-06
**Status:** Draft — pending user review
**Scope:** `PATCH /vaults/:vaultId/items/:itemId` only. Explicitly excludes the `POST /vaults/:vaultId/items/upsert` update path (deferred), frontend migration to the same mechanism (tracked separately in refhub-io/refhub.io#148), and any change to Drive-PDF (`publication_pdf_assets`) rollup, which is a different mechanism already confirmed correct.

**Spans two repos:** the SQL function and its migration live in `refhub.io` (`supabase/migrations/`, alongside `copy_publication_to_vault`); the handler change, RPC call, and tests live in `.netlify` (this repo). Both need to land together — the `.netlify` change is inert without the migration applied to the database, and the migration alone doesn't change any API behavior. The implementation plan needs one task list per repo.

---

## Problem

A paper can exist as multiple copies across a user's vaults: one canonical `publications` row plus one `vault_publications` row per vault, each pointing back via `original_publication_id`. Bibliographic fields (title, authors, year, doi, url, pdf_url, etc.) are meant to be shared across every copy — edit one, and the change should propagate to the canonical row and every sibling copy. `notes` and tags are the deliberate exception: vault-local, never propagated.

The RefHub frontend already implements this propagation directly against Supabase (`useSharedVaultOperations.updateVaultPublication`, and a near-duplicate inline version in `Dashboard.tsx`): update the target row, then fire off separate `.then()`-based updates to the canonical row and every sibling row. Errors are only `console.warn`'d — never surfaced, never rolled back.

The `.netlify` REST API's `PATCH /vaults/:vaultId/items/:itemId` has none of this. It only ever updates the single targeted `vault_publications` row. A CLI, browser extension, or any other API-key client editing a paper's `doi` (or any other bibliographic field) today gets **no propagation at all** — the canonical row and every sibling copy silently go stale, with no way to detect it and no bound on how long the divergence persists (there's no background reconciliation; it only "heals" if someone happens to edit that exact copy again through the web app, and even then only if a *different*, still-stale sibling isn't edited first, which would push its own stale values over the fix).

This design closes that gap for `PATCH`, with a stricter guarantee than the frontend's fire-and-forget version: the rollup is atomic — it fully applies or fully fails, with an explicit, structured error either way.

---

## Goals

1. Editing a vault item's bibliographic fields via `PATCH` propagates the change to the canonical `publications` row and every sibling `vault_publications` copy (same `original_publication_id`, different vault).
2. The propagation is atomic: partial application (target updated, siblings not, or vice versa) must be impossible.
3. Failures are reported with a specific, structured error — never silently swallowed, never returned as if the request had fully succeeded.
4. `notes` and `tag_ids` are never part of this mechanism — they stay exactly as vault-local as they are today.

## Non-goals

- Changing `POST /vaults/:vaultId/items/upsert`'s matched-update path to also roll up. Its bulk, automated-sync-shaped usage pattern has a meaningfully different blast-radius profile (see "Considered and rejected" below) — deferred as a separate decision once we see real usage.
- Migrating the frontend to call the same mechanism. Tracked in refhub-io/refhub.io#148.
- Anything about `drive_pdf_url` / `publication_pdf_assets`. That's a separate, already-correct rollup mechanism (vault-specific asset row + canonical asset row, read-side fallback) untouched by this work.

---

## Design

### The atomic Postgres function

A new SQL function, in the same explicit-per-field style as the existing `copy_publication_to_vault` function (not a fully dynamic/looped column update — each bibliographic column gets its own conditional branch, so array/int/text typing stays correct and there's no dynamic-SQL injection surface):

```sql
update_vault_publication_with_rollup(
  p_vault_publication_id uuid,
  p_vault_id uuid,
  p_patch jsonb,
  p_actor_user_id uuid
) RETURNS vault_publications
```

One transaction, three steps:

1. **Target row.** `UPDATE vault_publications SET <only the fields present in p_patch>, version = version + 1, updated_at = now() WHERE id = p_vault_publication_id AND vault_id = p_vault_id`. The `vault_id` check is a defense-in-depth data-layer guard — Node has already verified the caller's access and that the item belongs to this vault before calling the function, but the function doesn't assume that. If no row matches, raise `item_not_found`.
2. **Canonical row.** If `p_patch` touches at least one bibliographic field: `UPDATE publications SET <same fields>, updated_at = now() WHERE id = (the target row's original_publication_id)`. No `version` bump — `publications` has no `version` column, and this matches the frontend's existing behavior of only bumping `version` on the directly-edited copy.
3. **Sibling rows.** `UPDATE vault_publications SET <same fields>, updated_at = now(), updated_by = p_actor_user_id WHERE original_publication_id = <canonical id> AND id <> p_vault_publication_id`. Same no-version-bump rule.

Every `vault_publications` row created through the API always has a non-null `original_publication_id` (confirmed: both `handleAddItems` and `handleBulkUpsertItems`'s create path set it to the just-inserted canonical row's id) — there is no "copy with no canonical parent" case to special-case.

Any failure at any step raises, and Postgres rolls back the entire transaction — nothing partially applied, matching the "strict, exact errors" requirement.

`p_patch`'s fields are restricted to the same bibliographic field allow-list already enforced by `pickPublicationFieldsForUpdate` in `functions/api-v1.js` — Node builds and validates the patch before calling the function, so the function itself only needs to know how to apply each of those known columns, not validate arbitrary input.

### API integration (`handleUpdateItem`, `functions/api-v1.js`)

Current flow: build `updateRow` via `pickPublicationFieldsForUpdate(body)` → if non-empty, bump version/`updated_at` and `.update(updateRow).eq('id', itemId).eq('vault_id', vaultId)` directly against `vault_publications` → handle `tag_ids` separately (unchanged) → re-select and enrich with `drive_pdf_url` (unchanged).

New flow: replace the direct `.update(updateRow)` call with `supabase.rpc('update_vault_publication_with_rollup', { p_vault_publication_id: itemId, p_vault_id: vaultId, p_patch: updateRow, p_actor_user_id: principal.userId })` when `updateRow` is non-empty. Everything else (existence pre-check for a clean 404, `tag_ids` handling, the refreshed re-select + `drive_pdf_url` enrichment) stays as-is.

### Error handling

On RPC failure, return `502 publication_rollup_failed` with the underlying Postgres error message in `details`. No partial success is ever reported as a 200 — either the full rollup applied (200, with the refreshed, enriched row) or none of it did (502, item unchanged).

---

## Related, independently-discovered fix: bulk upsert field-wiping

While scoping this, found that `handleBulkUpsertItems`'s matched-item update branch (`src/routes/items.js`) has the *same* field-wiping bug that `PATCH` had before it was fixed (issue #21, bug 3): it calls `pickPublicationFields(item)` — the insert-time version that force-defaults `authors`/`editor`/`keywords`/`publication_type` to empty/`'article'` when absent from the input — instead of `pickPublicationFieldsForUpdate(item)`. A bulk upsert sending a partial `item` to update just one field on an existing match would wipe those fields today. Fixing this is included in this branch's scope since it's small, unrelated to the rollup mechanism itself, and clearly correct regardless of what's decided about upsert's rollup behavior.

---

## Considered and rejected

**Should `POST /vaults/:vaultId/items/upsert`'s matched-update path also use the rollup RPC?** Rejected for now:

- **Performance:** a single bulk request can update up to `maxBulkItems` (default 50) matched items; each would need its own separate rollup transaction, multiplying the per-request cost significantly.
- **Blast radius / intent mismatch:** `PATCH` is a deliberate, one-off edit of one known item. Bulk upsert matches by DOI/bibtex_key and is shaped for repeated, unattended automation (it already has an idempotency-key cache) — most plausibly "re-sync this vault from an external `.bib` file on a schedule." If that path also rolled up, a routine automated re-sync of one vault could silently overwrite carefully-curated fields (e.g. a manually-set `abstract` or `pdf_url`) in a *different* vault holding the same paper — a vault the sync tool doesn't touch directly and may not even know exists — on every run.

This is tracked as a follow-up decision once there's real usage data to weigh against the consistency argument (a CLI built around bulk sync might prefer to get the same guarantee `PATCH` gets).

---

## Testing

- **Vitest, mocking `supabase.rpc(...)`:** confirms the RPC is invoked with the correct `p_patch` when the body contains bibliographic fields; confirms it is *not* invoked for a tag-only `PATCH` (no fields present in `updateRow` at all). `notes` is itself one of `PUBLICATION_FIELDS`, so a notes-only `PATCH` *does* still call the RPC — it just updates the target row's `notes` and skips the canonical/sibling rollup, since `notes` alone doesn't trigger `v_has_bibliographic_patch`. Confirms an RPC failure surfaces as the structured `502 publication_rollup_failed` response rather than a 200, and that the item is left unmodified from the caller's perspective (no `data` returned as if it succeeded).
- **Bulk upsert regression test:** mirrors the existing `PATCH` regression test — sending a partial `item` to update an existing match must not wipe `authors`/`editor`/`keywords`/`publication_type`.
- **Out of reach for vitest:** the SQL function's actual transactional behavior (does it really roll back fully on a mid-transaction failure, does the canonical/sibling fan-out actually reach every row it should). This needs a manual dry run against a real Supabase/Postgres instance before merge — vitest can only verify that the Node layer calls the RPC correctly and handles its success/failure shape correctly, not that the SQL itself is correct.

---

## Migration

New file under `supabase/migrations/` (in `refhub.io`, where `copy_publication_to_vault` and the `publication_pdf_assets` migrations already live), following the existing timestamp-prefixed naming convention, containing the `update_vault_publication_with_rollup` function definition.
