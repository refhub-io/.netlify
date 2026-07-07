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

describe("PATCH /vaults/:vaultId/items/:itemId — partial update safety", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    process.env.REFHUB_API_MAX_BODY_BYTES = String(50 * 1024 * 1024);
    process.env.GOOGLE_DRIVE_MAX_UPLOAD_BYTES = String(25 * 1024 * 1024);
    vi.mocked(authenticateApiKey).mockReset();
  });

  it("does not clear authors or reset publication_type when only pdf_url is sent", async () => {
    const refreshedItem = { ...EXISTING_ITEM, pdf_url: "https://drive.example/view", version: 2 };

    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: VAULT, error: null }],
        vault_publications: [
          { data: EXISTING_ITEM, error: null }, // existingResult read
          { data: null, error: null }, // update() call result
          { data: refreshedItem, error: null }, // refreshed read
        ],
      },
      ["vault_publications"],
    );

    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"] }),
    });

    const res = await handler(makePatchEvent({ pdf_url: "https://drive.example/view" }));

    expect(res.statusCode).toBe(200);

    const updateArg = captured.vault_publications.updates[0];
    expect(updateArg).toBeDefined();
    expect(updateArg.pdf_url).toBe("https://drive.example/view");
    // Buggy code force-defaults these on any PATCH; fixed code omits untouched fields entirely.
    expect(updateArg).not.toHaveProperty("authors");
    expect(updateArg).not.toHaveProperty("publication_type");
    expect(updateArg).not.toHaveProperty("editor");
    expect(updateArg).not.toHaveProperty("keywords");

    const body = parseBody(res);
    expect(body.data.pdf_url).toBe("https://drive.example/view");
  });

  it("still applies fields the caller explicitly sends", async () => {
    const refreshedItem = { ...EXISTING_ITEM, title: "New Title", version: 2 };

    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: VAULT, error: null }],
        vault_publications: [
          { data: EXISTING_ITEM, error: null },
          { data: null, error: null },
          { data: refreshedItem, error: null },
        ],
      },
      ["vault_publications"],
    );

    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase,
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"] }),
    });

    const res = await handler(makePatchEvent({ title: "New Title" }));

    expect(res.statusCode).toBe(200);
    const updateArg = captured.vault_publications.updates[0];
    expect(updateArg.title).toBe("New Title");
    expect(updateArg).not.toHaveProperty("authors");
  });
});
