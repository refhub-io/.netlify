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
    expect(await attachDrivePdfUrls(supabase, [])).toEqual([]);
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
    ]);

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

    const [result] = await attachDrivePdfUrls(supabase, [{ id: "item1", original_publication_id: "pub1" }]);

    expect(result.drive_pdf_url).toBe("https://drive.example/canonical-copy");
  });

  it("sets drive_pdf_url to null when no asset has been stored", async () => {
    const supabase = makeMockSupabaseMulti({
      publication_pdf_assets: [{ data: [], error: null }],
    });

    const [result] = await attachDrivePdfUrls(supabase, [{ id: "item1", original_publication_id: null }]);

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
