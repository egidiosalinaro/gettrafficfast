import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * The secrets of the authorization server: what they look like, how they are
 * made, and how they are compared. Nothing here is stored: a row keeps the
 * SHA-256 (hex) of a code, a token or a client secret, never the value.
 *
 * Each kind has its own prefix, so a token pasted in the wrong place is
 * refused before any lookup, a leaked one is recognisable in a scan, and
 * none of them starts with `gtf_`, which is an API key's
 * (lib/api-keys.ts): `resolveCaller` routes on that.
 */

export const SECRET_PREFIX = {
  client: "gtfci_",
  clientSecret: "gtfcs_",
  code: "gtfco_",
  access: "gtfat_",
  refresh: "gtfrt_",
} as const;

export type SecretKind = keyof typeof SECRET_PREFIX;

/** 32 random bytes in base64url is 43 characters; a client id is 16 bytes, 22 characters. */
const BYTES: Record<SecretKind, number> = { client: 16, clientSecret: 32, code: 32, access: 32, refresh: 32 };
const LENGTH: Record<SecretKind, number> = { client: 22, clientSecret: 43, code: 43, access: 43, refresh: 43 };

export function generateSecret(kind: SecretKind): string {
  return `${SECRET_PREFIX[kind]}${randomBytes(BYTES[kind]).toString("base64url")}`;
}

/** True when `value` has the shape of a secret of this kind (says nothing about whether it exists). */
export function isSecretOf(kind: SecretKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = SECRET_PREFIX[kind];
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length === LENGTH[kind] && /^[A-Za-z0-9_-]+$/.test(body);
}

/** SHA-256, hex: what every `*_hash` column stores. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time equality of a stored hex digest and the digest of a presented value. */
export function matchesDigest(storedHex: unknown, presented: string): boolean {
  if (typeof storedHex !== "string" || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  const stored = Buffer.from(storedHex, "hex");
  const computed = Buffer.from(sha256Hex(presented), "hex");
  return timingSafeEqual(stored, computed);
}

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
/** The S256 challenge is a base64url SHA-256: always 43 characters. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The S256 challenge of a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** True when `verifier` hashes to `challenge` (S256), compared in constant time. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) return false;
  if (!CHALLENGE_PATTERN.test(challenge)) return false;
  const expected = Buffer.from(challenge, "utf8");
  const actual = Buffer.from(pkceChallenge(verifier), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
