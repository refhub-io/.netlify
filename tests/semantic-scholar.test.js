import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSemanticScholarDoiMetadata,
  fetchSemanticScholarRecommendations,
  fetchSemanticScholarSearch,
  normalizeSemanticScholarSearchRequest,
} from "../src/semantic-scholar.js";

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
        seedPaperId: "seed-1",
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
