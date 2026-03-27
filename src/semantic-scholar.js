const DEFAULT_PAPER_LIST_LIMIT = 10;
const MAX_PAPER_LIST_LIMIT = 25;
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

  if (response.status === 404 && queryType === "doi") {
    return null;
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
  const paperId =
    queryType === "doi"
      ? payload?.paperId
      : Array.isArray(payload?.data)
        ? payload.data[0]?.paperId
        : null;

  return typeof paperId === "string" && paperId.trim() ? paperId : null;
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
    return null;
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
