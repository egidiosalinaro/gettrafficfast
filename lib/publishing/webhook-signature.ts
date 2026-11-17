import { createHmac, timingSafeEqual } from "crypto";

/**
 * How a webhook delivery is signed: a PUBLIC CONTRACT, implemented by every
 * customer receiver (docs/NEXTJS_WEBHOOK_RECEIVER.md) and by this site's own
 * (app/api/gettrafficfast/route.ts).
 *
 * Two schemes travel on every delivery, so a receiver can move from the old
 * one to the new one at its own pace:
 *
 * - **v1, `X-Signature`** (legacy, deprecated): hex HMAC-SHA256 of the raw
 *   body. It proves who sent the bytes, not when, so a captured delivery
 *   verifies forever and can be replayed.
 * - **v2, `X-GTF-Signature: v2=<hex>`** with **`X-GTF-Timestamp`** (Unix
 *   seconds): hex HMAC-SHA256 of `${timestamp}.${rawBody}`. The timestamp is
 *   inside the signature, so it cannot be moved forward; a receiver rejects
 *   anything outside a tolerance (5 minutes), and drops a `delivery_id` it
 *   has already seen (payload v7) inside that window.
 *
 * The `v2=` prefix leaves room for a later scheme in the same header: a
 * receiver accepts the header when any entry it understands matches.
 */

export const LEGACY_SIGNATURE_HEADER = "X-Signature";
export const SIGNATURE_HEADER = "X-GTF-Signature";
export const TIMESTAMP_HEADER = "X-GTF-Timestamp";
export const SIGNATURE_SCHEME = "v2";

/** How far a delivery's timestamp may be from the receiver's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** v1: the raw body alone. Still sent, so receivers written for it keep working. */
export function signPayload(secret: string, rawBody: string): string {
  return hmacHex(secret, rawBody);
}

/** v2: the timestamp and the raw body, joined by a dot. */
export function signTimestamped(secret: string, timestamp: string, rawBody: string): string {
  return hmacHex(secret, `${timestamp}.${rawBody}`);
}

/** Every signature header a delivery carries, both schemes. */
export function signatureHeaders(secret: string, rawBody: string, nowMs: number = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [LEGACY_SIGNATURE_HEADER]: signPayload(secret, rawBody),
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: `${SIGNATURE_SCHEME}=${signTimestamped(secret, timestamp, rawBody)}`,
  };
}

function hexEqual(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]+$/i.test(candidate)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(candidate, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TimestampedVerdict =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "no_secret" | "missing" | "bad_timestamp" | "stale" | "mismatch" };

/**
 * The v2 check, over the RAW body: the signature must match one `v2=` entry
 * of the header, and the signed timestamp must be within the tolerance of
 * `nowMs`. The signature is compared first, so a stale but genuine delivery
 * and a forged one are told apart only for a caller holding the secret.
 */
export function verifyTimestamped(
  rawBody: string,
  signatureHeader: string | null | undefined,
  timestampHeader: string | null | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS
): TimestampedVerdict {
  if (!secret) return { ok: false, reason: "no_secret" };
  const timestamp = timestampHeader?.trim() ?? "";
  if (!signatureHeader || !timestamp) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const expected = signTimestamped(secret, timestamp, rawBody);
  const candidates = signatureHeader
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${SIGNATURE_SCHEME}=`))
    .map((entry) => entry.slice(SIGNATURE_SCHEME.length + 1));
  if (!candidates.some((candidate) => hexEqual(expected, candidate))) return { ok: false, reason: "mismatch" };

  const seconds = Number(timestamp);
  if (Math.abs(nowMs / 1000 - seconds) > toleranceSeconds) return { ok: false, reason: "stale" };
  return { ok: true, timestamp: seconds };
}
