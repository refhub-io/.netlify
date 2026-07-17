const OPENALEX_BASE_URL = "https://api.openalex.org";

const OPENALEX_HYDRATE_FIELDS = [
  "id",
  "doi",
  "title",
  "publication_year",
  "primary_location",
  "cited_by_count",
  "open_access",
  "best_oa_location",
  "authorships",
  "abstract_inverted_index",
];

export function reconstructAbstractFromInvertedIndex(invertedIndex) {
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(" ");
}

function createOpenAlexError(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

async function requestOpenAlex(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw createOpenAlexError("openalex_timeout", "OpenAlex request timed out", 504);
    }

    throw createOpenAlexError("openalex_unreachable", "OpenAlex request could not be completed", 502);
  }
}

async function parseOpenAlexJson(response) {
  try {
    return await response.json();
  } catch {
    // A JSON.parse failure here (e.g. malformed/truncated body) has no
    // openalex_* code, so isOpenAlexFallbackEligible would treat it as
    // ineligible and skip the Semantic Scholar fallback entirely. Wrap it so
    // fallback keeps working even when OpenAlex returns a broken body.
    throw createOpenAlexError("openalex_error", "OpenAlex response could not be parsed", 502);
  }
}

function assertSuccessfulOpenAlexResponse(response, { notFoundError, requestError } = {}) {
  if (response.status === 404 && notFoundError) {
    throw createOpenAlexError(
      notFoundError.code,
      notFoundError.message,
      notFoundError.status,
      notFoundError.details,
    );
  }

  if (!response.ok) {
    const override = requestError || {
      code: "openalex_error",
      message: "OpenAlex request failed",
      status: 502,
    };
    throw createOpenAlexError(override.code, override.message, override.status, {
      upstream_status: response.status,
    });
  }

  return true;
}

function withApiKey(url, apiKey) {
  if (apiKey) {
    url.searchParams.set("api_key", apiKey);
  }
  return url;
}

