import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
    fetchOpenAlexSearch: vi.fn(),
    takeOpenAlexBudget: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { fetchSemanticScholarDoiMetadata, fetchSemanticScholarSearch } from "../src/semantic-scholar.js";
import { fetchOpenAlexDoiMetadata, fetchOpenAlexSearch, takeOpenAlexBudget } from "../src/openalex.js";
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
    expect(fetchOpenAlexDoiMetadata).not.toHaveBeenCalled();
    expect(fetchSemanticScholarDoiMetadata).toHaveBeenCalledTimes(1);
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
    expect(fetchSemanticScholarSearch).not.toHaveBeenCalled();
    expect(takeOpenAlexBudget).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0.001);
  });

  it("skips straight to Semantic Scholar when the budget would be exceeded", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p1", title: "SS Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "network analysis" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p1");
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
  });
});
