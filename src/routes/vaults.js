/**
 * V2 vault lifecycle route handlers.
 *
 * Covered endpoints:
 *   POST   /api/v1/vaults                              handleCreateVault
 *   PATCH  /api/v1/vaults/:vaultId                     handleUpdateVault
 *   DELETE /api/v1/vaults/:vaultId                     handleDeleteVault
 *   PATCH  /api/v1/vaults/:vaultId/visibility          handleUpdateVaultVisibility
 *   GET    /api/v1/vaults/:vaultId/shares              handleListVaultShares
 *   POST   /api/v1/vaults/:vaultId/shares              handleCreateVaultShare
 *   PATCH  /api/v1/vaults/:vaultId/shares/:shareId     handleUpdateVaultShare
 *   DELETE /api/v1/vaults/:vaultId/shares/:shareId     handleDeleteVaultShare
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { VAULT_SELECT } from "./utils.js";

const VALID_VISIBILITIES = ["private", "protected", "public"];
const VALID_SHARE_ROLES = ["viewer", "editor"];

const SHARE_SELECT = "id, shared_with_email, shared_with_user_id, shared_with_name, role, created_at";

// ---------------------------------------------------------------------------
// Vault CRUD
// ---------------------------------------------------------------------------

export async function handleCreateVault(supabase, principal, context, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty name", context.requestId);
  }

  const visibility = VALID_VISIBILITIES.includes(body.visibility) ? body.visibility : "private";

  const row = {
    user_id: principal.userId,
    name: body.name.trim(),
    description: body.description != null ? String(body.description) : null,
    color: body.color || "#6366f1",
    visibility,
  };

  if (visibility === "public" && body.public_slug) {
    row.public_slug = body.public_slug;
  }

  const { data: vault, error } = await supabase
    .from("vaults")
    .insert(row)
    .select(VAULT_SELECT)
    .single();

  if (error) throw error;

  return json(201, { data: vault, meta: { request_id: context.requestId } });
}

export async function handleUpdateVault(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
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
  if (body.description !== undefined) updateRow.description = body.description;
  if (body.color !== undefined) updateRow.color = body.color;
  if (body.category !== undefined) updateRow.category = body.category;
  if (body.abstract !== undefined) updateRow.abstract = body.abstract;

  if (Object.keys(updateRow).length === 0) {
    return errorResponse(400, "invalid_body", "No updatable fields provided", context.requestId);
  }

  const { data: vault, error } = await supabase
    .from("vaults")
    .update(updateRow)
    .eq("id", vaultId)
    .select(VAULT_SELECT)
    .single();

  if (error) throw error;

  return json(200, { data: vault, meta: { request_id: context.requestId } });
}

export async function handleDeleteVault(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { error } = await supabase.from("vaults").delete().eq("id", vaultId);
  if (error) throw error;

  return json(200, { data: { id: vaultId }, meta: { request_id: context.requestId } });
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export async function handleUpdateVaultVisibility(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!VALID_VISIBILITIES.includes(body.visibility)) {
    return errorResponse(
      400,
      "invalid_body",
      "visibility must be private, protected, or public",
      context.requestId,
    );
  }

  if (body.visibility === "public" && !body.public_slug) {
    return errorResponse(400, "invalid_body", "public_slug is required for public visibility", context.requestId);
  }

  const updateRow = { visibility: body.visibility };
  // Always pass through public_slug; clear it when moving to non-public unless caller supplies one
  updateRow.public_slug = body.public_slug || null;

  const { data: vault, error } = await supabase
    .from("vaults")
    .update(updateRow)
    .eq("id", vaultId)
    .select(VAULT_SELECT)
    .single();

  if (error) throw error;

  return json(200, { data: vault, meta: { request_id: context.requestId } });
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export async function handleListVaultShares(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { data, error } = await supabase
    .from("vault_shares")
    .select(SHARE_SELECT)
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleCreateVaultShare(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.email || typeof body.email !== "string") {
    return errorResponse(400, "invalid_body", "Body must include an email", context.requestId);
  }

  const role = body.role || "viewer";
  if (!VALID_SHARE_ROLES.includes(role)) {
    return errorResponse(400, "invalid_body", "role must be viewer or editor", context.requestId);
  }

  const shareRow = {
    vault_id: vaultId,
    shared_with_email: body.email.toLowerCase().trim(),
    shared_by: principal.userId,
    role,
  };
  if (body.name) shareRow.shared_with_name = body.name;

  const { data: share, error: shareError } = await supabase
    .from("vault_shares")
    .insert(shareRow)
    .select(SHARE_SELECT)
    .single();

  if (shareError) throw shareError;

  // Promote a private vault to protected when the first share is created
  if (access.vault.visibility === "private") {
    await supabase.from("vaults").update({ visibility: "protected" }).eq("id", vaultId);
  }

  return json(201, {
    data: share,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleUpdateVaultShare(supabase, principal, context, vaultId, shareId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.role || !VALID_SHARE_ROLES.includes(body.role)) {
    return errorResponse(400, "invalid_body", "role must be viewer or editor", context.requestId);
  }

  const { data: share, error } = await supabase
    .from("vault_shares")
    .update({ role: body.role })
    .eq("id", shareId)
    .eq("vault_id", vaultId)
    .select(SHARE_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (!share) return errorResponse(404, "share_not_found", "Share not found", context.requestId);

  return json(200, {
    data: share,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleDeleteVaultShare(supabase, principal, context, vaultId, shareId) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const { error } = await supabase
    .from("vault_shares")
    .delete()
    .eq("id", shareId)
    .eq("vault_id", vaultId);

  if (error) throw error;

  return json(200, {
    data: { id: shareId },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
