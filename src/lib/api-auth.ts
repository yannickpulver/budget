/**
 * Shared auth/response helpers for the `/api/v1` routes that back the CLI.
 * The API is off by default — it only turns on once `API_TOKEN` is set on
 * the server (see docker-compose.yml) — and every route is a single bearer
 * token, timing-safe compared against that env var.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Guards a `/api/v1` route. Returns a `Response` to send as-is when the
 * request should be rejected, or `null` when the caller is authorized and
 * the handler should proceed.
 */
export function requireApiToken(req: Request): Response | null {
  const token = process.env.API_TOKEN;
  if (!token) {
    return json({ error: "API disabled: set API_TOKEN on the server." }, 503);
  }

  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return json({ error: "Unauthorized" }, 401);

  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  return null;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Maps a server action's `ActionResult` to the route's HTTP response. */
export function fromActionResult(result: { ok: true } | { ok: false; error: string }): Response {
  return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
}

/** Parses the request body as JSON, returning `null` on any malformed/empty body. */
export async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
