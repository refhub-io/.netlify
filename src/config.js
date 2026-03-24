const DEFAULT_MAX_BULK_ITEMS = 50;
const DEFAULT_MAX_BODY_BYTES = 262144;

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
    auditDisabled: process.env.REFHUB_API_AUDIT_DISABLED === "true",
  };
}
