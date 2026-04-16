import { describe, it, expect } from "vitest";
import {
  handleCreateVault,
  handleUpdateVault,
  handleDeleteVault,
  handleUpdateVaultVisibility,
  handleListVaultShares,
  handleCreateVaultShare,
  handleUpdateVaultShare,
  handleDeleteVaultShare,
} from "../../src/routes/vaults.js";
import {
  makeMockSupabase,
  makeMockSupabaseMulti,
  makeCapturingSupabaseMulti,
  makeApiKeyPrincipal,
  makeContext,
  makeEvent,
  makeMockVault,
  parseBody,
} from "../helpers.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Supabase mock that satisfies resolveVaultAccess (owner) + one extra table. */
function makeVaultAccessMock(vault, extraTable = {}) {
  return makeMockSupabase({
    vaults: { data: vault, error: null },
    vault_shares: { data: null, error: null },
    ...extraTable,
  });
}

const CTX = makeContext();

// ─── handleCreateVault ───────────────────────────────────────────────────────

describe("handleCreateVault", () => {
  it("returns 403 when vaults:admin scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "My Vault" }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error.code).toBe("missing_scope");
  });

  it("returns 400 when name is missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ description: "No name" }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("returns 400 when name is blank", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "   " }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with vault on success", async () => {
    const mockVault = makeMockVault({ name: "My Vault" });
    const supabase = makeMockSupabase({ vaults: { data: mockVault, error: null } });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "My Vault" }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data).toEqual(mockVault);
  });

  it("returns 400 when visibility is public but public_slug is missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "Public Vault", visibility: "public" }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    // Buggy code: creates vault without slug → 201. Fixed code: 400.
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("defaults visibility to private", async () => {
    const mockVault = makeMockVault();
    const supabase = makeMockSupabase({ vaults: { data: mockVault, error: null } });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "V" }) });

    const res = await handleCreateVault(supabase, principal, CTX, event);

    expect(res.statusCode).toBe(201);
  });
});

// ─── handleUpdateVault ───────────────────────────────────────────────────────

describe("handleUpdateVault", () => {
  it("returns 403 when vaults:admin scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:write"] });
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "New" }) });

    const res = await handleUpdateVault(supabase, principal, CTX, "v1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when vault not found", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "New" }) });

    const res = await handleUpdateVault(supabase, principal, CTX, "missing", event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when no updatable fields given", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({}) });

    const res = await handleUpdateVault(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const updated = { ...vault, name: "Renamed" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }, { data: updated, error: null }],
      vault_shares: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });

    const res = await handleUpdateVault(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.name).toBe("Renamed");
  });
});

// ─── handleDeleteVault ───────────────────────────────────────────────────────

describe("handleDeleteVault", () => {
  it("returns 403 when scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleDeleteVault(supabase, principal, CTX, "v1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when vault not found", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteVault(supabase, principal, CTX, "missing");

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with deleted id on success", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteVault(supabase, principal, CTX, vault.id);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe(vault.id);
  });
});

// ─── handleUpdateVaultVisibility ─────────────────────────────────────────────

describe("handleUpdateVaultVisibility", () => {
  it("returns 400 when visibility is invalid", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ visibility: "secret" }) });

    const res = await handleUpdateVaultVisibility(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when public without public_slug", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ visibility: "public" }) });

    const res = await handleUpdateVaultVisibility(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("does not include public_slug in update when switching to protected without providing a slug", async () => {
    const vault = makeMockVault({ visibility: "public", public_slug: "my-slug" });
    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }, { data: vault, error: null }],
      },
      ["vaults"],
    );
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ visibility: "protected" }) });

    await handleUpdateVaultVisibility(supabase, principal, CTX, vault.id, event);

    const updateArg = captured["vaults"].updates[0];
    expect(updateArg).toBeDefined();
    // Buggy code: updateArg.public_slug === null. Fixed code: public_slug not in updateArg.
    expect(Object.keys(updateArg)).not.toContain("public_slug");
  });

  it("returns 200 when setting to public with slug", async () => {
    const vault = makeMockVault();
    const updatedVault = { ...vault, visibility: "public", public_slug: "my-vault" };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }, { data: updatedVault, error: null }],
      vault_shares: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ visibility: "public", public_slug: "my-vault" }) });

    const res = await handleUpdateVaultVisibility(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(200);
  });
});

// ─── handleListVaultShares ───────────────────────────────────────────────────

describe("handleListVaultShares", () => {
  it("returns 403 when vaults:read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleListVaultShares(supabase, principal, CTX, "v1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with shares array", async () => {
    const vault = makeMockVault();
    const shares = [{ id: "s1", role: "viewer", shared_with_email: "a@b.com" }];
    // resolveVaultAccess does NOT query vault_shares for the vault owner
    // (vault.user_id === principal.userId), so only one vault_shares entry needed.
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: shares, error: null }],
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleListVaultShares(supabase, principal, CTX, vault.id);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toHaveLength(1);
  });
});

// ─── handleCreateVaultShare ──────────────────────────────────────────────────

describe("handleCreateVaultShare", () => {
  it("returns 400 when email is missing", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ role: "viewer" }) });

    const res = await handleCreateVaultShare(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when email is whitespace only", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ email: "   ", role: "viewer" }) });

    const res = await handleCreateVaultShare(supabase, principal, CTX, vault.id, event);

    // Buggy code: "   " passes string check, trimmed to "" and stored → 201.
    // Fixed code: validates after trim → 400.
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("returns 400 when role is invalid", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ email: "a@b.com", role: "owner" }) });

    const res = await handleCreateVaultShare(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 201 on success", async () => {
    const vault = makeMockVault();
    const share = { id: "s1", role: "viewer", shared_with_email: "a@b.com" };
    // resolveVaultAccess: vaults[0] (owner — no vault_shares query)
    // insert share: vault_shares[0]
    // promote to protected: vaults[1]
    const supabase = makeMockSupabaseMulti({
      vaults: [
        { data: vault, error: null }, // resolveVaultAccess read
        { data: null, error: null },  // promote to protected (update)
      ],
      vault_shares: [
        { data: share, error: null }, // insert share
      ],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ email: "a@b.com", role: "viewer" }) });

    const res = await handleCreateVaultShare(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.id).toBe("s1");
  });
});

// ─── handleUpdateVaultShare ──────────────────────────────────────────────────

describe("handleUpdateVaultShare", () => {
  it("returns 404 when share not found", async () => {
    const vault = makeMockVault();
    // resolveVaultAccess: vaults[0]; update maybySingle: vault_shares[0] = null → 404
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ role: "editor" }) });

    const res = await handleUpdateVaultShare(supabase, principal, CTX, vault.id, "missing-share", event);

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const updatedShare = { id: "s1", role: "editor" };
    // resolveVaultAccess: vaults[0] (owner — no vault_shares query)
    // update share maybySingle: vault_shares[0]
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: updatedShare, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ role: "editor" }) });

    const res = await handleUpdateVaultShare(supabase, principal, CTX, vault.id, "s1", event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.role).toBe("editor");
  });
});

// ─── handleDeleteVaultShare ──────────────────────────────────────────────────

describe("handleDeleteVaultShare", () => {
  it("returns 200 on success", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultAccessMock(vault);
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteVaultShare(supabase, principal, CTX, vault.id, "s1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe("s1");
  });
});
