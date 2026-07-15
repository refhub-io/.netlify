import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

const REQUIRED_ENV = {
  SUPABASE_URL: "http://localhost",
  SUPABASE_SERVICE_ROLE_KEY: "test",
  REFHUB_API_KEY_PEPPER: "test",
};

describe("getConfig OpenAlex settings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      process.env[key] = value;
    }
    // Set to "" rather than deleting: getConfig() lazily backfills any
    // process.env key that's still undefined from a local .env/.env.local
    // file on its first call (see ensureLocalEnvLoaded in src/config.js),
    // which would silently reintroduce a real local OPENALEX_API_KEY here
    // and break the "defaults to null" expectation below. An empty string
    // isn't undefined, so it skips that backfill, and getConfig()'s own
    // falsy-checks (|| null, readPositiveNumber) treat "" the same as unset.
    process.env.OPENALEX_API_KEY = "";
    process.env.OPENALEX_DAILY_BUDGET_USD = "";
    process.env.OPENALEX_TIMEOUT_MS = "";
  });

  afterEach(() => {
    // Mutate process.env's keys in place rather than reassigning the
    // binding -- process.env is a special Node object, and replacing it
    // wholesale can cause subtle cross-test issues for anything holding a
    // reference to the original object.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it("defaults to null key, $1.00 budget, 8000ms timeout", () => {
    const config = getConfig();
    expect(config.openalexApiKey).toBeNull();
    expect(config.openalexDailyBudgetUsd).toBe(1.0);
    expect(config.openalexTimeoutMs).toBe(8000);
  });

  it("reads overrides from environment", () => {
    process.env.OPENALEX_API_KEY = "oa-test-key";
    process.env.OPENALEX_DAILY_BUDGET_USD = "5.5";
    process.env.OPENALEX_TIMEOUT_MS = "4000";

    const config = getConfig();
    expect(config.openalexApiKey).toBe("oa-test-key");
    expect(config.openalexDailyBudgetUsd).toBe(5.5);
    expect(config.openalexTimeoutMs).toBe(4000);
  });

  it("rejects a non-numeric budget", () => {
    process.env.OPENALEX_DAILY_BUDGET_USD = "not-a-number";
    expect(() => getConfig()).toThrow("OPENALEX_DAILY_BUDGET_USD must be a positive number");
  });
});
