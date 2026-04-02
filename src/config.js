import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BULK_ITEMS = 50;
const DEFAULT_MAX_BODY_BYTES = 262144;
const DEFAULT_ALLOWED_ORIGINS = ["https://refhub.io", "http://localhost:3000"];
const LOCAL_ENV_FILES = [".env.local", ".env"];

let localEnvLoaded = false;

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\s+#.*$/, "");
}

function loadEnvFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = parseEnvValue(rawValue);
    }
  }
}

function ensureLocalEnvLoaded() {
  if (localEnvLoaded) {
    return;
  }

  const cwd = process.cwd();
  for (const relativePath of LOCAL_ENV_FILES) {
    const filePath = path.join(cwd, relativePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      loadEnvFile(filePath);
    }
  }

  localEnvLoaded = true;
}

function readRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getConfig() {
  ensureLocalEnvLoaded();

  return {
    supabaseUrl: readRequired("SUPABASE_URL"),
    supabaseServiceRoleKey: readRequired("SUPABASE_SERVICE_ROLE_KEY"),
    apiKeyPepper: readRequired("REFHUB_API_KEY_PEPPER"),
    appBaseUrl: process.env.REFHUB_APP_BASE_URL || null,
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || null,
    googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID || null,
    googleDriveClientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || null,
    googleDriveRedirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI || null,
    googleDriveStateSecret: process.env.GOOGLE_DRIVE_STATE_SECRET || null,
    googleDriveTokenSecret: process.env.GOOGLE_DRIVE_TOKEN_SECRET || null,
    googleDriveFolderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || "refhub",
    googleDriveMaxUploadBytes: (() => {
      const n = Number(process.env.GOOGLE_DRIVE_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("GOOGLE_DRIVE_MAX_UPLOAD_BYTES must be a positive integer");
      }
      return n;
    })(),
    maxBulkItems: (() => {
      const n = Number(process.env.REFHUB_API_MAX_BULK_ITEMS || DEFAULT_MAX_BULK_ITEMS);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("REFHUB_API_MAX_BULK_ITEMS must be a positive integer");
      }
      return n;
    })(),
    maxBodyBytes: (() => {
      const n = Number(process.env.REFHUB_API_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("REFHUB_API_MAX_BODY_BYTES must be a positive integer");
      }
      return n;
    })(),
    allowedOrigins: (() => {
      const raw = process.env.REFHUB_API_ALLOWED_ORIGINS;
      const values = raw
        ? raw.split(",").map((value) => value.trim()).filter(Boolean)
        : DEFAULT_ALLOWED_ORIGINS;

      return [...new Set(values)];
    })(),
    auditDisabled: process.env.REFHUB_API_AUDIT_DISABLED === "true",
  };
}
