# Publication Bibliographic Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `PATCH /vaults/:vaultId/items/:itemId` changes a bibliographic field (doi, url, pdf_url, title, authors, etc.), atomically roll that change up to the canonical `publications` row and every sibling `vault_publications` copy of the same paper in other vaults — matching what the RefHub frontend already does, but with a strict, atomic, error-surfacing guarantee the frontend's fire-and-forget version doesn't have.

**Architecture:** A new Postgres function (`update_vault_publication_with_rollup`) does the target-row update, the canonical-row update, and every sibling-row update inside one transaction — an unhandled exception anywhere aborts the whole thing, so partial application is impossible. `functions/api-v1.js`'s `handleUpdateItem` calls this function via `supabase.rpc(...)` instead of a direct `.update()`, and returns a structured `502 publication_rollup_failed` if it fails. `notes` and `tag_ids` are excluded from the rollup by construction — they're either not passed as bibliographic fields, or (tags) handled by unrelated, unchanged code.

**Tech Stack:** PL/pgSQL (refhub.io `supabase/migrations/`), Node.js + `@supabase/supabase-js` (`.netlify` repo), Vitest.

## Global Constraints

- **Spans two repos.** The migration lives in `refhub.io` (alongside the existing `copy_publication_to_vault` function). The handler wiring and tests live in `.netlify` (this repo). Task 1 is a `refhub.io` task; Tasks 2–4 are `.netlify` tasks.
- **Prerequisite for Task 2 only:** this `.netlify` branch was created off `main` before refhub-io/.netlify#22 (issue #21 fixes, including a `pickPublicationFieldsForUpdate` helper in `functions/api-v1.js`) merged. Task 2's code assumes `pickPublicationFieldsForUpdate(body)` already exists and is what `handleUpdateItem` calls to build `updateRow` (replacing the older, buggy `pickPublicationFields(body)` which force-defaults missing fields). **Before starting Task 2, run `grep -n "pickPublicationFieldsForUpdate" functions/api-v1.js`. If it prints nothing, stop and rebase this branch onto the latest `main` first** (after #22 or its split successor has merged) — do not reimplement that fix here. Task 1 and Task 3 have no such dependency and can run in any order relative to this.
- **Bibliographic field list** (29 fields — every column in `PUBLICATION_FIELDS` except `notes`): `title, authors, year, journal, volume, issue, pages, doi, url, abstract, pdf_url, bibtex_key, publication_type, booktitle, chapter, edition, editor, howpublished, institution, number, organization, publisher, school, series, type, eid, isbn, issn, keywords`. `notes` is applied to the target row only (it's already part of `pickPublicationFieldsForUpdate`'s output today) and must never appear in the canonical/sibling updates. `tag_ids` is handled entirely outside this mechanism (unchanged existing code in `handleUpdateItem`).
- **Strict atomicity, no partial success.** Any failure anywhere in the rollup must leave the database completely unchanged and must be reported to the caller — never silently swallowed, never reported as a 200 with only some of the writes applied.

---

## File map

