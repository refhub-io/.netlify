import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { serializeVaultExport } from "../src/export.js";

// Shared with refhub.io (src/lib/bibtex-golden.json): both exporters must agree on these.
const golden = JSON.parse(readFileSync(new URL("./fixtures/bibtex-golden.json", import.meta.url), "utf8"));

function parseEntry(bibtex) {
  const [head, ...rest] = bibtex.split("\n");
  const key = head.match(/^@[^{]+\{([^,]*),$/)[1];
  const fields = {};
  for (const line of rest) {
    const match = line.match(/^ {2}([a-z]+) = \{(.*)\},?$/);
    if (match) fields[match[1]] = match[2];
  }
  return { key, fields };
}

describe("BibTeX export golden file (shared with refhub.io)", () => {
  for (const testCase of golden.cases) {
    it(testCase.name, () => {
      const { body } = serializeVaultExport("bibtex", { publications: [testCase.publication] });
      const { key, fields } = parseEntry(body);
      const { key: expectedKey, ...expectedFields } = testCase.expected;
      if (expectedKey !== undefined) expect(key).toBe(expectedKey);
      for (const [field, value] of Object.entries(expectedFields)) {
        expect(fields[field]).toBe(value);
      }
    });
  }
});
