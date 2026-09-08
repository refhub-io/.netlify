/**
 * V2 vault section route handlers.
 *
 * Covered endpoints:
 *   GET    /api/v1/vaults/:vaultId/sections               handleListSections
 *   POST   /api/v1/vaults/:vaultId/sections               handleCreateSection
 *   PATCH  /api/v1/vaults/:vaultId/sections/:sectionId    handleUpdateSection
 *   DELETE /api/v1/vaults/:vaultId/sections/:sectionId    handleDeleteSection
 *
 * Sections group vault items for display on public vault pages (#196).
 * Owner-only for writes -- editors can view sections but not create,
 * reorder, or delete them, matching the "Vault owners can manage their
 * vault's sections" RLS policy and the enforce_vault_section_owner_only
 * trigger that also protects the section_id/featured fields on
 * vault_publications (see handleUpdateItem in functions/api-v1.js).
 */

import { API_SCOPES, requireScope, resolveVaultAccess, vaultAccessErrorMessage } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { touchVaultUpdatedAt } from "./utils.js";

const SECTION_SELECT = "id, vault_id, name, description, position, created_at, updated_at";

export async function handleListSections(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, vaultAccessErrorMessage(access.code), context.requestId);
  }

  const { data, error } = await supabase
    .from("vault_sections")
    .select(SECTION_SELECT)
    .eq("vault_id", vaultId)
    .order("position", { ascending: true });

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleCreateSection(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, vaultAccessErrorMessage(access.code), context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty name", context.requestId);
  }
  if (body.position !== undefined && !Number.isInteger(body.position)) {
    return errorResponse(400, "invalid_body", "position must be an integer", context.requestId);
  }

  const row = {
    vault_id: vaultId,
    name: body.name.trim(),
    description: body.description != null ? String(body.description) : null,
  };
  if (body.position !== undefined) row.position = body.position;

  const { data: section, error } = await supabase.from("vault_sections").insert(row).select(SECTION_SELECT).single();
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(201, {
    data: section,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleUpdateSection(supabase, principal, context, vaultId, sectionId, event) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, vaultAccessErrorMessage(access.code), context.requestId);
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
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position)) {
      return errorResponse(400, "invalid_body", "position must be an integer", context.requestId);
    }
    updateRow.position = body.position;
  }

  if (Object.keys(updateRow).length === 0) {
    return errorResponse(400, "invalid_body", "No updatable fields provided", context.requestId);
  }

  const { data: section, error } = await supabase
    .from("vault_sections")
    .update(updateRow)
    .eq("id", sectionId)
    .eq("vault_id", vaultId)
    .select(SECTION_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (!section) return errorResponse(404, "section_not_found", "Section not found", context.requestId);

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: section,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleDeleteSection(supabase, principal, context, vaultId, sectionId) {
  if (!requireScope(principal, API_SCOPES.ADMIN)) {
    return errorResponse(403, "missing_scope", "Scope vaults:admin is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, vaultAccessErrorMessage(access.code), context.requestId);
  }

  // vault_publications.section_id is ON DELETE SET NULL -- items in this
  // section are unfiled, not deleted, matching the frontend's own behavior.
  const { error } = await supabase.from("vault_sections").delete().eq("id", sectionId).eq("vault_id", vaultId);
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { id: sectionId },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
