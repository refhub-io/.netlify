import { describe, it, expect } from "vitest";
import { API_SCOPES, isValidApiKeyScope, requireScope, resolveVaultAccess } from "../src/auth.js";
import { makeMockSupabase, makeApiKeyPrincipal, makeMockVault } from "./helpers.js";

describe("API_SCOPES", () => {
  it("includes all four scopes", () => {
    expect(API_SCOPES.READ).toBe("vaults:read");
    expect(API_SCOPES.WRITE).toBe("vaults:write");
    expect(API_SCOPES.EXPORT).toBe("vaults:export");
    expect(API_SCOPES.ADMIN).toBe("vaults:admin");
  });
});

describe("isValidApiKeyScope", () => {
  it("accepts all four valid scopes", () => {
    expect(isValidApiKeyScope("vaults:read")).toBe(true);
    expect(isValidApiKeyScope("vaults:write")).toBe(true);
    expect(isValidApiKeyScope("vaults:export")).toBe(true);
    expect(isValidApiKeyScope("vaults:admin")).toBe(true);
  });

  it("rejects unknown scopes", () => {
    expect(isValidApiKeyScope("vaults:delete")).toBe(false);
    expect(isValidApiKeyScope("admin")).toBe(false);
    expect(isValidApiKeyScope("")).toBe(false);
  });
});

describe("requireScope", () => {
  const makePrincipal = (scopes) => ({ scopes: new Set(scopes) });

  it("returns true when scope is present", () => {
    expect(requireScope(makePrincipal(["vaults:read"]), "vaults:read")).toBe(true);
    expect(requireScope(makePrincipal(["vaults:admin"]), "vaults:admin")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(requireScope(makePrincipal(["vaults:read"]), "vaults:admin")).toBe(false);
    expect(requireScope(makePrincipal([]), "vaults:read")).toBe(false);
  });
});

describe("resolveVaultAccess — archived vaults", () => {
  function makeSupabaseForVault(vault) {
    return makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
  }

  it("rejects an editor-level check on an archived vault with vault_archived", async () => {
    const vault = makeMockVault({ archived_at: "2026-01-01T00:00:00Z" });
    const access = await resolveVaultAccess(makeSupabaseForVault(vault), makeApiKeyPrincipal(), vault.id, "editor");

    expect(access.ok).toBe(false);
    expect(access.status).toBe(409);
    expect(access.code).toBe("vault_archived");
  });

  it("rejects an owner-level check on an archived vault with vault_archived", async () => {
    const vault = makeMockVault({ archived_at: "2026-01-01T00:00:00Z" });
    const access = await resolveVaultAccess(makeSupabaseForVault(vault), makeApiKeyPrincipal(), vault.id, "owner");

    expect(access.ok).toBe(false);
    expect(access.status).toBe(409);
    expect(access.code).toBe("vault_archived");
  });

  it("allows a viewer-level check on an archived vault — reads are unaffected", async () => {
    const vault = makeMockVault({ archived_at: "2026-01-01T00:00:00Z" });
    const access = await resolveVaultAccess(makeSupabaseForVault(vault), makeApiKeyPrincipal(), vault.id, "viewer");

    expect(access.ok).toBe(true);
    expect(access.vault.archived_at).toBe("2026-01-01T00:00:00Z");
  });

  it("allows an owner-level check on an archived vault when allowArchived is set", async () => {
    const vault = makeMockVault({ archived_at: "2026-01-01T00:00:00Z" });
    const access = await resolveVaultAccess(
      makeSupabaseForVault(vault),
      makeApiKeyPrincipal(),
      vault.id,
      "owner",
      { allowArchived: true },
    );

    expect(access.ok).toBe(true);
  });

  it("still allows editor/owner checks on a non-archived vault (regression check)", async () => {
    const vault = makeMockVault({ archived_at: null });
    const access = await resolveVaultAccess(makeSupabaseForVault(vault), makeApiKeyPrincipal(), vault.id, "owner");

    expect(access.ok).toBe(true);
  });
});
