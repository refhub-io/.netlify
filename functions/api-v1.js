import { API_SCOPES, authenticateApiKey, requireScope, resolveVaultAccess } from "../src/auth.js";
import { getConfig } from "../src/config.js";
import { serializeVaultExport } from "../src/export.js";
import {
  createRequestContext,
  errorResponse,
  getRequestBodySize,
  getRouteSegments,
  json,
  parseJsonBody,
  text,
} from "../src/http.js";

const PUBLICATION_FIELDS = [
  "title",
  "authors",
  "year",
  "journal",
  "volume",
  "issue",
  "pages",
  "doi",
  "url",
  "abstract",
  "pdf_url",
  "bibtex_key",
  "publication_type",
  "notes",
  "booktitle",
  "chapter",
  "edition",
  "editor",
  "howpublished",
  "institution",
  "number",
  "organization",
  "publisher",
  "school",
  "series",
  "type",
  "eid",
  "isbn",
  "issn",
  "keywords",
];

const VAULT_SELECT =
  "id, user_id, name, description, color, public_slug, category, abstract, created_at, updated_at, visibility";
const VAULT_PUBLICATION_SELECT = [
  "id",
  "vault_id",
  "original_publication_id",
  "created_by",
  "version",
  "created_at",
  "updated_at",
  ...PUBLICATION_FIELDS,
].join(", ");

function toSafeErrorResponse(error, requestId) {
  if (error?.code === "invalid_tag_ids") {
    return errorResponse(400, "invalid_tag_ids", error.message, requestId);
  }

  return errorResponse(500, "internal_error", "Unexpected server error", requestId);
}

function getAuthFailureMessage(code) {
  if (code === "missing_api_key") {
    return "API key is required";
  }
  if (code === "invalid_api_key_format") {
    return "API key format is invalid";
  }
  if (code === "expired_api_key") {
    return "API key has expired";
  }
  if (code === "revoked_api_key") {
    return "API key has been revoked";
  }

  return "API key authentication failed";
}

function pickPublicationFields(input) {
  const row = {};

  for (const field of PUBLICATION_FIELDS) {
    if (input[field] !== undefined) {
      row[field] = input[field];
    }
  }

  if (!row.authors) {
    row.authors = [];
  }

  if (!row.editor) {
    row.editor = [];
  }

  if (!row.keywords) {
    row.keywords = [];
  }

  if (!row.publication_type) {
    row.publication_type = "article";
  }

  return row;
}

async function writeAuditLog(supabase, context, principal, response, metadata = {}) {
  const { auditDisabled } = getConfig();
  if (auditDisabled || !supabase || !principal) {
    return;
  }

  const durationMs = Date.now() - context.startedAt;

  const auditResult = await supabase.from("api_request_audit_logs").insert({
    api_key_id: principal.keyId,
    owner_user_id: principal.userId,
    request_id: context.requestId,
    method: context.method,
    path: context.path,
    response_status: response.statusCode,
    ip_address: context.ipAddress,
    user_agent: context.userAgent,
    duration_ms: durationMs,
    metadata,
  });

  if (auditResult.error) {
    throw auditResult.error;
  }
}

async function loadVaultContents(supabase, vaultId) {
  const { data: publications, error: publicationsError } = await supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT)
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: true });

  if (publicationsError) {
    throw publicationsError;
  }

  const publicationIds = publications.map((publication) => publication.id);
  const { data: tags, error: tagsError } = await supabase
    .from("tags")
    .select("*")
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: true });

  if (tagsError) {
    throw tagsError;
  }

  let publicationTags = [];
  let relations = [];

  if (publicationIds.length > 0) {
    const publicationTagResult = await supabase
      .from("publication_tags")
      .select("*")
      .in("vault_publication_id", publicationIds);

    if (publicationTagResult.error) {
      throw publicationTagResult.error;
    }

    publicationTags = publicationTagResult.data || [];

    const relationsResult = await supabase
      .from("publication_relations")
      .select("*")
      .or(
        publicationIds
          .map((id) => `publication_id.eq.${id},related_publication_id.eq.${id}`)
          .join(","),
      );

    if (relationsResult.error) {
      throw relationsResult.error;
    }

    relations = relationsResult.data || [];
  }

  return {
    publications,
    tags,
    publication_tags: publicationTags,
    publication_relations: relations,
  };
}

