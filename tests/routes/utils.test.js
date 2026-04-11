import { describe, it, expect } from "vitest";
import { pickPublicationFields, validateVaultTagIds, touchVaultUpdatedAt } from "../../src/routes/utils.js";
import { makeMockSupabase } from "../helpers.js";

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
