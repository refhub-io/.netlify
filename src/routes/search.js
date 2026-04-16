/**
 * V2 search, stats, and changes route handlers.
 *
 * Covered endpoints:
 *   GET /api/v1/vaults/:vaultId/items    handleSearchItems   (paginated, filterable)
 *   GET /api/v1/vaults/:vaultId/search   handleSearchItems   (alias)
 *   GET /api/v1/vaults/:vaultId/stats    handleGetVaultStats
 *   GET /api/v1/vaults/:vaultId/changes  handleGetVaultChanges
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse } from "../http.js";
import { VAULT_PUBLICATION_SELECT } from "./utils.js";

const VALID_SORT_FIELDS = ["created_at", "updated_at", "year", "title"];

// ─── Search / item listing ────────────────────────────────────────────────────

export async function handleSearchItems(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const params = (event && event.queryStringParameters) || {};
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(params.per_page || "25", 10) || 25));
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  const sortField = VALID_SORT_FIELDS.includes(params.sort) ? params.sort : "created_at";
  const ascending = params.order === "asc";

  // Tag filter: resolve item IDs that carry this tag
  let tagFilterIds = null;
  if (params.tag) {
    const { data: taggedItems, error: tagError } = await supabase
      .from("publication_tags")
      .select("vault_publication_id")
      .eq("tag_id", params.tag);

    if (tagError) throw tagError;

    tagFilterIds = (taggedItems || []).map((t) => t.vault_publication_id);

    // Short-circuit: tag exists but no items carry it
    if (tagFilterIds.length === 0) {
      return json(200, {
        data: [],
        meta: { request_id: context.requestId, vault_id: vaultId, total: 0, page, per_page: perPage },
      });
    }
  }

  let query = supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT, { count: "exact" })
    .eq("vault_id", vaultId);

  if (tagFilterIds) query = query.in("id", tagFilterIds);

  if (params.q) {
    // Strip PostgREST filter-syntax characters (commas, parens) from q before
    // interpolating into the OR filter, preventing filter injection.
    const safeQ = params.q.replace(/[(),]/g, " ").trim();
    if (safeQ) {
      query = query.or(`title.ilike.%${safeQ}%,abstract.ilike.%${safeQ}%`);
    }
  }

  if (params.author) {
    // authors is a text[] column; use array-containment (exact element match)
    query = query.contains("authors", [params.author]);
  }

  if (params.year) {
    const yr = parseInt(params.year, 10);
    if (!isNaN(yr)) query = query.eq("year", yr);
  }

  if (params.type) {
    query = query.eq("publication_type", params.type);
  }

  const { data, error, count } = await query
    .order(sortField, { ascending })
    .range(from, to);

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: {
      request_id: context.requestId,
      vault_id: vaultId,
      total: count ?? 0,
      page,
      per_page: perPage,
    },
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function handleGetVaultStats(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const [itemsResult, tagsResult, pubIdsResult] = await Promise.all([
    supabase
      .from("vault_publications")
      .select("id", { count: "exact", head: true })
      .eq("vault_id", vaultId),
    supabase
      .from("tags")
      .select("id", { count: "exact", head: true })
      .eq("vault_id", vaultId),
    supabase
      .from("vault_publications")
      .select("id")
      .eq("vault_id", vaultId),
  ]);

  if (itemsResult.error) throw itemsResult.error;
  if (tagsResult.error) throw tagsResult.error;
  if (pubIdsResult.error) throw pubIdsResult.error;

  const pubIds = (pubIdsResult.data || []).map((p) => p.id);
  let relationCount = 0;

  if (pubIds.length > 0) {
    // Count relations where the vault's items appear on either side of the relationship.
    const orFilter = pubIds
      .flatMap((id) => [`publication_id.eq.${id}`, `related_publication_id.eq.${id}`])
      .join(",");
    const relResult = await supabase
      .from("publication_relations")
      .select("id", { count: "exact", head: true })
      .or(orFilter);

    if (relResult.error) throw relResult.error;
    relationCount = relResult.count ?? 0;
  }

  return json(200, {
    data: {
      vault_id: vaultId,
      item_count: itemsResult.count ?? 0,
      tag_count: tagsResult.count ?? 0,
      relation_count: relationCount,
    },
    meta: { request_id: context.requestId },
  });
}

// ─── Changes ─────────────────────────────────────────────────────────────────

export async function handleGetVaultChanges(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const params = (event && event.queryStringParameters) || {};
  if (!params.since) {
    return errorResponse(400, "invalid_query", "Query param since is required (ISO-8601)", context.requestId);
  }

  const sinceDate = new Date(params.since);
  if (isNaN(sinceDate.getTime())) {
    return errorResponse(400, "invalid_query", "since must be a valid ISO-8601 timestamp", context.requestId);
  }

  const { data, error } = await supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT)
    .eq("vault_id", vaultId)
    .gt("updated_at", sinceDate.toISOString())
    .order("updated_at", { ascending: true });

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: {
      request_id: context.requestId,
      vault_id: vaultId,
      since: sinceDate.toISOString(),
    },
  });
}
