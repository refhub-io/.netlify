const DEFAULT_PAPER_LIST_LIMIT = 10;
const MAX_PAPER_LIST_LIMIT = 25;
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

function createSemanticScholarError(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
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

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal,
    });
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

  if (response.status === 404) {
    throw createSemanticScholarError(
      "paper_not_found",
      "Semantic Scholar seed paper was not found",
      404,
      { paper_id: seedPaperId },
    );
  }

  if (response.status === 429) {
    throw createSemanticScholarError(
      "semantic_scholar_rate_limited",
      "Semantic Scholar rate limit exceeded",
      503,
    );
  }

  if (!response.ok) {
    throw createSemanticScholarError(
      "semantic_scholar_error",
      "Semantic Scholar request failed",
      502,
      { upstream_status: response.status },
    );
  }

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

export async function fetchSemanticScholarRecommendations({ apiKey, seedPaperId, limit, signal }) {
  const url = new URL("https://api.semanticscholar.org/recommendations/v1/papers");

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        positivePaperIds: [seedPaperId],
        negativePaperIds: [],
      }),
      signal,
    });
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

  if (response.status === 404) {
    throw createSemanticScholarError(
      "paper_not_found",
      "Semantic Scholar seed paper was not found",
      404,
      { paper_id: seedPaperId },
    );
  }

  if (response.status === 429) {
    throw createSemanticScholarError(
      "semantic_scholar_rate_limited",
      "Semantic Scholar rate limit exceeded",
      503,
    );
  }

  if (!response.ok) {
    throw createSemanticScholarError(
      "semantic_scholar_error",
      "Semantic Scholar request failed",
      502,
      { upstream_status: response.status },
    );
  }

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
