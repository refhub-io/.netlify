/**
 * V2 tag route handlers.
 *
 * Covered endpoints:
 *   GET    /api/v1/vaults/:vaultId/tags               handleListTags
 *   POST   /api/v1/vaults/:vaultId/tags               handleCreateTag
 *   PATCH  /api/v1/vaults/:vaultId/tags/:tagId        handleUpdateTag
 *   DELETE /api/v1/vaults/:vaultId/tags/:tagId        handleDeleteTag
 *   POST   /api/v1/vaults/:vaultId/tags/attach        handleAttachTags
 *   POST   /api/v1/vaults/:vaultId/tags/detach        handleDetachTags
 *
 * All write operations call touchVaultUpdatedAt so that the vault's
 * updated_at reflects the latest tag change.
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { touchVaultUpdatedAt, validateVaultTagIds } from "./utils.js";

const TAG_SELECT = "id, name, color, parent_id, depth, created_at";

export async function handleListTags(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { data, error } = await supabase
    .from("tags")
    .select(TAG_SELECT)
    .eq("vault_id", vaultId)
    .order("name", { ascending: true });

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleCreateTag(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty name", context.requestId);
  }

  const row = {
    user_id: principal.userId,
    vault_id: vaultId,
    name: body.name.trim(),
    color: body.color || null,
    parent_id: body.parent_id || null,
  };

  const { data: tag, error } = await supabase.from("tags").insert(row).select(TAG_SELECT).single();
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(201, {
    data: tag,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleUpdateTag(supabase, principal, context, vaultId, tagId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  const updateRow = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return errorResponse(400, "invalid_body", "name must be a non-empty string", context.requestId);
    }
    updateRow.name = body.name.trim();
  }
  if (body.color !== undefined) updateRow.color = body.color;
  if (body.parent_id !== undefined) updateRow.parent_id = body.parent_id;

  if (Object.keys(updateRow).length === 0) {
    return errorResponse(400, "invalid_body", "No updatable fields provided", context.requestId);
  }

  const { data: tag, error } = await supabase
    .from("tags")
    .update(updateRow)
    .eq("id", tagId)
    .eq("vault_id", vaultId)
    .select(TAG_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (!tag) return errorResponse(404, "tag_not_found", "Tag not found", context.requestId);

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: tag,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleDeleteTag(supabase, principal, context, vaultId, tagId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { error } = await supabase.from("tags").delete().eq("id", tagId).eq("vault_id", vaultId);
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { id: tagId },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleAttachTags(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.item_id) {
    return errorResponse(400, "invalid_body", "Body must include item_id", context.requestId);
  }
  if (!Array.isArray(body.tag_ids) || body.tag_ids.length === 0) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty tag_ids array", context.requestId);
  }

  // Verify the item belongs to this vault
  const { data: item, error: itemError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("id", body.item_id)
    .eq("vault_id", vaultId)
    .maybeSingle();

  if (itemError) throw itemError;
  if (!item) return errorResponse(404, "item_not_found", "Item not found in this vault", context.requestId);

  // Verify all tags belong to this vault
  const tagIds = await validateVaultTagIds(supabase, vaultId, body.tag_ids);

  const rows = tagIds.map((tagId) => ({
    vault_publication_id: body.item_id,
    publication_id: null,
    tag_id: tagId,
  }));

  const { error: insertError } = await supabase.from("publication_tags").insert(rows);
  // Ignore unique-constraint violations (23505) — idempotent attach
  if (insertError && insertError.code !== "23505") throw insertError;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { item_id: body.item_id, tag_ids: tagIds },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleDetachTags(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.item_id) {
    return errorResponse(400, "invalid_body", "Body must include item_id", context.requestId);
  }
  if (!Array.isArray(body.tag_ids) || body.tag_ids.length === 0) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty tag_ids array", context.requestId);
  }

  const { error } = await supabase
    .from("publication_tags")
    .delete()
    .eq("vault_publication_id", body.item_id)
    .in("tag_id", body.tag_ids);

  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { item_id: body.item_id, tag_ids: body.tag_ids },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
