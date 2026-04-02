import crypto from "node:crypto";
import { getConfig } from "./config.js";

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

// SSRF protection: only allow http/https URLs pointing to public IP ranges.
function validateSourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error("Invalid PDF source URL.");
    error.code = "invalid_source_url";
    throw error;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const error = new Error("PDF source URL must use http or https.");
    error.code = "invalid_source_url";
    throw error;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === "localhost" || hostname === "::1") {
    const error = new Error("PDF source URL must not point to internal infrastructure.");
    error.code = "ssrf_blocked";
    throw error;
  }

  // Block private/link-local IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (isPrivate) {
      const error = new Error("PDF source URL must not point to internal infrastructure.");
      error.code = "ssrf_blocked";
      throw error;
    }
  }
}

function requireGoogleDriveConfig() {
  const config = getConfig();
  const missingEnv = [];

  if (!config.googleDriveClientId) missingEnv.push("GOOGLE_DRIVE_CLIENT_ID");
  if (!config.googleDriveClientSecret) missingEnv.push("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!config.googleDriveRedirectUri) missingEnv.push("GOOGLE_DRIVE_REDIRECT_URI");
  if (!config.googleDriveStateSecret) missingEnv.push("GOOGLE_DRIVE_STATE_SECRET");
  if (!config.googleDriveTokenSecret) missingEnv.push("GOOGLE_DRIVE_TOKEN_SECRET");

  if (missingEnv.length > 0) {
    const error = new Error("Google Drive integration is not configured on the backend.");
    error.code = "google_drive_not_configured";
    error.status = 503;
    error.details = { missing_env: missingEnv };
    throw error;
  }

  return config;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function getKey(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function signStatePayload(payload) {
  const config = requireGoogleDriveConfig();
  return crypto
    .createHmac("sha256", getKey(config.googleDriveStateSecret))
    .update(payload)
    .digest();
}

function getDefaultReturnTo(config) {
  return `${config.appBaseUrl || config.allowedOrigins[0] || "https://refhub.io"}/profile-edit?tab=storage`;
}

function normalizeReturnTo(returnTo) {
  const config = requireGoogleDriveConfig();
  const fallback = getDefaultReturnTo(config);
  if (!returnTo) {
    return fallback;
  }

  try {
    const parsed = new URL(returnTo);
    if (!config.allowedOrigins.includes(parsed.origin)) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function encryptSecret(secret) {
  const config = requireGoogleDriveConfig();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(config.googleDriveTokenSecret), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv, encrypted, tag].map((part) => base64UrlEncode(part)).join(".");
}

function decryptSecret(value) {
  const [ivPart, encryptedPart, tagPart] = String(value || "").split(".");
  if (!ivPart || !encryptedPart || !tagPart) {
    const error = new Error("Stored Google Drive token is invalid.");
    error.code = "invalid_google_drive_token";
    throw error;
  }

  const config = requireGoogleDriveConfig();
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(config.googleDriveTokenSecret), base64UrlDecode(ivPart));
  decipher.setAuthTag(base64UrlDecode(tagPart));
  const decrypted = Buffer.concat([
    decipher.update(base64UrlDecode(encryptedPart)),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

async function fetchGoogleJson(url, init, requestLabel) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    const error = new Error(`${requestLabel} network request failed: ${cause?.message || "fetch failed"}`);
    error.code = `${requestLabel}_network_error`;
    error.status = 502;
    error.cause = cause;
    throw error;
  }
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.error_description || payload?.error?.message || `${requestLabel} failed (${response.status}).`,
    );
    error.code = payload?.error || `${requestLabel}_failed`;
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function exchangeCodeForTokens(code) {
  const config = requireGoogleDriveConfig();

  return fetchGoogleJson(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.googleDriveClientId,
        client_secret: config.googleDriveClientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.googleDriveRedirectUri,
      }),
    },
    "google_drive_token_exchange",
  );
}

async function refreshAccessToken(refreshToken) {
  const config = requireGoogleDriveConfig();

  return fetchGoogleJson(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.googleDriveClientId,
        client_secret: config.googleDriveClientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    },
    "google_drive_token_refresh",
  );
}

async function revokeGoogleToken(token) {
  if (!token) return;

  const response = await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });

  if (!response.ok) {
    const error = new Error(`Google token revoke failed (${response.status}).`);
    error.code = "google_drive_revoke_failed";
    error.status = response.status;
    throw error;
  }
}

