/**
 * Shared test helpers for RefHub V2 route unit tests.
 *
 * makeMockSupabase — builds a lightweight chainable Supabase mock.
 *   Each method call on the chain (select, insert, update, delete, eq, in,
 *   ilike, or, order, range, contains, filter) returns the same chain so
 *   callers can fluently compose queries.  Terminal methods (maybeSingle,
 *   single) and the thenable protocol (then/catch) resolve to the
 *   pre-configured { data, error, count } result for the given table.
 *
 * makeMockSupabaseMulti — same, but each table maps to an array of results
 *   consumed in order (first call → first result, second call → second, …).
 */

function makeChain(result) {
  const proxy = new Proxy(
    {},
    {
      get(_, prop) {
        // Thenable — makes `await supabase.from('x').delete().eq(…)` work.
        if (prop === "then") return (fn) => Promise.resolve(result).then(fn);
        if (prop === "catch") return (fn) => Promise.resolve(result).catch(fn);
        if (prop === "finally") return (fn) => Promise.resolve(result).finally(fn);
        // Terminal selectors
        if (prop === "maybeSingle") return () => Promise.resolve(result);
        if (prop === "single") return () => Promise.resolve(result);
        // Any other method (select, insert, eq, in, order, …) stays chainable
        return () => makeChain(result);
      },
    },
  );
  return proxy;
}

/**
 * @param {Record<string, {data?: unknown, error?: unknown, count?: number}>} tableResults
 *   Map of table name → { data, error, count }.  Tables not listed resolve
 *   to { data: null, error: null }.
 */
export function makeMockSupabase(tableResults = {}) {
  return {
    from: (table) => makeChain(tableResults[table] ?? { data: null, error: null }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    },
  };
}

/**
 * Multi-call variant: each table maps to an array of results, returned one
 * per call in sequence.  Useful when the same table is queried differently
 * in a single handler (e.g., select then update).
 *
 * @param {Record<string, Array<{data?: unknown, error?: unknown, count?: number}>>} tableResultQueues
 */
export function makeMockSupabaseMulti(tableResultQueues = {}) {
  const cursors = {};
  return {
    from: (table) => {
      const queue = tableResultQueues[table] ?? [];
      const idx = cursors[table] ?? 0;
      cursors[table] = idx + 1;
      const result = queue[idx] ?? { data: null, error: null };
      return makeChain(result);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    },
  };
}

/**
 * Build an API-key principal. scopes accepts an array; it is stored as a Set
 * to match the real authenticateApiKey shape.
 */
export function makeApiKeyPrincipal(overrides = {}) {
  const scopeList = overrides.scopes ?? ["vaults:read", "vaults:write", "vaults:export", "vaults:admin"];
  return {
    authType: "api_key",
    keyId: "key-test",
    userId: "user-test",
    label: "Test Key",
    scopes: new Set(scopeList),
    restrictedVaultIds: overrides.restrictedVaultIds ?? null,
  };
}

/** Build a management-user principal (no scopes Set). */
export function makeManagementPrincipal(overrides = {}) {
  return {
    authType: "management_user",
    userId: overrides.userId ?? "user-test",
    email: overrides.email ?? "test@example.com",
  };
}

/** Build a minimal request context. */
export function makeContext(overrides = {}) {
  return {
    requestId: overrides.requestId ?? "req-test-001",
    startedAt: Date.now(),
    path: overrides.path ?? "/api/v1/test",
    method: overrides.method ?? "GET",
    ipAddress: null,
    userAgent: null,
  };
}

/**
 * Build a minimal Netlify event.
 * @param {{ method?, path?, headers?, query?, body? }} overrides
 */
export function makeEvent(overrides = {}) {
  return {
    httpMethod: overrides.method ?? "GET",
    path: overrides.path ?? "/api/v1/test",
    headers: overrides.headers ?? {},
    queryStringParameters: overrides.query ?? null,
    body: overrides.body ?? null,
    isBase64Encoded: false,
  };
}

/**
 * Build a mock vault row that resolveVaultAccess will accept as "owned".
 * user_id defaults to 'user-test' to match makeApiKeyPrincipal().
 */
export function makeMockVault(overrides = {}) {
  return {
    id: overrides.id ?? "vault-test",
    user_id: overrides.user_id ?? "user-test",
    name: overrides.name ?? "Test Vault",
    description: null,
    color: "#6366f1",
    public_slug: null,
    category: null,
    abstract: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    visibility: overrides.visibility ?? "private",
  };
}

/** Parse the response body JSON and return it. */
export function parseBody(response) {
  return JSON.parse(response.body);
}
