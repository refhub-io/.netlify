import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
    authenticateManagementUser: vi.fn(),
  };
});

vi.mock("../src/google-drive.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDriveResumableSession: vi.fn(),
    recordBrowserDriveUpload: vi.fn(),
    uploadPdfToGoogleDriveForUser: vi.fn(),
  };
});

import { authenticateApiKey, authenticateManagementUser } from "../src/auth.js";
import { createDriveResumableSession, recordBrowserDriveUpload, uploadPdfToGoogleDriveForUser } from "../src/google-drive.js";
import { getConfig } from "../src/config.js";
import { createCorsHeaders, errorResponse, withCors } from "../src/http.js";
import { handler } from "../functions/api-v1.js";
import { makeApiKeyPrincipal, makeManagementPrincipal, makeMockSupabase, makeMockSupabaseMulti } from "./helpers.js";

function makePdfEvent(overrides = {}) {
  return {
    httpMethod: "POST",
    path: overrides.path ?? "/api/v1/vaults/vault-1/items/item-1/pdf",
    headers: {
      origin: "https://refhub.io",
      authorization: "Bearer rhk_test_secret",
      "content-type": "application/pdf",
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
    vi.mocked(createDriveResumableSession).mockReset();
    vi.mocked(recordBrowserDriveUpload).mockReset();
    vi.mocked(uploadPdfToGoogleDriveForUser).mockReset();
  });

  it("rejects any raw application/pdf body with a structured 410, before auth, regardless of size", async () => {
    const res = await handler(makePdfEvent({}));

    expect(res.statusCode).toBe(410);
    expect(res.headers["access-control-allow-origin"]).toBe("https://refhub.io");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body).error.code).toBe("raw_pdf_upload_removed");
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a raw PDF body larger than the generic request-size limit with 410, not 413", async () => {
    process.env.REFHUB_API_MAX_BODY_BYTES = "1000";

    const res = await handler(makePdfEvent({ body: "%PDF-".padEnd(2000, "x") }));

    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).error.code).toBe("raw_pdf_upload_removed");
  });

  it("still accepts a JSON source_url body on the vault-item /pdf route", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabaseMulti({
        vaults: [{ data: { id: "vault-1", user_id: "user-test", visibility: "private" }, error: null }],
        vault_shares: [{ data: null, error: null }],
        vault_publications: [{ data: { id: "item-1", original_publication_id: "pub-1", title: "Paper", year: 2026, doi: null }, error: null }],
      }),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"] }),
    });
    vi.mocked(uploadPdfToGoogleDriveForUser).mockResolvedValue({
      attempted: true,
      stored: true,
      provider: "google_drive",
      fileId: "drive-file-1",
      driveUrl: "https://drive.example/view",
      sourceUrl: "https://source.example/paper.pdf",
    });

    const res = await handler(makePdfEvent({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_url: "https://source.example/paper.pdf" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(uploadPdfToGoogleDriveForUser).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: "https://source.example/paper.pdf",
      pdfBuffer: null,
    }));
  });

  it("creates resumable PDF sessions on the browser google-drive route with management auth", async () => {
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase: makeMockSupabase({
        vaults: { data: { id: "vault-1", user_id: "user-test", visibility: "private" }, error: null },
        vault_publications: { data: { id: "item-1", title: "Large Paper", year: 2026 }, error: null },
      }),
      principal: makeManagementPrincipal(),
    });
    vi.mocked(createDriveResumableSession).mockResolvedValue({ upload_url: "https://drive.example/upload", file_name: "Large Paper.pdf" });

    const res = await handler(makePdfEvent({
      path: "/api/v1/google-drive/vaults/vault-1/items/item-1/pdf/session",
      headers: { authorization: "Bearer supabase-session-jwt", "content-type": "application/json" },
      body: null,
    }));

    expect(res.statusCode).toBe(200);
    expect(authenticateManagementUser).toHaveBeenCalledTimes(1);
    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(createDriveResumableSession).toHaveBeenCalledWith(expect.anything(), "user-test", {
      title: "Large Paper",
      year: 2026,
      origin: "https://refhub.io",
    });
  });

  it("records completed resumable PDF uploads on the browser google-drive route with management auth", async () => {
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase: makeMockSupabaseMulti({
        vaults: [{ data: { id: "vault-1", user_id: "user-test", visibility: "private" }, error: null }],
        vault_publications: [{ data: { id: "item-1", original_publication_id: "pub-1" }, error: null }],
      }),
      principal: makeManagementPrincipal(),
    });
    vi.mocked(recordBrowserDriveUpload).mockResolvedValue({
      attempted: true,
      stored: true,
      provider: "google_drive",
      fileId: "drive-file-1",
      driveUrl: "https://drive.example/view",
      sourceUrl: null,
    });

    const res = await handler(makePdfEvent({
      path: "/api/v1/google-drive/vaults/vault-1/items/item-1/pdf/complete",
      headers: { authorization: "Bearer supabase-session-jwt", "content-type": "application/json" },
      body: JSON.stringify({ file_id: "drive-file-1", web_view_link: "https://drive.example/view" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(authenticateManagementUser).toHaveBeenCalledTimes(1);
    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(recordBrowserDriveUpload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "user-test",
      publicationId: "pub-1",
      vaultPublicationId: "item-1",
      fileId: "drive-file-1",
      webViewLink: "https://drive.example/view",
    }));
  });

  it("keeps the API-key resumable PDF session route under /vaults", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabase({
        vaults: { data: { id: "vault-1", user_id: "user-test", visibility: "private" }, error: null },
        vault_publications: { data: { id: "item-1", title: "Large Paper", year: 2026 }, error: null },
      }),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"] }),
    });
    vi.mocked(createDriveResumableSession).mockResolvedValue({ upload_url: "https://drive.example/upload", file_name: "Large Paper.pdf" });

    const res = await handler(makePdfEvent({
      path: "/api/v1/vaults/vault-1/items/item-1/pdf/session",
      headers: { authorization: "Bearer rhk_test_secret", "content-type": "application/json" },
      body: null,
    }));

    expect(res.statusCode).toBe(200);
    expect(authenticateApiKey).toHaveBeenCalledTimes(1);
    expect(authenticateManagementUser).not.toHaveBeenCalled();
  });

  it("keeps the API-key resumable PDF complete route under /vaults", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: makeMockSupabaseMulti({
        vaults: [{ data: { id: "vault-1", user_id: "user-test", visibility: "private" }, error: null }],
        vault_publications: [{ data: { id: "item-1", original_publication_id: "pub-1" }, error: null }],
      }),
      principal: makeApiKeyPrincipal({ scopes: ["vaults:write"] }),
    });
    vi.mocked(recordBrowserDriveUpload).mockResolvedValue({
      attempted: true,
      stored: true,
      provider: "google_drive",
      fileId: "drive-file-1",
      driveUrl: "https://drive.example/view",
      sourceUrl: null,
    });

    const res = await handler(makePdfEvent({
      path: "/api/v1/vaults/vault-1/items/item-1/pdf/complete",
      headers: { authorization: "Bearer rhk_test_secret", "content-type": "application/json" },
      body: JSON.stringify({ file_id: "drive-file-1", web_view_link: "https://drive.example/view" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(authenticateApiKey).toHaveBeenCalledTimes(1);
    expect(authenticateManagementUser).not.toHaveBeenCalled();
    expect(recordBrowserDriveUpload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "user-test",
      publicationId: "pub-1",
      vaultPublicationId: "item-1",
      fileId: "drive-file-1",
      webViewLink: "https://drive.example/view",
    }));
  });

  it("creates resumable PDF sessions on the publication-level route", async () => {
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase: makeMockSupabase({
        publications: { data: { id: "pub-1", title: "Solo Paper", year: 2025 }, error: null },
      }),
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });
    vi.mocked(createDriveResumableSession).mockResolvedValue({ upload_url: "https://drive.example/upload", file_name: "Solo Paper.pdf" });

    const res = await handler(makePdfEvent({
      path: "/api/v1/publications/pub-1/pdf/session",
      headers: { authorization: "Bearer supabase-session-jwt", "content-type": "application/json" },
      body: null,
    }));

    expect(res.statusCode).toBe(200);
    expect(authenticateManagementUser).toHaveBeenCalledTimes(1);
    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(createDriveResumableSession).toHaveBeenCalledWith(expect.anything(), "user-test", {
      title: "Solo Paper",
      year: 2025,
      origin: "https://refhub.io",
    });
  });

  it("records completed resumable PDF uploads on the publication-level route", async () => {
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase: makeMockSupabase({
        publications: { data: { id: "pub-1" }, error: null },
      }),
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });
    vi.mocked(recordBrowserDriveUpload).mockResolvedValue({
      attempted: true,
      stored: true,
      provider: "google_drive",
      fileId: "drive-file-1",
      driveUrl: "https://drive.example/view",
      sourceUrl: null,
    });

    const res = await handler(makePdfEvent({
      path: "/api/v1/publications/pub-1/pdf/complete",
      headers: { authorization: "Bearer supabase-session-jwt", "content-type": "application/json" },
      body: JSON.stringify({ file_id: "drive-file-1", web_view_link: "https://drive.example/view" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(recordBrowserDriveUpload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "user-test",
      publicationId: "pub-1",
      vaultPublicationId: null,
      fileId: "drive-file-1",
      webViewLink: "https://drive.example/view",
    }));
  });

  it("404s the publication-level session route for a publication the caller does not own", async () => {
    vi.mocked(authenticateManagementUser).mockResolvedValue({
      supabase: makeMockSupabase({
        publications: { data: null, error: null },
      }),
      principal: makeManagementPrincipal({ userId: "user-test" }),
    });

    const res = await handler(makePdfEvent({
      path: "/api/v1/publications/not-mine/pdf/session",
      headers: { authorization: "Bearer supabase-session-jwt", "content-type": "application/json" },
      body: null,
    }));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("publication_not_found");
    expect(createDriveResumableSession).not.toHaveBeenCalled();
  });

  it("preserves CORS when framework-level errors are converted to JSON", async () => {
    const event = makePdfEvent({ body: "%PDF-test" });
    const corsHeaders = createCorsHeaders(event, getConfig().allowedOrigins);

    const res = withCors(errorResponse(500, "internal_error", "Unexpected server error", "req-test"), corsHeaders);

    expect(res.statusCode).toBe(500);
    expect(res.headers["access-control-allow-origin"]).toBe("https://refhub.io");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body).error.code).toBe("internal_error");
  });
});
