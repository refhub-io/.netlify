# Changelog

All notable changes to `@refhub/api` are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/). History prior to
2.2.0 was not tracked in this file.

## [2.4.0] - 2026-07-17

### Added
- OpenAlex fallback extended to the two routes 2.3.0 explicitly left on
  Semantic Scholar only:
  - `/semantic-scholar/recommendations` (and its `/related` alias) now
    tries OpenAlex first when every seed in the batch is DOI-addressable,
    approximating Semantic Scholar's recommendations via each seed's own
    `related_works` (OpenAlex's own "works OpenAlex considers related to
    this one" field), unioned and deduplicated across all seeds, then
    falls back to Semantic Scholar on error, exhausted budget, or a batch
    with any non-DOI seed. `src/openalex.js` gains
    `fetchOpenAlexRecommendationsForSet`.
  - `/semantic-scholar/lookup` with a `title` query now tries an OpenAlex
    title search first, using the top result's DOI if it has one, falling
    back to Semantic Scholar otherwise. `src/openalex.js` gains
    `fetchOpenAlexPaperIdByTitle`. DOI-based lookups are unaffected — they
    were already provider-agnostic.
  - Both routes now report `meta.provider`, matching every other
    OpenAlex-backed route.

### Fixed
- These two gaps were the reason vault-augment discovery could still hit
  a hard Semantic Scholar rate limit with zero fallback, despite
  refhub.io's What's New entry for 2.3.0 already (incorrectly) claiming
  full OpenAlex coverage for discovery.

## [2.3.0] - 2026-07-10

### Added
- OpenAlex integrated as the primary metadata/discovery provider for DOI
  metadata, references, citations, and topic search, with automatic
  fallback to Semantic Scholar on error, rate limit, or exhausted daily
  budget. Every route keeps its existing request/response shape; only an
  additive `meta.provider` field (`"openalex"` or `"semantic_scholar"`)
  is new. Recommendations (batch seed papers -> related papers) continue
  to use Semantic Scholar exclusively, since OpenAlex has no equivalent.
- `src/openalex.js`: DOI-metadata, references, citations, and search
  fetchers against the OpenAlex API, plus a daily-budget tracker
  (`takeOpenAlexBudget`) that hard-stops OpenAlex usage at the configured
  free daily budget rather than incurring real billing.
- `src/providerFallback.js`: a small, provider-agnostic
  `withProviderFallback({ primary, fallback, isFallbackEligible,
  onProviderUsed })` helper used by every OpenAlex-backed route so the
  primary/fallback logic isn't duplicated per route.
- `openalex_budget_state` table and `take_openalex_budget` Postgres
  function (see refhub.io's `supabase/migrations`), tracking cumulative
  OpenAlex spend globally across all function instances and resetting at
  UTC midnight, mirroring the existing Semantic Scholar rate-limit
  tracker's design.
- New environment variables: `OPENALEX_API_KEY`, `OPENALEX_DAILY_BUDGET_USD`,
  `OPENALEX_TIMEOUT_MS`. When `OPENALEX_API_KEY` is unset, OpenAlex is
  skipped entirely and every route behaves exactly as it did before this
  change, using Semantic Scholar only.

## [2.2.0] - 2026-07-09

### Added
- `semantic_scholar_rate_limit_state` table and `take_semantic_scholar_rate_limit`
  Postgres function (see refhub.io's `supabase/migrations`), backing a single
  global Semantic Scholar rate-limit bucket shared across all function
  instances.
- `/semantic-scholar/recommendations` (and its `/recommendations` legacy
  alias) now accepts a `paper_ids` array, batching recommendations for a
  whole set of seed papers into one upstream Semantic Scholar call instead
  of one call per paper. The single-`paper_id` shape still works.

### Fixed
- Semantic Scholar rate limiting was keyed per-user in an in-process Map,
  so every user got their own allowance against the one shared
  `SEMANTIC_SCHOLAR_API_KEY` — with more than one active user, combined
  traffic routinely exceeded what the key actually permits, surfacing as
  near-constant 429s regardless of the key being configured correctly. The
  limiter is now one global, Postgres-backed bucket shared by every
  function instance.
