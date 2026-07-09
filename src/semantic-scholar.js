const DEFAULT_PAPER_LIST_LIMIT = 10;
const MAX_PAPER_LIST_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const MIN_SEARCH_QUERY_LENGTH = 2;
const SEMANTIC_SCHOLAR_LOOKUP_FIELDS = ["paperId"];
const SEMANTIC_SCHOLAR_PAPER_FIELDS = [
  "paperId",
  "externalIds",
  "url",
  "title",
  "abstract",
  "year",
  "venue",
  "authors",
  "citationCount",
  "openAccessPdf",
];

// A single shared SEMANTIC_SCHOLAR_API_KEY sits behind every request this
// backend makes, regardless of which user triggered it, so the bucket has to
// be one global key rather than per-user -- see
// take_semantic_scholar_rate_limit (supabase/migrations) for why this lives
// in Postgres instead of an in-process counter.
const SEMANTIC_SCHOLAR_RATE_LIMIT_BUCKET_KEY = "global";

export async function takeSemanticScholarRateLimit(supabase, config) {
  const { data, error } = await supabase.rpc("take_semantic_scholar_rate_limit", {
    p_bucket_key: SEMANTIC_SCHOLAR_RATE_LIMIT_BUCKET_KEY,
    p_max_requests: config.semanticScholarRateLimitMaxRequests,
    p_window_ms: config.semanticScholarRateLimitWindowMs,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    retryAfterSeconds: row?.allowed ? null : row?.retry_after_seconds ?? null,
  };
}

function createSemanticScholarError(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function parseRetryAfterSeconds(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(0, Math.ceil(numeric));
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return null;
  }

  const diffMs = dateMs - Date.now();
  return diffMs > 0 ? Math.max(1, Math.ceil(diffMs / 1000)) : 0;
}

function getUpstreamErrorDetails(response) {
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  return retryAfterSeconds == null
    ? undefined
    : {
      retry_after_seconds: retryAfterSeconds,
    };
}

async function requestSemanticScholar(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw createSemanticScholarError(
        "semantic_scholar_timeout",
        "Semantic Scholar request timed out",
        504,
      );
    }

    throw createSemanticScholarError(
      "semantic_scholar_unreachable",
      "Semantic Scholar request could not be completed",
      502,
    );
  }
}

function assertSuccessfulSemanticScholarResponse(response, notFoundError) {
  if (response.status === 404) {
    if (notFoundError === null) {
      return false;
    }

    throw createSemanticScholarError(
      notFoundError.code,
      notFoundError.message,
      notFoundError.status,
      notFoundError.details,
    );
  }

  if (response.status === 429) {
    throw createSemanticScholarError(
      "semantic_scholar_rate_limited",
      "Semantic Scholar rate limit exceeded",
      429,
      getUpstreamErrorDetails(response),
    );
  }

  if (!response.ok) {
    throw createSemanticScholarError(
      "semantic_scholar_error",
      "Semantic Scholar request failed",
      502,
      {
        upstream_status: response.status,
      },
    );
  }

  return true;
}

function normalizeAuthor(author) {
  if (!author || typeof author !== "object") {
    return null;
  }

  return {
    author_id: author.authorId || null,
    name: author.name || null,
  };
}

function normalizePaper(paper) {
  return {
    paper_id: paper.paperId || null,
    external_ids: paper.externalIds || {},
    title: paper.title || null,
    abstract: paper.abstract || null,
    year: paper.year || null,
    venue: paper.venue || null,
    url: paper.url || null,
    citation_count: paper.citationCount ?? null,
    open_access_pdf_url: paper.openAccessPdf?.url || null,
    authors: Array.isArray(paper.authors) ? paper.authors.map(normalizeAuthor).filter(Boolean) : [],
  };
}

function limitNormalizedPapers(papers, limit) {
  return papers.slice(0, limit);
}

export function isRefHubApiKeyValue(value) {
  return typeof value === "string" && /^rhk_[^_]+_[^_]+$/.test(value.trim());
}

export function normalizePaperListRequest(body) {
  const seedPaperId = typeof body?.paper_id === "string" ? body.paper_id.trim() : "";
  if (!seedPaperId) {
    return {
      error: "invalid_paper_id",
      message: "Body must include a non-empty paper_id string",
    };
  }

  const rawLimit = body?.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return {
      value: {
        seedPaperId,
        limit: DEFAULT_PAPER_LIST_LIMIT,
      },
    };
  }

  if (!Number.isInteger(rawLimit)) {
    return {
      error: "invalid_limit",
      message: `limit must be an integer between 1 and ${MAX_PAPER_LIST_LIMIT}`,
    };
  }

  if (rawLimit < 1 || rawLimit > MAX_PAPER_LIST_LIMIT) {
    return {
      error: "invalid_limit",
      message: `limit must be an integer between 1 and ${MAX_PAPER_LIST_LIMIT}`,
    };
  }

  return {
    value: {
      seedPaperId,
      limit: rawLimit,
    },
  };
}

