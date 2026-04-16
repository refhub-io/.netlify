import { describe, it, expect } from "vitest";
import {
  handleListRelations,
  handleCreateRelation,
  handleUpdateRelation,
  handleDeleteRelation,
} from "../../src/routes/relations.js";
import {
  makeMockSupabase,
  makeMockSupabaseMulti,
  makeApiKeyPrincipal,
  makeContext,
  makeEvent,
  makeMockVault,
  parseBody,
} from "../helpers.js";

const CTX = makeContext();

// ─── handleListRelations ─────────────────────────────────────────────────────

describe("handleListRelations", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleListRelations(supabase, principal, CTX, "v1", makeEvent());

    expect(res.statusCode).toBe(403);
  });

  it("returns empty array when vault has no items", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [], error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListRelations(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual([]);
  });

  it("returns 200 with relations", async () => {
    const vault = makeMockVault();
    const relations = [{ id: "r1", publication_id: "p1", related_publication_id: "p2", relation_type: "cites" }];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [{ id: "p1" }], error: null }],
      publication_relations: [{ data: relations, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListRelations(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toHaveLength(1);
  });
});

// ─── handleCreateRelation ────────────────────────────────────────────────────

describe("handleCreateRelation", () => {
  it("returns 400 when self-reference", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({ vaults: { data: vault, error: null }, vault_shares: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ publication_id: "p1", related_publication_id: "p1" }) });

    const res = await handleCreateRelation(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when source item not in vault", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [{ id: "p2" }], error: null }], // only p2 found
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ publication_id: "p1", related_publication_id: "p2" }) });

    const res = await handleCreateRelation(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 201 on success", async () => {
    const vault = makeMockVault();
    const relation = { id: "r1", publication_id: "p1", related_publication_id: "p2", relation_type: "related" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [{ id: "p1" }, { id: "p2" }], error: null }],
      publication_relations: [{ data: relation, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({
      body: JSON.stringify({ publication_id: "p1", related_publication_id: "p2" }),
    });

    const res = await handleCreateRelation(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.id).toBe("r1");
  });
});

// ─── handleUpdateRelation ────────────────────────────────────────────────────

describe("handleUpdateRelation", () => {
  it("returns 404 when relation not found", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publication_relations: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ relation_type: "cites" }) });

    const res = await handleUpdateRelation(supabase, principal, CTX, vault.id, "missing", event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when relation_type missing", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({ vaults: { data: vault, error: null }, vault_shares: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({}) });

    const res = await handleUpdateRelation(supabase, principal, CTX, vault.id, "r1", event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const relation = { id: "r1", publication_id: "p1", related_publication_id: "p2", relation_type: "cites" };
    const updated = { ...relation, relation_type: "extends" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publication_relations: [{ data: relation, error: null }, { data: updated, error: null }],
      vault_publications: [{ data: { id: "p1" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ relation_type: "extends" }) });

    const res = await handleUpdateRelation(supabase, principal, CTX, vault.id, "r1", event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.relation_type).toBe("extends");
  });
});

// ─── handleDeleteRelation ────────────────────────────────────────────────────

describe("handleDeleteRelation", () => {
  it("returns 404 when relation not found", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publication_relations: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteRelation(supabase, principal, CTX, vault.id, "missing");

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const relation = { id: "r1", publication_id: "p1" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publication_relations: [{ data: relation, error: null }, { data: null, error: null }],
      vault_publications: [{ data: { id: "p1" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteRelation(supabase, principal, CTX, vault.id, "r1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe("r1");
  });
});
