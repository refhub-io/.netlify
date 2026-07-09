import { describe, expect, it, vi } from "vitest";
import { withProviderFallback } from "../src/providerFallback.js";

describe("withProviderFallback", () => {
  it("returns the primary's result without calling fallback when primary succeeds", async () => {
    const primary = vi.fn().mockResolvedValue("primary-result");
    const fallback = vi.fn().mockResolvedValue("fallback-result");
    const onProviderUsed = vi.fn();

    const result = await withProviderFallback({
      primary,
      fallback,
      isFallbackEligible: () => true,
      onProviderUsed,
    });

    expect(result).toBe("primary-result");
    expect(fallback).not.toHaveBeenCalled();
    expect(onProviderUsed).toHaveBeenCalledWith("openalex");
  });

  it("calls fallback when primary throws an eligible error", async () => {
    const eligibleError = Object.assign(new Error("rate limited"), { code: "openalex_error" });
    const primary = vi.fn().mockRejectedValue(eligibleError);
    const fallback = vi.fn().mockResolvedValue("fallback-result");
    const onProviderUsed = vi.fn();

    const result = await withProviderFallback({
      primary,
      fallback,
      isFallbackEligible: (error) => error.code === "openalex_error",
      onProviderUsed,
    });

    expect(result).toBe("fallback-result");
    expect(onProviderUsed).toHaveBeenCalledWith("semantic_scholar");
  });

  it("rethrows without calling fallback when the error is not eligible", async () => {
    const ineligibleError = Object.assign(new Error("bad request"), { code: "invalid_input" });
    const primary = vi.fn().mockRejectedValue(ineligibleError);
    const fallback = vi.fn();

    await expect(
      withProviderFallback({
        primary,
        fallback,
        isFallbackEligible: (error) => error.code === "openalex_error",
      }),
    ).rejects.toThrow("bad request");

    expect(fallback).not.toHaveBeenCalled();
  });

  it("works without an onProviderUsed callback", async () => {
    const primary = vi.fn().mockResolvedValue("ok");

    const result = await withProviderFallback({ primary, fallback: vi.fn(), isFallbackEligible: () => true });
    expect(result).toBe("ok");
  });
});
