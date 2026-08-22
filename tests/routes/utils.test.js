import { describe, it, expect } from "vitest";
import { pickPublicationFields, validateVaultTagIds, touchVaultUpdatedAt, attachDrivePdfUrls } from "../../src/routes/utils.js";
import { makeMockSupabase, makeMockSupabaseMulti } from "../helpers.js";

describe("pickPublicationFields", () => {
  it("picks only known fields", () => {
    const result = pickPublicationFields({ title: "T", unknown: "X", doi: "10.x" });
    expect(result.title).toBe("T");
    expect(result.doi).toBe("10.x");
    expect(result.unknown).toBeUndefined();
  });

  it("defaults arrays and publication_type", () => {
    const result = pickPublicationFields({ title: "T" });
    expect(result.authors).toEqual([]);
    expect(result.editor).toEqual([]);
    expect(result.keywords).toEqual([]);
    expect(result.publication_type).toBe("article");
  });

  it("does not override provided arrays", () => {
    const result = pickPublicationFields({ title: "T", authors: ["Alice"], publication_type: "book" });
    expect(result.authors).toEqual(["Alice"]);
    expect(result.publication_type).toBe("book");
  });

  it("passes through reading_state and important when provided", () => {
    const result = pickPublicationFields({ title: "T", reading_state: "read", important: true });
    expect(result.reading_state).toBe("read");
    expect(result.important).toBe(true);
  });

  it("omits reading_state and important when absent, letting the DB column default apply", () => {
    const result = pickPublicationFields({ title: "T" });
    expect(result.reading_state).toBeUndefined();
    expect(result.important).toBeUndefined();
  });
});

describe("validateVaultTagIds", () => {
  it("returns empty array for empty input", async () => {
    const supabase = makeMockSupabase({});
    expect(await validateVaultTagIds(supabase, "v1", [])).toEqual([]);
    expect(await validateVaultTagIds(supabase, "v1", null)).toEqual([]);
  });

  it("returns ids when all found", async () => {
    const supabase = makeMockSupabase({ tags: { data: [{ id: "t1" }, { id: "t2" }], error: null } });
    const result = await validateVaultTagIds(supabase, "v1", ["t1", "t2"]);
    expect(result).toEqual(["t1", "t2"]);
  });

  it("throws with code invalid_tag_ids when some are missing", async () => {
    const supabase = makeMockSupabase({ tags: { data: [{ id: "t1" }], error: null } });
    await expect(validateVaultTagIds(supabase, "v1", ["t1", "t2"])).rejects.toMatchObject({
      code: "invalid_tag_ids",
    });
  });
});

describe("attachDrivePdfUrls", () => {
  it("returns items unchanged (empty array) when given none", async () => {
    const supabase = makeMockSupabase({});
    expect(await attachDrivePdfUrls(supabase, [], "user-1")).toEqual([]);
  });

  it("prefers the vault-specific asset over the canonical-publication fallback", async () => {
    const supabase = makeMockSupabaseMulti({
      publication_pdf_assets: [
        { data: [{ vault_publication_id: "item1", stored_pdf_url: "https://drive.example/vault-copy" }], error: null },
        { data: [{ publication_id: "pub1", stored_pdf_url: "https://drive.example/canonical-copy" }], error: null },
      ],
    });

    const [result] = await attachDrivePdfUrls(supabase, [
      { id: "item1", original_publication_id: "pub1", pdf_url: "https://journal.example/paper.pdf" },
    ], "user-1");

    expect(result.drive_pdf_url).toBe("https://drive.example/vault-copy");
    expect(result.pdf_url).toBe("https://journal.example/paper.pdf");
  });

  it("falls back to the canonical-publication asset when no vault-specific copy exists", async () => {
    const supabase = makeMockSupabaseMulti({
      publication_pdf_assets: [
        { data: [], error: null },
        { data: [{ publication_id: "pub1", stored_pdf_url: "https://drive.example/canonical-copy" }], error: null },
      ],
    });

    const [result] = await attachDrivePdfUrls(supabase, [{ id: "item1", original_publication_id: "pub1" }], "user-1");

    expect(result.drive_pdf_url).toBe("https://drive.example/canonical-copy");
  });

  it("sets drive_pdf_url to null when no asset has been stored", async () => {
    const supabase = makeMockSupabaseMulti({
      publication_pdf_assets: [{ data: [], error: null }],
    });

    const [result] = await attachDrivePdfUrls(supabase, [{ id: "item1", original_publication_id: null }], "user-1");

    expect(result.drive_pdf_url).toBeNull();
  });

  it("scopes both asset lookups to the given userId, not just any uploader", async () => {
    const eqCalls = [];
    function makeTrackingChain(result) {
      return new Proxy({}, {
        get(_, prop) {
          if (prop === "then") return (fn) => Promise.resolve(result).then(fn);
          return (...args) => {
            if (prop === "eq") eqCalls.push(args);
            return makeTrackingChain(result);
          };
        },
      });
    }
    const supabase = { from: () => makeTrackingChain({ data: [], error: null }) };

    await attachDrivePdfUrls(supabase, [{ id: "item1", original_publication_id: "pub1" }], "user-42");

    const userIdFilters = eqCalls.filter(([column]) => column === "user_id");
    // One .eq("user_id", ...) per lookup (vault-scoped + canonical), both scoped to the caller.
    expect(userIdFilters.length).toBe(2);
    expect(userIdFilters.every(([, value]) => value === "user-42")).toBe(true);
  });

  it("does not leak a different user's uploaded asset into drive_pdf_url", async () => {
    // Mock mirrors real Supabase behavior: a userId-scoped query for a different
    // user's asset returns no rows, even though a row exists for that item.
    const supabase = makeMockSupabaseMulti({
      publication_pdf_assets: [
        { data: [], error: null }, // vault-scoped lookup for "other-user": nothing visible
        { data: [], error: null }, // canonical lookup for "other-user": nothing visible
      ],
    });

    const [result] = await attachDrivePdfUrls(supabase, [
      { id: "item1", original_publication_id: "pub1" },
    ], "other-user");

    expect(result.drive_pdf_url).toBeNull();
  });
});

describe("touchVaultUpdatedAt", () => {
  it("does not throw on success", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: null } });
    await expect(touchVaultUpdatedAt(supabase, "v1")).resolves.toBeUndefined();
  });

  it("swallows supabase errors instead of propagating", async () => {
    const supabase = makeMockSupabase({ vaults: { data: null, error: { code: "42501", message: "denied" } } });
    await expect(touchVaultUpdatedAt(supabase, "v1")).resolves.toBeUndefined();
  });
});
