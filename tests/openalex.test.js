import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructAbstractFromInvertedIndex, normalizePaperFromWork, fetchOpenAlexDoiMetadata, fetchOpenAlexReferences, fetchOpenAlexCitations, fetchOpenAlexSearch } from "../src/openalex.js";

describe("reconstructAbstractFromInvertedIndex", () => {
  it("reorders words back into original sentence order", () => {
    const invertedIndex = {
      Quantum: [0],
      sensing: [1],
      is: [2],
      useful: [3],
    };

    expect(reconstructAbstractFromInvertedIndex(invertedIndex)).toBe("Quantum sensing is useful");
  });

  it("handles repeated words at multiple positions", () => {
    const invertedIndex = {
      the: [0, 3],
      cat: [1],
      and: [2],
      dog: [4],
    };

    expect(reconstructAbstractFromInvertedIndex(invertedIndex)).toBe("the cat and the dog");
  });
});

describe("normalizePaperFromWork", () => {
  it("normalizes a full OpenAlex work into the shared paper shape", () => {
    const work = {
      id: "https://openalex.org/W2159974629",
      doi: "https://doi.org/10.1038/nature12373",
      title: "Nanometre-scale thermometry in a living cell",
      publication_year: 2013,
      primary_location: { source: { display_name: "Nature" } },
      cited_by_count: 1962,
      open_access: { oa_url: "https://arxiv.org/pdf/1304.1068" },
      best_oa_location: { pdf_url: "https://arxiv.org/pdf/1304.1068" },
      abstract_inverted_index: { Quantum: [0], sensing: [1] },
      authorships: [
        { author: { id: "https://openalex.org/A5033043101", display_name: "Georg Kucsko" } },
      ],
    };

    expect(normalizePaperFromWork(work)).toEqual({
      paper_id: "W2159974629",
      external_ids: { DOI: "10.1038/nature12373" },
      title: "Nanometre-scale thermometry in a living cell",
      abstract: "Quantum sensing",
      year: 2013,
      venue: "Nature",
      url: "https://doi.org/10.1038/nature12373",
      citation_count: 1962,
      open_access_pdf_url: "https://arxiv.org/pdf/1304.1068",
      authors: [{ author_id: "A5033043101", name: "Georg Kucsko" }],
    });
  });

  it("handles a minimal work with missing optional fields", () => {
    const work = { id: "https://openalex.org/W1", title: "Untitled Work" };

    expect(normalizePaperFromWork(work)).toEqual({
      paper_id: "W1",
      external_ids: { DOI: undefined },
      title: "Untitled Work",
      abstract: null,
      year: null,
      venue: null,
      // Falls back to the OpenAlex work page when there's no DOI to link to.
      url: "https://openalex.org/W1",
      citation_count: null,
      open_access_pdf_url: null,
      authors: [],
    });
  });
});

describe("fetchOpenAlexDoiMetadata", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches and normalizes DOI metadata to the BibTeX-like shape", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "https://openalex.org/W2159974629",
          doi: "https://doi.org/10.1038/nature12373",
          title: "Nanometre-scale thermometry in a living cell",
          publication_year: 2013,
          type: "article",
          primary_location: { source: { display_name: "Nature" } },
          abstract_inverted_index: { Quantum: [0], sensing: [1] },
          authorships: [{ author: { display_name: "Georg Kucsko" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const metadata = await fetchOpenAlexDoiMetadata({
      apiKey: "test-key",
      doi: "10.1038/nature12373",
      signal: undefined,
    });

    expect(metadata).toEqual({
      title: "Nanometre-scale thermometry in a living cell",
      authors: ["Georg Kucsko"],
      year: 2013,
      journal: "Nature",
      doi: "10.1038/nature12373",
      url: "https://doi.org/10.1038/nature12373",
      abstract: "Quantum sensing",
      type: "article",
    });

    const [calledUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(calledUrl)).toBe(
      "https://api.openalex.org/works/doi:10.1038%2Fnature12373?api_key=test-key",
    );
  });

  it("classifies dissertation/book-chapter/conference-paper types correctly", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ title: "A Thesis", type: "dissertation" }), { status: 200 }),
    );

    const metadata = await fetchOpenAlexDoiMetadata({ apiKey: null, doi: "10.1/x", signal: undefined });
    expect(metadata.type).toBe("thesis");
  });

  it("throws openalex_not_found on 404", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 404 }));

    await expect(
      fetchOpenAlexDoiMetadata({ apiKey: "test-key", doi: "10.1/missing", signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_not_found", status: 404 });
  });

  it("omits api_key param when no key is configured", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ title: "X" }), { status: 200 }));

    await fetchOpenAlexDoiMetadata({ apiKey: null, doi: "10.1/x", signal: undefined });

    const [calledUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(calledUrl)).not.toContain("api_key");
  });
});

