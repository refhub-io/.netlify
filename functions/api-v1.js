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
  fetchSemanticScholarSearch,
  isRefHubApiKeyValue,
  normalizePaperListRequest,
  normalizePaperLookupRequest,
  normalizeRecommendationsRequest,
  normalizeSemanticScholarDoiRequest,
  normalizeSemanticScholarSearchRequest,
  takeSemanticScholarRateLimit,
} from "../src/semantic-scholar.js";
import {
  fetchOpenAlexCitations,
  fetchOpenAlexDoiMetadata,
  fetchOpenAlexReferences,
  fetchOpenAlexSearch,
  OPENALEX_CITATIONS_COST_USD,
  OPENALEX_SEARCH_COST_USD,
  takeOpenAlexBudget,
} from "../src/openalex.js";
import { withProviderFallback } from "../src/providerFallback.js";

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
  handleGetItem,
  handleDeleteItem,
  handleBulkUpsertItems,
  handleImportPreview,
} from "../src/routes/items.js";
import { attachDrivePdfUrls } from "../src/routes/utils.js";
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
const semanticScholarResponseCache = new Map();

function getSafeCorsHeaders(event) {
  try {
    return createCorsHeaders(event, getConfig().allowedOrigins);
  } catch (error) {
    console.error("RefHub API config error while building CORS headers", {
      code: error?.code,
      message: error?.message,
    });
    return createCorsHeaders(event, ["https://refhub.io", "http://localhost:3000"]);
  }
}

// Raw application/pdf bodies are no longer accepted anywhere — client-held bytes
// always go through the resumable session flow (PUT directly to Google Drive,
// bypassing this function entirely), regardless of size. This only matches the
// vault-item /pdf route, which still accepts a JSON { source_url } body for
// server-side fetches; the publications/pdf route was raw-bytes-only and has
// been replaced outright by /publications/:publicationId/pdf/session + /complete.
function isVaultItemPdfUploadRoute(route, method) {
  if (method !== "POST") {
    return false;
  }

  return (
    (route.length === 6 && route[0] === "google-drive" && route[1] === "vaults" && route[3] === "items" && route[5] === "pdf") ||
    (route.length === 5 && route[0] === "vaults" && route[2] === "items" && route[4] === "pdf")
  );
}

function rejectRawPdfBodyIfPresent(event, context) {
  const contentType = getHeader(event, "content-type") || "";
  if (!/application\/pdf|application\/octet-stream/i.test(contentType)) {
    return null;
  }

  return errorResponse(
    410,
    "raw_pdf_upload_removed",
    "Raw application/pdf request bodies are no longer accepted on this route. Use the resumable Drive upload flow instead: POST .../pdf/session, PUT the bytes to the returned upload_url, then POST .../pdf/complete.",
    context.requestId,
    { resumable_session_path_suffix: "/pdf/session" },
  );
}

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
    return errorResponse(error.status || 502, error.code, error.message, requestId, error.details);
  }

  return errorResponse(500, "internal_error", "Unexpected server error", requestId);
}

function pruneSemanticScholarState(now = Date.now()) {
  for (const [key, entry] of semanticScholarResponseCache.entries()) {
    if (!entry.promise && (entry.staleUntil || entry.expiresAt) <= now) {
      semanticScholarResponseCache.delete(key);
    }
  }
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


function ensureSemanticScholarReadScope(principal, context) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  return null;
}

const OPENALEX_FALLBACK_ELIGIBLE_CODES = new Set([
  "openalex_not_found",
  "openalex_error",
  "openalex_timeout",
  "openalex_unreachable",
]);

function isOpenAlexFallbackEligible(error) {
  return OPENALEX_FALLBACK_ELIGIBLE_CODES.has(error?.code);
}

const OPENALEX_FETCHERS_BY_ROUTE = {
  references: fetchOpenAlexReferences,
  citations: fetchOpenAlexCitations,
};

const OPENALEX_COST_BY_ROUTE = {
  references: 0,
  citations: OPENALEX_CITATIONS_COST_USD,
};

