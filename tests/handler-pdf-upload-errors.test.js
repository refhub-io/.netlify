import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
    authenticateManagementUser: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { getConfig } from "../src/config.js";
import { createCorsHeaders, errorResponse, withCors } from "../src/http.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeMockSupabase } from "./helpers.js";

function makePdfEvent(overrides = {}) {
  return {
    httpMethod: "POST",
    path: overrides.path ?? "/api/v1/vaults/vault-1/items/item-1/pdf",
    headers: {
      origin: "https://refhub.io",
      authorization: "Bearer rhk_test_secret",
      "content-type": "application/pdf",
      "content-length": String(overrides.contentLength ?? 0),
      ...(overrides.headers ?? {}),
    },
    queryStringParameters: null,
    body: overrides.body ?? "%PDF-test",
    isBase64Encoded: Boolean(overrides.isBase64Encoded),
  };
}

describe("PDF upload handler errors", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.REFHUB_API_AUDIT_DISABLED = "true";
    process.env.REFHUB_API_MAX_BODY_BYTES = String(50 * 1024 * 1024);
    process.env.GOOGLE_DRIVE_MAX_UPLOAD_BYTES = String(25 * 1024 * 1024);
    vi.mocked(authenticateManagementUser).mockReset();
    vi.mocked(authenticateApiKey).mockReset();
  });

  it("rejects raw PDF uploads above the API-safe limit with JSON and CORS before auth", async () => {
    const res = await handler(makePdfEvent({ contentLength: 7_524_181 }));

    expect(res.statusCode).toBe(413);
    expect(res.headers["access-control-allow-origin"]).toBe("https://refhub.io");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body).error.code).toBe("pdf_upload_too_large_for_api");
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it("preserves CORS when framework-level errors are converted to JSON", async () => {
    const event = makePdfEvent({ contentLength: 100, body: "%PDF-test" });
    const corsHeaders = createCorsHeaders(event, getConfig().allowedOrigins);

    const res = withCors(errorResponse(500, "internal_error", "Unexpected server error", "req-test"), corsHeaders);

    expect(res.statusCode).toBe(500);
    expect(res.headers["access-control-allow-origin"]).toBe("https://refhub.io");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body).error.code).toBe("internal_error");
  });
});
