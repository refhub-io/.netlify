import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructAbstractFromInvertedIndex, normalizePaperFromWork } from "../src/openalex.js";

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
