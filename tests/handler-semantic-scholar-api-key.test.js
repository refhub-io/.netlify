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
    fetchSemanticScholarSearch: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { fetchSemanticScholarSearch } from "../src/semantic-scholar.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeMockSupabase } from "./helpers.js";

function makeEvent(path, body, headers = { authorization: "Bearer rhk_test_secret" }) {
  return {
    httpMethod: "POST",
    path,
    headers,
    queryStringParameters: null,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("semantic-scholar API-key routes", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.SEMANTIC_SCHOLAR_API_KEY = "ss-test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    vi.mocked(authenticateManagementUser).mockReset();
    vi.mocked(authenticateApiKey).mockReset();
    vi.mocked(fetchSemanticScholarSearch).mockReset();
  });

  it("accepts RefHub API keys under /semantic-scholar/search", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase(),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:read"] }),
    });
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([
      { paper_id: "p1", title: "Paper" },
    ]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "visual analytics", limit: 3 }));

    expect(res.statusCode).toBe(200);
    expect(authenticateApiKey).toHaveBeenCalledTimes(1);
    expect(authenticateManagementUser).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.data[0].paper_id).toBe("p1");
  });

  it("requires vaults:read for API-key Semantic Scholar routes", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase(),
      principal: makeApiKeyPrincipal({ scopes: [] }),
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "visual analytics" }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("missing_scope");
  });
});
