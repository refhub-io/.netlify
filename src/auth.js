import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getConfig } from "./config.js";

const VAULT_SELECT =
  "id, user_id, name, description, color, public_slug, category, abstract, created_at, updated_at, visibility";

export const API_SCOPES = {
  READ: "vaults:read",
  WRITE: "vaults:write",
  EXPORT: "vaults:export",
  ADMIN: "vaults:admin",
};

const MANAGEMENT_SCOPES = new Set(Object.values(API_SCOPES));

function hashApiKey(rawKey, pepper) {
  return crypto.createHash("sha256").update(`${pepper}:${rawKey}`).digest("hex");
}

function getBearerToken(headers) {
  const authorization = headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return null;
}

function getPresentedApiKey(headers) {
  const bearerToken = getBearerToken(headers);
  if (bearerToken) {
    return bearerToken;
  }

  return headers["x-api-key"] || null;
}

function parseApiKey(rawKey) {
  const parts = rawKey.split("_");
  if (parts.length !== 3 || parts[0] !== "rhk") {
    return null;
  }

  return {
    prefix: `${parts[0]}_${parts[1]}`,
    rawKey,
  };
}

export function getSupabaseAdmin() {
  const config = getConfig();

  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function authenticateApiKey(event) {
  const config = getConfig();
  const supabase = getSupabaseAdmin();
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const rawKey = getPresentedApiKey(headers);
  if (!rawKey) {
    return { error: "missing_api_key" };
  }

  const parsed = parseApiKey(rawKey);
  if (!parsed) {
    return { error: "invalid_api_key_format" };
  }

  const { data, error } = await supabase
    .from("api_keys")
    .select("id, owner_user_id, label, key_hash, scopes, expires_at, revoked_at, api_key_vaults(vault_id)")
    .eq("key_prefix", parsed.prefix)
    .maybeSingle();

  if (error || !data) {
    return { error: "invalid_api_key" };
  }

  if (data.revoked_at) {
    return { error: "revoked_api_key", keyId: data.id };
  }

  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return { error: "expired_api_key", keyId: data.id };
  }

  const presentedHash = hashApiKey(parsed.rawKey, config.apiKeyPepper);
  const expected = Buffer.from(data.key_hash, "utf8");
  const actual = Buffer.from(presentedHash, "utf8");

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { error: "invalid_api_key", keyId: data.id };
  }

  const vaultIds = (data.api_key_vaults || []).map((entry) => entry.vault_id);

  const lastUsedResult = await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  if (lastUsedResult.error) {
    console.error("Failed to update api_keys.last_used_at", {
      keyId: data.id,
      code: lastUsedResult.error.code,
      message: lastUsedResult.error.message,
    });
  }

  return {
    supabase,
    principal: {
      authType: "api_key",
      keyId: data.id,
      userId: data.owner_user_id,
      label: data.label,
      scopes: new Set(data.scopes || []),
      restrictedVaultIds: vaultIds.length > 0 ? new Set(vaultIds) : null,
    },
  };
}

export async function authenticateManagementUser(event) {
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const accessToken = getBearerToken(headers);
  if (!accessToken) {
    return { error: "missing_bearer_token" };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) {
    return { error: "invalid_bearer_token" };
  }

  return {
    supabase,
    principal: {
      authType: "management_user",
      userId: data.user.id,
      email: data.user.email || null,
    },
  };
}

export function createApiKeySecret() {
  const publicId = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  const rawKey = `rhk_${publicId}_${secret}`;

  return {
    rawKey,
    keyPrefix: `rhk_${publicId}`,
  };
}

export function hashManagedApiKey(rawKey) {
  return hashApiKey(rawKey, getConfig().apiKeyPepper);
}

export function isValidApiKeyScope(scope) {
  return MANAGEMENT_SCOPES.has(scope);
}

export function requireScope(principal, scope) {
  return principal.scopes.has(scope);
}

function permissionRank(permission) {
  if (permission === "owner") return 3;
  if (permission === "editor") return 2;
  return 1;
}

export async function resolveVaultAccess(supabase, principal, vaultId, requiredPermission = "viewer") {
  if (principal.restrictedVaultIds && !principal.restrictedVaultIds.has(vaultId)) {
    return { ok: false, status: 403, code: "vault_not_allowed" };
  }

  const { data: vault, error } = await supabase
    .from("vaults")
    .select(VAULT_SELECT)
    .eq("id", vaultId)
    .maybeSingle();

  if (error || !vault) {
    return { ok: false, status: 404, code: "vault_not_found" };
  }

  let permission = null;

  if (vault.user_id === principal.userId) {
    permission = "owner";
  } else {
    const { data: share } = await supabase
      .from("vault_shares")
      .select("role")
      .eq("vault_id", vaultId)
      .eq("shared_with_user_id", principal.userId)
      .maybeSingle();

    if (share?.role) {
      permission = share.role;
    } else if (vault.visibility === "public") {
      permission = "viewer";
    }
  }

  if (!permission || permissionRank(permission) < permissionRank(requiredPermission)) {
    return { ok: false, status: 403, code: "insufficient_vault_access" };
  }

  return { ok: true, vault, permission };
}
