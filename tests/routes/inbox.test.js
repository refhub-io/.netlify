import { describe, it, expect } from "vitest";
import { handleListInboxItems } from "../../src/routes/inbox.js";
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
