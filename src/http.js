import crypto from "node:crypto";

function normalizeHeaders(headers = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  return normalized;
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
