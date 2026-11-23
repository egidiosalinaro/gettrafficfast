import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  API_KEY_PREFIX_LENGTH,
  LAST_USED_RESOLUTION_MS,
  MAX_ACTIVE_API_KEYS,
  bearerToken,
  createApiKey,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "@/lib/api-keys";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * API keys, below the routes. What is pinned: a key is gtf_ and 32 random
 * bytes, shown once and stored only as its SHA-256; verification finds it
 * by prefix and compares hashes, refuses a revoked or unknown key, and
 * writes last_used_at at most once a minute; creating checks the site is
 * the user's and caps live keys; revoking is the owner's, and idempotent.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-11-09T12:00:00.000Z");

const asClient = (db: FakeSupabase) => db as unknown as SupabaseClient;

const seed = () =>
  new FakeSupabase({
    businesses: [{ id: SITE, user_id: USER, name: "Acme", website_url: "https://acme.test" }],
    api_keys: [],
  });

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("the key itself", () => {
  it("is gtf_ and 43 base64url characters, with an 8-character prefix and a SHA-256 hash", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^gtf_[A-Za-z0-9_-]{43}$/);
    expect(isApiKeyFormat(key)).toBe(true);
    expect(prefix).toBe(key.slice(0, API_KEY_PREFIX_LENGTH));
    expect(prefix).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(generateApiKey().key).not.toBe(key);
  });

  it("reads the token of a Bearer header, whatever the case of the scheme", () => {
    expect(bearerToken("Bearer gtf_abc")).toBe("gtf_abc");
    expect(bearerToken("bearer   gtf_abc ")).toBe("gtf_abc");
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("createApiKey", () => {
  it("returns the key once and stores only its hash and prefix", async () => {
    const db = seed();
    const created = await createApiKey(asClient(db), { userId: USER, name: "  Claude Code  " });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = db.tables.api_keys[0];
    expect(row).toMatchObject({
      user_id: USER,
      business_id: null,
      name: "Claude Code",
      prefix: created.key.slice(0, 8),
      key_hash: hashApiKey(created.key),
      scopes: ["read", "write"],
    });
    // The raw key is nowhere in the row.
    expect(Object.values(row)).not.toContain(created.key);
    expect(created.apiKey).toMatchObject({ name: "Claude Code", businessId: null, scopes: ["read", "write"] });
    expect(created.apiKey).not.toHaveProperty("key_hash");
  });

  it("limits a key to one of the user's sites, and refuses a site that is not theirs", async () => {
    const db = seed();
    const scoped = await createApiKey(asClient(db), { userId: USER, name: "Acme only", businessId: SITE, scopes: ["read"] });
    expect(scoped.ok && scoped.apiKey).toMatchObject({ businessId: SITE, scopes: ["read"] });

    const foreign = await createApiKey(asClient(db), { userId: OTHER, name: "Not mine", businessId: SITE });
    expect(foreign).toMatchObject({ ok: false, status: 404, code: "business_not_found" });
  });

  it("refuses an unknown scope and an empty name, and keeps the scopes in a fixed order", async () => {
    const db = seed();
    expect(await createApiKey(asClient(db), { userId: USER, name: "x", scopes: ["admin"] })).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_input",
    });
    expect(await createApiKey(asClient(db), { userId: USER, name: "   " })).toMatchObject({ ok: false, status: 400 });
    const all = await createApiKey(asClient(db), { userId: USER, name: "all", scopes: ["spend", "read", "spend", "write"] });
    expect(all.ok && all.apiKey.scopes).toEqual(["read", "write", "spend"]);
  });

  it("caps the live keys of one account, and a revoked key frees its place", async () => {
    const db = seed();
    for (let i = 0; i < MAX_ACTIVE_API_KEYS; i++) {
      db.tables.api_keys.push({ id: `k-${i}`, user_id: USER, revoked_at: null, created_at: NOW.toISOString() });
    }
    expect(await createApiKey(asClient(db), { userId: USER, name: "one too many" })).toMatchObject({
      ok: false,
      status: 409,
      code: "cap_reached",
    });
    db.tables.api_keys[0].revoked_at = NOW.toISOString();
    expect((await createApiKey(asClient(db), { userId: USER, name: "fits again" })).ok).toBe(true);
  });
});

