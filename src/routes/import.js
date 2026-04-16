/**
 * V2 import route handlers.
 *
 * Covered endpoints:
 *   POST /api/v1/vaults/:vaultId/import/doi      handleImportDoi
 *   POST /api/v1/vaults/:vaultId/import/bibtex   handleImportBibtex
 *   POST /api/v1/vaults/:vaultId/import/url      handleImportUrl
 *
 * DOI resolution: CrossRef first, OpenAlex fallback (no Semantic Scholar
 * proxy — that would be circular from the backend).
 */

import { API_SCOPES, requireScope, resolveVaultAccess } from "../auth.js";
import { json, errorResponse, parseJsonBody } from "../http.js";
import { getConfig } from "../config.js";
import { parseBibtex } from "../bibtex.js";
import { VAULT_PUBLICATION_SELECT, touchVaultUpdatedAt } from "./utils.js";

// ---------------------------------------------------------------------------
// DOI metadata fetchers
// ---------------------------------------------------------------------------

function cleanDoi(doi) {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "");
}

async function fetchFromCrossRef(doi) {
  try {
    const resp = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const { message: w } = await resp.json();

    const authors = (w.author || []).map((a) =>
      a.given && a.family ? `${a.given} ${a.family}` : a.name || "Unknown Author",
    );

    let year;
    if (w["published-print"]?.["date-parts"]?.[0]?.[0]) year = w["published-print"]["date-parts"][0][0];
    else if (w["published-online"]?.["date-parts"]?.[0]?.[0]) year = w["published-online"]["date-parts"][0][0];
    else if (w["created"]?.["date-parts"]?.[0]?.[0]) year = w["created"]["date-parts"][0][0];

    let type = "article";
    if (w.type === "book" || w.type === "book-chapter") type = "book";
    else if (w.type === "proceedings-article") type = "inproceedings";
    else if (w.type === "dissertation") type = "thesis";
    else if (w.type === "report") type = "report";

    return {
      title: Array.isArray(w.title) ? w.title[0] : w.title || "Untitled",
      authors,
      year,
      journal: w["container-title"]?.[0] || null,
      volume: w.volume || null,
      issue: w.issue || null,
      pages: w.page || null,
      url: w.URL || `https://doi.org/${doi}`,
      abstract: w.abstract?.replace(/<[^>]*>/g, "") || null,
      type,
    };
  } catch {
    return null;
  }
}

function reconstructAbstract(invertedIndex) {
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(" ");
}

async function fetchFromOpenAlex(doi) {
  try {
    const resp = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const w = await resp.json();

    const authors = (w.authorships || []).map((a) => a.author?.display_name || "Unknown Author");
    const biblio = w.biblio || {};
    const pages =
      biblio.first_page && biblio.last_page
        ? `${biblio.first_page}-${biblio.last_page}`
        : biblio.first_page || null;

    return {
      title: w.title || "Untitled",
      authors,
      year: w.publication_year || null,
      journal: w.primary_location?.source?.display_name || null,
      volume: biblio.volume || null,
      issue: biblio.issue || null,
      pages,
      url: `https://doi.org/${doi}`,
      abstract: w.abstract_inverted_index ? reconstructAbstract(w.abstract_inverted_index) : null,
      type: "article",
    };
  } catch {
    return null;
  }
}

async function resolveDoiMetadata(doi) {
  const crossRef = await fetchFromCrossRef(doi);
  if (crossRef) return crossRef;
  return fetchFromOpenAlex(doi);
}

// ---------------------------------------------------------------------------
// Shared insert helper
// ---------------------------------------------------------------------------

