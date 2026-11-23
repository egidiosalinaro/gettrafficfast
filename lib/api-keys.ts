import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * API keys: how a machine acts for a user (docs/API.md).
 *
 * A key is `gtf_` followed by 32 random bytes in base64url, 47 characters in
 * all. It is shown once, when it is created, and never stored: the row keeps
 * the SHA-256 of the whole key (`key_hash`, hex) and its first 8 characters
 * (`prefix`), which Settings shows so a person can tell keys apart.
 *
 * Creating, listing and revoking go through the person's own client, so RLS
 * is the access control (migration 20261109200000_api_keys.sql). Verifying a
 * presented key cannot: there is no session yet, the key is the credential.
 * It goes through the service role, narrows on the prefix, and compares the
 * hashes in constant time, so how long a refusal takes says nothing about
 * how close a guess was.
 */

export const API_KEY_PREFIX = "gtf_";
/** Characters of the key stored and shown: "gtf_" and four more. */
export const API_KEY_PREFIX_LENGTH = 8;
const KEY_BYTES = 32;
/** 32 bytes in base64url without padding is 43 characters. */
const KEY_PATTERN = /^gtf_[A-Za-z0-9_-]{43}$/;

/**
 * What a key may do. `read` lists and reads; `write` changes the account's
 * own data; `spend` starts work that costs money (a model call, or a job
 * that makes one); `publish` puts something on a site in the owner's name.
 * One tool needs `publish`, `publish_article`, which delivers an article to
 * the site's own connected destination; none posts to X or anywhere else.
 */
export const API_KEY_SCOPES = ["read", "write", "spend", "publish"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * A new key's scopes when none are named, as in the table's default.
 * Spending is something the person ticks, never a default: the key existing
 * is not consent to spend (AGENTS.md §12).
 */
export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "write"];

/** Live keys one account may hold. Generous for people; a wall for a script minting keys. */
export const MAX_ACTIVE_API_KEYS = 20;

export const API_KEY_NAME_MAX = 100;

/**
 * `last_used_at` is written at most once a minute per key: it answers "is
 * this key still in use", not "how many calls", and a write per call would
 * double the database work of every API request.
 */
export const LAST_USED_RESOLUTION_MS = 60_000;

export const API_KEY_COLUMNS = "id, name, prefix, business_id, default_business_id, scopes, last_used_at, revoked_at, created_at";

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** The first 8 characters of the key, for telling keys apart. */
  prefix: string;
  /** The one site the key may act on; null for every site of the account. */
  businessId: string | null;
  /** The site it acts on when a call names none (set_default_site); null: the oldest. */
  defaultBusinessId: string | null;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function mapApiKey(row: Row): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    businessId: (row.business_id as string | null) ?? null,
    defaultBusinessId: (row.default_business_id as string | null) ?? null,
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter(isApiKeyScope),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** SHA-256 of the whole key, hex: what `key_hash` stores. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A new key, its display prefix and its hash. The key itself is never stored. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

