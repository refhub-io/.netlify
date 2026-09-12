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
