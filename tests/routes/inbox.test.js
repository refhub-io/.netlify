import { describe, it, expect, vi, afterEach } from "vitest";
import { handleListInboxItems, handleCreateInboxItem, handleAcceptInboxItem, handleRejectInboxItem, handlePostponeInboxItem, handleMergeInboxItem, handleDeleteInboxItem } from "../../src/routes/inbox.js";
import { makeMockSupabase, makeMockSupabaseMulti, makeApiKeyPrincipal, makeContext, makeEvent, parseBody, makeMockVault } from "../helpers.js";

const CTX = makeContext();

describe("handleListInboxItems", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleListInboxItems(supabase, principal, CTX, makeEvent());

    expect(res.statusCode).toBe(403);
  });

  it("returns only pending items for the caller, ordered by sort_order then created_at", async () => {
    const items = [
      { id: "i1", user_id: "user-test", status: "pending", source_type: "manual", source_ref: "A", parsed_fields: { title: "A" }, sort_order: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", suggested_vault_id: null, suggested_tag_ids: null, duplicate_of_publication_id: null, filed_publication_id: null },
    ];
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: items, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListInboxItems(supabase, principal, CTX, makeEvent());

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual(items);
  });
});

// ─── handleCreateInboxItem ───────────────────────────────────────────────────

describe("handleCreateInboxItem", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({ method: "POST", body: JSON.stringify({ source_type: "manual", source_ref: "X", parsed_fields: { title: "X" } }) }));

    expect(res.statusCode).toBe(403);
  });

  it("manual: requires parsed_fields.title", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({ method: "POST", body: JSON.stringify({ source_type: "manual", source_ref: "X" }) }));

    expect(res.statusCode).toBe(400);
  });

  it("manual: creates one pending item", async () => {
    const created = { id: "new-1", status: "pending", source_type: "manual", source_ref: "My Paper", parsed_fields: { title: "My Paper" } };
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: created, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "manual", source_ref: "My Paper", parsed_fields: { title: "My Paper" } }),
    }));

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data).toEqual(created);
  });

  it("bibtex: creates one item per entry, response data is an array", async () => {
    const bibtex = "@article{k1,\n  title = {Paper One},\n  author = {A. Uthor},\n  year = {2020}\n}\n@article{k2,\n  title = {Paper Two},\n  author = {B. Uthor},\n  year = {2021}\n}";
    const item1 = { id: "i1", status: "pending", source_type: "bibtex", source_ref: "k1" };
    const item2 = { id: "i2", status: "pending", source_type: "bibtex", source_ref: "k2" };
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: item1, error: null }, { data: item2, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "bibtex", source_ref: bibtex }),
    }));

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data).toEqual([item1, item2]);
  });

  it("bibtex: 400 when no entries parse", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "bibtex", source_ref: "not bibtex at all" }),
    }));

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_bibtex");
  });

  it("doi: degrades to a bare title when lookup fails, never blocks capture", async () => {
    const created = { id: "i1", status: "pending", source_type: "doi", source_ref: "10.1/x", parsed_fields: { title: "10.1/x", doi: "10.1/x" } };
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: created, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    // Stub fetch to simulate both CrossRef and OpenAlex being unreachable --
    // deterministic, no real network call. resolveDoiMetadata (from
    // import.js) tries CrossRef first, then OpenAlex; both must fail here.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "doi", source_ref: "10.1/x" }),
    }));

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.parsed_fields.title).toBe("10.1/x");
    expect(parseBody(res).data.parsed_fields.doi).toBe("10.1/x");
  });

  it("doi: stamps the resolved doi into parsed_fields on successful lookup", async () => {
    const created = { id: "i2", status: "pending", source_type: "doi", source_ref: "10.1/y", parsed_fields: { title: "Real Paper", doi: "10.1/y" } };
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: created, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { title: ["Real Paper"], author: [] } }),
    }));

    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "doi", source_ref: "10.1/y" }),
    }));

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.parsed_fields.doi).toBe("10.1/y");
  });
});

// ─── handleAcceptInboxItem ──────────────────────────────────────────────────

