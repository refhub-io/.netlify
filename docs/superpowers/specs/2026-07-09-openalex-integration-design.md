# OpenAlex integration: primary metadata provider with Semantic Scholar fallback

## Problem

Semantic Scholar is the only external metadata/discovery provider today. Even
after fixing the rate limiter to be a real global bucket (see the
rate-limit work, PR #27), the whole backend still shares one Semantic
Scholar API key at roughly 1 req/sec, globally, across every RefHub user.
That's a hard ceiling that can't grow without a different Semantic Scholar
pricing tier.

OpenAlex has just introduced a usage-based API (Feb 2026) with a free key.
For the operations RefHub actually needs, it is dramatically higher capacity:

| | OpenAlex (with key) | Semantic Scholar (with key) |
|---|---|---|
| Single work/DOI lookup | Free, unlimited | ~1 req/sec shared globally |
| References | Free (embedded in the lookup response) | Same shared ~1 req/sec budget |
| Citations | ~$0.0001/call, 10k free/day | Same shared ~1 req/sec budget |
| Search | ~$0.001/call, 1k free/day | Same shared ~1 req/sec budget |
| Recommendations (set-based ML) | Not available | Same shared ~1 req/sec budget |

This makes OpenAlex the right primary provider for everything except
recommendations, which only Semantic Scholar offers.

## Goals

- OpenAlex primary / Semantic Scholar fallback for: DOI metadata, references,
  citations, and topic search.
- Recommendations (the vault "related papers" batch tab) stays 100%
  Semantic Scholar — OpenAlex has no set-based ML recommender, only a
  precomputed per-paper `related_works` list, which is a different thing.
- **Zero route contract changes, zero frontend changes.** Every existing
  consumer — the web app and `refhub-cli` (which calls these routes
  directly with a RefHub API key) — keeps working completely unmodified.
- Never actually get billed by OpenAlex. Hard-stop at the free daily budget
  and fail over to Semantic Scholar instead.

## Non-goals

- No UI for viewing/adjusting the OpenAlex budget (server-side guard only,
  for now).
- No use of OpenAlex's `related_works` field anywhere — recommendations
  stays untouched, still exclusively Semantic Scholar.
- No change to `/lookup`'s title-search path. It stays Semantic-Scholar-only,
  exactly as today. See "Why this needs no route changes" for why that's
  an acceptable, non-regressing gap rather than a compromise.
- No renaming of anything. `doi-metadata`, `lookup`, `references`,
  `citations`, `search`, and `recommendations` are untouched at the
  route/contract level.

## Why this needs no route changes

Checked the actual behavior of both APIs (not assumed) and the actual
current code (not assumed):

- **Semantic Scholar accepts `DOI:<doi>` directly** as the paper identifier
  for the base lookup, `/references`, `/citations`, *and* in
  `positivePaperIds` for `/recommendations/v1/papers`. Verified live against
  `api.semanticscholar.org`.
- **`/lookup`'s existing DOI path already exploits this** — for
  `queryType === "doi"`, `handlePaperLookup` (`functions/api-v1.js:780-785`)
  doesn't call Semantic Scholar at all. It just echoes back
  `paper_id: DOI:<doi>`:

  ```js
  if (queryType === "doi") {
    const normalizedDoi = queryValue.replace(/^doi:/i, "").trim();
    return json(200, { data: { paper_id: `DOI:${normalizedDoi}` }, ... });
  }
  ```

  That `DOI:<doi>` value is already what flows into `references`,
  `citations`, and `recommendations` today for any publication with a DOI.
  It was already provider-agnostic before this feature existed — it just
  happened to only ever be sent to one provider.
- **OpenAlex also accepts a bare DOI directly**, for `GET
  /works/doi:{doi}`, which returns `referenced_works` and `related_works`
  embedded in the same free response. Its `cites`/`cited_by` filter,
  however, needs OpenAlex's own `W...` ID — one internal (free) DOI→work
  hop handles that, invisible outside `src/openalex.js`.

So the `paper_id` field already carries a DOI (prefixed `DOI:`) whenever a
publication has one — which is the large majority of vault publications.
`references`/`citations`/`recommendations` don't need a new identifier
concept; they need to recognize a `paper_id` they're already receiving and,
for the two OpenAlex-eligible routes, try OpenAlex first with the bare DOI.

**The one thing this doesn't cover**: publications with no DOI, resolved
via `/lookup`'s title-search path, which returns a Semantic-Scholar-native
opaque hash (not DOI-shaped). For those, `references`/`citations` still
only try Semantic Scholar — no fallback is attempted, because there's no
DOI to hand to OpenAlex. **This is not a regression** — today, a title-only
paper only ever gets a single shot at Semantic Scholar anyway. It simply
doesn't gain the new capacity/cost benefit. Given DOI coverage is the
common case, this is an acceptable v1 gap rather than something to build
more machinery around.

## Architecture

### New module: `src/openalex.js`

Mirrors the shape of the existing `src/semantic-scholar.js`:

- `normalizePaper(work)` — OpenAlex work JSON → the exact same normalized
  paper shape `semantic-scholar.js` already produces (`paper_id`,
  `external_ids.DOI`, `title`, `abstract`, `year`, `venue`, `url`,
  `citation_count`, `open_access_pdf_url`, `authors`). Abstract
  reconstruction from `abstract_inverted_index` reuses the same approach
  already written once in `src/routes/import.js`'s `reconstructAbstract`
  (that helper should move somewhere shared rather than being duplicated a
  third time).
- `fetchOpenAlexDoiMetadata({ apiKey, doi, signal })`
- `fetchOpenAlexReferences({ apiKey, doi, limit, signal })` — one free
  DOI→work fetch, then hydrates the `referenced_works` id list into full
  paper objects via one `works?filter=openalex_id:ID1|ID2|...` batch call
  (OpenAlex's own filter-list size cap applies here — the implementation
  plan needs to confirm that cap and chunk if `limit` exceeds it, same as
  the seed-chunking already done for Semantic Scholar recommendations).
- `fetchOpenAlexCitations({ apiKey, doi, limit, signal })` — free DOI→work
  fetch for the id, then `works?filter=cites:{id}`.
- `fetchOpenAlexSearch({ apiKey, query, limit, signal })`
- `takeOpenAlexBudget(supabase, config, costUsd)` — dollar-based sibling of
  `takeSemanticScholarRateLimit`.
- Error taxonomy mirrors `semantic-scholar.js`: `openalex_not_found`,
  `openalex_error`, `openalex_timeout`, `openalex_unreachable`, plus one
  RefHub-internal code, `openalex_budget_exceeded`, raised by
  `takeOpenAlexBudget` itself rather than by any upstream response.

No `fetchOpenAlexPaperLookup`/title-search fetcher is needed — `/lookup`'s
title path is out of scope (see above).

### Shared wrapper: `withProviderFallback`

One helper, used inside `references`, `citations`, `doi-metadata`, and
`search` — never in `recommendations` or `/lookup`'s title path:

```js
async function withProviderFallback({ primary, fallback, isFallbackEligible }) {
  try {
    return await primary();
  } catch (error) {
    if (!isFallbackEligible(error)) throw error;
    return await fallback();
  }
}
```

`isFallbackEligible` treats `openalex_budget_exceeded`, `openalex_rate_limited`,
`openalex_error`, `openalex_timeout`, `openalex_unreachable`, and
`openalex_not_found` as fallback triggers. If OpenAlex isn't configured
(`OPENALEX_API_KEY` unset), `primary` is skipped entirely and the route goes
straight to Semantic Scholar — same graceful-degradation shape the
`doi-metadata` route already uses today for a missing Semantic Scholar key.

For `references`/`citations` specifically: `withProviderFallback` is only
invoked when the incoming `paper_id` matches `/^DOI:/i`. If it doesn't
(a Semantic-Scholar-native hash from a title-only `/lookup` resolution),
the handler calls Semantic Scholar directly, unchanged from today, and
`src/openalex.js` is never touched for that request.

Each response gets one additive field, `meta.provider: "openalex" |
"semantic_scholar"`, so we can observe fallback frequency once this is live.
`data` is unchanged either way.

### Cost tracking migration (refhub.io `supabase/migrations`, git-ignored,
applied directly like the rate-limit one)