| Repo | Path | Responsibility |
|---|---|---|
| `refhub.io` | `supabase/migrations/20260706000000_publication_bibliographic_rollup.sql` | New `update_vault_publication_with_rollup` function |
| `.netlify` | `functions/api-v1.js` | `handleUpdateItem` calls the RPC instead of a direct `.update()` |
| `.netlify` | `src/routes/utils.js` | Add `pickPublicationFieldsForUpdate` (mirrors the one already added to `functions/api-v1.js` by #22, but this file's copy is independent — see file header comment) |
| `.netlify` | `src/routes/items.js` | `handleBulkUpsertItems`'s matched-update branch uses the new helper instead of `pickPublicationFields` |
| `.netlify` | `tests/handler-update-item.test.js` | Full rewrite: RPC-call assertions replace the old direct-`.update()` assertions, plus new tests for the tag-only-skip and RPC-failure paths |
| `.netlify` | `tests/routes/items.test.js` | New regression test for the upsert field-wiping fix |
| `.netlify` | `README.md` | Document the new `502 publication_rollup_failed` error and the rollup behavior |

---

### Task 1: `update_vault_publication_with_rollup` Postgres function

**Repo:** `refhub.io`

**Files:**
- Create: `supabase/migrations/20260706000000_publication_bibliographic_rollup.sql`

**Interfaces:**
- Produces: `update_vault_publication_with_rollup(p_vault_publication_id uuid, p_vault_id uuid, p_patch jsonb, p_actor_user_id uuid) RETURNS void`, callable via `supabase.rpc("update_vault_publication_with_rollup", { p_vault_publication_id, p_vault_id, p_patch, p_actor_user_id })` from Task 2. On success, the target row, canonical row, and all sibling rows are updated. On any failure, raises an exception (nothing is applied) — PostgREST surfaces this to `supabase-js` as `{ data: null, error: { message, code, ... } }`.

There is no automated SQL test harness in this repo (no `supabase/config.toml`, no pgTAP) — migrations are verified manually against a real Supabase project before merge, same as existing migrations. This task's "test cycle" is the manual verification script in Step 2.

- [ ] **Step 1: Write the migration**

```sql
-- 20260706000000_publication_bibliographic_rollup.sql
--
-- Rolls up bibliographic-field edits from one vault_publications copy to the
-- canonical publications row and every sibling vault_publications copy
-- (same original_publication_id, different vault), atomically. Parameters
-- are p_-prefixed to avoid the ambiguous-column-reference bug fixed in
-- migration 006 (a bare `vault_id = vault_id` inside a function body is
-- parsed as comparing the column to itself, not to the parameter, if the
-- parameter shares the column's name).
--
-- notes is intentionally never part of the bibliographic field list below —
-- it's vault-local and, like tag_ids, must never propagate.

CREATE OR REPLACE FUNCTION "public"."update_vault_publication_with_rollup"(
    "p_vault_publication_id" "uuid",
    "p_vault_id" "uuid",
    "p_patch" "jsonb",
    "p_actor_user_id" "uuid"
) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_original_id uuid;
    v_has_bibliographic_patch boolean;
BEGIN
    UPDATE vault_publications SET
        title = CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE title END,
        authors = CASE WHEN p_patch ? 'authors' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'authors')) ELSE authors END,
        year = CASE WHEN p_patch ? 'year' THEN (p_patch->>'year')::integer ELSE year END,
        journal = CASE WHEN p_patch ? 'journal' THEN p_patch->>'journal' ELSE journal END,
        volume = CASE WHEN p_patch ? 'volume' THEN p_patch->>'volume' ELSE volume END,
        issue = CASE WHEN p_patch ? 'issue' THEN p_patch->>'issue' ELSE issue END,
        pages = CASE WHEN p_patch ? 'pages' THEN p_patch->>'pages' ELSE pages END,
        doi = CASE WHEN p_patch ? 'doi' THEN p_patch->>'doi' ELSE doi END,
        url = CASE WHEN p_patch ? 'url' THEN p_patch->>'url' ELSE url END,
        abstract = CASE WHEN p_patch ? 'abstract' THEN p_patch->>'abstract' ELSE abstract END,
        pdf_url = CASE WHEN p_patch ? 'pdf_url' THEN p_patch->>'pdf_url' ELSE pdf_url END,
        bibtex_key = CASE WHEN p_patch ? 'bibtex_key' THEN p_patch->>'bibtex_key' ELSE bibtex_key END,
        publication_type = CASE WHEN p_patch ? 'publication_type' THEN p_patch->>'publication_type' ELSE publication_type END,
        notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
        booktitle = CASE WHEN p_patch ? 'booktitle' THEN p_patch->>'booktitle' ELSE booktitle END,
        chapter = CASE WHEN p_patch ? 'chapter' THEN p_patch->>'chapter' ELSE chapter END,
        edition = CASE WHEN p_patch ? 'edition' THEN p_patch->>'edition' ELSE edition END,
        editor = CASE WHEN p_patch ? 'editor' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'editor')) ELSE editor END,
        howpublished = CASE WHEN p_patch ? 'howpublished' THEN p_patch->>'howpublished' ELSE howpublished END,
        institution = CASE WHEN p_patch ? 'institution' THEN p_patch->>'institution' ELSE institution END,
        number = CASE WHEN p_patch ? 'number' THEN p_patch->>'number' ELSE number END,
        organization = CASE WHEN p_patch ? 'organization' THEN p_patch->>'organization' ELSE organization END,
        publisher = CASE WHEN p_patch ? 'publisher' THEN p_patch->>'publisher' ELSE publisher END,
        school = CASE WHEN p_patch ? 'school' THEN p_patch->>'school' ELSE school END,
        series = CASE WHEN p_patch ? 'series' THEN p_patch->>'series' ELSE series END,
        type = CASE WHEN p_patch ? 'type' THEN p_patch->>'type' ELSE type END,
        eid = CASE WHEN p_patch ? 'eid' THEN p_patch->>'eid' ELSE eid END,
        isbn = CASE WHEN p_patch ? 'isbn' THEN p_patch->>'isbn' ELSE isbn END,
        issn = CASE WHEN p_patch ? 'issn' THEN p_patch->>'issn' ELSE issn END,
        keywords = CASE WHEN p_patch ? 'keywords' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'keywords')) ELSE keywords END,
        version = version + 1,
        updated_at = now()
    WHERE id = p_vault_publication_id AND vault_id = p_vault_id
    RETURNING original_publication_id INTO v_original_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'vault publication % not found in vault %', p_vault_publication_id, p_vault_id
            USING ERRCODE = 'P0002';
    END IF;

    v_has_bibliographic_patch := p_patch ?| ARRAY[
        'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'doi', 'url',
        'abstract', 'pdf_url', 'bibtex_key', 'publication_type', 'booktitle', 'chapter',
        'edition', 'editor', 'howpublished', 'institution', 'number', 'organization',
        'publisher', 'school', 'series', 'type', 'eid', 'isbn', 'issn', 'keywords'
    ];

    IF v_original_id IS NOT NULL AND v_has_bibliographic_patch THEN
        UPDATE publications SET
            title = CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE title END,
            authors = CASE WHEN p_patch ? 'authors' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'authors')) ELSE authors END,
            year = CASE WHEN p_patch ? 'year' THEN (p_patch->>'year')::integer ELSE year END,
            journal = CASE WHEN p_patch ? 'journal' THEN p_patch->>'journal' ELSE journal END,
            volume = CASE WHEN p_patch ? 'volume' THEN p_patch->>'volume' ELSE volume END,
            issue = CASE WHEN p_patch ? 'issue' THEN p_patch->>'issue' ELSE issue END,
            pages = CASE WHEN p_patch ? 'pages' THEN p_patch->>'pages' ELSE pages END,
            doi = CASE WHEN p_patch ? 'doi' THEN p_patch->>'doi' ELSE doi END,
            url = CASE WHEN p_patch ? 'url' THEN p_patch->>'url' ELSE url END,
            abstract = CASE WHEN p_patch ? 'abstract' THEN p_patch->>'abstract' ELSE abstract END,
            pdf_url = CASE WHEN p_patch ? 'pdf_url' THEN p_patch->>'pdf_url' ELSE pdf_url END,
            bibtex_key = CASE WHEN p_patch ? 'bibtex_key' THEN p_patch->>'bibtex_key' ELSE bibtex_key END,
            publication_type = CASE WHEN p_patch ? 'publication_type' THEN p_patch->>'publication_type' ELSE publication_type END,
            booktitle = CASE WHEN p_patch ? 'booktitle' THEN p_patch->>'booktitle' ELSE booktitle END,
            chapter = CASE WHEN p_patch ? 'chapter' THEN p_patch->>'chapter' ELSE chapter END,
            edition = CASE WHEN p_patch ? 'edition' THEN p_patch->>'edition' ELSE edition END,
            editor = CASE WHEN p_patch ? 'editor' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'editor')) ELSE editor END,
            howpublished = CASE WHEN p_patch ? 'howpublished' THEN p_patch->>'howpublished' ELSE howpublished END,
            institution = CASE WHEN p_patch ? 'institution' THEN p_patch->>'institution' ELSE institution END,
            number = CASE WHEN p_patch ? 'number' THEN p_patch->>'number' ELSE number END,
            organization = CASE WHEN p_patch ? 'organization' THEN p_patch->>'organization' ELSE organization END,
            publisher = CASE WHEN p_patch ? 'publisher' THEN p_patch->>'publisher' ELSE publisher END,
            school = CASE WHEN p_patch ? 'school' THEN p_patch->>'school' ELSE school END,
            series = CASE WHEN p_patch ? 'series' THEN p_patch->>'series' ELSE series END,
            type = CASE WHEN p_patch ? 'type' THEN p_patch->>'type' ELSE type END,
            eid = CASE WHEN p_patch ? 'eid' THEN p_patch->>'eid' ELSE eid END,
            isbn = CASE WHEN p_patch ? 'isbn' THEN p_patch->>'isbn' ELSE isbn END,
            issn = CASE WHEN p_patch ? 'issn' THEN p_patch->>'issn' ELSE issn END,
            keywords = CASE WHEN p_patch ? 'keywords' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'keywords')) ELSE keywords END,
            updated_at = now()
        WHERE id = v_original_id;

        UPDATE vault_publications SET
            title = CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE title END,
            authors = CASE WHEN p_patch ? 'authors' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'authors')) ELSE authors END,
            year = CASE WHEN p_patch ? 'year' THEN (p_patch->>'year')::integer ELSE year END,
            journal = CASE WHEN p_patch ? 'journal' THEN p_patch->>'journal' ELSE journal END,
            volume = CASE WHEN p_patch ? 'volume' THEN p_patch->>'volume' ELSE volume END,
            issue = CASE WHEN p_patch ? 'issue' THEN p_patch->>'issue' ELSE issue END,
            pages = CASE WHEN p_patch ? 'pages' THEN p_patch->>'pages' ELSE pages END,
            doi = CASE WHEN p_patch ? 'doi' THEN p_patch->>'doi' ELSE doi END,
            url = CASE WHEN p_patch ? 'url' THEN p_patch->>'url' ELSE url END,
            abstract = CASE WHEN p_patch ? 'abstract' THEN p_patch->>'abstract' ELSE abstract END,
            pdf_url = CASE WHEN p_patch ? 'pdf_url' THEN p_patch->>'pdf_url' ELSE pdf_url END,
            bibtex_key = CASE WHEN p_patch ? 'bibtex_key' THEN p_patch->>'bibtex_key' ELSE bibtex_key END,
            publication_type = CASE WHEN p_patch ? 'publication_type' THEN p_patch->>'publication_type' ELSE publication_type END,
            booktitle = CASE WHEN p_patch ? 'booktitle' THEN p_patch->>'booktitle' ELSE booktitle END,
            chapter = CASE WHEN p_patch ? 'chapter' THEN p_patch->>'chapter' ELSE chapter END,
            edition = CASE WHEN p_patch ? 'edition' THEN p_patch->>'edition' ELSE edition END,
            editor = CASE WHEN p_patch ? 'editor' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'editor')) ELSE editor END,
            howpublished = CASE WHEN p_patch ? 'howpublished' THEN p_patch->>'howpublished' ELSE howpublished END,
            institution = CASE WHEN p_patch ? 'institution' THEN p_patch->>'institution' ELSE institution END,
            number = CASE WHEN p_patch ? 'number' THEN p_patch->>'number' ELSE number END,
            organization = CASE WHEN p_patch ? 'organization' THEN p_patch->>'organization' ELSE organization END,
            publisher = CASE WHEN p_patch ? 'publisher' THEN p_patch->>'publisher' ELSE publisher END,
            school = CASE WHEN p_patch ? 'school' THEN p_patch->>'school' ELSE school END,
            series = CASE WHEN p_patch ? 'series' THEN p_patch->>'series' ELSE series END,
            type = CASE WHEN p_patch ? 'type' THEN p_patch->>'type' ELSE type END,
            eid = CASE WHEN p_patch ? 'eid' THEN p_patch->>'eid' ELSE eid END,
            isbn = CASE WHEN p_patch ? 'isbn' THEN p_patch->>'isbn' ELSE isbn END,
            issn = CASE WHEN p_patch ? 'issn' THEN p_patch->>'issn' ELSE issn END,
            keywords = CASE WHEN p_patch ? 'keywords' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'keywords')) ELSE keywords END,
            updated_at = now(),
            updated_by = p_actor_user_id
        WHERE original_publication_id = v_original_id AND id <> p_vault_publication_id;
    END IF;
END;
$$;

ALTER FUNCTION "public"."update_vault_publication_with_rollup"("p_vault_publication_id" "uuid", "p_vault_id" "uuid", "p_patch" "jsonb", "p_actor_user_id" "uuid") OWNER TO "postgres";
```

Note on atomicity: this needs no explicit `BEGIN`/`COMMIT` inside the function body. A PL/pgSQL function body already executes as a single implicit transaction — an unhandled exception at any point (e.g. the `RAISE EXCEPTION` on not-found, or any constraint violation) aborts the entire function invocation and rolls back every write it made, automatically. That's the whole atomicity guarantee; there's no separate mechanism to add.

- [ ] **Step 2: Manual verification against a dev Supabase project**

There's no automated harness for this, so run the following in the Supabase SQL editor (or `psql`) against a **dev/staging** project only, after applying the migration above. Replace `<TEST_USER_ID>` with a real `id` from that project's `auth.users` table (e.g. `select id from auth.users limit 1;`).

```sql
-- Setup: one canonical publication, two vault copies in two different vaults.
INSERT INTO vaults (id, user_id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', '<TEST_USER_ID>', 'Rollup Test Vault A'),
  ('22222222-2222-2222-2222-222222222222', '<TEST_USER_ID>', 'Rollup Test Vault B');

INSERT INTO publications (id, user_id, title, doi) VALUES
  ('33333333-3333-3333-3333-333333333333', '<TEST_USER_ID>', 'Original Title', '10.1/original');

INSERT INTO vault_publications (id, vault_id, original_publication_id, title, doi, notes, version) VALUES
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'Original Title', '10.1/original', 'vault A notes', 1),
  ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'Original Title', '10.1/original', 'vault B notes', 1);

-- Edit vault A's copy: change doi and notes together.
SELECT update_vault_publication_with_rollup(
  '44444444-4444-4444-4444-444444444444'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  '{"doi": "10.1/updated", "notes": "vault A notes, edited"}'::jsonb,
  '<TEST_USER_ID>'::uuid
);

-- Expect: vault A's own row has the new doi AND the new notes, version bumped to 2.
SELECT doi, notes, version FROM vault_publications WHERE id = '44444444-4444-4444-4444-444444444444';
-- doi = '10.1/updated', notes = 'vault A notes, edited', version = 2

-- Expect: canonical row has the new doi.
SELECT doi FROM publications WHERE id = '33333333-3333-3333-3333-333333333333';
-- doi = '10.1/updated'

-- Expect: vault B's sibling copy has the new doi, but its OWN notes are untouched
-- (notes never propagates), and its version is still 1 (siblings don't bump version).
SELECT doi, notes, version, updated_by FROM vault_publications WHERE id = '55555555-5555-5555-5555-555555555555';
-- doi = '10.1/updated', notes = 'vault B notes' (unchanged), version = 1, updated_by = '<TEST_USER_ID>'

-- Not-found path: wrong vault_id for a real item id should raise, not silently no-op.
SELECT update_vault_publication_with_rollup(
  '44444444-4444-4444-4444-444444444444'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,  -- wrong vault on purpose
  '{"doi": "10.1/should-not-apply"}'::jsonb,
  '<TEST_USER_ID>'::uuid
);
-- Expect: ERROR: vault publication 44444444-... not found in vault 22222222-...

-- Cleanup
DELETE FROM vault_publications WHERE id IN ('44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555');
DELETE FROM publications WHERE id = '33333333-3333-3333-3333-333333333333';
DELETE FROM vaults WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
```

Confirm every `-- Expect:` comment matches actual output before proceeding.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260706000000_publication_bibliographic_rollup.sql
git commit -m "feat: add update_vault_publication_with_rollup Postgres function"
```

---

### Task 2: Wire `handleUpdateItem` to the rollup RPC

**Repo:** `.netlify` (this repo)

**Files:**
- Modify: `functions/api-v1.js:1912-1925` (inside `handleUpdateItem` — line numbers as of this branch's pre-#22 baseline; will shift slightly after the prerequisite rebase, but the surrounding code shown in Step 4 is unique enough to locate unambiguously)
- Modify: `tests/handler-update-item.test.js` (full replacement)

**Interfaces:**
- Consumes: `pickPublicationFieldsForUpdate(body)` (from #22, see prerequisite check below) — returns an object containing only the fields present in `body`, restricted to `PUBLICATION_FIELDS`, no defaults applied.
- Consumes: `update_vault_publication_with_rollup` RPC from Task 1 — `supabase.rpc("update_vault_publication_with_rollup", { p_vault_publication_id, p_vault_id, p_patch, p_actor_user_id })`, resolves to `{ data, error }`.
- Produces: `handleUpdateItem` now returns `502 publication_rollup_failed` (via the existing `errorResponse` helper) instead of throwing, when the RPC fails.

- [ ] **Step 1: Verify the prerequisite**

```bash
grep -n "pickPublicationFieldsForUpdate" functions/api-v1.js
```

Expected: at least one match (the function definition, plus its use inside `handleUpdateItem`). If this prints nothing, **stop** — rebase this branch onto the latest `main` (after refhub-io/.netlify#22 or its split successor has merged) before continuing.

- [ ] **Step 2: Write the failing tests**

Replace the entire contents of `tests/handler-update-item.test.js` with:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

import { authenticateApiKey } from "../src/auth.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeCapturingSupabaseMulti, parseBody } from "./helpers.js";

const VAULT = { id: "vault-1", user_id: "user-test", visibility: "private" };

const EXISTING_ITEM = {
  id: "item-1",
  vault_id: "vault-1",
  title: "Deep Learning for Vision",
  authors: ["ada lovelace", "alan turing"],
  year: 2019,
  publication_type: "book",
  pdf_url: null,
  version: 1,
};

function makePatchEvent(body) {
  return {
    httpMethod: "PATCH",
    path: "/api/v1/vaults/vault-1/items/item-1",
    headers: {
      origin: "https://refhub.io",
      authorization: "Bearer rhk_test_secret",
      "content-type": "application/json",
    },
    queryStringParameters: null,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** Builds the mock supabase client + a spy for the rollup RPC. */
function makeSupabaseWithRpc({ existingItem = EXISTING_ITEM, refreshedItem, rpcError = null } = {}) {
  const supabase = makeCapturingSupabaseMulti(
    {
      vaults: [{ data: VAULT, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [
        { data: existingItem, error: null }, // existingResult read
        { data: refreshedItem ?? existingItem, error: null }, // refreshed read
      ],
    },
    ["vault_publications"],
  ).supabase;

  const rpc = vi.fn().mockResolvedValue({ data: null, error: rpcError });
  supabase.rpc = rpc;

  return { supabase, rpc };
}

describe("PATCH /vaults/:vaultId/items/:itemId — bibliographic rollup", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    process.env.REFHUB_API_MAX_BODY_BYTES = String(50 * 1024 * 1024);
    process.env.GOOGLE_DRIVE_MAX_UPLOAD_BYTES = String(25 * 1024 * 1024);
    vi.mocked(authenticateApiKey).mockReset();
  });

  it("calls the rollup RPC with only the fields the caller sent, no defaults", async () => {
    const { supabase, rpc } = makeSupabaseWithRpc({
      refreshedItem: { ...EXISTING_ITEM, pdf_url: "https://drive.example/view", version: 2 },
    });
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"], userId: "user-test" }),
    });

    const res = await handler(makePatchEvent({ pdf_url: "https://drive.example/view" }));

    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith("update_vault_publication_with_rollup", {
      p_vault_publication_id: "item-1",
      p_vault_id: "vault-1",
      p_patch: { pdf_url: "https://drive.example/view" },
      p_actor_user_id: "user-test",
    });
    const body = parseBody(res);
    expect(body.data.pdf_url).toBe("https://drive.example/view");
  });

  it("still applies fields the caller explicitly sends, via the RPC patch", async () => {
    const { supabase, rpc } = makeSupabaseWithRpc({
      refreshedItem: { ...EXISTING_ITEM, title: "New Title", version: 2 },
    });
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"], userId: "user-test" }),
    });

    const res = await handler(makePatchEvent({ title: "New Title" }));

    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "update_vault_publication_with_rollup",
      expect.objectContaining({ p_patch: { title: "New Title" } }),
    );
  });

  it("does not call the RPC when the PATCH only touches tag_ids", async () => {
    const { supabase, rpc } = makeSupabaseWithRpc();
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"], userId: "user-test" }),
    });

    const res = await handler(makePatchEvent({ tag_ids: [] }));

    expect(res.statusCode).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns a structured 502 and does not report success when the rollup RPC fails", async () => {
    const { supabase, rpc } = makeSupabaseWithRpc({
      rpcError: { message: "vault publication item-1 not found in vault vault-1", code: "P0002" },
    });
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"], userId: "user-test" }),
    });

    const res = await handler(makePatchEvent({ doi: "10.1/new" }));

    expect(res.statusCode).toBe(502);
    const body = parseBody(res);
    expect(body.error.code).toBe("publication_rollup_failed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run tests/handler-update-item.test.js
```

Expected: all 4 tests FAIL — `handleUpdateItem` still calls `.update()` directly, so `rpc` is never invoked and the assertions on it fail; the 502 test fails because the current code throws (uncaught) rather than returning a structured 502.

- [ ] **Step 4: Implement the change**

In `functions/api-v1.js`, inside `handleUpdateItem`, replace:

```js
  if (Object.keys(updateRow).length > 0) {
    updateRow.version = (existingResult.data.version || 1) + 1;
    updateRow.updated_at = new Date().toISOString();

    const updateResult = await supabase
      .from("vault_publications")
      .update(updateRow)
      .eq("id", itemId)
      .eq("vault_id", vaultId);

    if (updateResult.error) {
      throw updateResult.error;
    }
  }
```

with:

```js
  if (Object.keys(updateRow).length > 0) {
    const rollupResult = await supabase.rpc("update_vault_publication_with_rollup", {
      p_vault_publication_id: itemId,
      p_vault_id: vaultId,
      p_patch: updateRow,
      p_actor_user_id: principal.userId,
    });

    if (rollupResult.error) {
      return errorResponse(
        502,
        "publication_rollup_failed",
        "Failed to apply the update across the canonical publication and its vault copies",
        context.requestId,
        { postgres_message: rollupResult.error.message },
      );
    }
  }
```

Note: `version`/`updated_at` are no longer set here — the SQL function bumps them itself as part of the same atomic update.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/handler-update-item.test.js
```

Expected: all 4 tests PASS.

- [ ] **Step 6: Run the full suite to check for regressions**

```bash
npm test
```

Expected: same pass count as before this task, plus these 4 new passes (the one pre-existing, unrelated `google-drive-resumable-cors.test.js` failure is expected and untouched by this change).

- [ ] **Step 7: Commit**

```bash
git add functions/api-v1.js tests/handler-update-item.test.js
git commit -m "feat: roll up PATCH bibliographic edits to canonical publication and sibling vault copies"
```

---

### Task 3: Fix the same field-wiping bug in bulk upsert

**Repo:** `.netlify` (this repo) — no dependency on Task 2 or the #22 prerequisite; can run independently.

**Files:**
- Modify: `src/routes/utils.js`
- Modify: `src/routes/items.js:162-167` (inside `handleBulkUpsertItems`)
- Modify: `tests/routes/items.test.js`

**Interfaces:**
- Produces: `pickPublicationFieldsForUpdate(input)` in `src/routes/utils.js` — same shape as the existing `pickPublicationFields(input)` in that file, but without the default-filling (`authors`/`editor`/`keywords` defaulting to `[]`, `publication_type` defaulting to `'article'`).

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/items.test.js`, inside the existing `describe("handleBulkUpsertItems", ...)` block:

```js
  it("does not clear authors or reset publication_type on a matched partial update", async () => {
    const vault = makeMockVault();
    const existing = { id: "vp1", doi: "10.1/existing", version: 1 };
    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        vault_shares: [{ data: null, error: null }],
        vault_publications: [
          { data: [existing], error: null }, // DOI dedup lookup — matches
          { data: { id: "vp1", doi: "10.1/updated", version: 2 }, error: null }, // update().select().single()
        ],
      },
      ["vault_publications"],
    );
    const principal = makeApiKeyPrincipal();
    // Only doi is provided — authors/publication_type are deliberately omitted.
    const event = makeEvent({ body: JSON.stringify({ items: [{ doi: "10.1/updated" }] }) });

    const res = await handleBulkUpsertItems(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    const updateArg = captured.vault_publications.updates[0];
    expect(updateArg).toBeDefined();
    expect(updateArg.doi).toBe("10.1/updated");
    // Buggy code force-defaults these on any update; fixed code omits untouched fields entirely.
    expect(updateArg).not.toHaveProperty("authors");
    expect(updateArg).not.toHaveProperty("publication_type");
    expect(updateArg).not.toHaveProperty("editor");
    expect(updateArg).not.toHaveProperty("keywords");
  });
```

Also update the file's import line to include `makeCapturingSupabaseMulti`:

```js
import {
  makeMockSupabase,
  makeMockSupabaseMulti,
  makeCapturingSupabaseMulti,
  makeApiKeyPrincipal,
  makeContext,
  makeEvent,
  makeMockVault,
  parseBody,
} from "../helpers.js";
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/routes/items.test.js -t "does not clear authors or reset publication_type on a matched partial update"
```

Expected: FAIL — `updateArg` currently has `authors: []` and `publication_type: "article"` because `handleBulkUpsertItems` still calls `pickPublicationFields`, not a for-update variant.

- [ ] **Step 3: Add `pickPublicationFieldsForUpdate` to `src/routes/utils.js`**

Add immediately after the existing `pickPublicationFields` function:

```js
/**
 * Same field allow-list as pickPublicationFields, but for partial updates:
 * only fields actually present in the input are included, with no defaults
 * applied. pickPublicationFields' defaults (empty arrays, 'article' type)
 * are correct for creating a new row but wipe existing values when reused
 * for a partial update, since any field the caller omits should stay
 * untouched.
 */
export function pickPublicationFieldsForUpdate(input) {
  const row = {};
  for (const field of PUBLICATION_FIELDS) {
    if (input[field] !== undefined) {
      row[field] = input[field];
    }
  }
  return row;
}
```

- [ ] **Step 4: Use it in `handleBulkUpsertItems`'s matched-update branch**

In `src/routes/items.js`, this task's baseline (before the #22 prerequisite rebase — see Global Constraints) has:

```js
import { VAULT_PUBLICATION_SELECT, pickPublicationFields, touchVaultUpdatedAt } from "./utils.js";
```

Add `pickPublicationFieldsForUpdate` to that import:

```js
import { VAULT_PUBLICATION_SELECT, pickPublicationFields, pickPublicationFieldsForUpdate, touchVaultUpdatedAt } from "./utils.js";
```

(If this branch has since been rebased onto a `main` that already includes #22, this line will also already import `attachDrivePdfUrls` — in that case just add `pickPublicationFieldsForUpdate` to whatever the import list already is, everything else in this step is unaffected.)

Then change the matched-update branch from:

```js
      if (existing) {
        const updateRow = {
          ...pickPublicationFields(item),
          version: (existing.version || 1) + 1,
          updated_at: new Date().toISOString(),
        };
```

to:

```js
      if (existing) {
        const updateRow = {
          ...pickPublicationFieldsForUpdate(item),
          version: (existing.version || 1) + 1,
          updated_at: new Date().toISOString(),
        };
```

(The `created` branch below it, which uses `pickPublicationFields(item)` for brand-new rows, is unchanged — new rows are supposed to get the insert-time defaults.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/routes/items.test.js
```

Expected: all tests in this file PASS, including the new one.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: same pass count as before, plus this new pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/utils.js src/routes/items.js tests/routes/items.test.js
git commit -m "fix: stop bulk upsert from wiping untouched fields on matched updates"
```

---

### Task 4: Document the new error code and run final verification

**Repo:** `.netlify` (this repo)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the error code to the PATCH docs**

Find the existing line in `README.md`:

```
### `PATCH /api/v1/vaults/:vaultId/items/:itemId`

scope: `vaults:write` · permission: editor. partial update. if `tag_ids` is present it replaces the full tag set.
```

Replace it with:

```
### `PATCH /api/v1/vaults/:vaultId/items/:itemId`

scope: `vaults:write` · permission: editor. partial update. if `tag_ids` is present it replaces the full tag set.

bibliographic fields (everything in the publication field set except `notes`) are rolled up atomically to the canonical `publications` row and every sibling `vault_publications` copy of the same paper in other vaults — matching the RefHub frontend's own propagation rule. `notes` and `tag_ids` are vault-local and never propagate. The rollup is all-or-nothing: on failure, nothing is applied and the response is `502 publication_rollup_failed` with the underlying database error in `details.postgres_message` — never a partial update reported as success.
```

- [ ] **Step 2: Run the full test suite and syntax check one more time**

```bash
npm test
npm run check
```

Expected: same results as the end of Task 3 (no new failures); `npm run check` prints nothing (success).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document publication_rollup_failed and the PATCH rollup contract"
```