describe("handleAcceptInboxItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "item-1", makeEvent({ method: "POST", body: JSON.stringify({ vault_id: "v1" }) }));

    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when vault_id missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "item-1", makeEvent({ method: "POST", body: JSON.stringify({}) }));

    expect(res.statusCode).toBe(400);
  });

  it("returns vault access error when caller lacks editor permission", async () => {
    const vault = makeMockVault({ user_id: "someone-else" });
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "item-1", makeEvent({ method: "POST", body: JSON.stringify({ vault_id: vault.id }) }));

    expect(res.statusCode).toBe(403);
  });

  it("happy path: calls the RPC with correct args and returns 200", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        vault_shares: [{ data: null, error: null }],
      },
      { accept_inbox_item: [{ data: [{ vault_publication_id: "vp-1", publication_id: "pub-1" }], error: null }] },
    );
    const principal = makeApiKeyPrincipal();

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "item-1", makeEvent({
      method: "POST",
      body: JSON.stringify({ vault_id: vault.id, tag_ids: ["t1"] }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual({ vault_publication_id: "vp-1", publication_id: "pub-1" });
  });

  it("maps a not-found RPC error to 404", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        vault_shares: [{ data: null, error: null }],
      },
      { accept_inbox_item: [{ data: null, error: { code: "P0002", message: "inbox item not found" } }] },
    );
    const principal = makeApiKeyPrincipal();

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "missing-item", makeEvent({
      method: "POST",
      body: JSON.stringify({ vault_id: vault.id }),
    }));

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error.code).toBe("inbox_item_not_found");
  });

  it("maps a not-pending RPC error to 409", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        vault_shares: [{ data: null, error: null }],
      },
      { accept_inbox_item: [{ data: null, error: { code: "23514", message: "inbox item is not pending" } }] },
    );
    const principal = makeApiKeyPrincipal();

    const res = await handleAcceptInboxItem(supabase, principal, CTX, "item-1", makeEvent({
      method: "POST",
      body: JSON.stringify({ vault_id: vault.id }),
    }));

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error.code).toBe("item_not_pending");
  });
});

// ─── handleRejectInboxItem ──────────────────────────────────────────────────

describe("handleRejectInboxItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleRejectInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when the item doesn't exist for this user", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleRejectInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the item exists but isn't pending", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: { id: "item-1", status: "accepted" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleRejectInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error.code).toBe("item_not_pending");
  });

  it("happy path: sets status=rejected, returns 200 with id", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [
        { data: { id: "item-1", status: "pending" }, error: null },
        { data: { id: "item-1" }, error: null },
      ],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleRejectInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual({ id: "item-1" });
  });
});

describe("handlePostponeInboxItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handlePostponeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 409 when the item exists but isn't pending", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: { id: "item-1", status: "rejected" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handlePostponeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error.code).toBe("item_not_pending");
  });

  it("happy path: bumps sort_order past the current max and returns 200", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [
        { data: { id: "item-1", status: "pending" }, error: null },
        { data: [{ sort_order: 3 }, { sort_order: 7 }], error: null },
        { data: { id: "item-1", sort_order: 8 }, error: null },
      ],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handlePostponeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual({ id: "item-1", sort_order: 8 });
  });
});

describe("handleMergeInboxItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleMergeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 409 when the item has no known duplicate target", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: { id: "item-1", status: "pending", duplicate_of_publication_id: null }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleMergeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error.code).toBe("no_duplicate_target");
  });

  it("happy path: sets status=merged, filed_publication_id=duplicate target", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [
        { data: { id: "item-1", status: "pending", duplicate_of_publication_id: "pub-1" }, error: null },
        { data: { id: "item-1", filed_publication_id: "pub-1" }, error: null },
      ],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleMergeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual({ id: "item-1", filed_publication_id: "pub-1" });
  });

  it("returns 404 when the item isn't found for this user", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleMergeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the item exists but isn't pending", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: { id: "item-1", status: "merged", duplicate_of_publication_id: "pub-1" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleMergeInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error.code).toBe("item_not_pending");
  });
});

describe("handleDeleteInboxItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleDeleteInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(403);
  });

  it("deletes regardless of status and returns 200 with id", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: { id: "item-1" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual({ id: "item-1" });
  });

  it("returns 404 for another user's item", async () => {
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteInboxItem(supabase, principal, CTX, "item-1");

    expect(res.statusCode).toBe(404);
  });
});