/** True when `value` has the shape of a GetTrafficFast key (says nothing about whether it exists). */
export function isApiKeyFormat(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** The token of an `Authorization: Bearer <token>` header, or null. The scheme is case-insensitive. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/** Constant-time equality of two hex digests of the same length. */
function sameDigest(storedHex: unknown, presented: Buffer): boolean {
  if (typeof storedHex !== "string" || storedHex.length !== presented.length * 2) return false;
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === presented.length && timingSafeEqual(stored, presented);
}

/** Scopes as asked: known ones only, each once, in a fixed order. None named: the default. */
export function normaliseScopes(scopes: readonly string[] | null | undefined): ApiKeyScope[] {
  const asked = new Set<string>(scopes ?? DEFAULT_API_KEY_SCOPES);
  return API_KEY_SCOPES.filter((scope) => asked.has(scope));
}

export type CreateApiKeyResult =
  | { ok: true; key: string; apiKey: ApiKeyRecord }
  | { ok: false; status: 400 | 404 | 409 | 500; code: string; error: string };

/**
 * Creates a key for `userId`, through the person's own client (RLS checks
 * the owner, and that a named site is theirs). Returns the raw key: the
 * only time it exists outside the hands of the person who asked for it.
 */
export async function createApiKey(
  supabase: SupabaseClient,
  input: { userId: string; name: string; businessId?: string | null; scopes?: readonly string[] | null }
): Promise<CreateApiKeyResult> {
  const name = input.name.trim();
  if (!name || name.length > API_KEY_NAME_MAX) {
    return { ok: false, status: 400, code: "invalid_input", error: `Give the key a name of 1 to ${API_KEY_NAME_MAX} characters.` };
  }
  const unknownScope = (input.scopes ?? []).find((scope) => !isApiKeyScope(scope));
  if (unknownScope !== undefined) {
    return {
      ok: false,
      status: 400,
      code: "invalid_input",
      error: `Unknown scope "${unknownScope}". Scopes are ${API_KEY_SCOPES.join(", ")}.`,
    };
  }
  const scopes = normaliseScopes(input.scopes);
  if (scopes.length === 0) {
    return { ok: false, status: 400, code: "invalid_input", error: `A key needs at least one scope: ${API_KEY_SCOPES.join(", ")}.` };
  }

  const businessId = input.businessId ?? null;
  if (businessId) {
    const { data: business } = await supabase
      .from("businesses")
      .select("id")
      .eq("id", businessId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (!business) return { ok: false, status: 404, code: "business_not_found", error: "That site is not one of yours." };
  }

  const { count, error: countError } = await supabase
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .is("revoked_at", null);
  if (countError) return { ok: false, status: 500, code: "internal", error: countError.message };
  if ((count ?? 0) >= MAX_ACTIVE_API_KEYS) {
    return {
      ok: false,
      status: 409,
      code: "cap_reached",
      error: `You have ${MAX_ACTIVE_API_KEYS} live keys, which is the limit. Revoke one you no longer use first.`,
    };
  }

  const generated = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      user_id: input.userId,
      business_id: businessId,
      name,
      prefix: generated.prefix,
      key_hash: generated.hash,
      scopes,
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (error || !data) return { ok: false, status: 500, code: "internal", error: error?.message ?? "Could not create the key." };
  return { ok: true, key: generated.key, apiKey: mapApiKey(data as Row) };
}

/** The user's keys, newest first, revoked ones included (they say when they stopped). */
export async function listApiKeys(supabase: SupabaseClient, userId: string): Promise<ApiKeyRecord[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`api_keys: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapApiKey);
}

export type RevokeApiKeyResult = { ok: true; apiKey: ApiKeyRecord } | { ok: false; status: 404 | 500; error: string };

/**
 * Revokes one of the user's keys. Revoking a key already revoked answers
 * with it as it is: the outcome the person asked for already holds.
 */
export async function revokeApiKey(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  now: Date = new Date()
): Promise<RevokeApiKeyResult> {
  const { data, error } = await supabase
    .from("api_keys")
    .update({ revoked_at: now.toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select(API_KEY_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (data) return { ok: true, apiKey: mapApiKey(data as Row) };

  const { data: existing } = await supabase
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return { ok: true, apiKey: mapApiKey(existing as Row) };
  return { ok: false, status: 404, error: "Key not found" };
}

/**
 * One live key of `userId`, as `set_default_site` needs it: its one site
 * (null for every site). Null when the key is not theirs, or is revoked.
 * Through any client that filters on the owner (the session's, or the
 * service role: the owner is named explicitly).
 */
export async function findLiveApiKey(
  supabase: SupabaseClient,
  userId: string,
  id: string
): Promise<{ businessId: string | null } | null> {
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, business_id, revoked_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`api_keys: ${error.message}`);
  const row = data as Row | null;
  if (!row || row.revoked_at) return null;
  return { businessId: (row.business_id as string | null) ?? null };
}

/**
 * Saves a live key's default site (null: back to the oldest). The site is
 * resolved and checked by the caller (lib/tools/site.ts `saveDefaultSite`);
 * the database checks again that it is one of the owner's sites
 * (migration 20261123120000_credential_default_site.sql).
 */
export async function setApiKeyDefaultSite(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  businessId: string | null
): Promise<{ ok: true } | { ok: false; status: 404 | 500; error: string }> {
  const { data, error } = await supabase
    .from("api_keys")
    .update({ default_business_id: businessId })
    .eq("id", id)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Key not found" };
  return { ok: true };
}

export interface VerifiedApiKey {
  id: string;
  userId: string;
  /** The one site the key may act on; null for every site of the account. */
  businessId: string | null;
  /** Its saved default site, if any; resolveCaller uses it while it is still a site of the account. */
  defaultBusinessId: string | null;
  scopes: ApiKeyScope[];
}

export type VerifyApiKeyResult =
  | { ok: true; key: VerifiedApiKey }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" };

/**
 * Who an `Authorization: Bearer gtf_…` header speaks for, or why it speaks
 * for no one. Fails closed: an unreadable table is an unknown key, never a
 * pass.
 */
export async function verifyApiKey(
  header: string | null | undefined,
  deps: { admin?: SupabaseClient; now?: Date } = {}
): Promise<VerifyApiKeyResult> {
  const token = bearerToken(header);
  if (!token) return { ok: false, reason: "missing" };
  if (!isApiKeyFormat(token)) return { ok: false, reason: "malformed" };

  const admin = deps.admin ?? createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id, user_id, business_id, default_business_id, scopes, key_hash, last_used_at, revoked_at")
    .eq("prefix", token.slice(0, API_KEY_PREFIX_LENGTH))
    .limit(50);
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "api_keys.verify_failed", error: error.message.slice(0, 300) }));
    return { ok: false, reason: "unknown" };
  }

  const presented = Buffer.from(hashApiKey(token), "hex");
  // Every candidate is compared, match or not: the loop does not stop early.
  let match: Row | null = null;
  for (const row of (data ?? []) as Row[]) {
    if (sameDigest(row.key_hash, presented) && !match) match = row;
  }
  if (!match) return { ok: false, reason: "unknown" };
  if (match.revoked_at) return { ok: false, reason: "revoked" };

  const now = deps.now ?? new Date();
  const lastUsed = typeof match.last_used_at === "string" ? Date.parse(match.last_used_at) : NaN;
  if (!Number.isFinite(lastUsed) || now.getTime() - lastUsed >= LAST_USED_RESOLUTION_MS) {
    const { error: touchError } = await admin
      .from("api_keys")
      .update({ last_used_at: now.toISOString() })
      .eq("id", match.id as string);
    // "Last used" is a courtesy: failing to write it never refuses the call.
    if (touchError) {
      console.warn(JSON.stringify({ level: "warn", event: "api_keys.last_used_failed", error: touchError.message.slice(0, 300) }));
    }
  }

  return {
    ok: true,
    key: {
      id: match.id as string,
      userId: match.user_id as string,
      businessId: (match.business_id as string | null) ?? null,
      defaultBusinessId: (match.default_business_id as string | null) ?? null,
      scopes: (Array.isArray(match.scopes) ? match.scopes : []).filter(isApiKeyScope),
    },
  };
}