const MAX_RECOMMENDATION_SEED_IDS = 20;

// Semantic Scholar's recommendations endpoint already accepts multiple seed
// papers in one request (positivePaperIds is an array) and returns a single
// combined list -- so a vault's whole "find related papers" pass can be one
// upstream call instead of one per paper.
export function normalizeRecommendationsRequest(body) {
  const rawIds = Array.isArray(body?.paper_ids)
    ? body.paper_ids
    : typeof body?.paper_id === "string"
      ? [body.paper_id]
      : null;

  if (!rawIds) {
    return {
      error: "invalid_paper_id",
      message: "Body must include a non-empty paper_id string or paper_ids array",
    };
  }

  const seedPaperIds = [
    ...new Set(rawIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean)),
  ];

  if (seedPaperIds.length === 0) {
    return {
      error: "invalid_paper_id",
      message: "Body must include a non-empty paper_id string or paper_ids array",
    };
  }

  if (seedPaperIds.length > MAX_RECOMMENDATION_SEED_IDS) {
    return {
      error: "invalid_paper_id",
      message: `paper_ids must contain at most ${MAX_RECOMMENDATION_SEED_IDS} entries`,
    };
  }

  const rawLimit = body?.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return { value: { seedPaperIds, limit: DEFAULT_PAPER_LIST_LIMIT } };
  }

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAPER_LIST_LIMIT) {
    return {
      error: "invalid_limit",
      message: `limit must be an integer between 1 and ${MAX_PAPER_LIST_LIMIT}`,
    };
  }

  return { value: { seedPaperIds, limit: rawLimit } };
}

export function normalizePaperLookupRequest(body) {
  const doi = typeof body?.doi === "string" ? body.doi.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";

  if (doi && title) {
    return {
      error: "invalid_lookup_request",
      message: "Provide exactly one of doi or title",
    };
  }

  if (doi) {
    return {
      value: {
        queryType: "doi",
        queryValue: doi,
      },
    };
  }

  if (title) {
    return {
      value: {
        queryType: "title",
        queryValue: title,
      },
    };
  }

  return {
    error: "invalid_lookup_request",
    message: "Body must include a non-empty doi or title string",
  };
}

export function normalizeSemanticScholarDoiRequest(body) {
  const doi = typeof body?.doi === "string" ? body.doi.trim() : "";

  if (!doi) {
    return {
      error: "invalid_doi",
      message: "Body must include a non-empty doi string",
    };
  }

  return {
    value: { doi },
  };
}

export function normalizeSemanticScholarSearchRequest(body) {
  const query = typeof body?.query === "string" ? body.query.trim() : "";

  if (query.length < MIN_SEARCH_QUERY_LENGTH) {
    return {
      error: "invalid_query",
      message: `Body must include a query string with at least ${MIN_SEARCH_QUERY_LENGTH} characters`,
    };
  }

  const rawLimit = body?.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return {
      value: {
        query,
        limit: DEFAULT_SEARCH_LIMIT,
      },
    };
  }

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_SEARCH_LIMIT) {
    return {
      error: "invalid_limit",
      message: `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
    };
  }

  return {
    value: {
      query,
      limit: rawLimit,
    },
  };
}

async function fetchSemanticScholarPaperList({
  apiKey,
  seedPaperId,
  limit,
  signal,
  url,
  responseItemsPath,
  paperKey,
}) {
  url.searchParams.set("fields", SEMANTIC_SCHOLAR_PAPER_FIELDS.join(","));
  url.searchParams.set("limit", String(limit));

  const headers = {
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await requestSemanticScholar(url, {
    method: "GET",
    headers,
    signal,
  });
  assertSuccessfulSemanticScholarResponse(response, {
    code: "paper_not_found",
    message: "Semantic Scholar seed paper was not found",
    status: 404,
    details: { paper_id: seedPaperId },
  });

  const payload = await response.json();
  const responseItems = responseItemsPath.reduce((value, key) => value?.[key], payload);
  const items = Array.isArray(responseItems) ? responseItems : [];

  return limitNormalizedPapers(
    items
    .map((item) => item?.[paperKey])
    .filter((paper) => paper && typeof paper === "object")
    .map(normalizePaper),
    limit,
  );
}

export async function fetchSemanticScholarRecommendations({ apiKey, seedPaperIds, limit, signal }) {
  const url = new URL("https://api.semanticscholar.org/recommendations/v1/papers");
  url.searchParams.set("fields", SEMANTIC_SCHOLAR_PAPER_FIELDS.join(","));

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await requestSemanticScholar(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      positivePaperIds: seedPaperIds,
      negativePaperIds: [],
    }),
    signal,
  });
  assertSuccessfulSemanticScholarResponse(response, {
    code: "paper_not_found",
    message: "Semantic Scholar seed paper was not found",
    status: 404,
    details: { paper_ids: seedPaperIds },
  });

  const payload = await response.json();
  const recommendedPapers = Array.isArray(payload?.recommendedPapers) ? payload.recommendedPapers : [];

  return limitNormalizedPapers(recommendedPapers.map(normalizePaper), limit);
}

export async function fetchSemanticScholarReferences({ apiKey, seedPaperId, limit, signal }) {
  const encodedPaperId = encodeURIComponent(seedPaperId);
  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodedPaperId}/references`);

  return fetchSemanticScholarPaperList({
    apiKey,
    seedPaperId,
    limit,
    signal,
    url,
    responseItemsPath: ["data"],
    paperKey: "citedPaper",
  });
}

