/**
 * V2 inbox route handlers.
 *
 * Covered endpoints:
 *   GET    /api/v1/inbox                handleListInboxItems
 *   POST   /api/v1/inbox                handleCreateInboxItem
 *   POST   /api/v1/inbox/:id/accept     handleAcceptInboxItem
 *   POST   /api/v1/inbox/:id/reject     handleRejectInboxItem
 *   POST   /api/v1/inbox/:id/merge      handleMergeInboxItem
 *   POST   /api/v1/inbox/:id/postpone   handlePostponeInboxItem
 *   DELETE /api/v1/inbox/:id            handleDeleteInboxItem
 *
 * Unlike every other V2 route family, these routes are NOT vault-scoped --
 * an inbox item belongs to the caller's account, with no vault at all
 * until handleAcceptInboxItem creates one. Every query below is scoped by
 * user_id explicitly instead of going through resolveVaultAccess. See
 * docs/superpowers/specs/2026-09-12-inbox-api-design.md for the full
 * design rationale.
 */

import { API_SCOPES, requireScope, resolveVaultAccess, vaultAccessErrorMessage } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { resolveDoiMetadata, cleanDoi } from "./import.js";
import { parseBibtex } from "../bibtex.js";
import { getConfig } from "../config.js";

const INBOX_ITEM_SELECT =
  "id, status, source_type, source_ref, parsed_fields, suggested_vault_id, suggested_tag_ids, duplicate_of_publication_id, filed_publication_id, sort_order, created_at, updated_at";

export async function handleListInboxItems(supabase, principal, context, event) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const query = event?.queryStringParameters || {};
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase
    .from("inbox_items")
    .select(INBOX_ITEM_SELECT)
    .eq("user_id", principal.userId)
    .eq("status", "pending")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .range(from, to);

  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: { request_id: context.requestId, page, limit },
  });
}

function doiMetadataToParsedFields(metadata) {
  const { type, ...rest } = metadata;
  return { ...rest, publication_type: type || "article" };
}

async function insertInboxItem(supabase, principal, sourceType, sourceRef, parsedFields) {
  const { data, error } = await supabase
    .from("inbox_items")
    .insert({
      user_id: principal.userId,
      status: "pending",
      source_type: sourceType,
      source_ref: sourceRef,
      parsed_fields: parsedFields,
    })
    .select(INBOX_ITEM_SELECT)
    .single();

  if (error) throw error;
  return data;
}

export async function handleCreateInboxItem(supabase, principal, context, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  const sourceType = body.source_type;

  if (!["doi", "bibtex", "manual"].includes(sourceType)) {
    return errorResponse(400, "invalid_body", "source_type must be one of doi, bibtex, manual", context.requestId);
  }

  if (sourceType === "manual") {
    const title = body.parsed_fields?.title;
    if (!title || typeof title !== "string" || !title.trim()) {
      return errorResponse(400, "invalid_body", "parsed_fields.title is required for manual capture", context.requestId);
    }
    const item = await insertInboxItem(supabase, principal, "manual", title.trim(), { title: title.trim() });
    return json(201, { data: item, meta: { request_id: context.requestId } });
  }

  if (sourceType === "doi") {
    if (!body.source_ref || typeof body.source_ref !== "string") {
      return errorResponse(400, "invalid_body", "source_ref must be a DOI string", context.requestId);
    }
    const doi = cleanDoi(body.source_ref);
    let parsedFields;
    if (body.parsed_fields) {
      parsedFields = body.parsed_fields;
    } else {
      // Neither fetchFromCrossRef nor fetchFromOpenAlex (both in import.js)
      // put a `doi` key in their returned metadata -- handleImportDoi (the
      // sibling vault-import route) papers over this itself with an
      // explicit `metadata.doi = doi` before use. Do the same here: without
      // it, a successfully-resolved DOI capture would file into a vault
      // with publications.doi left NULL once accepted, silently losing the
      // one field its whole capture path exists to preserve.
      const metadata = await resolveDoiMetadata(doi);
      parsedFields = metadata ? { ...doiMetadataToParsedFields(metadata), doi } : { title: doi, doi };
    }
    const item = await insertInboxItem(supabase, principal, "doi", doi, parsedFields);
    return json(201, { data: item, meta: { request_id: context.requestId } });
  }

  // bibtex
  if (!body.source_ref || typeof body.source_ref !== "string") {
    return errorResponse(400, "invalid_body", "source_ref must be a BibTeX string", context.requestId);
  }
  const { maxBulkItems } = getConfig();
  const entries = parseBibtex(body.source_ref);
  if (entries.length === 0) {
    return errorResponse(400, "invalid_bibtex", "No valid BibTeX entries found", context.requestId);
  }
  if (entries.length > maxBulkItems) {
    return errorResponse(400, "too_many_items", `BibTeX content contains ${entries.length} entries; maximum is ${maxBulkItems}`, context.requestId);
  }

  const created = [];
  for (const entry of entries) {
    const sourceRef = entry.bibtex_key || entry.title || "untitled";
    created.push(await insertInboxItem(supabase, principal, "bibtex", sourceRef, entry));
  }

  return json(201, { data: created, meta: { request_id: context.requestId } });
}

