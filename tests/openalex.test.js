import { describe, expect, it } from "vitest";
import { reconstructAbstractFromInvertedIndex } from "../src/openalex.js";

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
