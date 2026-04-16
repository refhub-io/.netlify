import {
  API_SCOPES,
  authenticateApiKey,
  authenticateManagementUser,
  createApiKeySecret,
  getSupabaseAdmin,
  hashManagedApiKey,
  isValidApiKeyScope,
  requireScope,
  resolveVaultAccess,
} from "../src/auth.js";
import { getConfig } from "../src/config.js";
import { serializeVaultExport } from "../src/export.js";
import {
  completeGoogleDriveLink,
  createDriveResumableSession,
  createGoogleDriveAuthorizationUrl,
  disconnectGoogleDriveForUser,
  ensureGoogleDriveFolderForUser,
  extractPdfMetadataFromBuffer,
  fetchPdfSourceBuffer,
  getGoogleDriveStatus,
  recordBrowserDriveUpload,
  uploadPdfToGoogleDriveForUser,
} from "../src/google-drive.js";
import {
  createCorsHeaders,
  createRequestContext,
  errorResponse,
  getRequestBodySize,
  getRouteSegments,
  json,
  parseJsonBody,
  text,
  withCors,
} from "../src/http.js";
import {
  fetchSemanticScholarCitations,
  fetchSemanticScholarDoiMetadata,
  fetchSemanticScholarPaperLookup,
  fetchSemanticScholarRecommendations,
  fetchSemanticScholarReferences,
  isRefHubApiKeyValue,
  normalizePaperListRequest,
  normalizePaperLookupRequest,
  normalizeSemanticScholarDoiRequest,
} from "../src/semantic-scholar.js";

// ── V2 route modules ──────────────────────────────────────────────────────────
import {
  handleCreateVault,
  handleUpdateVault,
  handleDeleteVault,
  handleUpdateVaultVisibility,
  handleListVaultShares,
  handleCreateVaultShare,
  handleUpdateVaultShare,
  handleDeleteVaultShare,
} from "../src/routes/vaults.js";
import {
  handleListTags,
  handleCreateTag,
  handleUpdateTag,
  handleDeleteTag,
  handleAttachTags,
  handleDetachTags,
} from "../src/routes/tags.js";
import {
  handleListRelations,
  handleCreateRelation,
  handleUpdateRelation,
  handleDeleteRelation,
} from "../src/routes/relations.js";
import {
  handleSearchItems,
  handleGetVaultStats,
  handleGetVaultChanges,
} from "../src/routes/search.js";
import {
  handleDeleteItem,
  handleBulkUpsertItems,
  handleImportPreview,
} from "../src/routes/items.js";
import {
  handleImportDoi,
  handleImportBibtex,
  handleImportUrl,
} from "../src/routes/import.js";
import {
  handleListVaultAudit,
  handleListGlobalAudit,
} from "../src/routes/audit.js";

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
const API_KEY_SELECT =
  "id, owner_user_id, label, description, key_prefix, scopes, expires_at, revoked_at, last_used_at, created_at, api_key_vaults(vault_id)";
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
const SEMANTIC_SCHOLAR_CACHE_TTL_MS = 60 * 1000;
const SEMANTIC_SCHOLAR_CACHE_STALE_TTL_MS = 10 * 60 * 1000;
const SEMANTIC_SCHOLAR_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SEMANTIC_SCHOLAR_RATE_LIMIT_MAX_REQUESTS = 12;
const semanticScholarResponseCache = new Map();
const semanticScholarRateLimitBuckets = new Map();

function toSafeErrorResponse(error, requestId) {
  if (error?.code === "google_drive_not_configured") {
    return errorResponse(
      error.status || 503,
      error.code,
      error.message,
      requestId,
      error.details,
    );
  }

  if (error?.code === "invalid_tag_ids") {
    return errorResponse(400, "invalid_tag_ids", error.message, requestId);
  }

  if (error?.code === "paper_not_found") {
    return errorResponse(error.status || 404, error.code, error.message, requestId, error.details);
  }

  if (["semantic_scholar_rate_limited", "semantic_scholar_error", "semantic_scholar_timeout", "semantic_scholar_unreachable"]
    .includes(error?.code)) {
    return errorResponse(error.status || 502, error.code, error.message, requestId);
  }

  return errorResponse(500, "internal_error", "Unexpected server error", requestId);
}

function pruneSemanticScholarState(now = Date.now()) {
  for (const [key, entry] of semanticScholarResponseCache.entries()) {
    if (!entry.promise && (entry.staleUntil || entry.expiresAt) <= now) {
      semanticScholarResponseCache.delete(key);
    }
  }

  for (const [key, bucket] of semanticScholarRateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      semanticScholarRateLimitBuckets.delete(key);
    }
  }
}

function takeSemanticScholarRateLimit(userId, now = Date.now()) {
  pruneSemanticScholarState(now);

  const bucketKey = userId || "anonymous";
  const existing = semanticScholarRateLimitBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    semanticScholarRateLimitBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + SEMANTIC_SCHOLAR_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true };
  }

  if (existing.count >= SEMANTIC_SCHOLAR_RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true };
}

