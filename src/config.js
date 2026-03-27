const DEFAULT_MAX_BULK_ITEMS = 50;
const DEFAULT_MAX_BODY_BYTES = 262144;
const DEFAULT_ALLOWED_ORIGINS = ["https://refhub.io", "http://localhost:3000"];

function readRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getConfig() {
  return {
    supabaseUrl: readRequired("SUPABASE_URL"),
    supabaseServiceRoleKey: readRequired("SUPABASE_SERVICE_ROLE_KEY"),
    apiKeyPepper: readRequired("REFHUB_API_KEY_PEPPER"),
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || null,
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
