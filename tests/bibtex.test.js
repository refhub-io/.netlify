import { describe, it, expect } from "vitest";
import { parseBibtex } from "../src/bibtex.js";

const SAMPLE_BIBTEX = `
@article{smith2023ml,
  title = {Deep Learning in Practice},
  author = {Alice Smith and Bob Jones},
  year = {2023},
  journal = {Nature},
  volume = {12},
  number = {3},
  pages = {100--120},
  doi = {10.1/example},
  keywords = {machine learning, deep learning}
}

@inproceedings{doe2022conf,
  title = {Conference Proceedings},
  author = {Jane Doe},
  year = {2022},
  booktitle = {ICML 2022}
}
`;

describe("parseBibtex", () => {
  it("returns empty array for empty string", () => {
    expect(parseBibtex("")).toEqual([]);
  });

  it("returns empty array for string with no entries", () => {
    expect(parseBibtex("% just a comment\n")).toEqual([]);
  });

  it("parses the number of entries correctly", () => {
    const result = parseBibtex(SAMPLE_BIBTEX);
    expect(result).toHaveLength(2);
  });

  it("parses title", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.title).toBe("Deep Learning in Practice");
  });

  it("splits authors by ' and '", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.authors).toEqual(["Alice Smith", "Bob Jones"]);
  });

  it("parses year as integer", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.year).toBe(2023);
  });

  it("preserves bibtex key", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.bibtex_key).toBe("smith2023ml");
  });

  it("preserves publication_type", () => {
    const [first, second] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.publication_type).toBe("article");
    expect(second.publication_type).toBe("inproceedings");
  });

  it("maps number field to issue", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.issue).toBe("3");
  });

  it("splits keywords by comma", () => {
    const [first] = parseBibtex(SAMPLE_BIBTEX);
    expect(first.keywords).toEqual(["machine learning", "deep learning"]);
  });

  it("maps booktitle for inproceedings", () => {
    const [, second] = parseBibtex(SAMPLE_BIBTEX);
    expect(second.booktitle).toBe("ICML 2022");
  });

  it("handles single-author entry", () => {
    const bib = `@article{solo2020,
      title = {Solo Work},
      author = {Single Author},
      year = {2020}
    }`;
    const [pub] = parseBibtex(bib);
    expect(pub.authors).toEqual(["Single Author"]);
  });

  it("handles missing year gracefully", () => {
    const bib = `@misc{noyear, title = {No Year Paper}}`;
    const [pub] = parseBibtex(bib);
    expect(pub.year).toBeUndefined();
  });

  it("uses 'Untitled' when title is absent", () => {
    const bib = `@misc{notitle, author = {Someone}}`;
    const [pub] = parseBibtex(bib);
    expect(pub.title).toBe("Untitled");
  });

  it("parses multiple entries in sequence", () => {
    const bib = `
      @article{a1, title = {A}}
      @article{a2, title = {B}}
      @article{a3, title = {C}}
    `;
    const result = parseBibtex(bib);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.title)).toEqual(["A", "B", "C"]);
  });
});