export async function fetchSemanticScholarCitations({ apiKey, seedPaperId, limit, signal }) {
  const encodedPaperId = encodeURIComponent(seedPaperId);
  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodedPaperId}/citations`);

  return fetchSemanticScholarPaperList({
    apiKey,
    seedPaperId,
    limit,
    signal,
    url,
    responseItemsPath: ["data"],
    paperKey: "citingPaper",
  });
}

export async function fetchSemanticScholarPaperLookup({ apiKey, queryType, queryValue, signal }) {
  const headers = {
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const url =
    queryType === "doi"
      ? new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(queryValue)}`)
      : new URL("https://api.semanticscholar.org/graph/v1/paper/search");

  url.searchParams.set("fields", SEMANTIC_SCHOLAR_LOOKUP_FIELDS.join(","));
  if (queryType === "title") {
    url.searchParams.set("query", queryValue);
    url.searchParams.set("limit", "1");
  }

  const response = await requestSemanticScholar(url, {
    method: "GET",
    headers,
    signal,
  });

  if (response.status === 404 && queryType === "doi") {
    return null;
  }

  assertSuccessfulSemanticScholarResponse(response, {
    code: "paper_not_found",
    message: "Semantic Scholar paper was not found",
    status: 404,
  });

  const payload = await response.json();
  const paperId =
    queryType === "doi"
      ? payload?.paperId
      : Array.isArray(payload?.data)
        ? payload.data[0]?.paperId
        : null;

  return typeof paperId === "string" && paperId.trim() ? paperId : null;
}

export async function fetchSemanticScholarSearch({ apiKey, query, limit, signal }) {
  const headers = {
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search/bulk");
  url.searchParams.set("query", query);
  url.searchParams.set("fields", SEMANTIC_SCHOLAR_PAPER_FIELDS.join(","));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "citationCount:desc");

  const response = await requestSemanticScholar(url, {
    method: "GET",
    headers,
    signal,
  });
  assertSuccessfulSemanticScholarResponse(response, {
    code: "semantic_scholar_search_failed",
    message: "Semantic Scholar search failed",
    status: 502,
  });

  const payload = await response.json();
  const papers = Array.isArray(payload?.data) ? payload.data : [];
  return limitNormalizedPapers(papers.map(normalizePaper), limit);
}

export async function fetchSemanticScholarDoiMetadata({ apiKey, doi, signal }) {
  const headers = {
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}`);
  url.searchParams.set(
    "fields",
    ["title", "authors", "year", "venue", "publicationVenue", "abstract", "externalIds", "publicationTypes"].join(","),
  );

  const response = await requestSemanticScholar(url, {
    method: "GET",
    headers,
    signal,
  });

  if (response.status === 404) {
    return null;
  }

  assertSuccessfulSemanticScholarResponse(response, {
    code: "paper_not_found",
    message: "Semantic Scholar paper was not found",
    status: 404,
  });

  const work = await response.json();
  const authors = Array.isArray(work?.authors)
    ? work.authors.map((author) => author?.name || "Unknown Author")
    : [];

  let publicationType = "article";
  const types = Array.isArray(work?.publicationTypes) ? work.publicationTypes : [];
  if (types.includes("Book") || types.includes("BookSection")) {
    publicationType = "book";
  } else if (types.includes("Conference")) {
    publicationType = "inproceedings";
  } else if (types.includes("Dissertation")) {
    publicationType = "thesis";
  } else if (types.includes("Report")) {
    publicationType = "report";
  }

  return {
    title: work?.title || "Untitled",
    authors,
    year: work?.year || undefined,
    journal: work?.venue || work?.publicationVenue?.name || undefined,
    doi,
    url: `https://doi.org/${doi}`,
    abstract: work?.abstract || undefined,
    type: publicationType,
  };
}