```sql
CREATE TABLE openalex_budget_state (
    bucket_key text PRIMARY KEY,
    spent_usd numeric NOT NULL DEFAULT 0,
    window_reset_at timestamptz NOT NULL
);

CREATE FUNCTION take_openalex_budget(
    p_bucket_key text,
    p_cost_usd numeric,
    p_daily_budget_usd numeric
) RETURNS TABLE(allowed boolean, spent_usd numeric) ...
```

Same `SELECT ... FOR UPDATE` row-lock pattern as
`take_semantic_scholar_rate_limit`, but the window resets at the next UTC
midnight (`date_trunc('day', now()) + interval '1 day'`) rather than a
rolling N-millisecond window, and the comparison is `spent_usd + p_cost_usd
> p_daily_budget_usd` instead of a request count. Kept as its own table
rather than generalizing the existing rate-limit table/function, to keep
the two migrations independent and separately reviewable/rebasable.

Single-work lookups cost `$0` and always pass; references (piggybacking on
a lookup) cost `$0`; citations and search pass their real per-call cost
(`$0.0001` / `$0.001`) into `take_openalex_budget` before the request goes
out, and skip straight to the Semantic Scholar fallback if that would
exceed `OPENALEX_DAILY_BUDGET_USD` (default `1.00`, i.e. the free daily
budget a key gets).

