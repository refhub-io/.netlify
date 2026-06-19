import { describe, it, expect } from "vitest";
import { handleListVaultAudit, handleListGlobalAudit } from "../../src/routes/audit.js";
import {
  makeMockSupabase,
  makeMockSupabaseMulti,
  makeApiKeyPrincipal,
  makeManagementPrincipal,
  makeContext,
  makeEvent,
  makeMockVault,
  parseBody,
} from "../helpers.js";

const CTX = makeContext();

// ─── handleListVaultAudit ────────────────────────────────────────────────────

describe("handleListVaultAudit", () => {
  it("returns 403 when user is not vault owner", async () => {
    // Vault owned by a different user
    const vault = { ...makeMockVault(), user_id: "other-user" };
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal(); // user_id = 'user-test'

    const res = await handleListVaultAudit(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when vault not found", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();

    const res = await handleListVaultAudit(supabase, principal, CTX, "missing", makeEvent());

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with audit log entries", async () => {
    const vault = makeMockVault();
    const logs = [
      { id: "log1", method: "GET", path: "/api/v1/vaults/v1/items", response_status: 200 },
    ];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      api_request_audit_logs: [{ data: logs, error: null, count: 1 }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListVaultAudit(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
    expect(body.meta.vault_id).toBe(vault.id);
  });

  it("returns 200 with empty array when no logs", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      api_request_audit_logs: [{ data: [], error: null, count: 0 }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListVaultAudit(supabase, principal, CTX, vault.id, makeEvent());

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual([]);
  });

  it("respects pagination params", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      api_request_audit_logs: [{ data: [], error: null, count: 50 }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ query: { page: "2", per_page: "10" } });

    const res = await handleListVaultAudit(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.meta.page).toBe(2);
    expect(body.meta.per_page).toBe(10);
    expect(body.meta.total).toBe(50);
  });
});

// ─── handleListGlobalAudit ───────────────────────────────────────────────────

describe("handleListGlobalAudit", () => {
  it("returns 200 with audit entries for the management user", async () => {
    const logs = [
      { id: "log1", method: "POST", path: "/api/v1/vaults/v1/items", response_status: 201 },
    ];
    const supabase = makeMockSupabase({
      api_request_audit_logs: { data: logs, error: null, count: 1 },
    });
    const principal = makeManagementPrincipal();

    const res = await handleListGlobalAudit(supabase, principal, CTX, makeEvent());

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data).toHaveLength(1);
  });

  it("returns 200 with empty array when no logs", async () => {
    const supabase = makeMockSupabase({
      api_request_audit_logs: { data: [], error: null, count: 0 },
    });
    const principal = makeManagementPrincipal();

    const res = await handleListGlobalAudit(supabase, principal, CTX, makeEvent());

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toEqual([]);
  });

  it("passes vault_id filter when provided", async () => {
    const supabase = makeMockSupabase({
      api_request_audit_logs: { data: [], error: null, count: 0 },
    });
    const principal = makeManagementPrincipal();
    const event = makeEvent({ query: { vault_id: "v1" } });

    const res = await handleListGlobalAudit(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(200);
  });
});