describe("fetchOpenAlexReferences", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches the work, then hydrates referenced_works into full papers", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "https://openalex.org/W2159974629",
            referenced_works: [
              "https://openalex.org/W111",
              "https://openalex.org/W222",
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { id: "https://openalex.org/W111", title: "Ref One" },
              { id: "https://openalex.org/W222", title: "Ref Two" },
            ],
          }),
          { status: 200 },
        ),
      );

    const papers = await fetchOpenAlexReferences({
      apiKey: "test-key",
      doi: "10.1038/nature12373",
      limit: 10,
      signal: undefined,
    });

    expect(papers).toEqual([
      expect.objectContaining({ paper_id: "W111", title: "Ref One" }),
      expect.objectContaining({ paper_id: "W222", title: "Ref Two" }),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    const [, secondUrl] = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(secondUrl).toContain("filter=openalex_id%3AW111%7CW222");
  });

  it("returns an empty array without a hydration call when there are no references", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "https://openalex.org/W1", referenced_works: [] }), { status: 200 }),
    );

    const papers = await fetchOpenAlexReferences({
      apiKey: "test-key",
      doi: "10.1/x",
      limit: 10,
      signal: undefined,
    });

    expect(papers).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("respects the limit by truncating referenced_works before hydrating", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "https://openalex.org/W1",
            referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2", "https://openalex.org/W3"],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: "https://openalex.org/W1", title: "One" }] }), { status: 200 }),
      );

    await fetchOpenAlexReferences({ apiKey: "test-key", doi: "10.1/x", limit: 1, signal: undefined });

    const [, secondUrl] = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(secondUrl).toContain("filter=openalex_id%3AW1");
    expect(secondUrl).not.toContain("W2");
  });

  it("throws openalex_not_found when the seed work doesn't exist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 404 }));

    await expect(
      fetchOpenAlexReferences({ apiKey: "test-key", doi: "10.1/missing", limit: 10, signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_not_found" });
  });

  it("throws openalex_error when the hydration call fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "https://openalex.org/W2159974629",
            referenced_works: ["https://openalex.org/W111"],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));

    await expect(
      fetchOpenAlexReferences({ apiKey: "test-key", doi: "10.1038/nature12373", limit: 10, signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_error" });
  });
});

describe("fetchOpenAlexCitations", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches the work for its id, then filters by cites:{id}", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "https://openalex.org/W2159974629" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: "https://openalex.org/W999", title: "Citing Paper" }] }),
          { status: 200 },
        ),
      );

    const papers = await fetchOpenAlexCitations({
      apiKey: "test-key",
      doi: "10.1038/nature12373",
      limit: 5,
      signal: undefined,
    });

    expect(papers).toEqual([expect.objectContaining({ paper_id: "W999", title: "Citing Paper" })]);

    const [, secondUrl] = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(secondUrl).toContain("filter=cites%3AW2159974629");
    expect(secondUrl).toContain("per-page=5");
  });

  it("throws openalex_not_found when the seed work doesn't exist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 404 }));

    await expect(
      fetchOpenAlexCitations({ apiKey: "test-key", doi: "10.1/missing", limit: 10, signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_not_found" });
  });

  it("throws openalex_error when the filter call itself fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "https://openalex.org/W1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));

    await expect(
      fetchOpenAlexCitations({ apiKey: "test-key", doi: "10.1/x", limit: 10, signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_error" });
  });
});

describe("fetchOpenAlexSearch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("searches and normalizes results", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ id: "https://openalex.org/W1", title: "Visual Analytics Survey" }] }),
        { status: 200 },
      ),
    );

    const papers = await fetchOpenAlexSearch({
      apiKey: "test-key",
      query: "visual analytics",
      limit: 20,
      signal: undefined,
    });

    expect(papers).toEqual([expect.objectContaining({ paper_id: "W1", title: "Visual Analytics Survey" })]);

    const [calledUrl] = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(calledUrl).toContain("search=visual+analytics");
    expect(calledUrl).toContain("per-page=20");
  });

  it("throws openalex_error on a failed search", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));

    await expect(
      fetchOpenAlexSearch({ apiKey: "test-key", query: "x", limit: 20, signal: undefined }),
    ).rejects.toMatchObject({ code: "openalex_error" });
  });
});
