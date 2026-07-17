import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
    authenticateManagementUser: vi.fn(),
  };
});

vi.mock("../src/semantic-scholar.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSemanticScholarDoiMetadata: vi.fn(),
    fetchSemanticScholarSearch: vi.fn(),
    fetchSemanticScholarReferences: vi.fn(),
    fetchSemanticScholarCitations: vi.fn(),
    fetchSemanticScholarRecommendations: vi.fn(),
    fetchSemanticScholarPaperLookup: vi.fn(),
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
    fetchOpenAlexSearch: vi.fn(),
    fetchOpenAlexReferences: vi.fn(),
    fetchOpenAlexCitations: vi.fn(),
    fetchOpenAlexRecommendationsForSet: vi.fn(),
    fetchOpenAlexPaperIdByTitle: vi.fn(),
    takeOpenAlexBudget: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import {
  fetchSemanticScholarDoiMetadata,
  fetchSemanticScholarSearch,
  fetchSemanticScholarReferences,
  fetchSemanticScholarCitations,
  fetchSemanticScholarRecommendations,
  fetchSemanticScholarPaperLookup,
} from "../src/semantic-scholar.js";
import {
  fetchOpenAlexDoiMetadata,
  fetchOpenAlexSearch,
  fetchOpenAlexReferences,
  fetchOpenAlexCitations,
  fetchOpenAlexRecommendationsForSet,
  fetchOpenAlexPaperIdByTitle,
  takeOpenAlexBudget,
} from "../src/openalex.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeMockSupabase } from "./helpers.js";

function makeEvent(path, body) {
  return {
    httpMethod: "POST",
    path,
    headers: { authorization: "Bearer rhk_test_secret" },
    queryStringParameters: null,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("doi-metadata route: OpenAlex primary, Semantic Scholar fallback", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.SEMANTIC_SCHOLAR_API_KEY = "ss-test";
    process.env.OPENALEX_API_KEY = "oa-test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    vi.mocked(authenticateManagementUser).mockReset();
    vi.mocked(authenticateApiKey).mockReset();
    vi.mocked(fetchSemanticScholarDoiMetadata).mockReset();
    vi.mocked(fetchOpenAlexDoiMetadata).mockReset();
    vi.mocked(fetchSemanticScholarSearch).mockReset();
    vi.mocked(fetchOpenAlexSearch).mockReset();
    vi.mocked(takeOpenAlexBudget).mockReset();
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: true, spentUsd: 0.001 });

    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase(),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:read"] }),
    });
  });

  it("reports the true originating provider on a cache hit, not \"cache\"", async () => {
    vi.mocked(fetchOpenAlexDoiMetadata).mockResolvedValue({
      title: "OpenAlex Cached Paper",
      authors: ["A"],
      doi: "10.1/cache-hit",
      url: "https://doi.org/10.1/cache-hit",
      type: "article",
    });

    const first = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/cache-hit" }));
    const second = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/cache-hit" }));

    expect(JSON.parse(first.body).meta.provider).toBe("openalex");
    expect(JSON.parse(second.body).meta.provider).toBe("openalex");
    expect(fetchOpenAlexDoiMetadata).toHaveBeenCalledTimes(1);
  });

  it("reports the true provider for a request that joins an in-flight fetch, not \"cache\"", async () => {
    let resolveFetch;
    vi.mocked(fetchOpenAlexDoiMetadata).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve({
              title: "OpenAlex In-Flight Paper",
              authors: ["A"],
              doi: "10.1/in-flight",
              url: "https://doi.org/10.1/in-flight",
              type: "article",
            });
        }),
    );

    const firstPromise = handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/in-flight" }));
    // Let the first request register its in-flight promise in the cache before the second joins it.
    await new Promise((resolve) => setImmediate(resolve));
    const secondPromise = handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/in-flight" }));

    resolveFetch();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(JSON.parse(first.body).meta.provider).toBe("openalex");
    expect(JSON.parse(second.body).meta.provider).toBe("openalex");
    expect(fetchOpenAlexDoiMetadata).toHaveBeenCalledTimes(1);
  });

  it("uses OpenAlex when it succeeds, never calling Semantic Scholar", async () => {
    vi.mocked(fetchOpenAlexDoiMetadata).mockResolvedValue({
      title: "OpenAlex Paper",
      authors: ["A"],
      doi: "10.1/x",
      url: "https://doi.org/10.1/x",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/x" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.title).toBe("OpenAlex Paper");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchSemanticScholarDoiMetadata).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar when OpenAlex fails", async () => {
    vi.mocked(fetchOpenAlexDoiMetadata).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "openalex_not_found" }),
    );
    vi.mocked(fetchSemanticScholarDoiMetadata).mockResolvedValue({
      title: "SS Paper",
      authors: ["B"],
      doi: "10.1/y",
      url: "https://doi.org/10.1/y",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/y" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.title).toBe("SS Paper");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexDoiMetadata).toHaveBeenCalledTimes(1);
    expect(fetchSemanticScholarDoiMetadata).toHaveBeenCalledTimes(1);
  });

  it("skips OpenAlex entirely when OPENALEX_API_KEY is unset", async () => {
    delete process.env.OPENALEX_API_KEY;
    vi.mocked(fetchSemanticScholarDoiMetadata).mockResolvedValue({
      title: "SS Only",
      authors: [],
      doi: "10.1/z",
      url: "https://doi.org/10.1/z",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/z" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexDoiMetadata).not.toHaveBeenCalled();
    expect(fetchSemanticScholarDoiMetadata).toHaveBeenCalledTimes(1);
  });

  it("serves via OpenAlex when SEMANTIC_SCHOLAR_API_KEY is unset", async () => {
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    vi.mocked(fetchOpenAlexDoiMetadata).mockResolvedValue({
      title: "OpenAlex Only",
      authors: ["A"],
      doi: "10.1/oa-only",
      url: "https://doi.org/10.1/oa-only",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/oa-only" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.title).toBe("OpenAlex Only");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchSemanticScholarDoiMetadata).not.toHaveBeenCalled();
  });

  it("returns 503 semantic_scholar_disabled when neither provider is configured", async () => {
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    delete process.env.OPENALEX_API_KEY;

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/none" }));

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("semantic_scholar_disabled");
    expect(fetchOpenAlexDoiMetadata).not.toHaveBeenCalled();
    expect(fetchSemanticScholarDoiMetadata).not.toHaveBeenCalled();
  });
});

describe("search route: OpenAlex primary (budget-gated), Semantic Scholar fallback", () => {
  // The doi-metadata describe's last test deletes OPENALEX_API_KEY from
  // process.env without restoring it, which otherwise leaks into these
  // tests since there is no per-file env reset. Restore it here so these
  // tests are not order-dependent on the other describe block. Mocks are
  // also reset per-test here since this describe has no beforeEach of its
  // own in the plan and mock call history/return values would otherwise
  // leak between the three `it()` blocks below.
  beforeEach(() => {
    process.env.OPENALEX_API_KEY = "oa-test";
    vi.mocked(fetchSemanticScholarSearch).mockReset();
    vi.mocked(fetchOpenAlexSearch).mockReset();
    vi.mocked(takeOpenAlexBudget).mockReset();
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: true, spentUsd: 0.001 });
  });

  // Each test uses a distinct query string. The response cache
  // (semanticScholarResponseCache in functions/api-v1.js) is a module-level
  // Map keyed by `search:${query}:${limit}` with a 60s TTL -- it is not
  // reset between `it()` blocks in the same file, so reusing a query would
  // let one test's mocked result leak into the next via the cache instead
  // of exercising that test's own mocks.
  it("uses OpenAlex when the budget check allows it", async () => {
    vi.mocked(fetchOpenAlexSearch).mockResolvedValue([{ paper_id: "W1", title: "OA Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "visual analytics" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("W1");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchSemanticScholarSearch).not.toHaveBeenCalled();
    expect(takeOpenAlexBudget).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0.001);
  });

  it("skips straight to Semantic Scholar when the budget would be exceeded", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p1", title: "SS Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "network analysis" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p1");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexSearch).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar when OpenAlex errors despite budget allowing it", async () => {
    vi.mocked(fetchOpenAlexSearch).mockRejectedValue(
      Object.assign(new Error("upstream error"), { code: "openalex_error" }),
    );
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p2", title: "SS Fallback Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "graph visualization" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p2");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
  });

  it("falls back to Semantic Scholar instead of a 500 when the budget RPC itself throws", async () => {
    vi.mocked(takeOpenAlexBudget).mockRejectedValue(new Error("relation take_openalex_budget does not exist"));
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p3", title: "SS Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "budget rpc missing" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p3");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexSearch).not.toHaveBeenCalled();
  });
});

describe("references/citations routes: DOI-prefixed paper_id triggers OpenAlex primary", () => {
  // This describe has no beforeEach in the plan snippet either, but without
  // resetting these mocks between `it()` blocks their call counts and mock
  // implementations would leak across tests in this describe (e.g. the
  // "never calls OpenAlex" assertions would see stale call counts from
  // earlier tests) -- same reasoning as the "search route" describe above.
  beforeEach(() => {
    vi.mocked(fetchSemanticScholarReferences).mockReset();
    vi.mocked(fetchSemanticScholarCitations).mockReset();
    vi.mocked(fetchSemanticScholarRecommendations).mockReset();
    vi.mocked(fetchOpenAlexReferences).mockReset();
    vi.mocked(fetchOpenAlexCitations).mockReset();
  });

  // Distinct DOIs per test for the same route: the response cache
  // (semanticScholarResponseCache) is keyed by `${routeName}:${seedPaperId}:${limit}`
  // and isn't reset between `it()` blocks in this file, so two "references"
  // tests reusing the same DOI would let the first test's cached result
  // leak into the second instead of exercising its own mocks.
  it("tries OpenAlex references when paper_id is DOI:-prefixed", async () => {
    vi.mocked(fetchOpenAlexReferences).mockResolvedValue([{ paper_id: "W1", title: "OA Ref" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("W1");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchOpenAlexReferences).toHaveBeenCalledWith(
      expect.objectContaining({ doi: "10.1038/nature12373", limit: 10 }),
    );
    expect(fetchSemanticScholarReferences).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar references when OpenAlex fails for a DOI paper_id", async () => {
    vi.mocked(fetchOpenAlexReferences).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "openalex_not_found" }),
    );
    vi.mocked(fetchSemanticScholarReferences).mockResolvedValue([{ paper_id: "ss1", title: "SS Ref" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "DOI:10.1038/nature99999", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("ss1");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
  });

  it("calls Semantic Scholar directly, never OpenAlex, for a non-DOI paper_id", async () => {
    vi.mocked(fetchSemanticScholarReferences).mockResolvedValue([{ paper_id: "ss2", title: "SS Only" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "abc123hash", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexReferences).not.toHaveBeenCalled();
    expect(fetchSemanticScholarReferences).toHaveBeenCalledTimes(1);
  });

  it("skips OpenAlex citations when the budget would be exceeded, still using the DOI-derived seed", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarCitations).mockResolvedValue([{ paper_id: "ss3", title: "SS Citation" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/citations", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexCitations).not.toHaveBeenCalled();
    expect(fetchSemanticScholarCitations).toHaveBeenCalledWith(
      expect.objectContaining({ seedPaperId: "DOI:10.1038/nature12373" }),
    );
  });

  it("falls back to Semantic Scholar citations instead of a 500 when the budget RPC itself throws", async () => {
    vi.mocked(takeOpenAlexBudget).mockRejectedValue(new Error("relation take_openalex_budget does not exist"));
    vi.mocked(fetchSemanticScholarCitations).mockResolvedValue([{ paper_id: "ss4", title: "SS Citation" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/citations", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexCitations).not.toHaveBeenCalled();
  });

});

describe("recommendations route: OpenAlex primary via related_works, Semantic Scholar fallback", () => {
  beforeEach(() => {
    process.env.OPENALEX_API_KEY = "oa-test";
    vi.mocked(fetchSemanticScholarRecommendations).mockReset();
    vi.mocked(fetchOpenAlexRecommendationsForSet).mockReset();
    vi.mocked(takeOpenAlexBudget).mockReset();
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: true, spentUsd: 0.0005 });
  });

  // Distinct seed sets per test: the response cache is keyed off the sorted
  // seedPaperIds, same leak risk noted above for references/citations.
  it("tries OpenAlex related_works when every seed is DOI:-prefixed", async () => {
    vi.mocked(fetchOpenAlexRecommendationsForSet).mockResolvedValue([{ paper_id: "W9", title: "OA Related" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", {
        paper_ids: ["DOI:10.1038/nature.rec.1"],
        limit: 10,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("W9");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchOpenAlexRecommendationsForSet).toHaveBeenCalledWith(
      expect.objectContaining({ dois: ["10.1038/nature.rec.1"], limit: 10 }),
    );
    expect(fetchSemanticScholarRecommendations).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar recommendations when OpenAlex fails", async () => {
    vi.mocked(fetchOpenAlexRecommendationsForSet).mockRejectedValue(
      Object.assign(new Error("upstream error"), { code: "openalex_error" }),
    );
    vi.mocked(fetchSemanticScholarRecommendations).mockResolvedValue([{ paper_id: "rec2", title: "SS Rec" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", {
        paper_ids: ["DOI:10.1038/nature.rec.2"],
        limit: 10,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("rec2");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
  });

  it("goes straight to Semantic Scholar when any seed is not DOI:-prefixed", async () => {
    vi.mocked(fetchSemanticScholarRecommendations).mockResolvedValue([{ paper_id: "rec3", title: "SS Only" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", {
        paper_ids: ["DOI:10.1038/nature.rec.3", "abc123hash"],
        limit: 10,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexRecommendationsForSet).not.toHaveBeenCalled();
  });

  it("skips OpenAlex recommendations when the budget would be exceeded", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarRecommendations).mockResolvedValue([{ paper_id: "rec4", title: "SS Rec" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", {
        paper_ids: ["DOI:10.1038/nature.rec.4"],
        limit: 10,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexRecommendationsForSet).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar instead of a 500 when the budget RPC itself throws", async () => {
    vi.mocked(takeOpenAlexBudget).mockRejectedValue(new Error("relation take_openalex_budget does not exist"));
    vi.mocked(fetchSemanticScholarRecommendations).mockResolvedValue([{ paper_id: "rec5", title: "SS Rec" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", {
        paper_ids: ["DOI:10.1038/nature.rec.5"],
        limit: 10,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexRecommendationsForSet).not.toHaveBeenCalled();
  });
});

describe("lookup route (title query): OpenAlex primary, Semantic Scholar fallback", () => {
  beforeEach(() => {
    process.env.OPENALEX_API_KEY = "oa-test";
    vi.mocked(fetchSemanticScholarPaperLookup).mockReset();
    vi.mocked(fetchOpenAlexPaperIdByTitle).mockReset();
    vi.mocked(takeOpenAlexBudget).mockReset();
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: true, spentUsd: 0.001 });
  });

  // Distinct titles per test: the response cache is keyed off
  // `lookup:title:${queryValue}`, same leak risk noted above.
  it("tries OpenAlex title search first and returns a DOI:-prefixed id", async () => {
    vi.mocked(fetchOpenAlexPaperIdByTitle).mockResolvedValue("DOI:10.1038/nature.title.1");

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/lookup", { title: "Deep learning title one" }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.paper_id).toBe("DOI:10.1038/nature.title.1");
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchSemanticScholarPaperLookup).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar when OpenAlex has no DOI-addressable match", async () => {
    vi.mocked(fetchOpenAlexPaperIdByTitle).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "openalex_not_found" }),
    );
    vi.mocked(fetchSemanticScholarPaperLookup).mockResolvedValue("ss-title-paper-2");

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/lookup", { title: "Deep learning title two" }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.paper_id).toBe("ss-title-paper-2");
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
  });

  it("skips OpenAlex title lookup when the budget would be exceeded", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarPaperLookup).mockResolvedValue("ss-title-paper-3");

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/lookup", { title: "Deep learning title three" }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("semantic_scholar");
    expect(fetchOpenAlexPaperIdByTitle).not.toHaveBeenCalled();
  });
});

describe("global Semantic Scholar rate limit only gates the SS-serving path", () => {
  // take_semantic_scholar_rate_limit protects the shared SEMANTIC_SCHOLAR_API_KEY
  // specifically. It must not block a request that OpenAlex can serve entirely on
  // its own -- that would undermine the whole point of OpenAlex being the
  // higher-capacity primary provider. Exhaustion is simulated directly via the
  // mocked RPC result (rather than accumulating real state across two calls)
  // since the limiter is now the global, Postgres-RPC-backed one shared across
  // all requests -- there's no longer a real per-test in-memory bucket to warm up.
  const exhaustedRpcResults = {
    take_semantic_scholar_rate_limit: { data: [{ allowed: false, retry_after_seconds: 5 }], error: null },
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.SEMANTIC_SCHOLAR_API_KEY = "ss-test";
    process.env.OPENALEX_API_KEY = "oa-test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    vi.mocked(authenticateManagementUser).mockReset();
    vi.mocked(authenticateApiKey).mockReset();
    vi.mocked(fetchSemanticScholarReferences).mockReset();
    vi.mocked(fetchOpenAlexReferences).mockReset();
  });

  it("still serves via OpenAlex even when the global SS bucket is exhausted", async () => {
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"], userId: "rate-limit-precedence-user-1" });
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase({}, exhaustedRpcResults),
      principal,
    });

    // A DOI-prefixed (OpenAlex-eligible) request should still succeed via
    // OpenAlex even though the global SS bucket is exhausted, since it never
    // touches the SS rate limit at all.
    vi.mocked(fetchOpenAlexReferences).mockResolvedValue([{ paper_id: "W1", title: "OA Ref" }]);
    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "DOI:10.1038/rate-limit-precedence", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).meta.provider).toBe("openalex");
    expect(fetchSemanticScholarReferences).not.toHaveBeenCalled();
  });

  it("still returns 429 with a real Retry-After once the SS bucket is exhausted and OpenAlex isn't eligible", async () => {
    delete process.env.OPENALEX_API_KEY;
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"], userId: "rate-limit-precedence-user-2" });
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase({}, exhaustedRpcResults),
      principal,
    });

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "some-seed-no-openalex", limit: 10 }),
    );

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error.code).toBe("rate_limit_exceeded");
    expect(res.headers["retry-after"]).not.toBe("null");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(fetchSemanticScholarReferences).not.toHaveBeenCalled();
  });
});