function stripOpenAlexIdPrefix(id) {
  return typeof id === "string" ? id.replace(/^https:\/\/openalex\.org\//, "") : id;
}

function stripDoiUrlPrefix(doi) {
  return typeof doi === "string" ? doi.replace(/^https?:\/\/doi\.org\//i, "") : doi;
}

function classifyOpenAlexType(type) {
  if (type === "book" || type === "book-chapter" || type === "book-section") return "book";
  if (type === "conference-paper" || type === "conference-abstract") return "inproceedings";
  if (type === "dissertation") return "thesis";
  if (type === "report") return "report";
  return "article";
}

function normalizeAuthorship(authorship) {
  const author = authorship?.author;
  if (!author?.display_name) return null;
  return { author_id: stripOpenAlexIdPrefix(author.id) || null, name: author.display_name };
}

export function normalizePaperFromWork(work) {
  return {
    paper_id: stripOpenAlexIdPrefix(work.id) || null,
    external_ids: { DOI: stripDoiUrlPrefix(work.doi) || undefined },
    title: work.title || null,
    abstract: work.abstract_inverted_index
      ? reconstructAbstractFromInvertedIndex(work.abstract_inverted_index)
      : null,
    year: work.publication_year || null,
    venue: work.primary_location?.source?.display_name || null,
    url: work.doi || work.id || null,
    citation_count: work.cited_by_count ?? null,
    open_access_pdf_url: work.open_access?.oa_url || work.best_oa_location?.pdf_url || null,
    authors: Array.isArray(work.authorships)
      ? work.authorships.map(normalizeAuthorship).filter(Boolean)
      : [],
  };
}

export async function fetchOpenAlexDoiMetadata({ apiKey, doi, signal }) {
  const url = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);

  const response = await requestOpenAlex(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(response, {
    notFoundError: { code: "openalex_not_found", message: "OpenAlex work was not found", status: 404 },
  });

  const work = await parseOpenAlexJson(response);
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map((a) => a.author?.display_name || "Unknown Author")
    : [];

  return {
    title: work.title || "Untitled",
    authors,
    year: work.publication_year || undefined,
    journal: work.primary_location?.source?.display_name || undefined,
    doi,
    url: `https://doi.org/${doi}`,
    abstract: work.abstract_inverted_index
      ? reconstructAbstractFromInvertedIndex(work.abstract_inverted_index)
      : undefined,
    type: classifyOpenAlexType(work.type),
  };
}

export async function fetchOpenAlexReferences({ apiKey, doi, limit, signal }) {
  const workUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);
  const workResponse = await requestOpenAlex(workUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(workResponse, {
    notFoundError: { code: "openalex_not_found", message: "OpenAlex work was not found", status: 404 },
  });

  const work = await parseOpenAlexJson(workResponse);
  const referencedIds = Array.isArray(work.referenced_works)
    ? work.referenced_works.slice(0, limit).map(stripOpenAlexIdPrefix)
    : [];

  if (referencedIds.length === 0) {
    return [];
  }

  // OR-filter values aren't chunked here because referencedIds.length is
  // bounded by `limit`, which callers cap at MAX_PAPER_LIST_LIMIT (25, see
  // src/semantic-scholar.js) -- well under OpenAlex's 100-value OR-filter
  // cap. If MAX_PAPER_LIST_LIMIT is ever raised past 100, this needs chunking.
  const listUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  listUrl.searchParams.set("filter", `openalex_id:${referencedIds.join("|")}`);
  listUrl.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  listUrl.searchParams.set("per-page", String(referencedIds.length));

  const listResponse = await requestOpenAlex(listUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(listResponse, {
    requestError: { code: "openalex_error", message: "OpenAlex reference lookup failed", status: 502 },
  });

  const payload = await parseOpenAlexJson(listResponse);
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork).slice(0, limit);
}

export async function fetchOpenAlexCitations({ apiKey, doi, limit, signal }) {
  const workUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);
  const workResponse = await requestOpenAlex(workUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(workResponse, {
    notFoundError: { code: "openalex_not_found", message: "OpenAlex work was not found", status: 404 },
  });

  const work = await parseOpenAlexJson(workResponse);
  const workId = stripOpenAlexIdPrefix(work.id);

  const listUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  listUrl.searchParams.set("filter", `cites:${workId}`);
  listUrl.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  listUrl.searchParams.set("per-page", String(limit));

  const listResponse = await requestOpenAlex(listUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(listResponse, {
    requestError: { code: "openalex_error", message: "OpenAlex citation lookup failed", status: 502 },
  });

  const payload = await parseOpenAlexJson(listResponse);
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork);
}

export const OPENALEX_CITATIONS_COST_USD = 0.0001;

export async function fetchOpenAlexSearch({ apiKey, query, limit, signal }) {
  const url = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  url.searchParams.set("search", query);
  url.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  url.searchParams.set("per-page", String(limit));

  const response = await requestOpenAlex(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(response, {
    requestError: { code: "openalex_error", message: "OpenAlex search failed", status: 502 },
  });

  const payload = await parseOpenAlexJson(response);
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork);
}

export const OPENALEX_SEARCH_COST_USD = 0.001;

// Resolves the DOI-addressable id a title search points at, for use as an
// OpenAlex-first replacement of Semantic Scholar's title-lookup route. Only
// the DOI is useful here (not the full normalized paper) because downstream
// routes (references/citations/recommendations) key off the DOI: pseudo-id
// convention shared by both providers -- see the doiMatch regex in
// functions/api-v1.js.
export async function fetchOpenAlexPaperIdByTitle({ apiKey, title, signal }) {
  const results = await fetchOpenAlexSearch({ apiKey, query: title, limit: 1, signal });
  const doi = results[0]?.external_ids?.DOI;

  if (!doi) {
    throw createOpenAlexError(
      "openalex_not_found",
      "OpenAlex found no DOI-addressable match for the given title",
      404,
    );
  }

  return `DOI:${doi}`;
}

const MAX_RELATED_WORKS_OR_FILTER = 100;

export const OPENALEX_RECOMMENDATIONS_COST_USD = 0.0005;

// OpenAlex has no Semantic-Scholar-style "recommendations" endpoint, so this
// approximates it with each seed's own `related_works` (a list of OpenAlex
// work ids OpenAlex itself considers related), unioned and deduplicated
// across every seed, then hydrated in one batched list request -- the same
// shape fetchOpenAlexReferences/fetchOpenAlexCitations already use.
export async function fetchOpenAlexRecommendationsForSet({ apiKey, dois, limit, signal }) {
  const outcomes = await Promise.all(
    dois.map(async (doi) => {
      try {
        const workUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);
        const workResponse = await requestOpenAlex(workUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          signal,
        });
        assertSuccessfulOpenAlexResponse(workResponse, {
          notFoundError: { code: "openalex_not_found", message: "OpenAlex work was not found", status: 404 },
        });

        const work = await parseOpenAlexJson(workResponse);
        const relatedIds = Array.isArray(work.related_works) ? work.related_works.map(stripOpenAlexIdPrefix) : [];
        return { ok: true, relatedIds };
      } catch {
        return { ok: false, relatedIds: [] };
      }
    }),
  );

  // Only bail out (letting the caller fall back to Semantic Scholar for the
  // whole batch) when every seed lookup failed outright. If some seeds
  // resolved -- even to zero related works each -- that's OpenAlex's real
  // answer, not a failure, so it returns normally (possibly empty).
  if (outcomes.every((outcome) => !outcome.ok)) {
    throw createOpenAlexError("openalex_error", "OpenAlex could not resolve any of the given seeds", 502);
  }

  const relatedIds = [...new Set(outcomes.flatMap((outcome) => outcome.relatedIds))].slice(
    0,
    MAX_RELATED_WORKS_OR_FILTER,
  );

  if (relatedIds.length === 0) {
    return [];
  }

  const listUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  listUrl.searchParams.set("filter", `openalex_id:${relatedIds.join("|")}`);
  listUrl.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  listUrl.searchParams.set("per-page", String(relatedIds.length));

  const listResponse = await requestOpenAlex(listUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(listResponse, {
    requestError: { code: "openalex_error", message: "OpenAlex related-works lookup failed", status: 502 },
  });

  const payload = await parseOpenAlexJson(listResponse);
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork).slice(0, limit);
}

const OPENALEX_BUDGET_BUCKET_KEY = "global";

export async function takeOpenAlexBudget(supabase, config, costUsd) {
  const { data, error } = await supabase.rpc("take_openalex_budget", {
    p_bucket_key: OPENALEX_BUDGET_BUCKET_KEY,
    p_cost_usd: costUsd,
    p_daily_budget_usd: config.openalexDailyBudgetUsd,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    spentUsd: row?.spent_usd ?? null,
  };
}
