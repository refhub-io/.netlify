import { describe, it, expect } from "vitest";
import {
  handleListTags,
  handleCreateTag,
  handleUpdateTag,
  handleDeleteTag,
  handleAttachTags,
  handleDetachTags,
} from "../../src/routes/tags.js";
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

function makeVaultMock(vault, extra = {}) {
  return makeMockSupabase({
    vaults: { data: vault, error: null },
    vault_shares: { data: null, error: null },
    vaults_touch: { data: null, error: null },
    ...extra,
  });
}

// ─── handleListTags ──────────────────────────────────────────────────────────

describe("handleListTags", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleListTags(supabase, principal, CTX, "v1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with tags array", async () => {
    const vault = makeMockVault();
    const tags = [{ id: "t1", name: "ML", color: "#ff0000", parent_id: null, depth: 0 }];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      tags: [{ data: tags, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListTags(supabase, principal, CTX, vault.id);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toHaveLength(1);
  });
});

// ─── handleCreateTag ─────────────────────────────────────────────────────────

describe("handleCreateTag", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });
    const event = makeEvent({ body: JSON.stringify({ name: "ML" }) });

    const res = await handleCreateTag(supabase, principal, CTX, "v1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when name missing", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ color: "#f00" }) });

    const res = await handleCreateTag(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with tag on success", async () => {
    const vault = makeMockVault();
    const tag = { id: "t1", name: "ML", color: null, parent_id: null, depth: 0 };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      tags: [{ data: tag, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ name: "ML" }) });

    const res = await handleCreateTag(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.name).toBe("ML");
  });
});

// ─── handleUpdateTag ─────────────────────────────────────────────────────────

describe("handleUpdateTag", () => {
  it("returns 404 when tag not found", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      tags: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ color: "#0f0" }) });

    const res = await handleUpdateTag(supabase, principal, CTX, vault.id, "missing", event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const tag = { id: "t1", name: "ML", color: "#0f0", parent_id: null, depth: 0 };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      tags: [{ data: tag, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ color: "#0f0" }) });

    const res = await handleUpdateTag(supabase, principal, CTX, vault.id, "t1", event);

    expect(res.statusCode).toBe(200);
  });
});

// ─── handleDeleteTag ─────────────────────────────────────────────────────────

describe("handleDeleteTag", () => {
  it("returns 200 with id on success", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteTag(supabase, principal, CTX, vault.id, "t1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe("t1");
  });
});

// ─── handleAttachTags ────────────────────────────────────────────────────────

describe("handleAttachTags", () => {
  it("returns 400 when item_id missing", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ tag_ids: ["t1"] }) });

    const res = await handleAttachTags(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when item not found in vault", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ item_id: "pub1", tag_ids: ["t1"] }) });

    const res = await handleAttachTags(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: { id: "pub1" }, error: null }],
      tags: [{ data: [{ id: "t1" }], error: null }],
      publication_tags: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ item_id: "pub1", tag_ids: ["t1"] }) });

    const res = await handleAttachTags(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.item_id).toBe("pub1");
  });
});

// ─── handleDetachTags ────────────────────────────────────────────────────────

describe("handleDetachTags", () => {
  it("returns 400 when tag_ids missing", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ item_id: "pub1" }) });

    const res = await handleDetachTags(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when item_id does not belong to the vault", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      // vault_publications ownership check returns null → item not in vault
      vault_publications: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ item_id: "foreign-item", tag_ids: ["t1"] }) });

    const res = await handleDetachTags(supabase, principal, CTX, vault.id, event);

    // Buggy code: no ownership check, returns 200. Fixed code: 404.
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_publications: [{ data: { id: "pub1" }, error: null }], // ownership check
      publication_tags: [{ data: null, error: null }],             // delete
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ item_id: "pub1", tag_ids: ["t1"] }) });

    const res = await handleDetachTags(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.tag_ids).toEqual(["t1"]);
  });
});
