/**
 * V2 item lifecycle route handlers (complement to existing add/update in api-v1.js).
 *
 * Covered endpoints:
 *   DELETE /api/v1/vaults/:vaultId/items/:itemId          handleDeleteItem
 *   POST   /api/v1/vaults/:vaultId/items/upsert           handleBulkUpsertItems
 *   POST   /api/v1/vaults/:vaultId/items/import-preview   handleImportPreview
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { getConfig } from "../config.js";
import { VAULT_PUBLICATION_SELECT, pickPublicationFields, touchVaultUpdatedAt } from "./utils.js";

// In-memory idempotency cache for bulk upsert (TTL: 5 min)
const upsertIdempotencyCache = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function handleDeleteItem(supabase, principal, context, vaultId, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { data: existing, error: findError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("id", itemId)
    .eq("vault_id", vaultId)
    .maybeSingle();

  if (findError) throw findError;
  if (!existing) return errorResponse(404, "item_not_found", "Item not found", context.requestId);

  const { error } = await supabase.from("vault_publications").delete().eq("id", itemId);
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { id: itemId },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

// ─── Bulk upsert ──────────────────────────────────────────────────────────────

export async function handleBulkUpsertItems(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};

  // Idempotency check — scoped to principal + vault so keys never leak across tenants.
  const idempotencyCacheKey = body.idempotency_key
    ? `${principal.userId}:${vaultId}:${body.idempotency_key}`
    : null;
  if (idempotencyCacheKey) {
    const cached = upsertIdempotencyCache.get(idempotencyCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return json(200, cached.result);
    }
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { maxBulkItems } = getConfig();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty items array", context.requestId);
  }
  if (body.items.length > maxBulkItems) {
    return errorResponse(400, "too_many_items", `Maximum bulk size is ${maxBulkItems}`, context.requestId);
  }

  // Pre-fetch existing items matching DOIs or bibtex_keys for deduplication
  const dois = body.items.filter((i) => i?.doi).map((i) => i.doi);
  const bibtexKeys = body.items.filter((i) => i?.bibtex_key && !i.doi).map((i) => i.bibtex_key);

  const existingByDoi = new Map();
  const existingByBibtexKey = new Map();

  if (dois.length > 0) {
    const { data, error } = await supabase
      .from("vault_publications")
      .select("id, doi, bibtex_key, version")
      .eq("vault_id", vaultId)
      .in("doi", dois);
    if (error) throw error;
    for (const row of data || []) existingByDoi.set(row.doi, row);
  }

  if (bibtexKeys.length > 0) {
    const { data, error } = await supabase
      .from("vault_publications")
      .select("id, doi, bibtex_key, version")
      .eq("vault_id", vaultId)
      .in("bibtex_key", bibtexKeys);
    if (error) throw error;
    for (const row of data || []) existingByBibtexKey.set(row.bibtex_key, row);
  }

  const created = [];
  const updated = [];
  const errors = [];

  for (const item of body.items) {
    if (!item?.title || typeof item.title !== "string") {
      errors.push({ title: item?.title ?? null, error: "Each item must include a title" });
      continue;
    }

    const existing =
      (item.doi && existingByDoi.get(item.doi)) ||
      (item.bibtex_key && existingByBibtexKey.get(item.bibtex_key));

    try {
      if (existing) {
        const updateRow = {
          ...pickPublicationFields(item),
          version: (existing.version || 1) + 1,
          updated_at: new Date().toISOString(),
        };

        const { data: updatedItem, error: updateError } = await supabase
          .from("vault_publications")
          .update(updateRow)
          .eq("id", existing.id)
          .select(VAULT_PUBLICATION_SELECT)
          .single();

        if (updateError) throw updateError;
        updated.push(updatedItem);
      } else {
        const pubRow = { ...pickPublicationFields(item), user_id: principal.userId };

        const { data: pub, error: pubError } = await supabase
          .from("publications")
          .insert(pubRow)
          .select("id")
          .single();

        if (pubError) throw pubError;

        const vaultPubRow = {
          vault_id: vaultId,
          original_publication_id: pub.id,
          created_by: principal.userId,
          version: 1,
          ...pickPublicationFields(item),
        };

        const { data: vaultPub, error: vaultPubError } = await supabase
          .from("vault_publications")
          .insert(vaultPubRow)
          .select(VAULT_PUBLICATION_SELECT)
          .single();

        if (vaultPubError) throw vaultPubError;
        created.push(vaultPub);
      }
    } catch (err) {
      errors.push({ title: item.title, error: err.message });
    }
  }

  if (created.length > 0 || updated.length > 0) {
    await touchVaultUpdatedAt(supabase, vaultId);
  }

  const result = {
    data: { created, updated, errors },
    meta: { request_id: context.requestId, vault_id: vaultId },
  };

  if (idempotencyCacheKey) {
    upsertIdempotencyCache.set(idempotencyCacheKey, {
      result,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  }

  return json(200, result);
}

// ─── Import preview ───────────────────────────────────────────────────────────

export async function handleImportPreview(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  const { maxBulkItems } = getConfig();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty items array", context.requestId);
  }
  if (body.items.length > maxBulkItems) {
    return errorResponse(400, "too_many_items", `Maximum bulk size is ${maxBulkItems}`, context.requestId);
  }

  const dois = body.items.filter((i) => i?.doi).map((i) => i.doi);
  const bibtexKeys = body.items.filter((i) => i?.bibtex_key && !i.doi).map((i) => i.bibtex_key);

  const existingByDoi = new Map();
  const existingByBibtexKey = new Map();

  if (dois.length > 0) {
    const { data, error } = await supabase
      .from("vault_publications")
      .select("id, doi, title")
      .eq("vault_id", vaultId)
      .in("doi", dois);
    if (error) throw error;
    for (const row of data || []) existingByDoi.set(row.doi, row);
  }

  if (bibtexKeys.length > 0) {
    const { data, error } = await supabase
      .from("vault_publications")
      .select("id, bibtex_key, title")
      .eq("vault_id", vaultId)
      .in("bibtex_key", bibtexKeys);
    if (error) throw error;
    for (const row of data || []) existingByBibtexKey.set(row.bibtex_key, row);
  }

  const wouldCreate = [];
  const wouldUpdate = [];
  const invalid = [];

  for (const item of body.items) {
    if (!item?.title) {
      invalid.push({ title: item?.title ?? null, reason: "missing title" });
      continue;
    }

    const existing =
      (item.doi && existingByDoi.get(item.doi)) ||
      (item.bibtex_key && existingByBibtexKey.get(item.bibtex_key));

    if (existing) {
      wouldUpdate.push({
        incoming: { title: item.title, doi: item.doi ?? null },
        existing: { id: existing.id, title: existing.title },
      });
    } else {
      wouldCreate.push({ title: item.title, doi: item.doi ?? null });
    }
  }

  return json(200, {
    data: { would_create: wouldCreate, would_update: wouldUpdate, invalid },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
