# OpenAlex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenAlex the primary metadata/discovery provider (DOI metadata, references, citations, topic search) with automatic Semantic Scholar fallback, at zero cost to RefHub, with zero route/frontend contract changes.

**Architecture:** A new `src/openalex.js` module mirrors `src/semantic-scholar.js`'s fetcher/normalizer shape exactly. A tiny `withProviderFallback` helper wraps a primary call with a fallback on specific error codes. Route handlers in `functions/api-v1.js` recognize that an incoming `paper_id` (or `doi`) is DOI-shaped — which it already is today for any publication with a DOI — and, when OpenAlex is configured, try it first. A new Postgres table/RPC (`openalex_budget_state`/`take_openalex_budget`), applied the same way as the existing rate-limit migration, hard-stops OpenAlex usage at its free daily budget before any real money could be spent.

**Tech Stack:** Node.js (Netlify Functions), vitest, Supabase Postgres (via `@supabase/supabase-js`), fetch.

## Global Constraints

- Zero changes to any route path, request shape, or response shape. `refhub-cli` and the web app must keep working unmodified.
- Recommendations (`recommendations`/`related` routes) never call OpenAlex, ever — no code path in this plan touches `src/openalex.js` from that route.
- `/lookup`'s title-search path is untouched — stays Semantic-Scholar-only.
- OpenAlex must never cost real money: `takeOpenAlexBudget` hard-stops at `OPENALEX_DAILY_BUDGET_USD` (default `1.00`) before any priced (non-zero-cost) OpenAlex call.
- If `OPENALEX_API_KEY` is unset, the entire feature no-ops back to today's Semantic-Scholar-only behavior.
- Spec reference: `docs/superpowers/specs/2026-07-09-openalex-integration-design.md`.

---

## Task 1: Add OpenAlex config

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`
- Test: `tests/config.test.js` (new)

**Interfaces:**
- Produces: `getConfig()` return object gains `openalexApiKey: string | null`, `openalexDailyBudgetUsd: number`, `openalexTimeoutMs: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

const REQUIRED_ENV = {
  SUPABASE_URL: "http://localhost",
  SUPABASE_SERVICE_ROLE_KEY: "test",
  REFHUB_API_KEY_PEPPER: "test",
};

