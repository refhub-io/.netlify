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
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { fetchSemanticScholarDoiMetadata } from "../src/semantic-scholar.js";
import { fetchOpenAlexDoiMetadata } from "../src/openalex.js";
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