describe("verifyApiKey", () => {
  async function withKey(over: Record<string, unknown> = {}) {
    const db = seed();
    const created = await createApiKey(asClient(db), { userId: USER, name: "k", businessId: SITE, scopes: ["read", "write", "spend"] });
    if (!created.ok) throw new Error("not created");
    Object.assign(db.tables.api_keys[0], { created_at: NOW.toISOString(), last_used_at: null, revoked_at: null, ...over });
    return { db, key: created.key };
  }

  it("answers who the key speaks for, and writes when it was last used", async () => {
    const { db, key } = await withKey();
    const verified = await verifyApiKey(`Bearer ${key}`, { admin: asClient(db), now: NOW });
    expect(verified).toEqual({
      ok: true,
      key: { id: db.tables.api_keys[0].id, userId: USER, businessId: SITE, defaultBusinessId: null, scopes: ["read", "write", "spend"] },
    });
    expect(db.tables.api_keys[0].last_used_at).toBe(NOW.toISOString());
  });

  it("writes last_used_at at most once a minute", async () => {
    const { db, key } = await withKey({ last_used_at: new Date(NOW.getTime() - 30_000).toISOString() });
    await verifyApiKey(`Bearer ${key}`, { admin: asClient(db), now: NOW });
    expect(db.tables.api_keys[0].last_used_at).toBe(new Date(NOW.getTime() - 30_000).toISOString());

    const later = new Date(NOW.getTime() + LAST_USED_RESOLUTION_MS);
    await verifyApiKey(`Bearer ${key}`, { admin: asClient(db), now: later });
    expect(db.tables.api_keys[0].last_used_at).toBe(later.toISOString());
  });

  it("refuses a revoked key, an unknown key, a malformed token and a missing header", async () => {
    const { db, key } = await withKey({ revoked_at: NOW.toISOString() });
    expect(await verifyApiKey(`Bearer ${key}`, { admin: asClient(db), now: NOW })).toEqual({ ok: false, reason: "revoked" });
    // Revoked: last_used_at is not touched.
    expect(db.tables.api_keys[0].last_used_at).toBeNull();

    const unknown = generateApiKey().key;
    expect(await verifyApiKey(`Bearer ${unknown}`, { admin: asClient(db) })).toEqual({ ok: false, reason: "unknown" });
    expect(await verifyApiKey("Bearer gtf_short", { admin: asClient(db) })).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyApiKey(null, { admin: asClient(db) })).toEqual({ ok: false, reason: "missing" });
  });

  it("finds the right key when two share a prefix", async () => {
    const { db, key } = await withKey();
    // Another key with the same 8 characters and a different secret.
    db.tables.api_keys.unshift({
      id: "same-prefix",
      user_id: OTHER,
      business_id: null,
      prefix: key.slice(0, 8),
      key_hash: hashApiKey(`${key.slice(0, 8)}${"x".repeat(43)}`),
      scopes: ["read"],
      revoked_at: null,
      last_used_at: null,
    });
    const verified = await verifyApiKey(`Bearer ${key}`, { admin: asClient(db), now: NOW });
    expect(verified.ok && verified.key.userId).toBe(USER);
  });

  it("fails closed when the table cannot be read", async () => {
    const broken = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          limit: async () => ({ data: null, error: { message: "relation api_keys does not exist" } }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    expect(await verifyApiKey(`Bearer ${generateApiKey().key}`, { admin: broken })).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("listApiKeys and revokeApiKey", () => {
  it("lists the owner's keys without their hashes, and revokes once, idempotently", async () => {
    const db = seed();
    const created = await createApiKey(asClient(db), { userId: USER, name: "k" });
    if (!created.ok) throw new Error("not created");
    db.tables.api_keys[0].created_at = NOW.toISOString();
    db.tables.api_keys.push({ id: "theirs", user_id: OTHER, name: "theirs", prefix: "gtf_abcd", scopes: ["read"], created_at: NOW.toISOString() });

    const listed = await listApiKeys(asClient(db), USER);
    expect(listed.map((k) => k.name)).toEqual(["k"]);
    expect(listed[0]).not.toHaveProperty("keyHash");

    const revoked = await revokeApiKey(asClient(db), USER, created.apiKey.id, NOW);
    expect(revoked).toMatchObject({ ok: true, apiKey: { revokedAt: NOW.toISOString() } });
    const again = await revokeApiKey(asClient(db), USER, created.apiKey.id, new Date(NOW.getTime() + 60_000));
    // Already revoked: the first revocation stands.
    expect(again).toMatchObject({ ok: true, apiKey: { revokedAt: NOW.toISOString() } });

    expect(await revokeApiKey(asClient(db), USER, "theirs", NOW)).toMatchObject({ ok: false, status: 404 });
    expect(db.tables.api_keys.find((k) => k.id === "theirs")?.revoked_at).toBeUndefined();
  });
});
