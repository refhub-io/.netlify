# AGENTS.md

Process guide for any coding agent (or human) working in this repo — Claude Code, Codex, Cursor, or otherwise. The point is that behavior stays consistent no matter which tool or session is doing the work. This mirrors the same process used in `refhub.io` and `refhub-cli`, adapted for a serverless API backend.

## 1. Check existing conventions first

Before adding or changing a route, read `README.md` (route list, auth model, `src/` structure) and `docs/API_USAGE.md`. Match the existing patterns: session-JWT management routes vs. `rhk_...` API-key data routes, the shared helpers in `src/http.js`/`src/auth.js`, and the response shapes already in use. Don't invent a new convention for one endpoint.

This API is a shared dependency of `refhub.io` and `refhub-cli` (and agent integrations like `refhub-skill`) — a route or response-shape change here can break all of them. Check `docs/V2_ROADMAP.md` for planned direction before making structural changes.

## 2. Do the work that's actually asked for

No unrequested refactors, no speculative abstractions, no drive-by cleanups bundled into an unrelated change. If you notice something else worth fixing while you're in there, say so — don't silently expand the scope of the current task.

## 3. Commit as soon as a fix or feature works

Don't let one commit accumulate multiple unrelated changes, and don't sit on working code uncommitted. As soon as a change does what it was supposed to do, verify it and commit it:

- `npm test` — all tests passing
- `npm run check` — syntax-checks every handler/lib file (`node --check`)
- For anything touching auth, scopes, or RLS-adjacent logic: double-check by hand, this backend has no separate staging environment

Small, working commits are easier to review, bisect, and revert than one large commit at the end.

## 4. Ship as a branch + PR

Never commit directly to `main`. Do the work on a feature/fix branch, then push and open a PR. **`main` deploys automatically via Netlify on merge** — there is no manual deploy gate, so nothing lands on `main` without review.

## 5. Keep `CHANGELOG.md` current

This repo doesn't have a `CHANGELOG.md` yet — the next change that ships should create one, following the same Keep a Changelog format used in `refhub.io` and `refhub-cli` ("History prior to X.Y.Z was not tracked in this file"). Update it in the same PR as the change it documents; don't let it drift and get backfilled later.

## 6. Versioning policy

Bump `package.json`'s version for every shipped change:

- **Patch** (`2.1.X`): version bump + `CHANGELOG.md` entry. Internal fixes, non-breaking tweaks.
- **Minor** (`2.X.0`): version bump + `CHANGELOG.md` entry with a clear "Added" section. Use this tier for new endpoints or additive, backward-compatible response fields.
- **Major** (`X.0.0`): version bump + `CHANGELOG.md` entry + a git tag, and call it out explicitly to whoever's touching `refhub.io`/`refhub-cli`/`refhub-skill` in the same work session — this tier is for breaking changes to routes, auth, or response shapes that those consumers depend on.

## Anything else worth doing before you start

- Check `git status` and recent `git log` before touching anything — know what's already in flight versus what you're about to add.
- Run the full test suite once at the start so you know the baseline is green, and any later failure is yours to fix, not inherited.
- If the task is large or the requirements are ambiguous, write a short plan and get it confirmed before touching code — don't guess at scope, especially for anything auth- or RLS-adjacent.