### Route changes (`functions/api-v1.js`)

- `doi-metadata`: wraps its existing single-provider call in
  `withProviderFallback`. Already takes `{ doi }` directly — no shape
  detection needed.
- `search`: wraps its existing single-provider call in
  `withProviderFallback`. Already takes `{ query, limit }` directly — no
  DOI involved at all.
- `references`/`citations`: **no request/response shape change.** Still
  `{ paper_id, limit }` in, normalized papers out. Internally: if
  `paper_id` is `DOI:`-prefixed, strip it and run it through
  `withProviderFallback` (OpenAlex primary, Semantic Scholar fallback);
  otherwise call Semantic Scholar directly, exactly as today.
- `lookup`: **no change at all.** DOI path already returns a
  provider-agnostic `DOI:<doi>` value; title path stays Semantic-Scholar-only.
- `recommendations`: **no change at all.** It's exclusively Semantic
  Scholar and already accepts `DOI:`-prefixed seed IDs — nothing here
  depends on OpenAlex existing.

### Frontend changes (`refhub.io`)

None. The web app calls the same routes with the same shapes it already
does; this entire feature is invisible to it.

## Testing plan

- `src/openalex.js`: unit tests per fetcher (mocked `fetch`), verifying
  normalized output matches `semantic-scholar.js`'s shape exactly, plus
  abstract reconstruction from inverted index.
- `takeOpenAlexBudget`: unit tests mirroring the existing rate-limit RPC
  tests — allowed, budget-exceeded, RPC-error-throws.
- `withProviderFallback`: unit tests — primary succeeds (fallback never
  called), primary fails with an eligible error (fallback called, result
  returned), primary fails with an ineligible error (throws, fallback
  never called), OpenAlex not configured (fallback called directly,
  primary never invoked).
- Handler-level tests per route:
  - `references`/`citations`: `DOI:`-prefixed `paper_id` → OpenAlex tried
    first, Semantic Scholar on eligible failure; non-DOI `paper_id` →
    Semantic Scholar only, `src/openalex.js` never invoked.
  - `doi-metadata`/`search`: OpenAlex succeeds → no SS call; OpenAlex
    budget-exceeded → SS called, response still 200 with the right shape;
    both fail → real error surfaced.
  - `lookup`: unchanged behavior, regression test only.
  - One explicit test asserting the recommendations route never imports or
    calls anything from `openalex.js`.
- No frontend test changes needed — nothing there changes.

## Rollout

- New branch (`.netlify` only — `refhub.io` needs no code change, just the
  git-ignored migration file, matching the rate-limit PR's pattern), based
  off current `main`, separate from the still-unmerged rate-limit PRs
  (#151, #27). Rebase onto updated `main` once those merge, since
  `recommendations` already relies on that PR's batched
  `fetchSemanticScholarRecommendations` signature.
- Migration applied to production the same way as the rate-limit one:
  user runs it directly (git-ignored in this repo), before the `.netlify`
  deploy that depends on `take_openalex_budget` existing.
- `OPENALEX_API_KEY` set by the user in the Netlify dashboard; absent means
  the whole feature no-ops back to Semantic Scholar-only, unchanged from
  today.