async function handleSemanticScholarPaperRoute(context, event, principal, supabase, routeName, fetcher) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
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
  let provider = "cache";
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const config = getConfig();
      const rateLimit = await takeSemanticScholarRateLimit(supabase, config);
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

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      const fetchFromSemanticScholar = () => {
        provider = "semantic_scholar";
        return fetcher({ apiKey: config.semanticScholarApiKey, seedPaperId, limit, signal: timeout });
      };

      return getCachedSemanticScholarResponse(cacheKey, async () => {
        const openAlexFetcher = OPENALEX_FETCHERS_BY_ROUTE[routeName];
        const doiMatch = /^DOI:(.+)$/i.exec(seedPaperId);

        if (!openAlexFetcher || !config.openalexApiKey || !doiMatch) {
          return fetchFromSemanticScholar();
        }

        const cost = OPENALEX_COST_BY_ROUTE[routeName] ?? 0;
        if (cost > 0) {
          const budget = await takeOpenAlexBudget(getSupabaseAdmin(), config, cost);
          if (!budget.allowed) {
            return fetchFromSemanticScholar();
          }
        }

        const bareDoi = doiMatch[1];
        const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
        return withProviderFallback({
          primary: () => openAlexFetcher({ apiKey: config.openalexApiKey, doi: bareDoi, limit, signal: openAlexTimeout }),
          fallback: fetchFromSemanticScholar,
          isFallbackEligible: isOpenAlexFallbackEligible,
          onProviderUsed: (usedProvider) => {
            provider = usedProvider;
          },
        });
      });
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
      provider,
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

function isLegacySemanticScholarRoute(route) {
  return route.length === 1 && [
    "recommendations",
    "references",
    "citations",
    "lookup",
    "doi-metadata",
    "search",
  ].includes(route[0]);
}

function isApiKeySemanticScholarRoute(route) {
  return route.length === 2 && route[0] === "semantic-scholar" && [
    "recommendations",
    "related",
    "references",
    "citations",
    "cited-by",
    "lookup",
    "doi-metadata",
    "search",
  ].includes(route[1]);
}

async function handleSemanticScholarRoute(context, event, principal, supabase, routeName) {
  const canonicalRoute = routeName === "related" ? "recommendations" : routeName === "cited-by" ? "citations" : routeName;
  if (canonicalRoute === "recommendations") return handlePaperRecommendations(context, event, principal, supabase);
  if (canonicalRoute === "references") return handlePaperReferences(context, event, principal, supabase);
  if (canonicalRoute === "citations") return handlePaperCitations(context, event, principal, supabase);
  if (canonicalRoute === "lookup") return handlePaperLookup(context, event, principal, supabase);
  if (canonicalRoute === "doi-metadata") return handleSemanticScholarDoiMetadataRoute(context, event, principal, supabase);
  if (canonicalRoute === "search") return handleSemanticScholarSearchRoute(context, event, principal, supabase);
  return errorResponse(404, "route_not_found", "Route not found", context.requestId);
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

async function handlePaperRecommendations(context, event, principal, supabase) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizeRecommendationsRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { seedPaperIds, limit } = normalizedRequest.value;
  const cacheKey = `recommendations:${[...seedPaperIds].sort().join(",")}:${limit}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const config = getConfig();
      const rateLimit = await takeSemanticScholarRateLimit(supabase, config);
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

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      return getCachedSemanticScholarResponse(cacheKey, () =>
        fetchSemanticScholarRecommendations({
          apiKey: config.semanticScholarApiKey,
          seedPaperIds,
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
      paper_ids: seedPaperIds,
      limit,
    },
  });
}

async function handlePaperReferences(context, event, principal, supabase) {
  return handleSemanticScholarPaperRoute(context, event, principal, supabase, "references", fetchSemanticScholarReferences);
}

async function handlePaperCitations(context, event, principal, supabase) {
  return handleSemanticScholarPaperRoute(context, event, principal, supabase, "citations", fetchSemanticScholarCitations);
}

async function handlePaperLookup(context, event, principal, supabase) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
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
      const config = getConfig();
      const rateLimit = await takeSemanticScholarRateLimit(supabase, config);
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

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      try {
        return await getCachedSemanticScholarResponse(cacheKey, () =>
          fetchSemanticScholarPaperLookup({
            apiKey: config.semanticScholarApiKey,
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
async function handleSemanticScholarSearchRoute(context, event, principal, supabase) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizeSemanticScholarSearchRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { query, limit } = normalizedRequest.value;
  const cacheKey = `search:${query.toLowerCase()}:${limit}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  let provider = "cache";
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const config = getConfig();
      const rateLimit = await takeSemanticScholarRateLimit(supabase, config);
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

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      const fetchFromSemanticScholar = () => {
        provider = "semantic_scholar";
        return fetchSemanticScholarSearch({ apiKey: config.semanticScholarApiKey, query, limit, signal: timeout });
      };

      try {
        return await getCachedSemanticScholarResponse(cacheKey, async () => {
          if (!config.openalexApiKey) {
            return fetchFromSemanticScholar();
          }

          const budget = await takeOpenAlexBudget(getSupabaseAdmin(), config, OPENALEX_SEARCH_COST_USD);
          if (!budget.allowed) {
            return fetchFromSemanticScholar();
          }

          const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
          return withProviderFallback({
            primary: () => fetchOpenAlexSearch({ apiKey: config.openalexApiKey, query, limit, signal: openAlexTimeout }),
            fallback: fetchFromSemanticScholar,
            isFallbackEligible: isOpenAlexFallbackEligible,
            onProviderUsed: (usedProvider) => {
              provider = usedProvider;
            },
          });
        });
      } catch (error) {
        const stale = getStaleSemanticScholarValue(cacheKey);
        if (error?.code === "semantic_scholar_rate_limited" && stale.hit) {
          return stale.value;
        }

        throw error;
      }
    })();

  if (papers?.statusCode) {
    return papers;
  }

  return json(200, {
    data: papers,
    meta: {
      request_id: context.requestId,
      query,
      limit,
      provider,
    },
  });
}