async function insertVaultPublication(supabase, principal, vaultId, pubData) {
  const pubRow = {
    user_id: principal.userId,
    title: pubData.title,
    authors: pubData.authors || [],
    year: pubData.year || null,
    journal: pubData.journal || null,
    volume: pubData.volume || null,
    issue: pubData.issue || null,
    pages: pubData.pages || null,
    doi: pubData.doi || null,
    url: pubData.url || null,
    abstract: pubData.abstract || null,
    bibtex_key: pubData.bibtex_key || null,
    publication_type: pubData.publication_type || pubData.type || "article",
    keywords: pubData.keywords || [],
    editor: pubData.editor || [],
    booktitle: pubData.booktitle || null,
    chapter: pubData.chapter || null,
    edition: pubData.edition || null,
    howpublished: pubData.howpublished || null,
    institution: pubData.institution || null,
    number: pubData.number || null,
    organization: pubData.organization || null,
    publisher: pubData.publisher || null,
    school: pubData.school || null,
    series: pubData.series || null,
    type: pubData.type || null,
    eid: pubData.eid || null,
    isbn: pubData.isbn || null,
    issn: pubData.issn || null,
  };

  const { data: pub, error: pubError } = await supabase
    .from("publications")
    .insert(pubRow)
    .select("id")
    .single();

  if (pubError) throw pubError;

  // Build the vault_publications row without user_id (that column belongs to
  // the publications table only; vault_publications uses created_by instead).
  const { user_id: _omit, ...pubFields } = pubRow;
  const { data: vaultPub, error: vaultPubError } = await supabase
    .from("vault_publications")
    .insert({
      vault_id: vaultId,
      original_publication_id: pub.id,
      created_by: principal.userId,
      version: 1,
      ...pubFields,
    })
    .select(VAULT_PUBLICATION_SELECT)
    .single();

  if (vaultPubError) throw vaultPubError;

  return vaultPub;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleImportDoi(supabase, principal, context, vaultId, event) {
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
  if (!body.doi || typeof body.doi !== "string") {
    return errorResponse(400, "invalid_body", "Body must include a doi string", context.requestId);
  }

  const doi = cleanDoi(body.doi);
  const metadata = await resolveDoiMetadata(doi);

  if (!metadata) {
    return errorResponse(404, "doi_not_found", `DOI ${doi} could not be resolved`, context.requestId);
  }

  metadata.doi = doi;
  const vaultPub = await insertVaultPublication(supabase, principal, vaultId, metadata);

  await touchVaultUpdatedAt(supabase, vaultId);

  return json(201, {
    data: vaultPub,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleImportBibtex(supabase, principal, context, vaultId, event) {
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
  if (!body.content || typeof body.content !== "string") {
    return errorResponse(400, "invalid_body", "Body must include a content string with BibTeX", context.requestId);
  }

  const { maxBulkItems } = getConfig();
  const entries = parseBibtex(body.content);

  if (entries.length === 0) {
    return errorResponse(400, "invalid_bibtex", "No valid BibTeX entries found", context.requestId);
  }
  if (entries.length > maxBulkItems) {
    return errorResponse(
      400,
      "too_many_items",
      `BibTeX file contains ${entries.length} entries; maximum is ${maxBulkItems}`,
      context.requestId,
    );
  }

  const created = [];
  const errors = [];

  for (const item of entries) {
    if (!item.title) {
      errors.push({ title: null, error: "Missing title" });
      continue;
    }
    try {
      const vaultPub = await insertVaultPublication(supabase, principal, vaultId, item);
      created.push(vaultPub);
    } catch (err) {
      errors.push({ title: item.title, error: err.message });
    }
  }

  if (created.length > 0) {
    await touchVaultUpdatedAt(supabase, vaultId);
  }

  return json(201, {
    data: { created, errors },
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}

export async function handleImportUrl(supabase, principal, context, vaultId, event) {
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
  if (!body.url || typeof body.url !== "string") {
    return errorResponse(400, "invalid_body", "Body must include a url string", context.requestId);
  }

  let urlObj;
  try {
    urlObj = new URL(body.url);
  } catch {
    return errorResponse(400, "invalid_body", "url must be a valid URL", context.requestId);
  }

  const pubData = {
    title: body.title || urlObj.hostname,
    authors: [],
    url: body.url,
    publication_type: "misc",
    keywords: [],
    editor: [],
  };

  const vaultPub = await insertVaultPublication(supabase, principal, vaultId, pubData);
  await touchVaultUpdatedAt(supabase, vaultId);

  return json(201, {
    data: vaultPub,
    meta: { request_id: context.requestId, vault_id: vaultId },
  });
}