async function handleListVaults(supabase, principal, context) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const ownedResult = await supabase
    .from("vaults")
    .select(VAULT_SELECT)
    .eq("user_id", principal.userId)
    .order("updated_at", { ascending: false });

  if (ownedResult.error) {
    throw ownedResult.error;
  }

  const sharedResult = await supabase
    .from("vault_shares")
    .select("vault_id, role")
    .eq("shared_with_user_id", principal.userId);

  if (sharedResult.error) {
    throw sharedResult.error;
  }

  const sharedVaultIds = [...new Set((sharedResult.data || []).map((entry) => entry.vault_id))];
  let sharedVaults = [];

  if (sharedVaultIds.length > 0) {
    const vaultResult = await supabase
      .from("vaults")
      .select(VAULT_SELECT)
      .in("id", sharedVaultIds);

    if (vaultResult.error) {
      throw vaultResult.error;
    }

    sharedVaults = vaultResult.data || [];
  }

  const permissionByVaultId = new Map();
  for (const vault of ownedResult.data || []) {
    permissionByVaultId.set(vault.id, "owner");
  }
  for (const share of sharedResult.data || []) {
    permissionByVaultId.set(share.vault_id, share.role);
  }

  const allVaults = [...(ownedResult.data || []), ...sharedVaults].filter((vault, index, collection) => {
    return collection.findIndex((candidate) => candidate.id === vault.id) === index;
  });

  const allowedVaults = principal.restrictedVaultIds
    ? allVaults.filter((vault) => principal.restrictedVaultIds.has(vault.id))
    : allVaults;

  const countsResult = allowedVaults.length
    ? await supabase
        .from("vault_publications")
        .select("vault_id")
        .in("vault_id", allowedVaults.map((vault) => vault.id))
    : { data: [], error: null };

  if (countsResult.error) {
    throw countsResult.error;
  }

  const countByVaultId = new Map();
  for (const row of countsResult.data || []) {
    countByVaultId.set(row.vault_id, (countByVaultId.get(row.vault_id) || 0) + 1);
  }

  return json(200, {
    data: allowedVaults.map((vault) => ({
      ...vault,
      permission: permissionByVaultId.get(vault.id) || "viewer",
      item_count: countByVaultId.get(vault.id) || 0,
    })),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleReadVault(supabase, principal, context, vaultId) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    const message = access.code === "vault_not_found" ? "Vault not found" : "Vault access denied";
    return errorResponse(access.status, access.code, message, context.requestId);
  }

  const contents = await loadVaultContents(supabase, vaultId);

  return json(200, {
    data: {
      vault: access.vault,
      permission: access.permission,
      ...contents,
    },
    meta: {
      request_id: context.requestId,
    },
  });
}