async function handleSemanticScholarDoiMetadataRoute(context, event, principal, supabase) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  // This route is disabled only when neither provider is configured at all.
  // SEMANTIC_SCHOLAR_API_KEY is not required on its own -- it just raises
  // Semantic Scholar's rate limit above the shared unauthenticated 1 req/s;
  // OPENALEX_API_KEY alone is enough to serve this route.
  const config = getConfig();
  if (!config.semanticScholarApiKey && !config.openalexApiKey) {
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
  let provider = "cache";
  const metadata = cached.hit
    ? await cached.value
    : await (async () => {
      const rateLimit = await takeSemanticScholarRateLimit(supabase, config);
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

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      return getCachedSemanticScholarResponse(cacheKey, () => {
        if (!config.openalexApiKey) {
          provider = "semantic_scholar";
          return fetchSemanticScholarDoiMetadata({ apiKey: config.semanticScholarApiKey, doi, signal: timeout });
        }

        const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
        return withProviderFallback({
          primary: () => fetchOpenAlexDoiMetadata({ apiKey: config.openalexApiKey, doi, signal: openAlexTimeout }),
          fallback: () => fetchSemanticScholarDoiMetadata({ apiKey: config.semanticScholarApiKey, doi, signal: timeout }),
          isFallbackEligible: isOpenAlexFallbackEligible,
          onProviderUsed: (usedProvider) => {
            provider = usedProvider;
          },
        });
      });
    })();

  if (metadata?.statusCode) {
    return metadata;
  }

  return json(200, {
    data: metadata,
    meta: {
      request_id: context.requestId,
      doi,
      provider,
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

/**
 * Same field allow-list as pickPublicationFields, but for partial updates:
 * only fields actually present in the input are included, with no defaults
 * applied. pickPublicationFields' defaults (empty arrays, 'article' type)
 * are correct for creating a new row but wipe existing values when reused
 * for PATCH, since any field the caller omits should stay untouched.
 */
function pickPublicationFieldsForUpdate(input) {
  const row = {};

  for (const field of PUBLICATION_FIELDS) {
    if (input[field] !== undefined) {
      row[field] = input[field];
    }
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

async function loadVaultContents(supabase, vaultId, userId) {
  const { data: rawPublications, error: publicationsError } = await supabase
    .from("vault_publications")
    .select(VAULT_PUBLICATION_SELECT)
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: true });

  if (publicationsError) {
    throw publicationsError;
  }

  const publications = await attachDrivePdfUrls(supabase, rawPublications, userId);

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

  const contents = await loadVaultContents(supabase, vaultId, principal.userId);

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
  if (!canWriteWithPrincipal(principal)) {
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

function getHeader(event, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function canWriteWithPrincipal(principal) {
  return principal.authType === "management_user" || requireScope(principal, API_SCOPES.WRITE);
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

  console.log("[pdf-upload] received source-url PDF request for vault_pub", {
    itemId,
    vaultId,
    sourceUrl,
    hasCookieHeader: Boolean(cookieHeader),
    referer,
  });

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
    pdfBuffer: null,
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

async function handleCreatePublicationPdfDriveSession(supabase, principal, context, publicationId) {
  if (!canWriteWithPrincipal(principal)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const { data: publication, error: publicationError } = await supabase
    .from("publications")
    .select("id, title, year")
    .eq("id", publicationId)
    .eq("user_id", principal.userId)
    .single();

  if (publicationError || !publication) {
    return errorResponse(404, "publication_not_found", "Publication not found", context.requestId);
  }

  const session = await createDriveResumableSession(supabase, principal.userId, {
    title: publication.title,
    year: publication.year,
    origin: context.origin,
  });

  if (!session) {
    return errorResponse(503, "drive_not_linked", "Google Drive is not linked for this account", context.requestId);
  }

  return json(200, { data: session, meta: { request_id: context.requestId } });
}

async function handleCompletePublicationPdfDriveUpload(supabase, principal, context, event, publicationId) {
  if (!canWriteWithPrincipal(principal)) {
    return errorResponse(403, "missing_scope", "Scope vaults:write is required", context.requestId);
  }

  const { data: publication, error: publicationError } = await supabase
    .from("publications")
    .select("id")
    .eq("id", publicationId)
    .eq("user_id", principal.userId)
    .single();

  if (publicationError || !publication) {
    return errorResponse(404, "publication_not_found", "Publication not found", context.requestId);
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
    publicationId: publication.id,
    vaultPublicationId: null,
    fileId: file_id,
    webViewLink: web_view_link || null,
    sourceUrl: source_url || null,
  });

  return json(200, { data: result, meta: { request_id: context.requestId } });
}

async function handleCreatePdfDriveSession(supabase, principal, context, vaultId, itemId) {
  if (!canWriteWithPrincipal(principal)) {
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
    origin: context.origin,
  });

  if (!session) {
    return errorResponse(503, "drive_not_linked", "Google Drive is not linked for this account", context.requestId);
  }

  return json(200, { data: session, meta: { request_id: context.requestId } });
}

async function handleCompletePdfDriveUpload(supabase, principal, context, event, vaultId, itemId) {
  if (!canWriteWithPrincipal(principal)) {
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
  const updateRow = pickPublicationFieldsForUpdate(body);

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
    const rollupResult = await supabase.rpc("update_vault_publication_with_rollup", {
      p_vault_publication_id: itemId,
      p_vault_id: vaultId,
      p_patch: updateRow,
      p_actor_user_id: principal.userId,
    });

    if (rollupResult.error) {
      // P0002 is the SQL function's own not-found raise (its WHERE id/vault_id
      // matched nothing) — this can happen via a race even though we just
      // checked existence above (item deleted in between). Map it to the same
      // 404 the pre-check above would have returned, rather than the generic
      // 502 reserved for genuine rollup/infrastructure failures.
      if (rollupResult.error.code === "P0002") {
        return errorResponse(404, "item_not_found", "Vault item not found", context.requestId);
      }

      return errorResponse(
        502,
        "publication_rollup_failed",
        "Failed to apply the update across the canonical publication and its vault copies",
        context.requestId,
        { postgres_message: rollupResult.error.message },
      );
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

  const [enrichedItem] = await attachDrivePdfUrls(supabase, [refreshed.data], principal.userId);

  return json(200, {
    data: enrichedItem,
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

  const contents = await loadVaultContents(supabase, vaultId, principal.userId);
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
  const corsHeaders = getSafeCorsHeaders(event);
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

    const route = getRouteSegments(event.path || "/");
    if (isVaultItemPdfUploadRoute(route, event.httpMethod)) {
      const rawBodyRejection = rejectRawPdfBodyIfPresent(event, context);
      if (rawBodyRejection) {
        return withCors(rawBodyRejection, corsHeaders);
      }
    }

    const { maxBodyBytes } = getConfig();
    if (getRequestBodySize(event) > maxBodyBytes) {
      return withCors(
        errorResponse(413, "request_too_large", `Request body exceeds ${maxBodyBytes} bytes`, context.requestId),
        corsHeaders,
      );
    }

    if (route.length === 2 && route[0] === "google-drive" && route[1] === "callback" && event.httpMethod === "GET") {
      return withCors(await handleGoogleDriveCallback(context, event), corsHeaders);
    }

    const isManagementRoute =
      route[0] === "keys" ||
      isLegacySemanticScholarRoute(route) ||
      route[0] === "google-drive" ||
      route[0] === "publications" ||
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

      if (isLegacySemanticScholarRoute(route) && event.httpMethod === "POST") {
        response = await handleSemanticScholarRoute(context, event, principal, supabase, route[0]);
      } else if (route.length === 1 && route[0] === "keys" && event.httpMethod === "GET") {
        response = await handleListApiKeys(supabase, principal, context);
      } else if (route.length === 1 && route[0] === "keys" && event.httpMethod === "POST") {
        response = await handleCreateApiKey(supabase, principal, context, event);
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
      } else if (route.length === 6 && route[0] === "google-drive" && route[1] === "vaults" && route[3] === "items" && route[5] === "pdf" && event.httpMethod === "POST") {
        response = await handleUploadItemPdf(supabase, principal, context, event, route[2], route[4]);
      } else if (route.length === 7 && route[0] === "google-drive" && route[1] === "vaults" && route[3] === "items" && route[5] === "pdf" && route[6] === "session" && event.httpMethod === "POST") {
        response = await handleCreatePdfDriveSession(supabase, principal, context, route[2], route[4]);
      } else if (route.length === 7 && route[0] === "google-drive" && route[1] === "vaults" && route[3] === "items" && route[5] === "pdf" && route[6] === "complete" && event.httpMethod === "POST") {
        response = await handleCompletePdfDriveUpload(supabase, principal, context, event, route[2], route[4]);
      } else if (route.length === 4 && route[0] === "publications" && route[2] === "pdf" && route[3] === "session" && event.httpMethod === "POST") {
        response = await handleCreatePublicationPdfDriveSession(supabase, principal, context, route[1]);
      } else if (route.length === 4 && route[0] === "publications" && route[2] === "pdf" && route[3] === "complete" && event.httpMethod === "POST") {
        response = await handleCompletePublicationPdfDriveUpload(supabase, principal, context, event, route[1]);
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

      if (isApiKeySemanticScholarRoute(route) && event.httpMethod === "POST") {
        response = await handleSemanticScholarRoute(context, event, principal, supabase, route[1]);
      } else if (route.length === 1 && route[0] === "vaults" && event.httpMethod === "GET") {
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
      } else if (route.length === 4 && route[0] === "vaults" && route[2] === "items" && event.httpMethod === "GET") {
        response = await handleGetItem(supabase, principal, context, route[1], route[3]);
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
    const isExpectedSemanticScholarError = [
      "semantic_scholar_rate_limited",
      "semantic_scholar_error",
      "semantic_scholar_timeout",
      "semantic_scholar_unreachable",
    ].includes(error?.code);
    const logPayload = {
      requestId: context.requestId,
      path: context.path,
      method: context.method,
      code: error?.code,
      message: error?.message,
    };

    if (isExpectedSemanticScholarError) {
      console.warn("RefHub upstream Semantic Scholar error", logPayload);
    } else {
      console.error("Unhandled RefHub API error", logPayload);
    }

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