function getCachedSemanticScholarValue(cacheKey, now = Date.now()) {
  pruneSemanticScholarState(now);

  const existing = semanticScholarResponseCache.get(cacheKey);
  if (existing?.value && existing.expiresAt > now) {
    return { hit: true, value: existing.value };
  }

  if (existing?.promise) {
    return { hit: true, value: existing.promise };
  }

  return { hit: false, value: null };
}

function getStaleSemanticScholarValue(cacheKey, now = Date.now()) {
  pruneSemanticScholarState(now);

  const existing = semanticScholarResponseCache.get(cacheKey);
  if (existing?.value && (existing.staleUntil || existing.expiresAt) > now) {
    return { hit: true, value: existing.value };
  }

  return { hit: false, value: null };
}

async function getCachedSemanticScholarResponse(cacheKey, fetcher, now = Date.now()) {
  pruneSemanticScholarState(now);

  const existing = semanticScholarResponseCache.get(cacheKey);
  if (existing?.value && existing.expiresAt > now) {
    return existing.value;
  }

  if (existing?.promise) {
    return existing.promise;
  }

  const promise = (async () => {
    try {
      const value = await fetcher();
      semanticScholarResponseCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + SEMANTIC_SCHOLAR_CACHE_TTL_MS,
        staleUntil: Date.now() + SEMANTIC_SCHOLAR_CACHE_STALE_TTL_MS,
      });
      return value;
    } catch (error) {
      semanticScholarResponseCache.delete(cacheKey);
      throw error;
    }
  })();

  semanticScholarResponseCache.set(cacheKey, {
    promise,
    expiresAt: now + SEMANTIC_SCHOLAR_CACHE_TTL_MS,
    staleUntil: now + SEMANTIC_SCHOLAR_CACHE_STALE_TTL_MS,
  });

  return promise;
}

