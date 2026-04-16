import { describe, it, expect } from "vitest";
import { handleSearchItems, handleGetVaultStats, handleGetVaultChanges } from "../../src/routes/search.js";
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

const CTX = makeContext();

// ─── handleSearchItems ───────────────────────────────────────────────────────

describe("handleSearchItems", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleSearchItems(supabase, principal, CTX, "v1", makeEvent());

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when vault not found", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();

    const res = await handleSearchItems(supabase, principal, CTX, "missing", makeEvent());

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with paginated items", async () => {
    const vault = makeMockVault();
    const items = [{ id: "pub1", title: "Test Paper" }];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: items, error: null, count: 1 }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleSearchItems(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
    expect(body.meta.page).toBe(1);
  });

  it("returns empty array when tag has no items", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publication_tags: [{ data: [], error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ query: { tag: "nonexistent-tag" } });

    const res = await handleSearchItems(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual([]);
    expect(parseBody(res).meta.total).toBe(0);
  });
});

// ─── handleGetVaultStats ─────────────────────────────────────────────────────

describe("handleGetVaultStats", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleGetVaultStats(supabase, principal, CTX, "v1");

    expect(res.statusCode).toBe(403);
  });

  it("includes related_publication_id in the relation count filter", async () => {
    const vault = makeMockVault();
    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        vault_publications: [
          { data: null, error: null, count: 1 },   // items count
          { data: [{ id: "p1" }], error: null },   // pub IDs list
        ],
        tags: [{ data: null, error: null, count: 0 }],
        publication_relations: [{ data: null, error: null, count: 0 }],
      },
      ["publication_relations"],
    );
    const principal = makeApiKeyPrincipal();

    await handleGetVaultStats(supabase, principal, CTX, vault.id);

    const orFilter = captured["publication_relations"].orFilters[0];
    // Buggy code: only "publication_id.eq.p1". Fixed code: also includes "related_publication_id.eq.p1".
    expect(orFilter).toContain("related_publication_id.eq.p1");
  });

  it("returns 200 with counts", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      // Three parallel queries: items count, tags count, pubIds list
      vault_publications: [
        { data: null, error: null, count: 5 },
        { data: [{ id: "p1" }], error: null },
      ],
      tags: [{ data: null, error: null, count: 3 }],
      publication_relations: [{ data: null, error: null, count: 2 }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleGetVaultStats(supabase, principal, CTX, vault.id);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.vault_id).toBe(vault.id);
  });
});

// ─── handleGetVaultChanges ───────────────────────────────────────────────────

describe("handleGetVaultChanges", () => {
  it("returns 400 when since param missing", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleGetVaultChanges(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_query");
  });

  it("returns 400 when since is not a valid date", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ query: { since: "not-a-date" } });

    const res = await handleGetVaultChanges(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with changed items", async () => {
    const vault = makeMockVault();
    const items = [{ id: "pub1", title: "Updated Paper" }];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: items, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ query: { since: "2025-01-01T00:00:00Z" } });

    const res = await handleGetVaultChanges(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toHaveLength(1);
    expect(parseBody(res).meta.since).toBeTruthy();
  });
});
