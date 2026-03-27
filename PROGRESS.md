# Progress

## Implemented in this scaffold

- implementation-ready API v1 spec and routing plan
- Netlify config for `/api/v1/*`
- shared API-key verification helpers using hashed key lookup plus scopes
- vault restriction checks via `api_key_vaults`
- best-effort audit logging hook
- initial handlers for list/create/revoke API keys plus list vaults, read vault, add items, update items, and export vault
- Supabase migration for `api_keys`, `api_key_vaults`, and `api_request_audit_logs`

## Delegated status

- 2026-03-24 07:50 CET: backend hardening pass started on branch `chore/backend-hardening-2026-03-24`
- 2026-03-24 07:50 CET: implementing priority fixes for error leakage, 4xx validation handling, bulk-write failure semantics, audit-log resilience, and API-key consistency
- 2026-03-24 08:02 CET: syntax checks passed via `npm run check`; helper smoke checks passed for JSON/body-size parsing and BibTeX sanitization
- 2026-03-24 08:05 CET: hardening patch finalized after diff review; branch ready for commit and push
- 2026-03-24 09:07 CET: API key management implementation started on `/api/v1/keys` with separate Supabase JWT auth path
- 2026-03-24 09:16 CET: management route handlers added for list/create/revoke; server-side key issuance and ownership checks wired
- 2026-03-24 09:21 CET: local verification passed for syntax and diff hygiene; runtime smoke import blocked locally because `@supabase/supabase-js` is not installed in this checkout
- 2026-03-27 08:30 CET: Semantic Scholar recommendations backend route added on `POST /api/v1/recommendations` with Supabase session JWT auth only and explicit RefHub API-key rejection
- 2026-03-27 08:30 CET: server-side Semantic Scholar proxy helper added with lean paper normalization and optional `SEMANTIC_SCHOLAR_API_KEY` support
- 2026-03-27 08:45 CET: Semantic Scholar references/citations backend routes added on `POST /api/v1/references` and `POST /api/v1/citations` with the same Supabase JWT-only auth mode and lean normalized response shape
- 2026-03-27 08:45 CET: shared Semantic Scholar paper-list request validation/normalization expanded so recommendations, references, and citations stay aligned for frontend use
- 2026-03-27 09:00 CET: Semantic Scholar backend hardening applied on the existing PR branch with sanitized upstream errors, consistent shared route handling, short in-memory response caching, and lightweight per-user throttling for the JWT-only routes

## Still pending

- live end-to-end testing against deployed Supabase/Netlify once the backend runtime has dependencies installed and environment variables configured
- transactional write path if add/update needs to become an RPC instead of sequential REST writes
- stricter schema validation and rate limiting
- automated tests once the backend repo/package is wired into CI
- deployment hookup in the actual standalone backend repo if it exists outside this checkout
- live recommendation smoke testing against Semantic Scholar once this environment has outbound network access and runtime env vars available
- live references/citations smoke testing against Semantic Scholar once this environment has outbound network access and runtime env vars available
- load testing or distributed rate limiting if these routes need stronger protection beyond a single warm function instance

## Local repo note

The task referenced a separate `refhub-io/.netlify` repo, but only the `refhub` repo was available locally. This scaffold was created under `refhub/.netlify` as the closest workable fallback.