export async function handleAcceptInboxItem(supabase, principal, context, itemId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsed.value || {};
  if (!body.vault_id || typeof body.vault_id !== "string") {
    return errorResponse(400, "invalid_body", "Body must include vault_id", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, body.vault_id, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, vaultAccessErrorMessage(access.code), context.requestId);
  }

  const tagIds = Array.isArray(body.tag_ids) ? body.tag_ids : [];

  const { data, error } = await supabase.rpc("accept_inbox_item", {
    p_inbox_item_id: itemId,
    p_target_vault_id: body.vault_id,
    p_tag_ids: tagIds,
    p_user_id: principal.userId,
  });

  if (error) {
    if (error.code === "P0002") {
      return errorResponse(404, "inbox_item_not_found", "Inbox item not found", context.requestId);
    }
    if (error.code === "23514") {
      return errorResponse(409, "item_not_pending", "Inbox item is not pending", context.requestId);
    }
    throw error;
  }

  const result = Array.isArray(data) ? data[0] : data;

  return json(200, {
    data: { vault_publication_id: result.vault_publication_id, publication_id: result.publication_id },
    meta: { request_id: context.requestId },
  });
}

async function fetchOwnPendingItem(supabase, principal, itemId, context, selectCols = "id, status") {
  const { data: item, error } = await supabase
    .from("inbox_items")
    .select(selectCols)
    .eq("id", itemId)
    .eq("user_id", principal.userId)
    .maybeSingle();

  if (error) throw error;
  if (!item) return { errorResponse: errorResponse(404, "inbox_item_not_found", "Inbox item not found", context.requestId) };
  if (item.status !== "pending") {
    return { errorResponse: errorResponse(409, "item_not_pending", "Inbox item is not pending", context.requestId) };
  }
  return { item };
}

export async function handleRejectInboxItem(supabase, principal, context, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const found = await fetchOwnPendingItem(supabase, principal, itemId, context);
  if (found.errorResponse) return found.errorResponse;

  const { data, error } = await supabase
    .from("inbox_items")
    .update({ status: "rejected" })
    .eq("id", itemId)
    .eq("user_id", principal.userId)
    .select("id")
    .single();

  if (error) throw error;

  return json(200, { data: { id: data.id }, meta: { request_id: context.requestId } });
}

export async function handlePostponeInboxItem(supabase, principal, context, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const found = await fetchOwnPendingItem(supabase, principal, itemId, context);
  if (found.errorResponse) return found.errorResponse;

  const { data: pending, error: pendingError } = await supabase
    .from("inbox_items")
    .select("sort_order")
    .eq("user_id", principal.userId)
    .eq("status", "pending");

  if (pendingError) throw pendingError;

  const maxSortOrder = (pending || []).reduce((max, item) => Math.max(max, item.sort_order), 0);

  const { data, error } = await supabase
    .from("inbox_items")
    .update({ sort_order: maxSortOrder + 1 })
    .eq("id", itemId)
    .eq("user_id", principal.userId)
    .select("id, sort_order")
    .single();

  if (error) throw error;

  return json(200, { data, meta: { request_id: context.requestId } });
}

export async function handleMergeInboxItem(supabase, principal, context, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const found = await fetchOwnPendingItem(supabase, principal, itemId, context, "id, status, duplicate_of_publication_id");
  if (found.errorResponse) return found.errorResponse;

  if (!found.item.duplicate_of_publication_id) {
    return errorResponse(409, "no_duplicate_target", "This item has no known duplicate to merge into", context.requestId);
  }

  const { data, error } = await supabase
    .from("inbox_items")
    .update({ status: "merged", filed_publication_id: found.item.duplicate_of_publication_id })
    .eq("id", itemId)
    .eq("user_id", principal.userId)
    .select("id, filed_publication_id")
    .single();

  if (error) throw error;

  return json(200, { data, meta: { request_id: context.requestId } });
}

export async function handleDeleteInboxItem(supabase, principal, context, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const { data, error } = await supabase
    .from("inbox_items")
    .delete()
    .eq("id", itemId)
    .eq("user_id", principal.userId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return errorResponse(404, "inbox_item_not_found", "Inbox item not found", context.requestId);

  return json(200, { data: { id: data.id }, meta: { request_id: context.requestId } });
}
