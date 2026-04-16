import { describe, it, expect, vi } from "vitest";
import { handleImportBibtex, handleImportUrl } from "../../src/routes/import.js";
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

const CTX = makeContext();

// ─── handleImportBibtex ──────────────────────────────────────────────────────

describe("handleImportBibtex", () => {
  it("returns 403 when write scope missing", async () => {
    const supabase = makeMockSupabase({});
    const principal = makeApiKeyPrincipal({ scopes: ["vaults:read"] });
    const event = makeEvent({ body: JSON.stringify({ content: "@article{a, title={T}}" }) });

    const res = await handleImportBibtex(supabase, principal, CTX, "v1", event);

    expect(res.statusCode).toBe(403);
  });

  it("returns 400 when content is missing", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({}) });

    const res = await handleImportBibtex(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_body");
  });

  it("returns 400 when BibTeX has no valid entries", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ content: "% no entries here" }) });

    const res = await handleImportBibtex(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error.code).toBe("invalid_bibtex");
  });

  it("returns 201 with created items on success", async () => {
    const vault = makeMockVault();
    const bibtex = `@article{smith2023, title = {Test Paper}, author = {A Smith}, year = {2023}}`;
    const vaultPub = { id: "vp1", title: "Test Paper" };

    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publications: [{ data: { id: "pub1" }, error: null }],
      vault_publications: [{ data: vaultPub, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ content: bibtex }) });

    const res = await handleImportBibtex(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.created).toHaveLength(1);
    expect(parseBody(res).data.errors).toHaveLength(0);
  });
});

// ─── insertVaultPublication (via handleImportUrl) ────────────────────────────

describe("insertVaultPublication", () => {
  it("does not include user_id in the vault_publications insert", async () => {
    const vault = makeMockVault();
    const vaultPub = { id: "vp1", url: "https://example.com" };

    const { supabase, captured } = makeCapturingSupabaseMulti(
      {
        vaults: [{ data: vault, error: null }],
        publications: [{ data: { id: "pub1" }, error: null }],
        vault_publications: [{ data: vaultPub, error: null }],
      },
      ["vault_publications"],
    );
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ url: "https://example.com" }) });

    const res = await handleImportUrl(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    const insertArg = captured["vault_publications"].inserts[0];
    expect(insertArg).toBeDefined();
    expect(Object.keys(insertArg)).not.toContain("user_id");
  });
});

// ─── handleImportUrl ─────────────────────────────────────────────────────────

describe("handleImportUrl", () => {
  it("returns 400 when url is missing", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ title: "No URL" }) });

    const res = await handleImportUrl(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when url is malformed", async () => {
    const vault = makeMockVault();
    const supabase = makeMockSupabase({
      vaults: { data: vault, error: null },
      vault_shares: { data: null, error: null },
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ url: "not-a-url" }) });

    const res = await handleImportUrl(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with created item on success", async () => {
    const vault = makeMockVault();
    const vaultPub = { id: "vp1", title: "example.com", url: "https://example.com" };

    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publications: [{ data: { id: "pub1" }, error: null }],
      vault_publications: [{ data: vaultPub, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({ body: JSON.stringify({ url: "https://example.com" }) });

    const res = await handleImportUrl(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
    expect(parseBody(res).data.id).toBe("vp1");
  });

  it("uses supplied title when provided", async () => {
    const vault = makeMockVault();
    const vaultPub = { id: "vp1", title: "My Custom Title", url: "https://example.com" };

    const supabase = makeMockSupabaseMulti({
      vaults: [{ data: vault, error: null }],
      vault_shares: [{ data: null, error: null }],
      publications: [{ data: { id: "pub1" }, error: null }],
      vault_publications: [{ data: vaultPub, error: null }],
    });
    const principal = makeApiKeyPrincipal();
    const event = makeEvent({
      body: JSON.stringify({ url: "https://example.com", title: "My Custom Title" }),
    });

    const res = await handleImportUrl(supabase, principal, CTX, vault.id, event);

    expect(res.statusCode).toBe(201);
  });
});
