import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The one check every scheduled route makes: `Authorization: Bearer
 * <CRON_SECRET>`, the header Vercel Cron sends.
 *
 * Fails closed: no secret configured means nobody is authorised, never
 * everybody. The comparison is constant-time over SHA-256 digests, so
 * neither the secret's content nor its length leaks through timing
 * (`timingSafeEqual` itself throws on unequal lengths, and an early length
 * check would leak the length).
 */
export function isCronAuthorized(
  request: { headers: { get(name: string): string | null } },
  secret: string | undefined = process.env.CRON_SECRET
): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
