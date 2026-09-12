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

import { API_SCOPES, requireScope } from "../auth.js";
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
  const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
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
      const metadata = await resolveDoiMetadata(doi);
      parsedFields = metadata ? doiMetadataToParsedFields(metadata) : { title: doi };
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
