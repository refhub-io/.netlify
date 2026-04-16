import { describe, it, expect } from "vitest";
import { API_SCOPES, isValidApiKeyScope, requireScope } from "../src/auth.js";

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
