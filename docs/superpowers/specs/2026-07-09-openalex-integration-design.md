# OpenAlex integration: primary metadata provider with Semantic Scholar fallback

## Problem

Semantic Scholar is the only external metadata/discovery provider today. Even
after fixing the rate limiter to be a real global bucket (see
`2026-07-09` rate-limit work, PR #27), the whole backend still shares one
Semantic Scholar API key at roughly 1 req/sec, globally, across every RefHub
user. That's a hard ceiling that can't grow without a different Semantic
Scholar pricing tier.

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

- OpenAlex primary / Semantic Scholar fallback for: DOI metadata, lookup
  (DOI or title), references, citations, and topic search.
- Recommendations (the vault "related papers" batch tab) stays 100%
  Semantic Scholar — OpenAlex has no set-based ML recommender, only a
  precomputed per-paper `related_works` list, which is a different thing.
- The frontend never has to know which provider answered. Same routes,
  same request/response shapes as today, for every existing consumer
  (the web app and `refhub-cli`, which calls these routes directly with a
  RefHub API key).
- Never actually get billed by OpenAlex. Hard-stop at the free daily budget
  and fail over to Semantic Scholar instead.

## Non-goals

- No UI for viewing/adjusting the OpenAlex budget (server-side guard only,
  for now).
- No use of OpenAlex's `related_works` field anywhere — recommendations
  stays untouched, still exclusively Semantic Scholar.
- No renaming of existing route *paths* — `doi-metadata`, `lookup`,
  `references`, `citations`, `search`, and `recommendations` keep their
  current URLs. This does **not** mean every request/response shape stays
  identical: `references`/`citations` specifically must change shape (see
  Route changes below) since their input can no longer be a pre-resolved,
  provider-specific `paper_id`. That's a deliberate, flagged break for
  `refhub-cli`'s `discover` command, not an oversight — see Rollout.

## Why DOI works as the one identifier

Verified live against both APIs (not assumed):

- **Semantic Scholar** accepts `DOI:<doi>` directly as the paper identifier
  for the base lookup, `/references`, `/citations`, *and* in
  `positivePaperIds` for `/recommendations/v1/papers`. No separate
  lookup-to-internal-ID step is ever required on the Semantic Scholar side.
- **OpenAlex** accepts a DOI directly for `GET /works/doi:{doi}`, which
  returns `referenced_works` (reference list) and `related_works` embedded
  in the same free response. Its `cites`/`cited_by` filter, however,
  requires OpenAlex's own `W...` ID, not a DOI — so citations need one
  internal (free) DOI→work hop before the (cheap) filter call. This is
  invisible outside `src/openalex.js`.
- For publications with **no DOI**, both providers support a title-based
  secondary path (OpenAlex `works?search=`, Semantic Scholar
  `/paper/search`), used only when the DOI path isn't available.

Because DOI is a first-class identifier on both sides, no route needs to
pre-resolve to a provider-specific opaque ID, and no route needs to reason
about "whose ID is this." Every route's external contract is `{doi, title}`
in, normalized papers out — never a provider ID.

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
- `fetchOpenAlexPaperLookup({ apiKey, queryType: 'doi' | 'title', queryValue, signal })`
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

### Shared wrapper: `withProviderFallback`

One helper, used by every route except recommendations:

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

`doi-metadata`, `lookup`, `references`, `citations`, `search` each wrap
their existing single-provider call in `withProviderFallback`. Request
bodies for `references`/`citations` change from `{ paper_id, limit }` to
`{ doi?, title?, limit }` (title used only when `doi` is absent) — this is
a breaking shape change for those two routes specifically, since the old
`paper_id` concept (Semantic-Scholar-only, pre-resolved via `/lookup`) no
longer has a cross-provider equivalent. `refhub-cli`'s `discover` command
uses these routes and will need a matching update (tracked separately, not
in this repo).

`recommendations` changes from taking a pre-resolved `paper_id` to taking
`{ doi?, title? }` per seed directly (`positivePaperIds` built from
`DOI:<doi>` where available, falling back to an internal
Semantic-Scholar-only title lookup per seed otherwise) — but stays
exclusively Semantic Scholar; `withProviderFallback` is not used here at
all.

### Frontend changes (`refhub.io`)

- `lookupPaperByDOI`/`lookupPaperByTitle`/`resolveSelectedPaperIds` and the
  `ResolvedPaper`/`resolvedPaperIds` ref in `VaultAugmentDialog.tsx` are
  deleted — no route needs a pre-resolved ID anymore.
- `getReferences`/`getCitations` take `{ doi?, title? }` instead of a
  `paperId` string.
- `getRecommendationsForSet` takes `{ doi?, title? }[]` instead of
  `paperId[]`.
- `fetchRelated` and `fetchTabData` in `VaultAugmentDialog.tsx` build seeds
  directly from `publications`/the selected publication, no lookup stage
  first.

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
- Handler-level tests per route: OpenAlex succeeds → no SS call; OpenAlex
  budget-exceeded → SS called, response still 200 with the right shape;
  both fail → real error surfaced. One explicit test asserting the
  recommendations route never imports or calls anything from
  `openalex.js`.
- Frontend: updated tests for `getReferences`/`getCitations`/
  `getRecommendationsForSet`'s new request shapes; a test confirming
  `VaultAugmentDialog` no longer references `lookupPaperByDOI`/`ByTitle`.

## Rollout

- New branch off current `main` (both `refhub.io` and `.netlify`), separate
  from the rate-limit PRs (#151, #27). Once those merge, this branch
  rebases onto the updated `main` to pick up the global rate-limit bucket
  and batched-recommendations work, since recommendations' DOI-based
  `positivePaperIds` change builds directly on that PR's
  `fetchSemanticScholarRecommendations` signature.
- Migration applied to production the same way as the rate-limit one:
  user runs it directly (git-ignored in this repo), before the `.netlify`
  deploy that depends on `take_openalex_budget` existing.
- `OPENALEX_API_KEY` set by the user in the Netlify dashboard; absent means
  the whole feature no-ops back to Semantic Scholar-only, unchanged from
  today.
