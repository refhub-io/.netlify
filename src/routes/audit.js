/**
 * V2 audit log route handlers.
 *
 * Covered endpoints:
 *   GET /api/v1/vaults/:vaultId/audit   handleListVaultAudit   (API key, vault owner)
 *   GET /api/v1/audit                   handleListGlobalAudit  (management user only)
 *
 * No scope guard on audit reads — any authenticated API key that holds vault
 * owner access can read its vault-level audit log.  Global audit is management
 * only, which is enforced by the dispatcher routing (management branch).
 *
 * TODO: expose audit log viewer in the frontend API Key management panel.
 */

import { resolveVaultAccess } from "../auth.js";
import { json, errorResponse } from "../http.js";

const AUDIT_SELECT = "id, api_key_id, request_id, method, path, response_status, ip_address, user_agent, duration_ms, created_at";
const GLOBAL_AUDIT_SELECT = "id, api_key_id, request_id, method, path, response_status, vault_id, ip_address, user_agent, duration_ms, created_at";

function parsePaginationParams(params) {
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(params.per_page || "25", 10) || 25));
  return { page, perPage, from: (page - 1) * perPage, to: (page - 1) * perPage + perPage - 1 };
}

export async function handleListVaultAudit(supabase, principal, context, vaultId, event) {
  // No scope guard — vault owner access is sufficient
  const access = await resolveVaultAccess(supabase, principal, vaultId, "owner");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault access denied", context.requestId);
  }

  const params = (event && event.queryStringParameters) || {};
  const { page, perPage, from, to } = parsePaginationParams(params);

  const { data, error, count } = await supabase
    .from("api_request_audit_logs")
    .select(AUDIT_SELECT, { count: "exact" })
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: false })
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

export async function handleListGlobalAudit(supabase, principal, context, event) {
  // Management user only — enforced by the dispatcher routing this endpoint
  // exclusively to the management branch.  No additional check needed here.
  const params = (event && event.queryStringParameters) || {};
  const { page, perPage, from, to } = parsePaginationParams(params);

  let query = supabase
    .from("api_request_audit_logs")
    .select(GLOBAL_AUDIT_SELECT, { count: "exact" })
    .eq("owner_user_id", principal.userId)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (params.vault_id) query = query.eq("vault_id", params.vault_id);
  if (params.status) {
    const status = parseInt(params.status, 10);
    if (!isNaN(status)) query = query.eq("response_status", status);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return json(200, {
    data: data || [],
    meta: {
      request_id: context.requestId,
      total: count ?? 0,
      page,
      per_page: perPage,
    },
  });
}
