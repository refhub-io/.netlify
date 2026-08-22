# Contributing to RefHub API

This is the process guide for changes in the `.netlify` backend/API repo. `AGENTS.md` gives coding agents repo-local operating rules; this file is the contributor checklist.

## Brand, style, and identity

Backend docs, route names, examples, errors, and release notes are part of the product surface. Use `refhub-style-guide/refhub-identity.md` for public docs/copy decisions while keeping API responses stable, precise, and automation-friendly.

Core rules:

- Prefer concise, practical wording over marketing copy.
- Preserve lowercase, `//` comment-style headings, snake_case labels, and monospace conventions where the repo surface already uses them.
- Keep examples concrete and operational: vaults, papers, tags, relations, PDFs, exports, agents, and API keys.
- Do not introduce a one-off visual, copy, naming, or interaction style for a single feature.

## Existing conventions

Before adding or changing a route, read `README.md`, `docs/API_USAGE.md`, and nearby handlers in `functions/api-v1.js`.

Preserve existing boundaries:

- session-JWT management routes for account/admin flows;
- `rhk_...` API-key data routes for agent/CLI workflows;
- shared response helpers from `src/http.js`;
- auth and scope helpers from `src/auth.js`;
- route and response shapes that `refhub.io`, `refhub-cli`, and agent skills depend on.

Check `docs/V2_ROADMAP.md` before structural API changes.

## Scope and branch discipline

Do the work that was asked for. Keep unrelated refactors, dependency churn, formatting sweeps, and opportunistic cleanup out of focused PRs unless they are required.

## Pull requests

Never commit directly to `main`. `main` deploys automatically via Netlify after merge.

Use a fresh branch from current `origin/main`:

- `fix/...` for bugs.
- `feature/...` for new endpoints or provider behavior.
- `docs/...` for documentation-only changes.
- `chore/...` for maintenance.

Open a PR for every change.

## Verification

Run the relevant checks before opening a PR:

```sh
npm run check
npm test
```

Some tests require local placeholder env:

```sh
SUPABASE_URL=http://localhost \
SUPABASE_SERVICE_ROLE_KEY=dummy \
REFHUB_API_KEY_PEPPER=dummy \
REFHUB_API_AUDIT_DISABLED=true \
npm test
```

For anything touching auth, scopes, route ownership, or RLS-adjacent behavior, double-check the route family manually. There is no separate staging safety net.

## Changelog and semver

Keep `CHANGELOG.md` current in the same PR as the shipped change. The file uses Keep a Changelog and Semantic Versioning.

Bump `package.json` and `package-lock.json` for shipped changes.

- Patch: internal fixes, documentation that affects API consumers, non-breaking tweaks.
- Minor: new endpoints or additive response fields.
- Major: breaking changes to routes, auth, scopes, or response shapes. Call out major changes explicitly to whoever is touching `refhub.io`, `refhub-cli`, and `refhub-skill` in the same work session.

## Security and credentials

Never commit API keys, bearer tokens, Supabase service-role keys, local env files, production dumps, or user-specific credentials. Examples must use placeholders only.