describe("getConfig OpenAlex settings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      process.env[key] = value;
    }
    delete process.env.OPENALEX_API_KEY;
    delete process.env.OPENALEX_DAILY_BUDGET_USD;
    delete process.env.OPENALEX_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to null key, $1.00 budget, 8000ms timeout", () => {
    const config = getConfig();
    expect(config.openalexApiKey).toBeNull();
    expect(config.openalexDailyBudgetUsd).toBe(1.0);
    expect(config.openalexTimeoutMs).toBe(8000);
  });

  it("reads overrides from environment", () => {
    process.env.OPENALEX_API_KEY = "oa-test-key";
    process.env.OPENALEX_DAILY_BUDGET_USD = "5.5";
    process.env.OPENALEX_TIMEOUT_MS = "4000";

    const config = getConfig();
    expect(config.openalexApiKey).toBe("oa-test-key");
    expect(config.openalexDailyBudgetUsd).toBe(5.5);
    expect(config.openalexTimeoutMs).toBe(4000);
  });

  it("rejects a non-numeric budget", () => {
    process.env.OPENALEX_DAILY_BUDGET_USD = "not-a-number";
    expect(() => getConfig()).toThrow("OPENALEX_DAILY_BUDGET_USD must be a positive number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — `config.openalexApiKey` is `undefined`, not `null` (property doesn't exist yet).

- [ ] **Step 3: Add the config**

In `src/config.js`, add a new default constant near the other `DEFAULT_SEMANTIC_SCHOLAR_*` constants (after line 9):

```js
const DEFAULT_SEMANTIC_SCHOLAR_TIMEOUT_MS = 8000;
const DEFAULT_OPENALEX_DAILY_BUDGET_USD = 1.0;
const DEFAULT_OPENALEX_TIMEOUT_MS = 8000;
const LOCAL_ENV_FILES = [".env.local", ".env"];
```

Add a new helper function after `readPositiveInteger` (after line 87):

```js
function readPositiveNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}
```

In the `getConfig()` return object, add three fields right after `semanticScholarTimeoutMs` (after line 109):

```js
    semanticScholarTimeoutMs: readPositiveInteger(
      "SEMANTIC_SCHOLAR_TIMEOUT_MS",
      DEFAULT_SEMANTIC_SCHOLAR_TIMEOUT_MS,
    ),
    openalexApiKey: process.env.OPENALEX_API_KEY || null,
    openalexDailyBudgetUsd: readPositiveNumber(
      "OPENALEX_DAILY_BUDGET_USD",
      DEFAULT_OPENALEX_DAILY_BUDGET_USD,
    ),
    openalexTimeoutMs: readPositiveInteger(
      "OPENALEX_TIMEOUT_MS",
      DEFAULT_OPENALEX_TIMEOUT_MS,
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Update `.env.example`**

In `.env.example`, after the `SEMANTIC_SCHOLAR_TIMEOUT_MS="8000"` line, add:

```
# Optional OpenAlex primary provider. Unset means the backend stays
# Semantic-Scholar-only, unchanged from before this integration existed.
# Get a free key at https://openalex.org/settings/api
OPENALEX_API_KEY=""
# Hard-stop guard: never spend more than this per UTC day on OpenAlex's
# usage-priced endpoints (search, citations). $1.00 matches the free
# daily budget every OpenAlex key gets.
OPENALEX_DAILY_BUDGET_USD="1.00"
OPENALEX_TIMEOUT_MS="8000"
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All existing tests still pass, plus the 3 new ones (previous total + 3).

- [ ] **Step 7: Commit**

```bash
git add src/config.js .env.example tests/config.test.js
git commit -m "Add OpenAlex config: API key, daily budget, timeout"
```

---

## Task 2: Move abstract reconstruction into `src/openalex.js`, dedupe from `import.js`

**Files:**
- Create: `src/openalex.js`
- Modify: `src/routes/import.js:70-77,79-109`
- Test: `tests/openalex.test.js` (new)

**Interfaces:**
- Produces: `reconstructAbstractFromInvertedIndex(invertedIndex: Record<string, number[]>): string`, exported from `src/openalex.js`.
- Consumes (by `import.js`): the same function, imported instead of locally defined.

- [ ] **Step 1: Write the failing test**

Create `tests/openalex.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — cannot find module `../src/openalex.js`.

- [ ] **Step 3: Create `src/openalex.js` with the moved function**

Create `src/openalex.js`:

```js
const OPENALEX_BASE_URL = "https://api.openalex.org";

export function reconstructAbstractFromInvertedIndex(invertedIndex) {
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(" ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Update `import.js` to use the shared function**

In `src/routes/import.js`, add the import at the top (after the existing `import { VAULT_PUBLICATION_SELECT, touchVaultUpdatedAt } from "./utils.js";` line):

```js
import { reconstructAbstractFromInvertedIndex } from "../openalex.js";
```

Delete the local `reconstructAbstract` function (lines 70-77):

```js
function reconstructAbstract(invertedIndex) {
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(" ");
}
```

In `fetchFromOpenAlex`, change the one call site (currently `reconstructAbstract(w.abstract_inverted_index)`) to:

```js
abstract: w.abstract_inverted_index ? reconstructAbstractFromInvertedIndex(w.abstract_inverted_index) : null,
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including existing `tests/routes/import.test.js` (regression check — no test there directly referenced the old local function name, so this should be unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/openalex.js src/routes/import.js tests/openalex.test.js
git commit -m "Move OpenAlex abstract reconstruction into shared src/openalex.js"
```

---

## Task 3: `src/openalex.js` — HTTP helpers, error taxonomy, paper-list normalizer

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Produces: `requestOpenAlex(url, init)`, `assertSuccessfulOpenAlexResponse(response, notFoundError)`, `withApiKey(url, apiKey)`, `stripOpenAlexIdPrefix(id)`, `stripDoiUrlPrefix(doi)`, `classifyOpenAlexType(type)`, `normalizePaperFromWork(work)` (all internal except `normalizePaperFromWork`, which is exported since Task 3's tests need to verify it directly).
- Error shape thrown: `Error` with `.code` (e.g. `"openalex_not_found"`, `"openalex_error"`, `"openalex_timeout"`, `"openalex_unreachable"`), `.status`, `.details`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/openalex.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePaperFromWork } from "../src/openalex.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `normalizePaperFromWork` is not exported.

- [ ] **Step 3: Implement the helpers and normalizer**

Replace the full content of `src/openalex.js` with:

```js
const OPENALEX_BASE_URL = "https://api.openalex.org";

export function reconstructAbstractFromInvertedIndex(invertedIndex) {
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(" ");
}

function createOpenAlexError(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

async function requestOpenAlex(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw createOpenAlexError("openalex_timeout", "OpenAlex request timed out", 504);
    }

    throw createOpenAlexError("openalex_unreachable", "OpenAlex request could not be completed", 502);
  }
}

function assertSuccessfulOpenAlexResponse(response, notFoundError) {
  if (response.status === 404 && notFoundError) {
    throw createOpenAlexError(
      notFoundError.code,
      notFoundError.message,
      notFoundError.status,
      notFoundError.details,
    );
  }

  if (!response.ok) {
    throw createOpenAlexError("openalex_error", "OpenAlex request failed", 502, {
      upstream_status: response.status,
    });
  }

  return true;
}

function withApiKey(url, apiKey) {
  if (apiKey) {
    url.searchParams.set("api_key", apiKey);
  }
  return url;
}

function stripOpenAlexIdPrefix(id) {
  return typeof id === "string" ? id.replace(/^https:\/\/openalex\.org\//, "") : id;
}

function stripDoiUrlPrefix(doi) {
  return typeof doi === "string" ? doi.replace(/^https?:\/\/doi\.org\//i, "") : doi;
}

function classifyOpenAlexType(type) {
  if (type === "book" || type === "book-chapter" || type === "book-section") return "book";
  if (type === "conference-paper" || type === "conference-abstract") return "inproceedings";
  if (type === "dissertation") return "thesis";
  if (type === "report") return "report";
  return "article";
}

function normalizeAuthorship(authorship) {
  const author = authorship?.author;
  if (!author?.display_name) return null;
  return { author_id: stripOpenAlexIdPrefix(author.id) || null, name: author.display_name };
}

export function normalizePaperFromWork(work) {
  return {
    paper_id: stripOpenAlexIdPrefix(work.id) || null,
    external_ids: { DOI: stripDoiUrlPrefix(work.doi) || undefined },
    title: work.title || null,
    abstract: work.abstract_inverted_index
      ? reconstructAbstractFromInvertedIndex(work.abstract_inverted_index)
      : null,
    year: work.publication_year || null,
    venue: work.primary_location?.source?.display_name || null,
    url: work.doi || work.id || null,
    citation_count: work.cited_by_count ?? null,
    open_access_pdf_url: work.open_access?.oa_url || work.best_oa_location?.pdf_url || null,
    authors: Array.isArray(work.authorships)
      ? work.authorships.map(normalizeAuthorship).filter(Boolean)
      : [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (4 tests total: 2 from Task 2, 2 new)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/openalex.js tests/openalex.test.js
git commit -m "Add OpenAlex HTTP helpers, error taxonomy, and paper normalizer"
```

---

## Task 4: `src/openalex.js` — `fetchOpenAlexDoiMetadata`

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Consumes: `requestOpenAlex`, `assertSuccessfulOpenAlexResponse`, `withApiKey`, `reconstructAbstractFromInvertedIndex`, `classifyOpenAlexType` (all defined in Task 3, same file).
- Produces: `fetchOpenAlexDoiMetadata({ apiKey, doi, signal }): Promise<{ title, authors: string[], year, journal, doi, url, abstract, type }>` — same shape as `fetchSemanticScholarDoiMetadata` in `src/semantic-scholar.js`.

- [ ] **Step 1: Write the failing test**

Add to `tests/openalex.test.js`:

```js
import { fetchOpenAlexDoiMetadata } from "../src/openalex.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `fetchOpenAlexDoiMetadata` is not exported.

- [ ] **Step 3: Implement `fetchOpenAlexDoiMetadata`**

Add to the end of `src/openalex.js`:

```js
export async function fetchOpenAlexDoiMetadata({ apiKey, doi, signal }) {
  const url = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);

  const response = await requestOpenAlex(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(response, {
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await response.json();
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map((a) => a.author?.display_name || "Unknown Author")
    : [];

  return {
    title: work.title || "Untitled",
    authors,
    year: work.publication_year || undefined,
    journal: work.primary_location?.source?.display_name || undefined,
    doi,
    url: `https://doi.org/${doi}`,
    abstract: work.abstract_inverted_index
      ? reconstructAbstractFromInvertedIndex(work.abstract_inverted_index)
      : undefined,
    type: classifyOpenAlexType(work.type),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (8 tests total)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/openalex.js tests/openalex.test.js
git commit -m "Add fetchOpenAlexDoiMetadata"
```

---

## Task 5: `src/openalex.js` — `fetchOpenAlexReferences`

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Produces: `fetchOpenAlexReferences({ apiKey, doi, limit, signal }): Promise<NormalizedPaper[]>` where `NormalizedPaper` is the shape from `normalizePaperFromWork`.

- [ ] **Step 1: Write the failing test**

Add to `tests/openalex.test.js`:

```js
import { fetchOpenAlexReferences } from "../src/openalex.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `fetchOpenAlexReferences` is not exported.

- [ ] **Step 3: Implement `fetchOpenAlexReferences`**

Add near the top of `src/openalex.js`, right after the `OPENALEX_BASE_URL` constant:

```js
const OPENALEX_HYDRATE_FIELDS = [
  "id",
  "doi",
  "title",
  "publication_year",
  "primary_location",
  "cited_by_count",
  "open_access",
  "best_oa_location",
  "authorships",
  "abstract_inverted_index",
];
```

Add to the end of `src/openalex.js`:

```js
export async function fetchOpenAlexReferences({ apiKey, doi, limit, signal }) {
  const workUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);
  const workResponse = await requestOpenAlex(workUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(workResponse, {
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await workResponse.json();
  const referencedIds = Array.isArray(work.referenced_works)
    ? work.referenced_works.slice(0, limit).map(stripOpenAlexIdPrefix)
    : [];

  if (referencedIds.length === 0) {
    return [];
  }

  const listUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  listUrl.searchParams.set("filter", `openalex_id:${referencedIds.join("|")}`);
  listUrl.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  listUrl.searchParams.set("per-page", String(referencedIds.length));

  const listResponse = await requestOpenAlex(listUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(listResponse, {
    code: "openalex_error",
    message: "OpenAlex reference lookup failed",
    status: 502,
  });

  const payload = await listResponse.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (12 tests total)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/openalex.js tests/openalex.test.js
git commit -m "Add fetchOpenAlexReferences"
```

---

## Task 6: `src/openalex.js` — `fetchOpenAlexCitations`

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Produces: `fetchOpenAlexCitations({ apiKey, doi, limit, signal }): Promise<NormalizedPaper[]>`

- [ ] **Step 1: Write the failing test**

Add to `tests/openalex.test.js`:

```js
import { fetchOpenAlexCitations } from "../src/openalex.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `fetchOpenAlexCitations` is not exported.

- [ ] **Step 3: Implement `fetchOpenAlexCitations`**

Add to the end of `src/openalex.js`:

```js
export async function fetchOpenAlexCitations({ apiKey, doi, limit, signal }) {
  const workUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works/doi:${encodeURIComponent(doi)}`), apiKey);
  const workResponse = await requestOpenAlex(workUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(workResponse, {
    code: "openalex_not_found",
    message: "OpenAlex work was not found",
    status: 404,
  });

  const work = await workResponse.json();
  const workId = stripOpenAlexIdPrefix(work.id);

  const listUrl = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  listUrl.searchParams.set("filter", `cites:${workId}`);
  listUrl.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  listUrl.searchParams.set("per-page", String(limit));

  const listResponse = await requestOpenAlex(listUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(listResponse, {
    code: "openalex_error",
    message: "OpenAlex citation lookup failed",
    status: 502,
  });

  const payload = await listResponse.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork);
}

export const OPENALEX_CITATIONS_COST_USD = 0.0001;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (15 tests total)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/openalex.js tests/openalex.test.js
git commit -m "Add fetchOpenAlexCitations"
```

---

## Task 7: `src/openalex.js` — `fetchOpenAlexSearch`

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Produces: `fetchOpenAlexSearch({ apiKey, query, limit, signal }): Promise<NormalizedPaper[]>`, `OPENALEX_SEARCH_COST_USD: number`

- [ ] **Step 1: Write the failing test**

Add to `tests/openalex.test.js`:

```js
import { fetchOpenAlexSearch } from "../src/openalex.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `fetchOpenAlexSearch` is not exported.

- [ ] **Step 3: Implement `fetchOpenAlexSearch`**

Add to the end of `src/openalex.js`:

```js
export async function fetchOpenAlexSearch({ apiKey, query, limit, signal }) {
  const url = withApiKey(new URL(`${OPENALEX_BASE_URL}/works`), apiKey);
  url.searchParams.set("search", query);
  url.searchParams.set("select", OPENALEX_HYDRATE_FIELDS.join(","));
  url.searchParams.set("per-page", String(limit));

  const response = await requestOpenAlex(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  assertSuccessfulOpenAlexResponse(response, {
    code: "openalex_error",
    message: "OpenAlex search failed",
    status: 502,
  });

  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizePaperFromWork);
}

export const OPENALEX_SEARCH_COST_USD = 0.001;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (17 tests total)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/openalex.js tests/openalex.test.js
git commit -m "Add fetchOpenAlexSearch"
```

---

## Task 8: `src/openalex.js` — `takeOpenAlexBudget`

**Files:**
- Modify: `src/openalex.js`
- Test: `tests/openalex.test.js`

**Interfaces:**
- Produces: `takeOpenAlexBudget(supabase, config, costUsd): Promise<{ allowed: boolean, spentUsd: number | null }>`, calling `supabase.rpc("take_openalex_budget", { p_bucket_key, p_cost_usd, p_daily_budget_usd })`.
- Consumes: `config.openalexDailyBudgetUsd` (from Task 1).

- [ ] **Step 1: Write the failing test**

Add to `tests/openalex.test.js`:

```js
import { takeOpenAlexBudget } from "../src/openalex.js";

describe("takeOpenAlexBudget", () => {
  const config = { openalexDailyBudgetUsd: 1.0 };

  it("calls the global budget RPC with the configured daily budget", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ allowed: true, spent_usd: 0.0001 }], error: null });
    const supabase = { rpc };

    const result = await takeOpenAlexBudget(supabase, config, 0.0001);

    expect(result).toEqual({ allowed: true, spentUsd: 0.0001 });
    expect(rpc).toHaveBeenCalledWith("take_openalex_budget", {
      p_bucket_key: "global",
      p_cost_usd: 0.0001,
      p_daily_budget_usd: 1.0,
    });
  });

  it("reports not-allowed when the RPC says the budget would be exceeded", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [{ allowed: false, spent_usd: 1.0 }], error: null }),
    };

    const result = await takeOpenAlexBudget(supabase, config, 0.001);
    expect(result).toEqual({ allowed: false, spentUsd: 1.0 });
  });

  it("throws if the RPC call itself fails", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("connection refused") }),
    };

    await expect(takeOpenAlexBudget(supabase, config, 0.0001)).rejects.toThrow("connection refused");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openalex.test.js`
Expected: FAIL — `takeOpenAlexBudget` is not exported.

- [ ] **Step 3: Implement `takeOpenAlexBudget`**

Add to the end of `src/openalex.js`:

```js
const OPENALEX_BUDGET_BUCKET_KEY = "global";

export async function takeOpenAlexBudget(supabase, config, costUsd) {
  const { data, error } = await supabase.rpc("take_openalex_budget", {
    p_bucket_key: OPENALEX_BUDGET_BUCKET_KEY,
    p_cost_usd: costUsd,
    p_daily_budget_usd: config.openalexDailyBudgetUsd,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    spentUsd: row?.spent_usd ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openalex.test.js`
Expected: PASS (20 tests total)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/openalex.js tests/openalex.test.js
git commit -m "Add takeOpenAlexBudget"
```

---

## Task 9: Cost-tracking migration

**Files:**
- Create: `../refhub.io/supabase/migrations/20260709130000_openalex_budget.sql`

This file lives in the `refhub.io` repo (sibling directory `../refhub.io` relative to this repo), matching where `20260709120000_semantic_scholar_global_rate_limit.sql` already lives. `supabase/migrations` is git-ignored there — this step creates the file on disk; it is applied directly (not committed), same as the rate-limit migration.

**Interfaces:**
- Produces: Postgres table `openalex_budget_state`, function `take_openalex_budget(p_bucket_key text, p_cost_usd numeric, p_daily_budget_usd numeric) RETURNS TABLE(allowed boolean, spent_usd numeric)`, matching exactly what Task 8's `takeOpenAlexBudget` calls.

- [ ] **Step 1: Write the migration file**

Create `../refhub.io/supabase/migrations/20260709130000_openalex_budget.sql`:

```sql
-- 20260709130000_openalex_budget.sql
--
-- Hard-stops OpenAlex usage at its free daily budget. Every OpenAlex API
-- key gets $1.00/day of free usage before real billing kicks in; single
-- work/DOI lookups are always free, but citations and search are metered
-- ($0.0001 and $0.001/call respectively). This tracks cumulative spend
-- globally (one row, shared across every Netlify function instance, same
-- reasoning as semantic_scholar_rate_limit_state) and resets at the next
-- UTC midnight rather than a rolling window, matching how OpenAlex's own
-- daily budget resets.

CREATE TABLE IF NOT EXISTS "public"."openalex_budget_state" (
    "bucket_key" "text" PRIMARY KEY,
    "spent_usd" numeric NOT NULL DEFAULT 0,
    "window_reset_at" timestamptz NOT NULL
);

ALTER TABLE "public"."openalex_budget_state" OWNER TO "postgres";

REVOKE ALL ON TABLE "public"."openalex_budget_state" FROM PUBLIC;
GRANT ALL ON TABLE "public"."openalex_budget_state" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."take_openalex_budget"(
    "p_bucket_key" "text",
    "p_cost_usd" numeric,
    "p_daily_budget_usd" numeric
) RETURNS TABLE("allowed" boolean, "spent_usd" numeric)
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_now timestamptz := clock_timestamp();
    v_next_reset timestamptz := date_trunc('day', v_now) + interval '1 day';
    v_reset_at timestamptz;
    v_spent numeric;
BEGIN
    -- Same FOR UPDATE row-lock reasoning as take_semantic_scholar_rate_limit:
    -- it's the only thing that can coordinate across Netlify's independent,
    -- memory-isolated function instances.
    SELECT "window_reset_at", "spent_usd" INTO v_reset_at, v_spent
    FROM "public"."openalex_budget_state"
    WHERE "bucket_key" = p_bucket_key
    FOR UPDATE;

    IF NOT FOUND THEN
        IF p_cost_usd > p_daily_budget_usd THEN
            INSERT INTO "public"."openalex_budget_state" ("bucket_key", "spent_usd", "window_reset_at")
            VALUES (p_bucket_key, 0, v_next_reset);
            RETURN QUERY SELECT false, 0::numeric;
            RETURN;
        END IF;

        INSERT INTO "public"."openalex_budget_state" ("bucket_key", "spent_usd", "window_reset_at")
        VALUES (p_bucket_key, p_cost_usd, v_next_reset);
        RETURN QUERY SELECT true, p_cost_usd;
        RETURN;
    END IF;

    IF v_reset_at <= v_now THEN
        v_spent := 0;
        v_reset_at := v_next_reset;
    END IF;

    IF v_spent + p_cost_usd > p_daily_budget_usd THEN
        UPDATE "public"."openalex_budget_state"
        SET "spent_usd" = v_spent, "window_reset_at" = v_reset_at
        WHERE "bucket_key" = p_bucket_key;
        RETURN QUERY SELECT false, v_spent;
        RETURN;
    END IF;

    UPDATE "public"."openalex_budget_state"
    SET "spent_usd" = v_spent + p_cost_usd, "window_reset_at" = v_reset_at
    WHERE "bucket_key" = p_bucket_key;
    RETURN QUERY SELECT true, v_spent + p_cost_usd;
END;
$$;

ALTER FUNCTION "public"."take_openalex_budget"("p_bucket_key" "text", "p_cost_usd" numeric, "p_daily_budget_usd" numeric) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."take_openalex_budget"("p_bucket_key" "text", "p_cost_usd" numeric, "p_daily_budget_usd" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."take_openalex_budget"("p_bucket_key" "text", "p_cost_usd" numeric, "p_daily_budget_usd" numeric) TO "service_role";
```

- [ ] **Step 2: Verify the file is syntactically sane**

Run: `grep -c "^END;$" ../refhub.io/supabase/migrations/20260709130000_openalex_budget.sql`
Expected: `1` (the single closing `END;` of the `take_openalex_budget` function body, right before the `$$;` that ends the function definition).

Run: `tail -3 ../refhub.io/supabase/migrations/20260709130000_openalex_budget.sql`
Expected: last line is the final `GRANT ALL ON FUNCTION ... TO "service_role";` statement — confirms the file wasn't truncated mid-write.

No automated test — this is manually applied to the production database by the user later (git-ignored, same flow as the existing rate-limit migration), not part of the test suite.

- [ ] **Step 3: No commit here**

This file lives in a different repo (`refhub.io`) and that repo's `.gitignore` excludes `supabase/migrations` entirely — there is nothing to commit. Leave it on disk; note it in the final task's summary for the user to apply.

---

## Task 10: `src/providerFallback.js`

**Files:**
- Create: `src/providerFallback.js`
- Test: `tests/provider-fallback.test.js` (new)

**Interfaces:**
- Produces: `withProviderFallback({ primary, fallback, isFallbackEligible, onProviderUsed }): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `tests/provider-fallback.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { withProviderFallback } from "../src/providerFallback.js";

describe("withProviderFallback", () => {
  it("returns the primary's result without calling fallback when primary succeeds", async () => {
    const primary = vi.fn().mockResolvedValue("primary-result");
    const fallback = vi.fn().mockResolvedValue("fallback-result");
    const onProviderUsed = vi.fn();

    const result = await withProviderFallback({
      primary,
      fallback,
      isFallbackEligible: () => true,
      onProviderUsed,
    });

    expect(result).toBe("primary-result");
    expect(fallback).not.toHaveBeenCalled();
    expect(onProviderUsed).toHaveBeenCalledWith("openalex");
  });

  it("calls fallback when primary throws an eligible error", async () => {
    const eligibleError = Object.assign(new Error("rate limited"), { code: "openalex_error" });
    const primary = vi.fn().mockRejectedValue(eligibleError);
    const fallback = vi.fn().mockResolvedValue("fallback-result");
    const onProviderUsed = vi.fn();

    const result = await withProviderFallback({
      primary,
      fallback,
      isFallbackEligible: (error) => error.code === "openalex_error",
      onProviderUsed,
    });

    expect(result).toBe("fallback-result");
    expect(onProviderUsed).toHaveBeenCalledWith("semantic_scholar");
  });

  it("rethrows without calling fallback when the error is not eligible", async () => {
    const ineligibleError = Object.assign(new Error("bad request"), { code: "invalid_input" });
    const primary = vi.fn().mockRejectedValue(ineligibleError);
    const fallback = vi.fn();

    await expect(
      withProviderFallback({
        primary,
        fallback,
        isFallbackEligible: (error) => error.code === "openalex_error",
      }),
    ).rejects.toThrow("bad request");

    expect(fallback).not.toHaveBeenCalled();
  });

  it("works without an onProviderUsed callback", async () => {
    const primary = vi.fn().mockResolvedValue("ok");

    const result = await withProviderFallback({ primary, fallback: vi.fn(), isFallbackEligible: () => true });
    expect(result).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/provider-fallback.test.js`
Expected: FAIL — cannot find module `../src/providerFallback.js`.

- [ ] **Step 3: Implement `withProviderFallback`**

Create `src/providerFallback.js`:

```js
export async function withProviderFallback({ primary, fallback, isFallbackEligible, onProviderUsed }) {
  try {
    const value = await primary();
    onProviderUsed?.("openalex");
    return value;
  } catch (error) {
    if (!isFallbackEligible(error)) {
      throw error;
    }

    const value = await fallback();
    onProviderUsed?.("semantic_scholar");
    return value;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/provider-fallback.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full test suite and commit**

```bash
npm test
git add src/providerFallback.js tests/provider-fallback.test.js
git commit -m "Add withProviderFallback helper"
```

---

## Task 11: Wire `doi-metadata` route

**Files:**
- Modify: `functions/api-v1.js:931-1003` (current `handleSemanticScholarDoiMetadataRoute`)
- Modify: `functions/api-v1.js:1,37-49` (imports)
- Test: `tests/handler-openalex-fallback.test.js` (new)

**Interfaces:**
- Consumes: `fetchOpenAlexDoiMetadata` (Task 4), `withProviderFallback` (Task 10), `getConfig()` gains `openalexApiKey`/`openalexTimeoutMs` (Task 1).
- No change to the route's external request/response shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/handler-openalex-fallback.test.js`:

```js
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
    fetchSemanticScholarDoiMetadata: vi.fn(),
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { fetchSemanticScholarDoiMetadata } from "../src/semantic-scholar.js";
import { fetchOpenAlexDoiMetadata } from "../src/openalex.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeMockSupabase } from "./helpers.js";

function makeEvent(path, body) {
  return {
    httpMethod: "POST",
    path,
    headers: { authorization: "Bearer rhk_test_secret" },
    queryStringParameters: null,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("doi-metadata route: OpenAlex primary, Semantic Scholar fallback", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.SEMANTIC_SCHOLAR_API_KEY = "ss-test";
    process.env.OPENALEX_API_KEY = "oa-test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    vi.mocked(authenticateManagementUser).mockReset();
    vi.mocked(authenticateApiKey).mockReset();
    vi.mocked(fetchSemanticScholarDoiMetadata).mockReset();
    vi.mocked(fetchOpenAlexDoiMetadata).mockReset();

    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase(),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:read"] }),
    });
  });

  it("uses OpenAlex when it succeeds, never calling Semantic Scholar", async () => {
    vi.mocked(fetchOpenAlexDoiMetadata).mockResolvedValue({
      title: "OpenAlex Paper",
      authors: ["A"],
      doi: "10.1/x",
      url: "https://doi.org/10.1/x",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/x" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.title).toBe("OpenAlex Paper");
    expect(fetchSemanticScholarDoiMetadata).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar when OpenAlex fails", async () => {
    vi.mocked(fetchOpenAlexDoiMetadata).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "openalex_not_found" }),
    );
    vi.mocked(fetchSemanticScholarDoiMetadata).mockResolvedValue({
      title: "SS Paper",
      authors: ["B"],
      doi: "10.1/y",
      url: "https://doi.org/10.1/y",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/y" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.title).toBe("SS Paper");
    expect(fetchOpenAlexDoiMetadata).toHaveBeenCalledTimes(1);
    expect(fetchSemanticScholarDoiMetadata).toHaveBeenCalledTimes(1);
  });

  it("skips OpenAlex entirely when OPENALEX_API_KEY is unset", async () => {
    delete process.env.OPENALEX_API_KEY;
    vi.mocked(fetchSemanticScholarDoiMetadata).mockResolvedValue({
      title: "SS Only",
      authors: [],
      doi: "10.1/z",
      url: "https://doi.org/10.1/z",
      type: "article",
    });

    const res = await handler(makeEvent("/api/v1/semantic-scholar/doi-metadata", { doi: "10.1/z" }));

    expect(res.statusCode).toBe(200);
    expect(fetchOpenAlexDoiMetadata).not.toHaveBeenCalled();
    expect(fetchSemanticScholarDoiMetadata).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: FAIL — OpenAlex is never invoked yet (`fetchOpenAlexDoiMetadata` mock never called), so the first two assertions fail.

- [ ] **Step 3: Wire the route**

In `functions/api-v1.js`, add a new import after the existing `from "../src/semantic-scholar.js";` import block (after line 49):

```js
import {
  fetchOpenAlexCitations,
  fetchOpenAlexDoiMetadata,
  fetchOpenAlexReferences,
  fetchOpenAlexSearch,
  OPENALEX_CITATIONS_COST_USD,
  OPENALEX_SEARCH_COST_USD,
  takeOpenAlexBudget,
} from "../src/openalex.js";
import { withProviderFallback } from "../src/providerFallback.js";
```

Add a shared fallback-eligibility predicate near `ensureSemanticScholarReadScope` (near line 324):

```js
const OPENALEX_FALLBACK_ELIGIBLE_CODES = new Set([
  "openalex_not_found",
  "openalex_error",
  "openalex_timeout",
  "openalex_unreachable",
]);

function isOpenAlexFallbackEligible(error) {
  return OPENALEX_FALLBACK_ELIGIBLE_CODES.has(error?.code);
}
```

Replace `handleSemanticScholarDoiMetadataRoute` (lines 931-1003) with:

```js
async function handleSemanticScholarDoiMetadataRoute(context, event, principal) {
  if (!requireScope(principal, API_SCOPES.READ)) {
    return errorResponse(403, "missing_scope", "Scope vaults:read is required", context.requestId);
  }

  // Semantic Scholar is disabled when no API key is configured. Without a key
  // the unauthenticated rate limit (1 req/s shared) is hit almost immediately.
  // Set SEMANTIC_SCHOLAR_API_KEY in the environment to re-enable this route.
  const config = getConfig();
  if (!config.semanticScholarApiKey) {
    return errorResponse(503, "semantic_scholar_disabled", "Semantic Scholar metadata enrichment is not configured on this server.", context.requestId);
  }

  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizeSemanticScholarDoiRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { doi } = normalizedRequest.value;
  const cacheKey = `doi-metadata:${doi}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  let provider = "cache";
  const metadata = cached.hit
    ? await cached.value
    : await (async () => {
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId, config);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      return getCachedSemanticScholarResponse(cacheKey, () => {
        if (!config.openalexApiKey) {
          provider = "semantic_scholar";
          return fetchSemanticScholarDoiMetadata({ apiKey: config.semanticScholarApiKey, doi, signal: timeout });
        }

        const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
        return withProviderFallback({
          primary: () => fetchOpenAlexDoiMetadata({ apiKey: config.openalexApiKey, doi, signal: openAlexTimeout }),
          fallback: () => fetchSemanticScholarDoiMetadata({ apiKey: config.semanticScholarApiKey, doi, signal: timeout }),
          isFallbackEligible: isOpenAlexFallbackEligible,
          onProviderUsed: (usedProvider) => {
            provider = usedProvider;
          },
        });
      });
    })();

  if (metadata?.statusCode) {
    return metadata;
  }

  return json(200, {
    data: metadata,
    meta: {
      request_id: context.requestId,
      doi,
      provider,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including the existing `tests/handler-semantic-scholar-api-key.test.js` and `tests/semantic-scholar.test.js` (regression check — doi-metadata isn't covered by those files directly, but this confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add functions/api-v1.js tests/handler-openalex-fallback.test.js
git commit -m "Wire doi-metadata route: OpenAlex primary, Semantic Scholar fallback"
```

---

## Task 12: Wire `search` route

**Files:**
- Modify: `functions/api-v1.js:855-929` (current `handleSemanticScholarSearchRoute`)
- Test: `tests/handler-openalex-fallback.test.js`

**Interfaces:**
- Consumes: `fetchOpenAlexSearch`, `OPENALEX_SEARCH_COST_USD`, `takeOpenAlexBudget` (Task 7, 8), `withProviderFallback` (Task 10), `getSupabaseAdmin` (already imported, Task 11 confirmed it's available).

- [ ] **Step 1: Write the failing tests**

Add to `tests/handler-openalex-fallback.test.js`:

```js
vi.mock("../src/semantic-scholar.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSemanticScholarDoiMetadata: vi.fn(),
    fetchSemanticScholarSearch: vi.fn(),
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
    fetchOpenAlexSearch: vi.fn(),
    takeOpenAlexBudget: vi.fn(),
  };
});
```

Replace the two `vi.mock` calls at the top of the file with the two above (same mock targets, extended with the new functions), then add:

```js
import { fetchSemanticScholarSearch } from "../src/semantic-scholar.js";
import { fetchOpenAlexSearch, takeOpenAlexBudget } from "../src/openalex.js";
```

(added to the existing import lines from those two modules), and in `beforeEach`, add:

```js
    vi.mocked(fetchSemanticScholarSearch).mockReset();
    vi.mocked(fetchOpenAlexSearch).mockReset();
    vi.mocked(takeOpenAlexBudget).mockReset();
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: true, spentUsd: 0.001 });
```

Then add a new describe block:

```js
describe("search route: OpenAlex primary (budget-gated), Semantic Scholar fallback", () => {
  // Each test uses a distinct query string. The response cache
  // (semanticScholarResponseCache in functions/api-v1.js) is a module-level
  // Map keyed by `search:${query}:${limit}` with a 60s TTL -- it is not
  // reset between `it()` blocks in the same file, so reusing a query would
  // let one test's mocked result leak into the next via the cache instead
  // of exercising that test's own mocks.
  it("uses OpenAlex when the budget check allows it", async () => {
    vi.mocked(fetchOpenAlexSearch).mockResolvedValue([{ paper_id: "W1", title: "OA Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "visual analytics" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("W1");
    expect(fetchSemanticScholarSearch).not.toHaveBeenCalled();
    expect(takeOpenAlexBudget).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0.001);
  });

  it("skips straight to Semantic Scholar when the budget would be exceeded", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p1", title: "SS Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "network analysis" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p1");
    expect(fetchOpenAlexSearch).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar when OpenAlex errors despite budget allowing it", async () => {
    vi.mocked(fetchOpenAlexSearch).mockRejectedValue(
      Object.assign(new Error("upstream error"), { code: "openalex_error" }),
    );
    vi.mocked(fetchSemanticScholarSearch).mockResolvedValue([{ paper_id: "p2", title: "SS Fallback Result" }]);

    const res = await handler(makeEvent("/api/v1/semantic-scholar/search", { query: "graph visualization" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("p2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: FAIL — `fetchOpenAlexSearch`/`takeOpenAlexBudget` are never invoked yet.

- [ ] **Step 3: Wire the route**

Replace `handleSemanticScholarSearchRoute` (lines 855-929) with:

```js
async function handleSemanticScholarSearchRoute(context, event, principal) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizeSemanticScholarSearchRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { query, limit } = normalizedRequest.value;
  const cacheKey = `search:${query.toLowerCase()}:${limit}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  let provider = "cache";
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const config = getConfig();
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId, config);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      const fetchFromSemanticScholar = () => {
        provider = "semantic_scholar";
        return fetchSemanticScholarSearch({ apiKey: config.semanticScholarApiKey, query, limit, signal: timeout });
      };

      return getCachedSemanticScholarResponse(cacheKey, async () => {
        if (!config.openalexApiKey) {
          return fetchFromSemanticScholar();
        }

        const budget = await takeOpenAlexBudget(getSupabaseAdmin(), config, OPENALEX_SEARCH_COST_USD);
        if (!budget.allowed) {
          return fetchFromSemanticScholar();
        }

        const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
        return withProviderFallback({
          primary: () => fetchOpenAlexSearch({ apiKey: config.openalexApiKey, query, limit, signal: openAlexTimeout }),
          fallback: fetchFromSemanticScholar,
          isFallbackEligible: isOpenAlexFallbackEligible,
          onProviderUsed: (usedProvider) => {
            provider = usedProvider;
          },
        });
      });
    })();

  if (papers?.statusCode) {
    return papers;
  }

  return json(200, {
    data: papers,
    meta: {
      request_id: context.requestId,
      query,
      limit,
      provider,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: PASS (6 tests total)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/api-v1.js tests/handler-openalex-fallback.test.js
git commit -m "Wire search route: OpenAlex primary (budget-gated), Semantic Scholar fallback"
```

---

## Task 13: Wire `references`/`citations` routes (DOI-prefix detection)

**Files:**
- Modify: `functions/api-v1.js:332-397` (current `handleSemanticScholarPaperRoute`, shared by recommendations/references/citations)
- Test: `tests/handler-openalex-fallback.test.js`

**Interfaces:**
- Consumes: `fetchOpenAlexReferences`, `fetchOpenAlexCitations`, `OPENALEX_CITATIONS_COST_USD` (Tasks 5, 6), `withProviderFallback` (Task 10).
- **Recommendations must be unaffected**: `handlePaperRecommendations` calls this same shared function with `routeName: "recommendations"`, which must never match an OpenAlex fetcher.

- [ ] **Step 1: Write the failing tests**

Add to `tests/handler-openalex-fallback.test.js`:

```js
vi.mock("../src/semantic-scholar.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSemanticScholarDoiMetadata: vi.fn(),
    fetchSemanticScholarSearch: vi.fn(),
    fetchSemanticScholarReferences: vi.fn(),
    fetchSemanticScholarCitations: vi.fn(),
    fetchSemanticScholarRecommendations: vi.fn(),
  };
});

vi.mock("../src/openalex.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOpenAlexDoiMetadata: vi.fn(),
    fetchOpenAlexSearch: vi.fn(),
    fetchOpenAlexReferences: vi.fn(),
    fetchOpenAlexCitations: vi.fn(),
    takeOpenAlexBudget: vi.fn(),
  };
});
```

(Same replacement pattern as Task 12 — extend the two existing `vi.mock` factories with these additional names.) Add matching imports:

```js
import {
  fetchSemanticScholarSearch,
  fetchSemanticScholarReferences,
  fetchSemanticScholarCitations,
  fetchSemanticScholarRecommendations,
} from "../src/semantic-scholar.js";
import {
  fetchOpenAlexSearch,
  fetchOpenAlexReferences,
  fetchOpenAlexCitations,
  takeOpenAlexBudget,
} from "../src/openalex.js";
```

Add resets in `beforeEach`:

```js
    vi.mocked(fetchSemanticScholarReferences).mockReset();
    vi.mocked(fetchSemanticScholarCitations).mockReset();
    vi.mocked(fetchSemanticScholarRecommendations).mockReset();
    vi.mocked(fetchOpenAlexReferences).mockReset();
    vi.mocked(fetchOpenAlexCitations).mockReset();
```

Add a new describe block:

```js
describe("references/citations routes: DOI-prefixed paper_id triggers OpenAlex primary", () => {
  // Distinct DOIs per test for the same route: the response cache
  // (semanticScholarResponseCache) is keyed by `${routeName}:${seedPaperId}:${limit}`
  // and isn't reset between `it()` blocks in this file, so two "references"
  // tests reusing the same DOI would let the first test's cached result
  // leak into the second instead of exercising its own mocks.
  it("tries OpenAlex references when paper_id is DOI:-prefixed", async () => {
    vi.mocked(fetchOpenAlexReferences).mockResolvedValue([{ paper_id: "W1", title: "OA Ref" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("W1");
    expect(fetchOpenAlexReferences).toHaveBeenCalledWith(
      expect.objectContaining({ doi: "10.1038/nature12373", limit: 10 }),
    );
    expect(fetchSemanticScholarReferences).not.toHaveBeenCalled();
  });

  it("falls back to Semantic Scholar references when OpenAlex fails for a DOI paper_id", async () => {
    vi.mocked(fetchOpenAlexReferences).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "openalex_not_found" }),
    );
    vi.mocked(fetchSemanticScholarReferences).mockResolvedValue([{ paper_id: "ss1", title: "SS Ref" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "DOI:10.1038/nature99999", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0].paper_id).toBe("ss1");
  });

  it("calls Semantic Scholar directly, never OpenAlex, for a non-DOI paper_id", async () => {
    vi.mocked(fetchSemanticScholarReferences).mockResolvedValue([{ paper_id: "ss2", title: "SS Only" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/references", { paper_id: "abc123hash", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(fetchOpenAlexReferences).not.toHaveBeenCalled();
    expect(fetchSemanticScholarReferences).toHaveBeenCalledTimes(1);
  });

  it("skips OpenAlex citations when the budget would be exceeded, still using the DOI-derived seed", async () => {
    vi.mocked(takeOpenAlexBudget).mockResolvedValue({ allowed: false, spentUsd: 1.0 });
    vi.mocked(fetchSemanticScholarCitations).mockResolvedValue([{ paper_id: "ss3", title: "SS Citation" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/citations", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(fetchOpenAlexCitations).not.toHaveBeenCalled();
    expect(fetchSemanticScholarCitations).toHaveBeenCalledWith(
      expect.objectContaining({ seedPaperId: "DOI:10.1038/nature12373" }),
    );
  });

  it("never calls OpenAlex for recommendations, even with a DOI:-prefixed seed", async () => {
    vi.mocked(fetchSemanticScholarRecommendations).mockResolvedValue([{ paper_id: "rec1", title: "Rec" }]);

    const res = await handler(
      makeEvent("/api/v1/semantic-scholar/related", { paper_id: "DOI:10.1038/nature12373", limit: 10 }),
    );

    expect(res.statusCode).toBe(200);
    expect(fetchOpenAlexReferences).not.toHaveBeenCalled();
    expect(fetchOpenAlexCitations).not.toHaveBeenCalled();
    expect(fetchSemanticScholarRecommendations).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: FAIL — OpenAlex references/citations fetchers are never invoked yet; all requests currently go straight to Semantic Scholar regardless of `paper_id` shape.

- [ ] **Step 3: Wire the shared handler**

Add near the other module-level constants, after `OPENALEX_FALLBACK_ELIGIBLE_CODES`/`isOpenAlexFallbackEligible` (added in Task 11):

```js
const OPENALEX_FETCHERS_BY_ROUTE = {
  references: fetchOpenAlexReferences,
  citations: fetchOpenAlexCitations,
};

const OPENALEX_COST_BY_ROUTE = {
  references: 0,
  citations: OPENALEX_CITATIONS_COST_USD,
};
```

Add `fetchOpenAlexReferences`, `fetchOpenAlexCitations` to the `from "../src/openalex.js"` import block added in Task 11 (they're already listed there — no change needed if Task 11's import already includes all four OpenAlex fetchers as written).

Replace `handleSemanticScholarPaperRoute` (lines 332-397) with:

```js
async function handleSemanticScholarPaperRoute(context, event, principal, routeName, fetcher) {
  const scopeError = ensureSemanticScholarReadScope(principal, context);
  if (scopeError) return scopeError;
  const parsedBody = parseJsonBody(event);
  if (!parsedBody.ok) {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", context.requestId);
  }

  const normalizedRequest = normalizePaperListRequest(parsedBody.value || {});
  if (normalizedRequest.error) {
    return errorResponse(400, normalizedRequest.error, normalizedRequest.message, context.requestId);
  }

  const { seedPaperId, limit } = normalizedRequest.value;
  const cacheKey = `${routeName}:${seedPaperId}:${limit}`;
  const cached = getCachedSemanticScholarValue(cacheKey);
  let provider = "cache";
  const papers = cached.hit
    ? await cached.value
    : await (async () => {
      const config = getConfig();
      const rateLimit = takeSemanticScholarRateLimit(principal?.userId, config);
      if (!rateLimit.allowed) {
        return json(
          429,
          {
            error: {
              code: "rate_limit_exceeded",
              message: "Too many Semantic Scholar requests; please retry shortly",
              details: {
                retry_after_seconds: rateLimit.retryAfterSeconds,
              },
            },
            meta: {
              request_id: context.requestId,
            },
          },
          {
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const timeout = AbortSignal.timeout(config.semanticScholarTimeoutMs);
      const fetchFromSemanticScholar = () => {
        provider = "semantic_scholar";
        return fetcher({ apiKey: config.semanticScholarApiKey, seedPaperId, limit, signal: timeout });
      };

      return getCachedSemanticScholarResponse(cacheKey, async () => {
        const openAlexFetcher = OPENALEX_FETCHERS_BY_ROUTE[routeName];
        const doiMatch = /^DOI:(.+)$/i.exec(seedPaperId);

        if (!openAlexFetcher || !config.openalexApiKey || !doiMatch) {
          return fetchFromSemanticScholar();
        }

        const cost = OPENALEX_COST_BY_ROUTE[routeName] ?? 0;
        if (cost > 0) {
          const budget = await takeOpenAlexBudget(getSupabaseAdmin(), config, cost);
          if (!budget.allowed) {
            return fetchFromSemanticScholar();
          }
        }

        const bareDoi = doiMatch[1];
        const openAlexTimeout = AbortSignal.timeout(config.openalexTimeoutMs);
        return withProviderFallback({
          primary: () => openAlexFetcher({ apiKey: config.openalexApiKey, doi: bareDoi, limit, signal: openAlexTimeout }),
          fallback: fetchFromSemanticScholar,
          isFallbackEligible: isOpenAlexFallbackEligible,
          onProviderUsed: (usedProvider) => {
            provider = usedProvider;
          },
        });
      });
    })();

  if (papers?.statusCode) {
    return papers;
  }

  return json(200, {
    data: papers,
    meta: {
      request_id: context.requestId,
      paper_id: seedPaperId,
      limit,
      provider,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handler-openalex-fallback.test.js`
Expected: PASS (11 tests total)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including `tests/handler-semantic-scholar-api-key.test.js`'s existing recommendations-related assertions (regression check — recommendations must show no behavior change).

- [ ] **Step 6: Commit**

```bash
git add functions/api-v1.js tests/handler-openalex-fallback.test.js
git commit -m "Wire references/citations routes: DOI-prefixed paper_id tries OpenAlex first"
```

---

## Task 14: Final regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: All tests pass (Task 1's 3 + Task 2-8's ~20 in `tests/openalex.test.js` + Task 10's 4 in `tests/provider-fallback.test.js` + Task 11-13's 11 in `tests/handler-openalex-fallback.test.js`, plus every pre-existing test file unchanged and passing).

- [ ] **Step 2: Run the syntax check**

Run: `npm run check`
Expected: Exits 0. If `src/openalex.js` or `src/providerFallback.js` aren't covered by the `check` script's file list in `package.json`, add them:

```json
"check": "node --check functions/api-v1.js && node --check src/auth.js && node --check src/config.js && node --check src/export.js && node --check src/google-drive.js && node --check src/http.js && node --check src/semantic-scholar.js && node --check src/openalex.js && node --check src/providerFallback.js",
```

- [ ] **Step 3: Confirm no route/response shape changed for existing consumers**

Run: `npx vitest run tests/handler-semantic-scholar-api-key.test.js tests/semantic-scholar.test.js`
Expected: All pass unmodified from before this plan — confirms `refhub-cli` and the web app see no behavior change for anything not touched by this plan (recommendations, `/lookup`).

- [ ] **Step 4: Bump the package version and changelog**

In `package.json`, bump `"version"` from its current value to the next minor version (check current value first with `grep version package.json`, since this branch is based on `main` before the rate-limit PR's `2.2.0` bump lands — bump from whatever `main` currently has).

Add an entry to `CHANGELOG.md` (create it if this branch predates the rate-limit PR's changelog addition — check first with `ls CHANGELOG.md`) documenting: OpenAlex added as primary provider for DOI metadata/references/citations/search with Semantic Scholar fallback; zero route/frontend changes; new `OPENALEX_API_KEY`/`OPENALEX_DAILY_BUDGET_USD`/`OPENALEX_TIMEOUT_MS` env vars; new `openalex_budget_state`/`take_openalex_budget` migration (applied separately, git-ignored).

- [ ] **Step 5: Commit and summarize for the user**

```bash
git add package.json CHANGELOG.md
git commit -m "Bump version, add changelog entry for OpenAlex integration"
```

Tell the user, in the final summary of this work: the migration at
`../refhub.io/supabase/migrations/20260709130000_openalex_budget.sql` still
needs to be applied to production directly (git-ignored, same as the
rate-limit one) before setting `OPENALEX_API_KEY` takes effect — until
then, the code gracefully no-ops back to Semantic-Scholar-only since
`config.openalexApiKey` will be unset.

---

## Self-Review Notes

**Spec coverage:** Every section of `docs/superpowers/specs/2026-07-09-openalex-integration-design.md` maps to a task — config (Task 1), `src/openalex.js` module (Tasks 2-8), migration (Task 9), `withProviderFallback` (Task 10), route wiring for `doi-metadata`/`search`/`references`/`citations` (Tasks 11-13), and the explicit "recommendations never touches OpenAlex" requirement is directly tested in Task 13. `/lookup`'s title path is untouched — no task modifies `handlePaperLookup`.

**Type/name consistency verified:** `fetchOpenAlexDoiMetadata`, `fetchOpenAlexReferences`, `fetchOpenAlexCitations`, `fetchOpenAlexSearch`, `takeOpenAlexBudget`, `OPENALEX_CITATIONS_COST_USD`, `OPENALEX_SEARCH_COST_USD` — same names used consistently from their Task 3-8 definitions through Task 11-13's imports and call sites. `withProviderFallback`'s `{ primary, fallback, isFallbackEligible, onProviderUsed }` signature (Task 10) matches every call site in Tasks 11-13 exactly.

**Known limitation carried forward from the spec:** title-only publications (no DOI) never reach OpenAlex — `handlePaperLookup`'s title-search path is intentionally untouched, so `seedPaperId` for such papers is always an opaque Semantic-Scholar hash, which `/^DOI:(.+)$/i` never matches, so `references`/`citations` correctly fall through to Semantic-Scholar-only for those papers. This is the accepted, non-regressing gap the spec called out.
