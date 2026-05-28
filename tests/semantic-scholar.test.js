import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSemanticScholarDoiMetadata,
  fetchSemanticScholarRecommendations,
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
