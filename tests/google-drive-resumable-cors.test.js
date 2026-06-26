import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDriveResumableSession } from "../src/google-drive.js";

function makeEncryptedRefreshToken(secret, plaintext = "refresh-token") {
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  const iv = Buffer.alloc(12, 1);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encode = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return [iv, encrypted, tag].map(encode).join(".");
}

function makeSupabase() {
  const link = {
    user_id: "user-test",
    encrypted_refresh_token: makeEncryptedRefreshToken(process.env.GOOGLE_DRIVE_TOKEN_SECRET),
    drive_folder_id: "folder-1",
    drive_folder_name: "refhub",
    scope: "https://www.googleapis.com/auth/drive.file",
  };

  return {
    from(table) {
      if (table === "user_google_drive_links") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: link, error: null }),
            }),
          }),
          upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: link, error: null }) }) }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function makeJsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe("Google Drive resumable session CORS origin", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    process.env.REFHUB_API_KEY_PEPPER = "test";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "client-id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_DRIVE_REDIRECT_URI = "https://api.example.test/callback";
    process.env.GOOGLE_DRIVE_STATE_SECRET = "state-secret";
    process.env.GOOGLE_DRIVE_TOKEN_SECRET = "token-secret";
    delete process.env.REFHUB_API_ALLOWED_ORIGINS;
    vi.restoreAllMocks();
  });

  it("forwards an allowed browser Origin when creating the Drive upload session", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return makeJsonResponse({ access_token: "access-token" });
      }
      if (String(url).includes("/drive/v3/files/folder-1")) {
        return makeJsonResponse({ id: "folder-1", name: "refhub", mimeType: "application/vnd.google-apps.folder", trashed: false });
      }
      if (String(url).includes("/upload/drive/v3/files")) {
        return makeJsonResponse({}, { headers: { location: "https://www.googleapis.com/upload/session" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createDriveResumableSession(makeSupabase(), "user-test", {
      title: "Large Paper",
      year: 2026,
      origin: "http://localhost:5173",
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/upload/drive/v3/files"));
    expect(uploadCall?.[1]?.headers?.Origin).toBe("http://localhost:5173");
  });

  it("does not forward a disallowed browser Origin to Google", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return makeJsonResponse({ access_token: "access-token" });
      }
      if (String(url).includes("/drive/v3/files/folder-1")) {
        return makeJsonResponse({ id: "folder-1", name: "refhub", mimeType: "application/vnd.google-apps.folder", trashed: false });
      }
      if (String(url).includes("/upload/drive/v3/files")) {
        return makeJsonResponse({}, { headers: { location: "https://www.googleapis.com/upload/session" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createDriveResumableSession(makeSupabase(), "user-test", {
      title: "Large Paper",
      year: 2026,
      origin: "https://evil.example",
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/upload/drive/v3/files"));
    expect(uploadCall?.[1]?.headers?.Origin).toBeUndefined();
  });
});
