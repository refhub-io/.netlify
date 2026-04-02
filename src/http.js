import crypto from "node:crypto";

const CORS_ALLOWED_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, X-Api-Key";

function normalizeHeaders(headers = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  return normalized;
}

function appendVary(currentValue, nextValue) {
  const values = new Set(
    `${currentValue || ""},${nextValue || ""}`
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return [...values].join(", ");
}

export function createRequestContext(event) {
  const headers = normalizeHeaders(event.headers);

  return {
    requestId: crypto.randomUUID(),
    startedAt: Date.now(),
    path: event.path || "/",
    method: event.httpMethod || "GET",
    ipAddress:
      headers["x-nf-client-connection-ip"] ||
      headers["x-forwarded-for"] ||
      null,
    userAgent: headers["user-agent"] || null,
  };
}

export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function text(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body,
  };
}

export function errorResponse(statusCode, code, message, requestId, details = undefined) {
  return json(statusCode, {
    error: {
      code,
      message,
      details,
    },
    meta: {
      request_id: requestId,
    },
  });
}

export function parseJsonBody(event) {
  if (!event.body) {
    return { ok: true, value: null };
  }

  try {
    return { ok: true, value: JSON.parse(event.body) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export function getRequestBodySize(event) {
  if (!event.body) {
    return 0;
  }

  return Buffer.byteLength(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

export function getRouteSegments(path) {
  const normalized = path.replace(/^\/+/, "");
  const withoutPrefix = normalized.startsWith("api/v1/")
    ? normalized.slice("api/v1/".length)
    : normalized === "api/v1"
      ? ""
      : normalized;

  return withoutPrefix.split("/").filter(Boolean);
}

export function createCorsHeaders(event, allowedOrigins = []) {
  const headers = normalizeHeaders(event.headers);
  const origin = headers.origin;

  if (!origin) {
    return {};
  }

  // Browser extension origins (moz-extension://, chrome-extension://, safari-extension://)
  // are bound to a specific installed extension and cannot be spoofed by arbitrary web pages.
  // Auth is handled by the API key, so allowing these is safe.
  const isExtensionOrigin = /^(chrome|moz|safari)-extension:\/\//i.test(origin);

  if (!isExtensionOrigin && !allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": CORS_ALLOWED_METHODS,
    "access-control-allow-headers": headers["access-control-request-headers"] || CORS_ALLOWED_HEADERS,
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function withCors(response, corsHeaders) {
  if (!corsHeaders || Object.keys(corsHeaders).length === 0) {
    return response;
  }

  const responseHeaders = response.headers || {};
  const mergedHeaders = {
    ...responseHeaders,
    ...corsHeaders,
  };

  mergedHeaders.vary = appendVary(responseHeaders.vary, corsHeaders.vary);

  return {
    ...response,
    headers: mergedHeaders,
  };
}