async function driveRequest(accessToken, path, init = {}) {
  const url = path.startsWith("http") ? path : `${GOOGLE_DRIVE_API_URL}${path}`;
  return fetchGoogleJson(
    url,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    },
    "google_drive_request",
  );
}

async function getStoredLink(supabase, userId) {
  const result = await supabase
    .from("user_google_drive_links")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  return result.data;
}

async function upsertStoredLink(supabase, row) {
  const result = await supabase
    .from("user_google_drive_links")
    .upsert(row, {
      onConflict: "user_id",
    })
    .select("*")
    .single();
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

function toDriveStatus(link) {
  if (!link) {
    return {
      linked: false,
      scope: GOOGLE_DRIVE_SCOPE,
      folderStatus: "unlinked",
      folderId: null,
      folderName: null,
      googleDriveEmail: null,
      lastLinkedAt: null,
      lastCheckedAt: null,
      lastError: null,
    };
  }

  return {
    linked: true,
    scope: link.scope || GOOGLE_DRIVE_SCOPE,
    folderStatus: link.drive_folder_status || (link.drive_folder_id ? "ready" : "pending_creation"),
    folderId: link.drive_folder_id || null,
    folderName: link.drive_folder_name || null,
    googleDriveEmail: link.google_drive_email || null,
    lastLinkedAt: link.last_linked_at || null,
    lastCheckedAt: link.last_checked_at || null,
    lastError: link.last_error || null,
  };
}

function buildFolderSearchUrl(folderName) {
  const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);
  url.searchParams.set("q", `mimeType='${GOOGLE_DRIVE_FOLDER_MIME_TYPE}' and name='${folderName}' and trashed=false`);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("fields", "files(id,name)");
  return url.toString();
}

async function createFolder(accessToken, folderName) {
  return driveRequest(accessToken, "/files?fields=id,name", {
    method: "POST",
    body: JSON.stringify({
      name: folderName,
      mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
    }),
  });
}

async function getFreshDriveAccess(link, supabase) {
  const refreshToken = decryptSecret(link.encrypted_refresh_token);
  const tokens = await refreshAccessToken(refreshToken);

  // If Google rotated the refresh token, persist the new one immediately.
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken && supabase) {
    const update = await supabase
      .from("user_google_drive_links")
      .update({ encrypted_refresh_token: encryptSecret(tokens.refresh_token) })
      .eq("user_id", link.user_id);
    if (update.error) {
      // Log but don't fail the request — the upload can still proceed with the new access token.
      console.error("Failed to persist rotated Google refresh token", {
        userId: link.user_id,
        message: update.error.message,
      });
    }
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
  };
}

