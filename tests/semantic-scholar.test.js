import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSemanticScholarDoiMetadata,
  fetchSemanticScholarRecommendations,
  fetchSemanticScholarSearch,
  normalizeRecommendationsRequest,
  normalizeSemanticScholarSearchRequest,
  takeSemanticScholarRateLimit,
} from "../src/semantic-scholar.js";

describe("normalizeRecommendationsRequest", () => {
  it("accepts a batch of seed paper ids", () => {
    expect(normalizeRecommendationsRequest({ paper_ids: ["p1", "p2", "p2", " p3 "], limit: 5 })).toEqual({
      value: { seedPaperIds: ["p1", "p2", "p3"], limit: 5 },
    });
  });

  it("still accepts a single legacy paper_id string", () => {
    expect(normalizeRecommendationsRequest({ paper_id: "p1" })).toEqual({
      value: { seedPaperIds: ["p1"], limit: 10 },
    });
  });

  it("rejects an empty request", () => {
    expect(normalizeRecommendationsRequest({})).toMatchObject({ error: "invalid_paper_id" });
    expect(normalizeRecommendationsRequest({ paper_ids: [] })).toMatchObject({ error: "invalid_paper_id" });
  });

  it("rejects more seed ids than the batch cap", () => {
    const paperIds = Array.from({ length: 21 }, (_, i) => `p${i}`);
    expect(normalizeRecommendationsRequest({ paper_ids: paperIds })).toMatchObject({ error: "invalid_paper_id" });
  });

  it("validates limit the same way as the single-seed routes", () => {
    expect(normalizeRecommendationsRequest({ paper_id: "p1", limit: 50 })).toMatchObject({ error: "invalid_limit" });
  });
});

describe("takeSemanticScholarRateLimit", () => {
  const config = {
    semanticScholarRateLimitMaxRequests: 60,
    semanticScholarRateLimitWindowMs: 60000,
  };

  it("calls the shared global bucket RPC, not a per-user one", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });
    const supabase = { rpc };

    const result = await takeSemanticScholarRateLimit(supabase, config);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: null });
    expect(rpc).toHaveBeenCalledWith("take_semantic_scholar_rate_limit", {
      p_bucket_key: "global",
      p_max_requests: 60,
      p_window_ms: 60000,
    });
  });

  it("surfaces retry_after_seconds when the bucket is exhausted", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [{ allowed: false, retry_after_seconds: 17 }], error: null }),
    };

    const result = await takeSemanticScholarRateLimit(supabase, config);

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 17 });
  });

  it("throws if the RPC call itself fails", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("connection refused") }),
    };

    await expect(takeSemanticScholarRateLimit(supabase, config)).rejects.toThrow("connection refused");
  });

  it("throws if the RPC succeeds but returns no usable row, instead of a fake denial", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };

    await expect(takeSemanticScholarRateLimit(supabase, config)).rejects.toThrow(
      "unexpected response shape",
    );
  });

  it("throws if the RPC returns a row without a boolean allowed field", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [{ retry_after_seconds: 5 }], error: null }),
    };

    await expect(takeSemanticScholarRateLimit(supabase, config)).rejects.toThrow(
      "unexpected response shape",
    );
  });
});

describe("semantic-scholar upstream errors", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("preserves Retry-After metadata for recommendations rate limits", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("{}", {
        status: 429,
        headers: {
          "retry-after": "17",
        },
      }),
    );

    await expect(
      fetchSemanticScholarRecommendations({
        apiKey: "test-key",
        seedPaperIds: ["seed-1"],
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: "semantic_scholar_rate_limited",
      status: 429,
      details: {
        retry_after_seconds: 17,
      },
    });
  });

  it("sends every seed paper id in a single recommendations request", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ recommendedPapers: [] }), { status: 200 }),
    );

    await fetchSemanticScholarRecommendations({
      apiKey: "test-key",
      seedPaperIds: ["p1", "p2", "p3"],
      limit: 10,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      positivePaperIds: ["p1", "p2", "p3"],
      negativePaperIds: [],
    });
  });

  it("validates topic search requests", () => {
    expect(normalizeSemanticScholarSearchRequest({ query: "ai", limit: 5 })).toEqual({
      value: { query: "ai", limit: 5 },
    });
    expect(normalizeSemanticScholarSearchRequest({ query: "x" })).toMatchObject({
      error: "invalid_query",
    });
    expect(normalizeSemanticScholarSearchRequest({ query: "visualization", limit: 50 })).toMatchObject({
      error: "invalid_limit",
    });
  });

  it("searches and normalizes Semantic Scholar papers through the bulk endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          {
            paperId: "paper-1",
            title: "Useful Paper",
            year: 2024,
            venue: "CHI",
            citationCount: 7,
            externalIds: { DOI: "10.123/example" },
            authors: [{ authorId: "a1", name: "Ada" }],
            openAccessPdf: { url: "https://example.test/paper.pdf" },
          },
        ],
      }), { status: 200 }),
    );

    await expect(
      fetchSemanticScholarSearch({ apiKey: "test-key", query: "visual analytics", limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({
        paper_id: "paper-1",
        title: "Useful Paper",
        external_ids: { DOI: "10.123/example" },
        authors: [{ author_id: "a1", name: "Ada" }],
        open_access_pdf_url: "https://example.test/paper.pdf",
      }),
    ]);
    const url = new URL(vi.mocked(fetch).mock.calls[0][0].toString());
    expect(url.pathname).toBe("/graph/v1/paper/search/bulk");
    expect(url.searchParams.get("sort")).toBe("citationCount:desc");
  });

  it("still returns null for DOI metadata misses", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("{}", {
        status: 404,
      }),
    );

    await expect(
      fetchSemanticScholarDoiMetadata({
        apiKey: "test-key",
        doi: "10.123/example",
      }),
    ).resolves.toBeNull();
  });
});
