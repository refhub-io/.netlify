import { describe, it, expect } from "vitest";
import { handleDeleteItem, handleBulkUpsertItems, handleImportPreview } from "../../src/routes/items.js";
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

// ─── handleDeleteItem ────────────────────────────────────────────────────────

describe("handleDeleteItem", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleDeleteItem(supabase, principal, CTX, "v1", "item1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when item not found", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteItem(supabase, principal, CTX, vault.id, "missing");

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with id on success", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [
        { data: { id: "item1" }, error: null }, // find
        { data: null, error: null },              // delete
      ],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteItem(supabase, principal, CTX, vault.id, "item1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe("item1");
  });
});

// ─── handleBulkUpsertItems ───────────────────────────────────────────────────

describe("handleBulkUpsertItems", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });
    const event = makeEvent({ body: JSON.stringify({ items: [{ title: "T" }] }) });

    const res = await handleBulkUpsertItems(supabase, principal, CTX, "v1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when items array is empty", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ items: [] }) });

    const res = await handleBulkUpsertItems(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("inserts new item and returns created array", async () => {
    const vault = makeMockVault();
    const newVaultPub = { id: "vp1", title: "New Paper", vault_id: vault.id };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      // No matching DOI/bibtex_key → no dedup lookups
      vault_publications: [
        { data: [], error: null },       // DOI lookup (empty)
        { data: newVaultPub, error: null }, // insert result
      ],
      publications: [{ data: { id: "pub1" }, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ items: [{ title: "New Paper" }] }) });

    const res = await handleBulkUpsertItems(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.errors).toHaveLength(0);
  });

  it("records error entry when item has no title", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ items: [{ doi: "10.x" }] }) });

    const res = await handleBulkUpsertItems(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.errors).toHaveLength(1);
  });

  it("does not serve cached result to a different principal", async () => {
    const vault = makeMockVault({ user_id: "user-A" });
    const newVaultPub = { id: "vp1", title: "Paper", vault_id: vault.id };
    const supabaseA = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_publications: [{ data: [], error: null }, { data: newVaultPub, error: null }],
      publications: [{ data: { id: "pub1" }, error: null }],
    });
    const principalA = makeApiKeyPrincipal({ userId: "user-A" });
    const key = `cross-tenant-${Date.now()}`;
    const makeEvt = () => makeEvent({ body: JSON.stringify({ items: [{ title: "Paper" }], idempotency_key: key }) });

    const first = await handleBulkUpsertItems(supabaseA, principalA, CTX, vault.id, makeEvt());
    expect(first.statusCode).toBe(200);

    // Principal B uses the same key but must NOT get A's cached result
    const principalB = makeApiKeyPrincipal({ userId: "user-B" });
    const brokenSupabase = makeMockSupabase({ vaults: { data: null, error: null } }); // vault not found for B
    const second = await handleBulkUpsertItems(brokenSupabase, principalB, CTX, vault.id, makeEvt());

    // Buggy code: returns 200 (cache hit). Fixed code: 404 (vault not found, separate cache key).
    expect(second.statusCode).toBe(404);
  });

  it("returns cached result for same idempotency key", async () => {
    const vault = makeMockVault();
    const newVaultPub = { id: "vp1", title: "Cached Paper", vault_id: vault.id };

    // Build a mock that will succeed on the first call
    const makeSupabase = () =>
      makeMockSupabaseMulti({
        vaults: [{ data: vault, error: null }],
        vault_shares: [{ data: null, error: null }],
        vault_publications: [{ data: [], error: null }, { data: newVaultPub, error: null }],
        publications: [{ data: { id: "pub1" }, error: null }],
      });

    const key = `idem-test-${Date.now()}`;
    const principal = makeApiKeyPrincipal();
    const eventFn = () =>
      makeEvent({ body: JSON.stringify({ items: [{ title: "Cached Paper" }], idempotency_key: key }) });

    const first = await handleBulkUpsertItems(makeSupabase(), principal, CTX, vault.id, eventFn());
    expect(first.statusCode).toBe(200);

    // Second call with same key — even with a broken supabase it should return cached result
    const brokenSupabase = makeMockSupabase({ vaults: { data: null, error: { message: "boom" } } });
    const second = await handleBulkUpsertItems(brokenSupabase, principal, CTX, vault.id, eventFn());
    expect(second.statusCode).toBe(200);
    expect(parseBody(second)).toEqual(parseBody(first));
  });
});

// ─── handleImportPreview ─────────────────────────────────────────────────────

describe("handleImportPreview", () => {
  it("returns 400 when items array is empty", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ items: [] }) });

    const res = await handleImportPreview(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 200 for a read-only key (preview writes nothing)", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_publications: [{ data: [], error: null }],
    });
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });
    const event = makeEvent({ body: JSON.stringify({ items: [{ title: "T", doi: "10.1/x" }] }) });

    const res = await handleImportPreview(supabase, principal, CTX, vault.id, event);

    // Buggy code: 403 (requires write scope). Fixed code: 200 (preview is read-only).
    expect(res.statusCode).toBe(200);
  });

  it("classifies new items as would_create", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [], error: null }], // no existing DOI matches
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({
      body: JSON.stringify({ items: [{ title: "Novel Paper", doi: "10.1/new" }] }),
    });

    const res = await handleImportPreview(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.would_create).toHaveLength(1);
    expect(body.data.would_update).toHaveLength(0);
  });

  it("classifies duplicate DOI as would_update", async () => {
    const vault = makeMockVault();
    const existing = { id: "vp1", doi: "10.1/dup", title: "Old Title" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_publications: [{ data: [existing], error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({
      body: JSON.stringify({ items: [{ title: "New Title", doi: "10.1/dup" }] }),
    });

    const res = await handleImportPreview(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.would_update).toHaveLength(1);
    expect(body.data.would_create).toHaveLength(0);
  });
});
