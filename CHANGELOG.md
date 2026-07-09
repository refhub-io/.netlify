# Changelog

All notable changes to `@refhub/api` are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/). History prior to
2.2.0 was not tracked in this file.

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
