/**
 * The caller's address, for per-address rate limits only.
 *
 * Which header can be believed depends on what sits in front of the app,
 * and nothing in a request says so: a client can send any header it likes.
 *
 * - **Default (Vercel).** Vercel's edge sets `x-vercel-forwarded-for` and
 *   `x-real-ip` itself and overwrites whatever the client sent, so those are
 *   read first. The leftmost `x-forwarded-for` is the last resort (local
 *   development); on Vercel it is the same address.
 * - **Self-hosted behind your own proxies.** Set `TRUSTED_PROXY_HOPS` to the
 *   number of proxies you run in front of the app (a load balancer plus a
 *   reverse proxy is 2). Each one appends the address it received the
 *   request from to `x-forwarded-for`, so the client is the entry that many
 *   places from the right; everything to its left was written by the client
 *   and is ignored, as are `x-real-ip` and `x-vercel-forwarded-for`. A header
 *   with fewer entries than that is not from your proxies and gives
 *   "unknown", never a guess.
 *
 * Without `TRUSTED_PROXY_HOPS`, a self-hosted deployment that does not strip
 * those headers lets a caller choose its own address and step around the
 * per-address limits.
 */

export const TRUSTED_PROXY_HOPS_ENV = "TRUSTED_PROXY_HOPS";

/** The configured number of trusted proxies, or null for the Vercel default. */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[TRUSTED_PROXY_HOPS_ENV]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${TRUSTED_PROXY_HOPS_ENV} must be a whole number of proxies, 1 or more (got "${raw}")`);
  }
  return Number(raw);
}

function forwardedChain(headers: Headers, name: string): string[] {
  return (headers.get(name) ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function clientIp(
  request: { headers: Headers },
  env: Record<string, string | undefined> = process.env
): string {
  const { headers } = request;
  const hops = trustedProxyHops(env);

  if (hops !== null) {
    const chain = forwardedChain(headers, "x-forwarded-for");
    return chain.length >= hops ? chain[chain.length - hops] : "unknown";
  }

  return (
    forwardedChain(headers, "x-vercel-forwarded-for")[0] ||
    headers.get("x-real-ip")?.trim() ||
    forwardedChain(headers, "x-forwarded-for")[0] ||
    "unknown"
  );
}
