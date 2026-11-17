import { NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { OAUTH_CORS_HEADERS } from "./config";

/**
 * The HTTP edges of the OAuth endpoints: reading a request's parameters and
 * client credentials, and answering in RFC 6749's shapes. The token
 * endpoint must take `application/x-www-form-urlencoded` (Claude sends its
 * exchanges and refreshes that way); registration is JSON (RFC 7591).
 */

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** A JSON answer that no cache keeps, readable cross-origin. Tokens travel in these. */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...OAUTH_CORS_HEADERS, ...NO_STORE, ...headers } });
}

/** RFC 6749 §5.2: `{ error, error_description }`. */
export function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): NextResponse {
  return oauthJson({ error, error_description: description }, status, headers);
}

/** The answer to a CORS preflight. */
export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/**
 * A POST's parameters: a form body (the standard), or a JSON object of
 * strings for clients that send one. Null when the body is neither.
 * A parameter sent twice is kept twice, so callers can refuse it.
 */
export async function readParams(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await request.text().catch(() => null);
  if (text === null) return null;
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") params.append(key, value);
      }
      return params;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(text);
}

/** The single value of `name`, or null when it is absent or sent more than once (RFC 6749 §3.1). */
export function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/** True when a parameter was sent more than once, which RFC 6749 refuses. */
export function repeated(params: URLSearchParams, names: readonly string[]): string | null {
  return names.find((name) => params.getAll(name).length > 1) ?? null;
}

/**
 * The client's credentials: HTTP Basic (RFC 6749 §2.3.1, each part
 * form-encoded) or the body's `client_id` / `client_secret`. Both ways at
 * once naming different clients is an error.
 */
export function clientCredentials(
  request: Request,
  params: URLSearchParams
): { ok: true; clientId: string | null; clientSecret: string | null } | { ok: false; description: string } {
  let basicId: string | null = null;
  let basicSecret: string | null = null;
  const header = request.headers.get("authorization");
  const match = /^\s*basic\s+(\S+)\s*$/i.exec(header ?? "");
  if (match) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return { ok: false, description: "Malformed Basic credentials." };
      basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
      basicSecret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
    } catch {
      return { ok: false, description: "Malformed Basic credentials." };
    }
  }
  const bodyId = single(params, "client_id");
  if (basicId && bodyId && basicId !== bodyId) return { ok: false, description: "Two different client ids." };
  return {
    ok: true,
    clientId: basicId ?? bodyId,
    clientSecret: basicSecret ?? single(params, "client_secret"),
  };
}

/**
 * True when a form POST comes from a page on this site: the consent
 * screen's Allow must not be clickable from another site (CSRF). The
 * `Origin` header decides when present (the consent page's referrer policy
 * is `same-origin`, so it is); otherwise `Sec-Fetch-Site`. Neither is a
 * refusal.
 */
export function isSameOrigin(request: Request, siteUrl: string): boolean {
  const allowed = new Set([new URL(siteUrl).origin, new URL(request.url).origin]);
  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin);
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** The caller's address, for rate limits only (lib/client-ip.ts: Vercel's headers, or TRUSTED_PROXY_HOPS). */
export function callerIp(request: Request): string {
  return clientIp(request);
}
