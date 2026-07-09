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

function assertSuccessfulOpenAlexResponse(response, notFoundError) {
  if (response.status === 404 && notFoundError) {
    throw createOpenAlexError(
      notFoundError.code,
      notFoundError.message,
      notFoundError.status,
      notFoundError.details,
    );
  }

  if (!response.ok) {
    throw createOpenAlexError("openalex_error", "OpenAlex request failed", 502, {
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
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await response.json();
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
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await workResponse.json();
  const referencedIds = Array.isArray(work.referenced_works)
    ? work.referenced_works.slice(0, limit).map(stripOpenAlexIdPrefix)
    : [];

  if (referencedIds.length === 0) {
    return [];
  }

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
    code: "openalex_error",
    message: "OpenAlex reference lookup failed",
    status: 502,
  });

  const payload = await listResponse.json();
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
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await workResponse.json();
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
    code: "openalex_error",
    message: "OpenAlex citation lookup failed",
    status: 502,
  });

  const payload = await listResponse.json();
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
    code: "openalex_error",
    message: "OpenAlex search failed",
    status: 502,
  });

  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork);
}

export const OPENALEX_SEARCH_COST_USD = 0.001;

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