async function ensureGoogleDriveFolderWithAccessToken(supabase, userId, accessToken) {
  const link = await getStoredLink(supabase, userId);
  if (!link) {
    const error = new Error("Google Drive is not linked for this account.");
    error.code = "google_drive_not_linked";
    throw error;
  }

  const config = requireGoogleDriveConfig();
  let folder = null;

  if (link.drive_folder_id) {
    try {
      folder = await driveRequest(
        accessToken,
        `/files/${encodeURIComponent(link.drive_folder_id)}?fields=id,name,mimeType,trashed`,
        { method: "GET" },
      );
      if (folder?.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE || folder?.trashed) {
        folder = null;
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  if (!folder) {
    const searchResult = await driveRequest(accessToken, buildFolderSearchUrl(config.googleDriveFolderName), {
      method: "GET",
    });
    folder = searchResult?.files?.[0] || null;
  }

  if (!folder) {
    folder = await createFolder(accessToken, config.googleDriveFolderName);
  }

  const updated = await upsertStoredLink(supabase, {
    user_id: userId,
    google_drive_email: link.google_drive_email,
    encrypted_refresh_token: link.encrypted_refresh_token,
    scope: link.scope || GOOGLE_DRIVE_SCOPE,
    drive_folder_id: folder.id,
    drive_folder_name: folder.name,
    drive_folder_status: "ready",
    last_linked_at: link.last_linked_at || new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_error: null,
  });

  return toDriveStatus(updated);
}

export function createGoogleDriveAuthorizationUrl({ userId, returnTo }) {
  const config = requireGoogleDriveConfig();
  const payload = JSON.stringify({
    userId,
    returnTo: normalizeReturnTo(returnTo),
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
  });
  const encodedPayload = base64UrlEncode(payload);
  const encodedSignature = base64UrlEncode(signStatePayload(encodedPayload));
  const state = `${encodedPayload}.${encodedSignature}`;

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.googleDriveClientId);
  url.searchParams.set("redirect_uri", config.googleDriveRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  return {
    authorizationUrl: url.toString(),
    returnTo: normalizeReturnTo(returnTo),
    scope: GOOGLE_DRIVE_SCOPE,
  };
}

function parseGoogleDriveState(state) {
  if (!state || !state.includes(".")) {
    const error = new Error("Missing or invalid Google Drive OAuth state.");
    error.code = "invalid_google_drive_state";
    throw error;
  }

  const [encodedPayload, encodedSignature] = state.split(".");
  const expected = signStatePayload(encodedPayload);
  const actual = base64UrlDecode(encodedSignature);

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const error = new Error("Google Drive OAuth state verification failed.");
    error.code = "invalid_google_drive_state";
    throw error;
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  if (!payload?.userId || !payload?.issuedAt) {
    const error = new Error("Google Drive OAuth state payload is incomplete.");
    error.code = "invalid_google_drive_state";
    throw error;
  }

  if (Date.now() - payload.issuedAt > OAUTH_STATE_MAX_AGE_MS) {
    const error = new Error("Google Drive OAuth state has expired.");
    error.code = "expired_google_drive_state";
    throw error;
  }

  return payload;
}

export async function getGoogleDriveStatus(supabase, userId) {
  return toDriveStatus(await getStoredLink(supabase, userId));
}

export async function ensureGoogleDriveFolderForUser(supabase, userId) {
  const link = await getStoredLink(supabase, userId);
  if (!link) {
    const error = new Error("Google Drive is not linked for this account.");
    error.code = "google_drive_not_linked";
    throw error;
  }

  const { accessToken } = await getFreshDriveAccess(link, supabase);
  return ensureGoogleDriveFolderWithAccessToken(supabase, userId, accessToken);
}

export async function completeGoogleDriveLink(supabase, { state, code, error: oauthError }) {
  const payload = parseGoogleDriveState(state);
  const redirectUrl = new URL(normalizeReturnTo(payload.returnTo));

  if (oauthError) {
    redirectUrl.searchParams.set("gdrive", "error");
    redirectUrl.searchParams.set("gdrive_message", oauthError);
    return { redirectUrl: redirectUrl.toString() };
  }

  const tokenPayload = await exchangeCodeForTokens(code);
  if (!tokenPayload.refresh_token) {
    const error = new Error("Google did not return a refresh token; relink with consent.");
    error.code = "missing_google_drive_refresh_token";
    throw error;
  }

  await upsertStoredLink(supabase, {
    user_id: payload.userId,
    google_drive_email: null,
    encrypted_refresh_token: encryptSecret(tokenPayload.refresh_token),
    scope: tokenPayload.scope || GOOGLE_DRIVE_SCOPE,
    drive_folder_id: null,
    drive_folder_name: null,
    drive_folder_status: "pending_creation",
    last_linked_at: new Date().toISOString(),
    last_checked_at: null,
    last_error: null,
  });

  try {
    await ensureGoogleDriveFolderWithAccessToken(supabase, payload.userId, tokenPayload.access_token);
    redirectUrl.searchParams.set("gdrive", "connected");
  } catch (error) {
    await upsertStoredLink(supabase, {
      user_id: payload.userId,
      google_drive_email: null,
      encrypted_refresh_token: encryptSecret(tokenPayload.refresh_token),
      scope: tokenPayload.scope || GOOGLE_DRIVE_SCOPE,
      drive_folder_id: null,
      drive_folder_name: null,
      drive_folder_status: "error",
      last_linked_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      last_error: error.message,
    });
    redirectUrl.searchParams.set("gdrive", "connected");
    redirectUrl.searchParams.set("gdrive_folder", "pending");
    redirectUrl.searchParams.set("gdrive_message", error.message);
  }

  return { redirectUrl: redirectUrl.toString() };
}

export async function disconnectGoogleDriveForUser(supabase, userId) {
  const link = await getStoredLink(supabase, userId);
  if (!link) {
    return toDriveStatus(null);
  }

  try {
    await revokeGoogleToken(decryptSecret(link.encrypted_refresh_token));
  } catch (error) {
    console.error("Google Drive token revoke failed", {
      userId,
      code: error.code,
      message: error.message,
    });
  }

  const result = await supabase.from("user_google_drive_links").delete().eq("user_id", userId);
  if (result.error) {
    throw result.error;
  }

  return toDriveStatus(null);
}

function sanitizeFileName(input) {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function buildPdfName(title, year) {
  const base = sanitizeFileName(`${title || "refhub-paper"}${year ? ` ${year}` : ""}`);
  return `${base || "refhub-paper"}.pdf`;
}

async function uploadDriveFile(accessToken, folderId, filename, pdfBuffer) {
  const boundary = `refhub-${crypto.randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: filename,
    parents: [folderId],
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);

  return fetchGoogleJson(
    `${GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink,webContentLink,mimeType,parents`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    "google_drive_upload",
  );
}

async function upsertPdfAssetRecord(supabase, record) {
  const result = await supabase
    .from("publication_pdf_assets")
    .upsert(record, {
      onConflict: "vault_publication_id,storage_provider",
    })
    .select("*")
    .single();

  if (result.error) {
    throw result.error;
  }

  return result.data;
}

export async function uploadPdfToGoogleDriveForUser({
  supabase,
  userId,
  publicationId,
  vaultPublicationId,
  title,
  year,
  sourceUrl,
}) {
  const link = await getStoredLink(supabase, userId);
  if (!link) {
    return {
      attempted: false,
      stored: false,
      provider: "google_drive",
      code: "google_drive_not_linked",
      message: "Google Drive is not linked for this user.",
    };
  }

  try {
    const folder = await ensureGoogleDriveFolderForUser(supabase, userId);
    const { accessToken } = await getFreshDriveAccess(link, supabase);
    validateSourceUrl(sourceUrl);
    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "accept": "application/pdf,application/octet-stream,*/*;q=0.8",
        "user-agent": "RefHubBot/1.0 (+https://refhub.io)",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch PDF source (${response.status}).`);
    }

    const config = requireGoogleDriveConfig();
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > config.googleDriveMaxUploadBytes) {
      throw new Error(`PDF exceeds upload limit (${config.googleDriveMaxUploadBytes} bytes).`);
    }

    const contentType = response.headers.get("content-type") || "";
    // Accept application/pdf, application/octet-stream (common for binary downloads),
    // and URLs whose path signals a PDF (/doi/pdf/, /content/pdf/, pdfdirect, .pdf ext).
    const isPdfContentType = /pdf|octet-stream/i.test(contentType);
    const isPdfUrl = /\.pdf(\?|$)|\/e?pdf(direct|ft)?[/?]/i.test(sourceUrl);
    if (!isPdfContentType && !isPdfUrl) {
      throw new Error("RefHub could not confirm that the source URL returned a PDF.");
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());
    if (pdfBuffer.length > config.googleDriveMaxUploadBytes) {
      throw new Error(`PDF exceeds upload limit (${config.googleDriveMaxUploadBytes} bytes).`);
    }

    const uploaded = await uploadDriveFile(accessToken, folder.folderId, buildPdfName(title, year), pdfBuffer);
    await upsertPdfAssetRecord(supabase, {
      user_id: userId,
      publication_id: publicationId,
      vault_publication_id: vaultPublicationId,
      storage_provider: "google_drive",
      source_pdf_url: sourceUrl,
      stored_pdf_url: uploaded.webViewLink || uploaded.webContentLink || null,
      stored_file_id: uploaded.id,
      status: "stored",
      error_message: null,
    });

    return {
      attempted: true,
      stored: true,
      provider: "google_drive",
      fileId: uploaded.id,
      folderId: folder.folderId,
      folderName: folder.folderName,
      pdfUrl: uploaded.webViewLink || uploaded.webContentLink || null,
      sourceUrl,
    };
  } catch (error) {
    await upsertPdfAssetRecord(supabase, {
      user_id: userId,
      publication_id: publicationId,
      vault_publication_id: vaultPublicationId,
      storage_provider: "google_drive",
      source_pdf_url: sourceUrl,
      stored_pdf_url: null,
      stored_file_id: null,
      status: "failed",
      error_message: error.message,
    });

    return {
      attempted: true,
      stored: false,
      provider: "google_drive",
      code: error.code || "google_drive_upload_failed",
      message: error.message,
    };
  }
}
