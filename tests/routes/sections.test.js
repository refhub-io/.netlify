import { describe, it, expect } from "vitest";
import {
  handleListSections,
  handleCreateSection,
  handleUpdateSection,
  handleDeleteSection,
} from "../../src/routes/sections.js";
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

function makeVaultMock(vault, extra = {}) {
  return makeMockSupabase({
    vaults: { data: vault, error: null },
    vault_shares: { data: null, error: null },
    ...extra,
  });
}

// ─── handleListSections ──────────────────────────────────────────────────────

describe("handleListSections", () => {
  it("returns 403 when read scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: [] });

    const res = await handleListSections(supabase, principal, CTX, "v1");

    expect(res.statusCode).toBe(403);
  });

  it("allows a viewer (non-owner) to list sections", async () => {
    const vault = makeMockVault({ visibility: "public", user_id: "someone-else" });
    const sections = [{ id: "s1", name: "Methods", description: null, position: 0 }];
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_sections: [{ data: sections, error: null }],
    });
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });

    const res = await handleListSections(supabase, principal, CTX, vault.id);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data).toHaveLength(1);
  });
});

// ─── handleCreateSection ─────────────────────────────────────────────────────

describe("handleCreateSection", () => {
  it("returns 403 when admin scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:write"] });
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "Methods" }) });

    const res = await handleCreateSection(supabase, principal, CTX, "v1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when caller is an editor, not owner", async () => {
    const vault = makeMockVault({ user_id: "someone-else" });
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: { role: "editor" }, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "Methods" }) });

    const res = await handleCreateSection(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error.code).toBe("insufficient_vault_access");
  });

  it("returns 400 when name is missing", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({}) });

    const res = await handleCreateSection(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("returns 400 when position is not an integer", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "Methods", position: "first" }) });

    const res = await handleCreateSection(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with the created section on success", async () => {
    const vault = makeMockVault();
    const section = { id: "s1", vault_id: vault.id, name: "Methods", description: null, position: 0 };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }, { data: null, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_sections: [{ data: section, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "POST", body: JSON.stringify({ name: "Methods" }) });

    const res = await handleCreateSection(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.name).toBe("Methods");
  });
});

// ─── handleUpdateSection ─────────────────────────────────────────────────────

describe("handleUpdateSection", () => {
  it("returns 403 when caller is an editor, not owner", async () => {
    const vault = makeMockVault({ user_id: "someone-else" });
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: { role: "editor" }, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });

    const res = await handleUpdateSection(supabase, principal, CTX, vault.id, "s1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when no updatable fields given", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault);
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({}) });

    const res = await handleUpdateSection(supabase, principal, CTX, vault.id, "s1", event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when section not found in this vault", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_sections: [{ data: null, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });

    const res = await handleUpdateSection(supabase, principal, CTX, vault.id, "missing", event);

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error.code).toBe("section_not_found");
  });

  it("returns 200 with the updated section on success", async () => {
    const vault = makeMockVault();
    const section = { id: "s1", vault_id: vault.id, name: "Renamed", description: null, position: 0 };
    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }, { data: null, error: null }],
      vault_shares: [{ data: null, error: null }],
      vault_sections: [{ data: section, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });

    const res = await handleUpdateSection(supabase, principal, CTX, vault.id, "s1", event);

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.name).toBe("Renamed");
  });
});

// ─── handleDeleteSection ─────────────────────────────────────────────────────

describe("handleDeleteSection", () => {
  it("returns 403 when caller is an editor, not owner", async () => {
    const vault = makeMockVault({ user_id: "someone-else" });
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: { role: "editor" }, error: null },
    });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteSection(supabase, principal, CTX, vault.id, "s1");

    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with deleted id on success", async () => {
    const vault = makeMockVault();
    const supabase = makeVaultMock(vault, { vault_sections: { data: null, error: null } });
    const principal = makeApiKeyPrincipal();

    const res = await handleDeleteSection(supabase, principal, CTX, vault.id, "s1");

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).data.id).toBe("s1");
  });
});
