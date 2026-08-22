import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateManagementUser: vi.fn(),
  };
});

import { authenticateManagementUser } from "../src/auth.js";
import { handler } from "../functions/api-v1.js";
import { makeManagementPrincipal } from "./helpers.js";

const API_KEY_ROW = {
  id: "key-1",
  owner_user_id: "user-test",
  label: "agent key",
  description: null,
  key_prefix: "rhk_testprefix",
  scopes: ["vaults:read"],
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  created_at: "2026-08-22T06:00:00.000Z",
  api_key_vaults: [],
};

function makeKeyEvent(method, path = "/api/v1/keys/key-1", headers = { authorization: "Bearer session-jwt" }) {
  return {
    httpMethod: method,
    path,
    headers,
    queryStringParameters: null,
    body: null,
    isBase64Encoded: false,
  };
}

function makeApiKeySupabase(results) {
  const calls = [];
  const cursors = {};

  function makeChain(result) {
    const chain = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return (fn) => Promise.resolve(result).then(fn);
          if (prop === "catch") return (fn) => Promise.resolve(result).catch(fn);
          if (prop === "finally") return (fn) => Promise.resolve(result).finally(fn);
          if (prop === "maybeSingle") return () => Promise.resolve(result);
          if (prop === "single") return () => Promise.resolve(result);
          return (...args) => {
            calls.push({ method: prop, args });
            return chain;
          };
        },
      },
    );
    return chain;
  }

  return {
    calls,
    supabase: {
      from(table) {
        calls.push({ method: "from", args: [table] });
        const queue = results[table] ?? [];
        const idx = cursors[table] ?? 0;
        cursors[table] = idx + 1;
        return makeChain(queue[idx] ?? { data: null, error: null });
      },
      rpc: vi.fn().mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null }),
      auth: { getUser: vi.fn() },
    },
  };
}

describe("management API key routes", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    vi.mocked(authenticateManagementUser).mockReset();
  });

  it("hard-deletes an owned API key on DELETE /keys/:keyId", async () => {
    const { supabase, calls } = makeApiKeySupabase({
      api_keys: [
        { data: API_KEY_ROW, error: null },
        { data: null, error: null, count: 1 },
      ],
    });
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase,
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });

    const res = await handler(makeKeyEvent("DELETE"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ id: "key-1" });
    expect(calls).toContainEqual({ method: "delete", args: [{ count: "exact" }] });
    expect(calls).toContainEqual({ method: "eq", args: ["owner_user_id", "user-test"] });
    expect(calls.some((call) => call.method === "update")).toBe(false);
  });

  it("keeps POST /keys/:keyId/revoke as a soft revoke", async () => {
    const revokedRow = { ...API_KEY_ROW, revoked_at: "2026-08-22T06:10:00.000Z" };
    const { supabase, calls } = makeApiKeySupabase({
      api_keys: [
        { data: API_KEY_ROW, error: null },
        { data: null, error: null },
        { data: revokedRow, error: null },
      ],
    });
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase,
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });

    const res = await handler(makeKeyEvent("POST", "/api/v1/keys/key-1/revoke"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.revoked_at).toBe(revokedRow.revoked_at);
    expect(calls.some((call) => call.method === "update" && call.args[0].revoked_at)).toBe(true);
    expect(calls.some((call) => call.method === "delete")).toBe(false);
  });

  it("returns 404 when deleting a key not owned by the user", async () => {
    const { supabase, calls } = makeApiKeySupabase({
      api_keys: [{ data: null, error: null }],
    });
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase,
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });

    const res = await handler(makeKeyEvent("DELETE"));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("api_key_not_found");
    expect(calls.some((call) => call.method === "delete")).toBe(false);
  });

  it("rejects RefHub API keys on management delete routes", async () => {
    const res = await handler(makeKeyEvent("DELETE", "/api/v1/keys/key-1", {
      authorization: "Bearer rhk_testprefix_secret",
    }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("refhub_api_key_not_supported");
    expect(authenticateManagementUser).not.toHaveBeenCalled();
  });
});
