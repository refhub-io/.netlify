import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructAbstractFromInvertedIndex, normalizePaperFromWork, fetchOpenAlexDoiMetadata } from "../src/openalex.js";

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