async function validateVaultTagIds(supabase, vaultId, tagIds) {
  if (!tagIds || tagIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("tags")
    .select("id")
    .eq("vault_id", vaultId)
    .in("id", tagIds);

  if (error) {
    throw error;
  }

  const foundTagIds = new Set((data || []).map((tag) => tag.id));
  const missingTagIds = tagIds.filter((tagId) => !foundTagIds.has(tagId));
  if (missingTagIds.length > 0) {
    const errorDetails = new Error(`Unknown vault tag ids: ${missingTagIds.join(", ")}`);
    errorDetails.code = "invalid_tag_ids";
    throw errorDetails;
  }

  return tagIds;
}

async function handleAddItems(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault write access denied", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const items = parsedBody.value?.items;
  const { maxBulkItems } = getConfig();

  if (!Array.isArray(items) || items.length === 0) {
    return errorResponse(400, "invalid_body", "Body must include a non-empty items array", context.requestId);
  }

  if (items.length > maxBulkItems) {
    return errorResponse(400, "too_many_items", `Maximum bulk size is ${maxBulkItems}`, context.requestId);
  }

  for (const item of items) {
    if (!item?.title || typeof item.title !== "string") {
      return errorResponse(400, "invalid_item", "Each item must include a title", context.requestId);
    }
  }

  const normalizedItems = [];
  for (const item of items) {
    const tagIds = await validateVaultTagIds(supabase, vaultId, item.tag_ids || []);
    normalizedItems.push({
      tagIds,
      publicationRow: {
        ...pickPublicationFields(item),
        user_id: principal.userId,
      },
      vaultPublicationRow: {
        vault_id: vaultId,
        created_by: principal.userId,
        version: 1,
        ...pickPublicationFields(item),
      },
    });
  }

  const created = [];
  const createdPublicationIds = [];
  const createdVaultPublicationIds = [];

  try {
    for (const { tagIds, publicationRow, vaultPublicationRow } of normalizedItems) {
      const publicationInsert = await supabase
        .from("publications")
        .insert(publicationRow)
        .select("id")
        .single();

      if (publicationInsert.error) {
        throw publicationInsert.error;
      }

      createdPublicationIds.push(publicationInsert.data.id);

      const vaultPublicationInsert = await supabase
        .from("vault_publications")
        .insert({
          ...vaultPublicationRow,
          original_publication_id: publicationInsert.data.id,
        })
        .select(VAULT_PUBLICATION_SELECT)
        .single();

      if (vaultPublicationInsert.error) {
        throw vaultPublicationInsert.error;
      }

      createdVaultPublicationIds.push(vaultPublicationInsert.data.id);

      if (tagIds.length > 0) {
        const tagRows = tagIds.map((tagId) => ({
          publication_id: null,
          vault_publication_id: vaultPublicationInsert.data.id,
          tag_id: tagId,
        }));

        const tagInsert = await supabase.from("publication_tags").insert(tagRows);
        if (tagInsert.error) {
          throw tagInsert.error;
        }
      }

      created.push(vaultPublicationInsert.data);
    }
  } catch (error) {
    let rollbackFailed = false;

    if (createdVaultPublicationIds.length > 0) {
      const tagDeleteResult = await supabase
        .from("publication_tags")
        .delete()
        .in("vault_publication_id", createdVaultPublicationIds);
      rollbackFailed = rollbackFailed || Boolean(tagDeleteResult.error);
    }

    if (createdVaultPublicationIds.length > 0) {
      const vaultDeleteResult = await supabase
        .from("vault_publications")
        .delete()
        .in("id", createdVaultPublicationIds);
      rollbackFailed = rollbackFailed || Boolean(vaultDeleteResult.error);
    }

    if (createdPublicationIds.length > 0) {
      const publicationDeleteResult = await supabase
        .from("publications")
        .delete()
        .in("id", createdPublicationIds);
      rollbackFailed = rollbackFailed || Boolean(publicationDeleteResult.error);
    }

    if (rollbackFailed) {
      console.error("Bulk insert rollback failed", {
        requestId: context.requestId,
        vaultId,
        createdPublicationIds,
        createdVaultPublicationIds,
        code: error?.code,
      });

      return errorResponse(
        500,
        "bulk_insert_partial_failure",
        "Bulk insert failed after partial writes; manual reconciliation may be required",
        context.requestId,
      );
    }

    console.error("Bulk insert failed and was rolled back", {
      requestId: context.requestId,
      vaultId,
      itemCount: normalizedItems.length,
      code: error?.code,
    });

    return errorResponse(
      500,
      "bulk_insert_failed",
      "Bulk insert failed and all staged writes were rolled back",
      context.requestId,
    );
  }

  return json(201, {
    data: created,
    meta: {
      request_id: context.requestId,
      vault_id: vaultId,
    },
  });
}

async function handleUpdateItem(supabase, principal, context, vaultId, itemId, event) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault write access denied", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsedBody.value || {};
  const updateRow = pickPublicationFields(body);

  const existingResult = await supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT)
    .eq("id", itemId)
    .eq("vault_id", vaultId)
    .maybeSingle();

  if (existingResult.error || !existingResult.data) {
    return errorResponse(404, "item_not_found", "Vault item not found", context.requestId);
  }

  if (Object.keys(updateRow).length > 0) {
    updateRow.version = (existingResult.data.version || 1) + 1;
    updateRow.updated_at = new Date().toISOString();

    const updateResult = await supabase
      .from("vault_publications")
      .update(updateRow)
      .eq("id", itemId)
      .eq("vault_id", vaultId);

    if (updateResult.error) {
      throw updateResult.error;
    }
  }

  if (body.tag_ids !== undefined) {
    const tagIds = await validateVaultTagIds(supabase, vaultId, body.tag_ids || []);

    const deleteResult = await supabase
      .from("publication_tags")
      .delete()
      .eq("vault_publication_id", itemId);

    if (deleteResult.error) {
      throw deleteResult.error;
    }

    if (tagIds.length > 0) {
      const insertResult = await supabase.from("publication_tags").insert(
        tagIds.map((tagId) => ({
          publication_id: null,
          vault_publication_id: itemId,
          tag_id: tagId,
        })),
      );

      if (insertResult.error) {
        throw insertResult.error;
      }
    }
  }

  const refreshed = await supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT)
    .eq("id", itemId)
    .single();

  if (refreshed.error) {
    throw refreshed.error;
  }

  return json(200, {
    data: refreshed.data,
    meta: {
      request_id: context.requestId,
      vault_id: vaultId,
    },
  });
}

