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
