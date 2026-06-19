/**
 * V2 publication-relation route handlers.
 *
 * Covered endpoints:
 *   GET    /api/v1/vaults/:vaultId/relations                    handleListRelations
 *   POST   /api/v1/vaults/:vaultId/relations                    handleCreateRelation
 *   PATCH  /api/v1/vaults/:vaultId/relations/:relationId        handleUpdateRelation
 *   DELETE /api/v1/vaults/:vaultId/relations/:relationId        handleDeleteRelation
 *
 * publication_relations.publication_id references vault_publications.id
 * (confirmed via FK constraints in schema.sql).  Ownership is verified by
 * checking that the source publication belongs to the vault before acting.
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { touchVaultUpdatedAt } from "./utils.js";

const RELATION_SELECT = "id, publication_id, related_publication_id, relation_type, created_at, created_by";

export async function handleListRelations(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  // Collect all vault publication IDs to build the OR filter
  const { data: vaultPubs, error: vaultPubsError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("vault_id", vaultId);

  if (vaultPubsError) throw vaultPubsError;

  const pubIds = (vaultPubs || []).map((p) => p.id);
  if (pubIds.length === 0) {
    return json(200, {
      data: [],
      meta: { request_id: context.requestId, vault_id: vaultId },
    });
  }

  const params = (event && event.queryStringParameters) || {};
  const orFilter = pubIds.map((id) => `publication_id.eq.${id},related_publication_id.eq.${id}`).join(",");

  let query = supabase
    .from("publication_relations")
    .select(RELATION_SELECT)
    .or(orFilter)
    .order("created_at", { ascending: true });

  if (params.type) query = query.eq("relation_type", params.type);

  const { data, error } = await query;
  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleCreateRelation(supabase, principal, context, vaultId, event) {
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
  if (!body.publication_id || !body.related_publication_id) {
    return errorResponse(
      400,
      "invalid_body",
      "Body must include publication_id and related_publication_id",
      context.requestId,
    );
  }
  if (body.publication_id === body.related_publication_id) {
    return errorResponse(
      400,
      "invalid_body",
      "publication_id and related_publication_id must be different",
      context.requestId,
    );
  }

  // Verify both items belong to this vault
  const { data: pubs, error: pubsError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("vault_id", vaultId)
    .in("id", [body.publication_id, body.related_publication_id]);

  if (pubsError) throw pubsError;

  const foundIds = new Set((pubs || []).map((p) => p.id));
  if (!foundIds.has(body.publication_id)) {
    return errorResponse(404, "item_not_found", `Item ${body.publication_id} not found in this vault`, context.requestId);
  }
  if (!foundIds.has(body.related_publication_id)) {
    return errorResponse(404, "item_not_found", `Item ${body.related_publication_id} not found in this vault`, context.requestId);
  }

  const row = {
    publication_id: body.publication_id,
    related_publication_id: body.related_publication_id,
    relation_type: body.relation_type || "related",
    created_by: principal.userId,
  };

  const { data: relation, error } = await supabase
    .from("publication_relations")
    .insert(row)
    .select(RELATION_SELECT)
    .single();

  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(201, {
    data: relation,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleUpdateRelation(supabase, principal, context, vaultId, relationId, event) {
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
  if (!body.relation_type) {
    return errorResponse(400, "invalid_body", "Body must include relation_type", context.requestId);
  }

  // Fetch the relation and verify it belongs to this vault via its source publication
  const { data: relation, error: findError } = await supabase
    .from("publication_relations")
    .select(RELATION_SELECT)
    .eq("id", relationId)
    .maybeSingle();

  if (findError) throw findError;
  if (!relation) return errorResponse(404, "relation_not_found", "Relation not found", context.requestId);

  const { data: pub, error: pubError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("id", relation.publication_id)
    .eq("vault_id", vaultId)
    .maybeSingle();

  if (pubError) throw pubError;
  if (!pub) return errorResponse(404, "relation_not_found", "Relation not found in this vault", context.requestId);

  const { data: updated, error } = await supabase
    .from("publication_relations")
    .update({ relation_type: body.relation_type })
    .eq("id", relationId)
    .select(RELATION_SELECT)
    .single();

  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: updated,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleDeleteRelation(supabase, principal, context, vaultId, relationId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  // Fetch the relation and verify vault ownership
  const { data: relation, error: findError } = await supabase
    .from("publication_relations")
    .select("id, publication_id")
    .eq("id", relationId)
    .maybeSingle();

  if (findError) throw findError;
  if (!relation) return errorResponse(404, "relation_not_found", "Relation not found", context.requestId);

  const { data: pub, error: pubError } = await supabase
    .from("vault_publications")
    .select("id")
    .eq("id", relation.publication_id)
    .eq("vault_id", vaultId)
    .maybeSingle();

  if (pubError) throw pubError;
  if (!pub) return errorResponse(404, "relation_not_found", "Relation not found in this vault", context.requestId);

  const { error } = await supabase.from("publication_relations").delete().eq("id", relationId);
  if (error) throw error;

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(200, {
    data: { id: relationId },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