async function handleExportVault(supabase, principal, context, vaultId, event) {
  if (!requireScope(principal, API_SCOPES.EXPORT)) {
    return errorResponse(403, "missing_scope", "Scope vaults:export is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "viewer");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault export access denied", context.requestId);
  }

  const format = event.queryStringParameters?.format || "json";
  if (!["json", "bibtex"].includes(format)) {
    return errorResponse(400, "unsupported_format", "Supported export formats: json, bibtex", context.requestId);
  }

  const contents = await loadVaultContents(supabase, vaultId);
  const payload = {
    vault: access.vault,
    exported_at: new Date().toISOString(),
    ...contents,
  };

  const serialized = serializeVaultExport(format, payload);
  return text(200, serialized.body, {
    "content-type": serialized.contentType,
    "content-disposition": `attachment; filename=\"vault-${vaultId}.${serialized.extension}\"`,
    "x-refhub-request-id": context.requestId,
  });
}

export async function handler(event) {
  const context = createRequestContext(event);
  let supabase = null;
  let principal = null;
  let response;

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          allow: "GET,POST,PATCH,OPTIONS",
        },
      };
    }

    const { maxBodyBytes } = getConfig();
    if (getRequestBodySize(event) > maxBodyBytes) {
      return errorResponse(413, "request_too_large", `Request body exceeds ${maxBodyBytes} bytes`, context.requestId);
    }

    const authResult = await authenticateApiKey(event);
    if (authResult.error) {
      return errorResponse(401, authResult.error, getAuthFailureMessage(authResult.error), context.requestId, {
        auth_scheme: "Bearer",
      });
    }

    supabase = authResult.supabase;
    principal = authResult.principal;

    const route = getRouteSegments(event.path || "/");
    if (route.length === 1 && route[0] === "vaults" && event.httpMethod === "GET") {
      response = await handleListVaults(supabase, principal, context);
    } else if (route.length === 2 && route[0] === "vaults" && event.httpMethod === "GET") {
      response = await handleReadVault(supabase, principal, context, route[1]);
    } else if (route.length === 3 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "POST") {
      response = await handleAddItems(supabase, principal, context, route[1], event);
    } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "PATCH") {
      response = await handleUpdateItem(supabase, principal, context, route[1], route[3], event);
    } else if (route.length === 3 && route[0] === "vaults" && route[2] === "export" && event.httpMethod === "GET") {
      response = await handleExportVault(supabase, principal, context, route[1], event);
    } else {
      response = errorResponse(404, "route_not_found", "Route not found", context.requestId);
    }
  } catch (error) {
    console.error("Unhandled RefHub API error", {
      requestId: context.requestId,
      path: context.path,
      method: context.method,
      code: error?.code,
      message: error?.message,
    });
    response = toSafeErrorResponse(error, context.requestId);
  }

  try {
    await writeAuditLog(supabase, context, principal, response, {
      route: event.path || "/",
    });
  } catch (error) {
    console.error("Audit log write failed", {
      requestId: context.requestId,
      path: context.path,
      method: context.method,
      code: error?.code,
      message: error?.message,
    });
  }

  return response;
}