async function handleSemanticScholarPaperRoute(context, event, principal, routeName, fetcher) {
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizePaperListRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { seedPaperId, limit } = normalizedRequest.value;
  const cacheKey = `${routeName}:${seedPaperId}:${limit}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const { semanticScholarApiKey } = getConfig();
      const timeout = AbortSignal.timeout(8000);
      return getCachedSemanticScholarResponse(cacheKey, () =>
        fetcher({
          apiKey: semanticScholarApiKey,
          seedPaperId,
          limit,
          signal: timeout,
        })
      );
    })();

  if (papers?.statusCode) {
    return papers;
  }

  return json(200, {
    data: papers,
    meta: {
      request_id: context.requestId,
      paper_id: seedPaperId,
      limit,
    },
  });
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

function getManagementAuthFailureMessage(code) {
  if (code === "missing_bearer_token") {
    return "Bearer token is required";
  }

  if (code === "refhub_api_key_not_supported") {
    return "RefHub API keys are not supported for this route";
  }

  if (code === "invalid_bearer_token") {
    return "Bearer token is invalid";
  }

  return "Bearer token authentication failed";
}

function getGoogleDriveCallbackFallbackUrl() {
  return `${getConfig().appBaseUrl || getConfig().allowedOrigins[0] || "https://refhub.io"}/profile-edit?tab=storage`;
}

function serializeApiKeyRecord(record) {
  return {
    id: record.id,
    label: record.label,
    description: record.description,
    key_prefix: record.key_prefix,
    scopes: record.scopes || [],
    expires_at: record.expires_at,
    revoked_at: record.revoked_at,
    last_used_at: record.last_used_at,
    created_at: record.created_at,
    vault_ids: (record.api_key_vaults || []).map((entry) => entry.vault_id),
  };
}

function normalizeRequestedScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { error: "invalid_scopes", message: "Body must include a non-empty scopes array" };
  }

  const normalized = [...new Set(scopes)];
  if (normalized.some((scope) => typeof scope !== "string" || !isValidApiKeyScope(scope))) {
    return { error: "invalid_scopes", message: "Scopes must be one of vaults:read, vaults:write, vaults:export, vaults:admin" };
  }

  return { value: normalized };
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") {
    return { value: null };
  }

  if (typeof expiresAt !== "string") {
    return { error: "invalid_expires_at", message: "expires_at must be an ISO-8601 timestamp or null" };
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "invalid_expires_at", message: "expires_at must be an ISO-8601 timestamp or null" };
  }

  if (parsed.getTime() <= Date.now()) {
    return { error: "invalid_expires_at", message: "expires_at must be in the future" };
  }

  return { value: parsed.toISOString() };
}

async function resolveManagedVaultIds(supabase, userId, requestedVaultIds) {
  const uniqueVaultIds = [...new Set(requestedVaultIds)];
  if (uniqueVaultIds.length === 0) {
    return { value: [] };
  }

  const ownedResult = await supabase
    .from("vaults")
    .select("id")
    .eq("user_id", userId)
    .in("id", uniqueVaultIds);

  if (ownedResult.error) {
    throw ownedResult.error;
  }

  const sharedResult = await supabase
    .from("vault_shares")
    .select("vault_id")
    .eq("shared_with_user_id", userId)
    .in("vault_id", uniqueVaultIds);

  if (sharedResult.error) {
    throw sharedResult.error;
  }

  const allowedVaultIds = new Set([
    ...(ownedResult.data || []).map((vault) => vault.id),
    ...(sharedResult.data || []).map((share) => share.vault_id),
  ]);

  const inaccessibleVaultIds = uniqueVaultIds.filter((vaultId) => !allowedVaultIds.has(vaultId));
  if (inaccessibleVaultIds.length > 0) {
    return {
      error: "invalid_vault_ids",
      message: "One or more vault_ids are not accessible to this user",
      details: inaccessibleVaultIds,
    };
  }

  return { value: uniqueVaultIds };
}

async function fetchManagedApiKey(supabase, keyId, ownerUserId) {
  const result = await supabase
    .from("api_keys")
    .select(API_KEY_SELECT)
    .eq("id", keyId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  return result.data;
}

async function handleListApiKeys(supabase, principal, context) {
  const result = await supabase
    .from("api_keys")
    .select(API_KEY_SELECT)
    .eq("owner_user_id", principal.userId)
    .order("created_at", { ascending: false });

  if (result.error) {
    throw result.error;
  }

  return json(200, {
    data: (result.data || []).map(serializeApiKeyRecord),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleCreateApiKey(supabase, principal, context, event) {
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const body = parsedBody.value || {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return errorResponse(400, "invalid_label", "Body must include a non-empty label", context.requestId);
  }

  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return errorResponse(400, "invalid_description", "description must be a string or null", context.requestId);
  }

  const scopesResult = normalizeRequestedScopes(body.scopes);
  if (scopesResult.error) {
    return errorResponse(400, scopesResult.error, scopesResult.message, context.requestId);
  }

  const expiresAtResult = normalizeExpiresAt(body.expires_at);
  if (expiresAtResult.error) {
    return errorResponse(400, expiresAtResult.error, expiresAtResult.message, context.requestId);
  }

  if (body.vault_ids !== undefined && !Array.isArray(body.vault_ids)) {
    return errorResponse(400, "invalid_vault_ids", "vault_ids must be an array of vault ids", context.requestId);
  }

  const requestedVaultIds = body.vault_ids || [];
  if (requestedVaultIds.some((vaultId) => typeof vaultId !== "string" || !vaultId)) {
    return errorResponse(400, "invalid_vault_ids", "vault_ids must contain non-empty strings", context.requestId);
  }

  const managedVaultIds = await resolveManagedVaultIds(supabase, principal.userId, requestedVaultIds);
  if (managedVaultIds.error) {
    return errorResponse(403, managedVaultIds.error, managedVaultIds.message, context.requestId, {
      vault_ids: managedVaultIds.details,
    });
  }

  let createdKey = null;
  let rawKey = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = createApiKeySecret();
    rawKey = generated.rawKey;

    const insertResult = await supabase
      .from("api_keys")
      .insert({
        owner_user_id: principal.userId,
        created_by: principal.userId,
        label,
        description: body.description?.trim() || null,
        key_prefix: generated.keyPrefix,
        key_hash: hashManagedApiKey(generated.rawKey),
        scopes: scopesResult.value,
        expires_at: expiresAtResult.value,
      })
      .select("id")
      .single();

    if (!insertResult.error) {
      createdKey = insertResult.data;
      break;
    }

    if (insertResult.error.code !== "23505") {
      throw insertResult.error;
    }
  }

  if (!createdKey || !rawKey) {
    return errorResponse(500, "api_key_generation_failed", "Failed to generate a unique API key", context.requestId);
  }

  if (managedVaultIds.value.length > 0) {
    const vaultInsertResult = await supabase.from("api_key_vaults").insert(
      managedVaultIds.value.map((vaultId) => ({
        api_key_id: createdKey.id,
        vault_id: vaultId,
      })),
    );

    if (vaultInsertResult.error) {
      const rollbackResult = await supabase.from("api_keys").delete().eq("id", createdKey.id);
      if (rollbackResult.error) {
        console.error("API key vault restriction rollback failed", {
          requestId: context.requestId,
          keyId: createdKey.id,
          code: vaultInsertResult.error.code,
        });
        return errorResponse(
          500,
          "api_key_partial_failure",
          "API key creation failed after partial writes; manual reconciliation may be required",
          context.requestId,
        );
      }

      throw vaultInsertResult.error;
    }
  }

  const storedKey = await fetchManagedApiKey(supabase, createdKey.id, principal.userId);
  if (!storedKey) {
    return errorResponse(500, "api_key_not_found", "API key was created but could not be reloaded", context.requestId);
  }

  return json(201, {
    data: serializeApiKeyRecord(storedKey),
    secret: rawKey,
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleRevokeApiKey(supabase, principal, context, keyId) {
  const existingKey = await fetchManagedApiKey(supabase, keyId, principal.userId);
  if (!existingKey) {
    return errorResponse(404, "api_key_not_found", "API key not found", context.requestId);
  }

  if (!existingKey.revoked_at) {
    const revokeResult = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", keyId)
      .eq("owner_user_id", principal.userId);

    if (revokeResult.error) {
      throw revokeResult.error;
    }
  }

  const revokedKey = await fetchManagedApiKey(supabase, keyId, principal.userId);
  if (!revokedKey) {
    return errorResponse(404, "api_key_not_found", "API key not found", context.requestId);
  }

  return json(200, {
    data: serializeApiKeyRecord(revokedKey),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handlePaperRecommendations(context, event, principal) {
  return handleSemanticScholarPaperRoute(
    context,
    event,
    principal,
    "recommendations",
    fetchSemanticScholarRecommendations,
  );
}

async function handlePaperReferences(context, event, principal) {
  return handleSemanticScholarPaperRoute(context, event, principal, "references", fetchSemanticScholarReferences);
}

async function handlePaperCitations(context, event, principal) {
  return handleSemanticScholarPaperRoute(context, event, principal, "citations", fetchSemanticScholarCitations);
}

async function handlePaperLookup(context, event, principal) {
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizePaperLookupRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { queryType, queryValue } = normalizedRequest.value;
  if (queryType === "doi") {
    const normalizedDoi = queryValue.replace(/^doi:/i, "").trim();
    return json(200, {
      data: {
        paper_id: `DOI:${normalizedDoi}`,
      },
      meta: {
        request_id: context.requestId,
        query_type: queryType,
      },
    });
  }

  const cacheKey = `lookup:${queryType}:${queryValue}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  const paperId = cached.hit
    ? await cached.value
    : await (async () => {
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const { semanticScholarApiKey } = getConfig();
      const timeout = AbortSignal.timeout(8000);
      try {
        return await getCachedSemanticScholarResponse(cacheKey, () =>
          fetchSemanticScholarPaperLookup({
            apiKey: semanticScholarApiKey,
            queryType,
            queryValue,
            signal: timeout,
          })
        );
      } catch (error) {
        const stale = getStaleSemanticScholarValue(cacheKey);
        if (error?.code === "semantic_scholar_rate_limited" && stale.hit) {
          return stale.value;
        }

        throw error;
      }
    })();

  if (paperId?.statusCode) {
    return paperId;
  }

  return json(200, {
    data: {
      paper_id: paperId,
    },
    meta: {
      request_id: context.requestId,
      query_type: queryType,
    },
  });
}
async function handleSemanticScholarDoiMetadataRoute(context, event, principal) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  // Semantic Scholar is disabled when no API key is configured. Without a key
  // the unauthenticated rate limit (1 req/s shared) is hit almost immediately.
  // Set SEMANTIC_SCHOLAR_API_KEY in the environment to re-enable this route.
  const { semanticScholarApiKey } = getConfig();
  if (!semanticScholarApiKey) {
    return errorResponse(503, "semantic_scholar_disabled", "Semantic Scholar metadata enrichment is not configured on this server.", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizeSemanticScholarDoiRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { doi } = normalizedRequest.value;
  const cacheKey = `doi-metadata:${doi}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  const metadata = cached.hit
    ? await cached.value
    : await (async () => {
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const timeout = AbortSignal.timeout(8000);
      return getCachedSemanticScholarResponse(cacheKey, () =>
        fetchSemanticScholarDoiMetadata({
          apiKey: semanticScholarApiKey,
          doi,
          signal: timeout,
        })
      );
    })();

  if (metadata?.statusCode) {
    return metadata;
  }

  return json(200, {
    data: metadata,
    meta: {
      request_id: context.requestId,
      doi,
    },
  });
}

async function handlePdfMetadataRoute(context, event, principal) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const sourceUrl = typeof parsedBody.value?.source_url === "string" ? parsedBody.value.source_url.trim() : "";
  const cookieHeader = typeof parsedBody.value?.cookie_header === "string" ? parsedBody.value.cookie_header.trim() : "";
  const referer = typeof parsedBody.value?.referer === "string" ? parsedBody.value.referer.trim() : "";
  if (!sourceUrl) {
    return errorResponse(400, "invalid_source_url", "Body must include a non-empty source_url", context.requestId);
  }

  let pdfBuffer;
  try {
    pdfBuffer = await fetchPdfSourceBuffer({
      sourceUrl,
      cookieHeader,
      referer,
      maxBytes: 10 * 1024 * 1024,
    });
  } catch (fetchErr) {
    // PDF not accessible from the server (e.g. institutional IP auth, 403, etc.).
    // Return empty metadata with a note rather than letting this throw a 500 —
    // the extension already handles null/empty metadata gracefully.
    console.log("[pdf-metadata] PDF fetch failed, returning empty metadata", { sourceUrl, message: fetchErr.message });
    return json(200, {
      data: { doi: null, title: null, authors: [], year: null, journal: null, text_excerpt: "" },
      meta: { request_id: context.requestId, source_url: sourceUrl, fetch_skipped: true, fetch_error: fetchErr.message },
    });
  }

  const metadata = await extractPdfMetadataFromBuffer(pdfBuffer);

  return json(200, {
    data: {
      doi: metadata.doi || null,
      title: metadata.title || null,
      authors: metadata.authors || [],
      year: metadata.year || null,
      journal: metadata.journal || null,
      text_excerpt: metadata.firstPageText ? metadata.firstPageText.slice(0, 2000) : "",
    },
    meta: {
      request_id: context.requestId,
      source_url: sourceUrl,
    },
  });
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
  if (auditDisabled || !supabase || !principal || principal.authType !== "api_key") {
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

async function handleUploadItemPdf(supabase, principal, context, event, vaultId, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault write access denied", context.requestId);
  }

  const { data: vaultPub, error: vpError } = await supabase
    .from("vault_publications")
    .select("id, original_publication_id, title, year, doi")
    .eq("id", itemId)
    .eq("vault_id", vaultId)
    .single();

  if (vpError || !vaultPub) {
    return errorResponse(404, "item_not_found", "Vault item not found", context.requestId);
  }

  const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  let pdfBuffer = null;
  let sourceUrl = null;
  let cookieHeader = null;
  let referer = null;

  if (/application\/json/i.test(contentType)) {
    const parsedBody = parseJsonBody(event);
    if (!parsedBody.ok) {
      return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
    }

    sourceUrl = typeof parsedBody.value?.source_url === "string" ? parsedBody.value.source_url.trim() : "";
    cookieHeader = typeof parsedBody.value?.cookie_header === "string" ? parsedBody.value.cookie_header.trim() : "";
    referer = typeof parsedBody.value?.referer === "string" ? parsedBody.value.referer.trim() : "";
    if (!sourceUrl) {
      return errorResponse(400, "invalid_source_url", "Body must include a non-empty source_url", context.requestId);
    }

    console.log("[pdf-upload] received source-url PDF request for vault_pub", {
      itemId,
      vaultId,
      sourceUrl,
      hasCookieHeader: Boolean(cookieHeader),
      referer,
    });
  } else {
    if (!event.body) {
      return errorResponse(400, "missing_body", "Request body must be a PDF binary or JSON source_url", context.requestId);
    }

    // Netlify base64-encodes binary request bodies
    pdfBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "binary");

    // Validate PDF magic bytes (%PDF-)
    if (pdfBuffer.length < 5 || pdfBuffer[0] !== 0x25 || pdfBuffer[1] !== 0x50 || pdfBuffer[2] !== 0x44 || pdfBuffer[3] !== 0x46) {
      return errorResponse(400, "invalid_pdf", "Request body does not appear to be a valid PDF", context.requestId);
    }

    console.log("[pdf-upload] received PDF for vault_pub", { itemId, vaultId, bytes: pdfBuffer.length });
  }

  const result = await uploadPdfToGoogleDriveForUser({
    supabase,
    userId: principal.userId,
    publicationId: vaultPub.original_publication_id,
    vaultPublicationId: vaultPub.id,
    title: vaultPub.title,
    year: vaultPub.year,
    doi: vaultPub.doi,
    sourceUrl,
    cookieHeader,
    referer,
    pdfBuffer,
  });

  if (!result.stored) {
    return errorResponse(
      502,
      result.code || "drive_upload_failed",
      result.message || "PDF upload to Drive failed",
      context.requestId,
    );
  }

  return json(200, {
    data: result,
    meta: { request_id: context.requestId },
  });
}

async function handleCreatePdfDriveSession(supabase, principal, context, vaultId, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault write access denied", context.requestId);
  }

  const { data: vaultPub, error: vpError } = await supabase
    .from("vault_publications")
    .select("id, title, year")
    .eq("id", itemId)
    .eq("vault_id", vaultId)
    .single();

  if (vpError || !vaultPub) {
    return errorResponse(404, "item_not_found", "Vault item not found", context.requestId);
  }

  const session = await createDriveResumableSession(supabase, principal.userId, {
    title: vaultPub.title,
    year: vaultPub.year,
  });

  if (!session) {
    return errorResponse(503, "drive_not_linked", "Google Drive is not linked for this account", context.requestId);
  }

  return json(200, { data: session, meta: { request_id: context.requestId } });
}

async function handleCompletePdfDriveUpload(supabase, principal, context, event, vaultId, itemId) {
  if (!requireScope(principal, API_SCOPES.WRITE)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const access = await resolveVaultAccess(supabase, principal, vaultId, "editor");
  if (!access.ok) {
    return errorResponse(access.status, access.code, "Vault write access denied", context.requestId);
  }

  const { data: vaultPub, error: vpError } = await supabase
    .from("vault_publications")
    .select("id, original_publication_id")
    .eq("id", itemId)
    .eq("vault_id", vaultId)
    .single();

  if (vpError || !vaultPub) {
    return errorResponse(404, "item_not_found", "Vault item not found", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const { file_id, web_view_link, source_url } = parsedBody.value || {};
  if (!file_id) {
    return errorResponse(400, "missing_file_id", "Body must include file_id", context.requestId);
  }

  const result = await recordBrowserDriveUpload(supabase, {
    userId: principal.userId,
    publicationId: vaultPub.original_publication_id,
    vaultPublicationId: vaultPub.id,
    fileId: file_id,
    webViewLink: web_view_link || null,
    sourceUrl: source_url || null,
  });

  return json(200, { data: result, meta: { request_id: context.requestId } });
}

async function handleGetGoogleDriveStatus(supabase, principal, context) {
  return json(200, {
    data: await getGoogleDriveStatus(supabase, principal.userId),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleStartGoogleDriveLink(principal, context, event) {
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const { authorizationUrl, returnTo, scope } = createGoogleDriveAuthorizationUrl({
    userId: principal.userId,
    returnTo: parsedBody.value?.return_to,
  });

  return json(200, {
    data: {
      authorization_url: authorizationUrl,
      return_to: returnTo,
      scope,
    },
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleEnsureGoogleDriveFolder(supabase, principal, context) {
  return json(200, {
    data: await ensureGoogleDriveFolderForUser(supabase, principal.userId),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleDisconnectGoogleDrive(supabase, principal, context) {
  return json(200, {
    data: await disconnectGoogleDriveForUser(supabase, principal.userId),
    meta: {
      request_id: context.requestId,
    },
  });
}

async function handleGoogleDriveCallback(_context, event) {
  const params = event.queryStringParameters || {};
  const state = params.state || null;
  const code = params.code || null;
  const oauthError = params.error || null;

  if (!state) {
    return text(400, "Missing Google Drive OAuth state.");
  }

  if (!code && !oauthError) {
    return text(400, "Missing Google Drive OAuth code.");
  }

  try {
    const { redirectUrl } = await completeGoogleDriveLink(getSupabaseAdmin(), {
      state,
      code,
      error: oauthError,
    });

    return {
      statusCode: 302,
      headers: {
        location: redirectUrl,
        "cache-control": "no-store",
      },
      body: "",
    };
  } catch (error) {
    const redirectUrl = new URL(getGoogleDriveCallbackFallbackUrl());
    redirectUrl.searchParams.set("gdrive", "error");
    redirectUrl.searchParams.set("gdrive_message", error.message || "Google Drive linking failed.");
    return {
      statusCode: 302,
      headers: {
        location: redirectUrl.toString(),
        "cache-control": "no-store",
      },
      body: "",
    };
  }
}

async function handleExtensionGoogleDriveStatus(supabase, principal, context) {
  const status = await getGoogleDriveStatus(supabase, principal.userId);
  return json(200, {
    data: {
      linked: status.linked,
      folder_status: status.folderStatus,
      folder_name: status.folderName,
      folder_id: status.folderId,
    },
    meta: {
      request_id: context.requestId,
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
  const corsHeaders = createCorsHeaders(event, getConfig().allowedOrigins);
  let supabase = null;
  let principal = null;
  let response;

  try {
    if (event.httpMethod === "OPTIONS") {
      return withCors({
        statusCode: 204,
        headers: {
          allow: "GET,POST,PATCH,DELETE,OPTIONS",
        },
      }, corsHeaders);
    }

    const { maxBodyBytes } = getConfig();
    if (getRequestBodySize(event) > maxBodyBytes) {
      return withCors(
        errorResponse(413, "request_too_large", `Request body exceeds ${maxBodyBytes} bytes`, context.requestId),
        corsHeaders,
      );
    }

    const route = getRouteSegments(event.path || "/");

    if (route.length === 2 && route[0] === "google-drive" && route[1] === "callback" && event.httpMethod === "GET") {
      return withCors(await handleGoogleDriveCallback(context, event), corsHeaders);
    }

    const isManagementRoute =
      route[0] === "keys" ||
      route[0] === "recommendations" ||
      route[0] === "references" ||
      route[0] === "citations" ||
      route[0] === "lookup" ||
      route[0] === "google-drive" ||
      route[0] === "audit";

    if (isManagementRoute) {
      const authorization = event.headers?.authorization || event.headers?.Authorization || null;
      const presentedApiKey = event.headers?.["x-api-key"] || event.headers?.["X-API-Key"] || null;
      const bearerToken = typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : null;
      if (isRefHubApiKeyValue(bearerToken) || isRefHubApiKeyValue(presentedApiKey)) {
        return withCors(
          errorResponse(
            401,
            "refhub_api_key_not_supported",
            getManagementAuthFailureMessage("refhub_api_key_not_supported"),
            context.requestId,
            { auth_scheme: "Bearer" },
          ),
          corsHeaders,
        );
      }

      const authResult = await authenticateManagementUser(event);
      if (authResult.error) {
        return withCors(
          errorResponse(401, authResult.error, getManagementAuthFailureMessage(authResult.error), context.requestId, {
            auth_scheme: "Bearer",
          }),
          corsHeaders,
        );
      }

      supabase = authResult.supabase;
      principal = authResult.principal;

      if (route.length === 1 && route[0] === "keys" && event.httpMethod === "GET") {
        response = await handleListApiKeys(supabase, principal, context);
      } else if (route.length === 1 && route[0] === "keys" && event.httpMethod === "POST") {
        response = await handleCreateApiKey(supabase, principal, context, event);
      } else if (route.length === 1 && route[0] === "recommendations" && event.httpMethod === "POST") {
        response = await handlePaperRecommendations(context, event, principal);
      } else if (route.length === 1 && route[0] === "references" && event.httpMethod === "POST") {
        response = await handlePaperReferences(context, event, principal);
      } else if (route.length === 1 && route[0] === "citations" && event.httpMethod === "POST") {
        response = await handlePaperCitations(context, event, principal);
      } else if (route.length === 1 && route[0] === "lookup" && event.httpMethod === "POST") {
        response = await handlePaperLookup(context, event, principal);
      } else if (route.length === 1 && route[0] === "doi-metadata" && event.httpMethod === "POST") {
        response = await handleSemanticScholarDoiMetadataRoute(context, event, principal);
      } else if (route.length === 2 && route[0] === "keys" && event.httpMethod === "DELETE") {
        response = await handleRevokeApiKey(supabase, principal, context, route[1]);
      } else if (route.length === 3 && route[0] === "keys" && route[2] === "revoke" && event.httpMethod === "POST") {
        response = await handleRevokeApiKey(supabase, principal, context, route[1]);
      } else if (route.length === 1 && route[0] === "google-drive" && event.httpMethod === "GET") {
        response = await handleGetGoogleDriveStatus(supabase, principal, context);
      } else if (route.length === 2 && route[0] === "google-drive" && route[1] === "connect" && event.httpMethod === "POST") {
        response = await handleStartGoogleDriveLink(principal, context, event);
      } else if (route.length === 2 && route[0] === "google-drive" && route[1] === "folder" && event.httpMethod === "POST") {
        response = await handleEnsureGoogleDriveFolder(supabase, principal, context);
      } else if (route.length === 1 && route[0] === "google-drive" && event.httpMethod === "DELETE") {
        response = await handleDisconnectGoogleDrive(supabase, principal, context);
      // ── V2 management routes ────────────────────────────────────────────────
      } else if (route.length === 1 && route[0] === "audit" && event.httpMethod === "GET") {
        response = await handleListGlobalAudit(supabase, principal, context, event);
      } else {
        response = errorResponse(404, "route_not_found", "Route not found", context.requestId);
      }
    } else {
      const authResult = await authenticateApiKey(event);
      if (authResult.error) {
        return withCors(
          errorResponse(401, authResult.error, getAuthFailureMessage(authResult.error), context.requestId, {
            auth_scheme: "Bearer",
          }),
          corsHeaders,
        );
      }

      supabase = authResult.supabase;
      principal = authResult.principal;

      if (route.length === 1 && route[0] === "vaults" && event.httpMethod === "GET") {
        response = await handleListVaults(supabase, principal, context);
      // ── V2: vault CRUD ──────────────────────────────────────────────────────
      } else if (route.length === 1 && route[0] === "vaults" && event.httpMethod === "POST") {
        response = await handleCreateVault(supabase, principal, context, event);
      } else if (route.length === 2 && route[0] === "vaults" && event.httpMethod === "GET") {
        response = await handleReadVault(supabase, principal, context, route[1]);
      } else if (route.length === 2 && route[0] === "vaults" && event.httpMethod === "PATCH") {
        response = await handleUpdateVault(supabase, principal, context, route[1], event);
      } else if (route.length === 2 && route[0] === "vaults" && event.httpMethod === "DELETE") {
        response = await handleDeleteVault(supabase, principal, context, route[1]);
      // ── V2: visibility ──────────────────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "visibility" && event.httpMethod === "PATCH") {
        response = await handleUpdateVaultVisibility(supabase, principal, context, route[1], event);
      // ── V2: shares ──────────────────────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "shares" && event.httpMethod === "GET") {
        response = await handleListVaultShares(supabase, principal, context, route[1]);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "shares" && event.httpMethod === "POST") {
        response = await handleCreateVaultShare(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "shares" && event.httpMethod === "PATCH") {
        response = await handleUpdateVaultShare(supabase, principal, context, route[1], route[3], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "shares" && event.httpMethod === "DELETE") {
        response = await handleDeleteVaultShare(supabase, principal, context, route[1], route[3]);
      // ── V2: tags ────────────────────────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "tags" && event.httpMethod === "GET") {
        response = await handleListTags(supabase, principal, context, route[1]);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "tags" && event.httpMethod === "POST") {
        response = await handleCreateTag(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "tags" && route[3] === "attach" && event.httpMethod === "POST") {
        response = await handleAttachTags(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "tags" && route[3] === "detach" && event.httpMethod === "POST") {
        response = await handleDetachTags(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "tags" && event.httpMethod === "PATCH") {
        response = await handleUpdateTag(supabase, principal, context, route[1], route[3], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "tags" && event.httpMethod === "DELETE") {
        response = await handleDeleteTag(supabase, principal, context, route[1], route[3]);
      // ── V2: relations ───────────────────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "relations" && event.httpMethod === "GET") {
        response = await handleListRelations(supabase, principal, context, route[1], event);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "relations" && event.httpMethod === "POST") {
        response = await handleCreateRelation(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "relations" && event.httpMethod === "PATCH") {
        response = await handleUpdateRelation(supabase, principal, context, route[1], route[3], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "relations" && event.httpMethod === "DELETE") {
        response = await handleDeleteRelation(supabase, principal, context, route[1], route[3]);
      // ── V2: search / stats / changes ────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "GET") {
        response = await handleSearchItems(supabase, principal, context, route[1], event);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "search" && event.httpMethod === "GET") {
        response = await handleSearchItems(supabase, principal, context, route[1], event);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "stats" && event.httpMethod === "GET") {
        response = await handleGetVaultStats(supabase, principal, context, route[1]);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "changes" && event.httpMethod === "GET") {
        response = await handleGetVaultChanges(supabase, principal, context, route[1], event);
      // ── V2: item delete / upsert / preview ──────────────────────────────────
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && route[3] === "upsert" && event.httpMethod === "POST") {
        response = await handleBulkUpsertItems(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && route[3] === "import-preview" && event.httpMethod === "POST") {
        response = await handleImportPreview(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "DELETE") {
        response = await handleDeleteItem(supabase, principal, context, route[1], route[3]);
      // ── V2: import ──────────────────────────────────────────────────────────
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "import" && route[3] === "doi" && event.httpMethod === "POST") {
        response = await handleImportDoi(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "import" && route[3] === "bibtex" && event.httpMethod === "POST") {
        response = await handleImportBibtex(supabase, principal, context, route[1], event);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "import" && route[3] === "url" && event.httpMethod === "POST") {
        response = await handleImportUrl(supabase, principal, context, route[1], event);
      // ── V2: audit ───────────────────────────────────────────────────────────
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "audit" && event.httpMethod === "GET") {
        response = await handleListVaultAudit(supabase, principal, context, route[1], event);
      // ── existing routes ─────────────────────────────────────────────────────
      } else if (route.length === 1 && route[0] === "doi-metadata" && event.httpMethod === "POST") {
        response = await handleSemanticScholarDoiMetadataRoute(context, event, principal);
      } else if (route.length === 1 && route[0] === "pdf-metadata" && event.httpMethod === "POST") {
        response = await handlePdfMetadataRoute(context, event, principal);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "POST") {
        response = await handleAddItems(supabase, principal, context, route[1], event);
      } else if (route.length === 5 && route[0] === "vaults" && route[2] === "items" && route[4] === "pdf" && event.httpMethod === "POST") {
        response = await handleUploadItemPdf(supabase, principal, context, event, route[1], route[3]);
      } else if (route.length === 6 && route[0] === "vaults" && route[2] === "items" && route[4] === "pdf" && route[5] === "session" && event.httpMethod === "POST") {
        response = await handleCreatePdfDriveSession(supabase, principal, context, route[1], route[3]);
      } else if (route.length === 6 && route[0] === "vaults" && route[2] === "items" && route[4] === "pdf" && route[5] === "complete" && event.httpMethod === "POST") {
        response = await handleCompletePdfDriveUpload(supabase, principal, context, event, route[1], route[3]);
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "PATCH") {
        response = await handleUpdateItem(supabase, principal, context, route[1], route[3], event);
      } else if (route.length === 3 && route[0] === "vaults" && route[2] === "export" && event.httpMethod === "GET") {
        response = await handleExportVault(supabase, principal, context, route[1], event);
      } else if (route.length === 2 && route[0] === "extension" && route[1] === "google-drive-status" && event.httpMethod === "GET") {
        response = await handleExtensionGoogleDriveStatus(supabase, principal, context);
      } else {
        response = errorResponse(404, "route_not_found", "Route not found", context.requestId);
      }
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

  return withCors(response, corsHeaders);
}
