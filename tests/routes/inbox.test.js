import { describe, it, expect, vi, afterEach } from "vitest";
import { handleListInboxItems, handleCreateInboxItem } from "../../src/routes/inbox.js";
import { makeMockSupabase, makeMockSupabaseMulti, makeApiKeyPrincipal, makeContext, makeEvent, parseBody } from "../helpers.js";

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
    const created = { id: "i1", status: "pending", source_type: "doi", source_ref: "10.1/x", parsed_fields: { title: "10.1/x" } };
    const supabase = makeMockSupabaseMulti({
      inbox_items: [{ data: created, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    // fetch is unmocked in this test environment, so the real CrossRef/OpenAlex
    // calls in resolveDoiMetadata will fail (no network) and resolve to null --
    // exercising exactly the degrade-gracefully path this test is for.
    const res = await handleCreateInboxItem(supabase, principal, CTX, makeEvent({
      method: "POST",
      body: JSON.stringify({ source_type: "doi", source_ref: "10.1/x" }),
    }));

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.parsed_fields.title).toBe("10.1/x");
  });
});
