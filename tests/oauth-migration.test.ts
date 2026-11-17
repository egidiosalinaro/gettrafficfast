import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The OAuth migration, read as text: the three tables with hashes and never
 * a secret, the redirect URI rule in the database, codes that live ten
 * minutes at most, grants that die with their site instead of widening, RLS
 * on every table with the service role writing and a person reading only
 * their own grants, the guard that keeps a token's grant fixed, the
 * additive column on tool_calls, and no statement that would stop the
 * automatic apply for a confirmation (CLAUDE.md, "Migrations reach
 * production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261110160000_oauth.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261110160000_oauth.sql", () => {
  it("never removes anything, so it applies without a confirmation", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });

  it("stores hashes, never a secret, a code or a token", () => {
    expect(code).toContain("client_secret_hash text check (client_secret_hash is null or client_secret_hash ~ '^[0-9a-f]{64}$')");
    expect(code).toContain("code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$')");
    expect(code).toContain("access_token_hash text not null unique check (access_token_hash ~ '^[0-9a-f]{64}$')");
    expect(code).toContain("refresh_token_hash text not null unique check (refresh_token_hash ~ '^[0-9a-f]{64}$')");
    expect(code).not.toMatch(/\b(client_secret|access_token|refresh_token|code) text\b/);
  });

  it("creates the clients with exact redirect URIs, https or loopback only", () => {
    expect(code).toContain("create table if not exists public.oauth_clients (");
    expect(code).toContain("redirect_uris text[] not null check (public.oauth_redirect_uris_ok(redirect_uris))");
    expect(code).toContain("create or replace function public.oauth_redirect_uris_ok(uris text[])");
    expect(code).toContain("immutable");
    expect(code).toContain("'^https://");
    expect(code).toContain("'^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])");
    expect(code).toContain("check ((token_endpoint_auth_method = 'none') = (client_secret_hash is null))");
    expect(code).toContain("last_used_at timestamptz");
  });

  it("keeps codes short-lived, PKCE S256 only, and bound to a redirect URI and a resource", () => {
    expect(code).toContain("create table if not exists public.oauth_authorization_codes (");
    expect(code).toContain("check (expires_at <= created_at + interval '10 minutes')");
    expect(code).toContain("code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256')");
    expect(code).toContain("redirect_uri text not null");
    expect(code).toContain("resource text not null");
    expect(code).toContain("used_at timestamptz");
  });

  it("creates the tokens: families, rotation, revocation, and a grant that dies with its site", () => {
    expect(code).toContain("create table if not exists public.oauth_tokens (");
    for (const column of [
      "family_id uuid not null",
      "client_id text not null references public.oauth_clients(client_id) on delete cascade",
      "user_id uuid not null references auth.users(id) on delete cascade",
      "business_id uuid references public.businesses(id) on delete cascade",
      "scopes <@ array['read', 'write', 'spend', 'publish']::text[]",
      "access_expires_at timestamptz not null",
      "refresh_expires_at timestamptz not null",
      "rotated_at timestamptz",
      "revoked_at timestamptz",
      "last_used_at timestamptz",
    ]) {
      expect(code).toContain(column);
    }
    expect(code).toContain("on public.oauth_tokens (family_id)");
    expect(code).toContain("where rotated_at is null and revoked_at is null");
  });

  it("turns RLS on everywhere: the service role writes, a person reads only their own grants", () => {
    for (const table of ["oauth_clients", "oauth_authorization_codes", "oauth_tokens"]) {
      expect(code).toContain(`alter table public.${table} enable row level security;`);
      expect(code).toContain(`on public.${table} for all to service_role using (true) with check (true)`);
      expect(code).not.toMatch(new RegExp(`on public\\.${table} for (insert|update|delete|all) to authenticated`));
    }
    expect(code).toMatch(/on public\.oauth_tokens for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).not.toMatch(/on public\.oauth_(clients|authorization_codes) for select to authenticated/);
  });

  it("keeps what a token grants fixed, a revoked token revoked, a spent one spent", () => {
    expect(code).toContain("create or replace function public.oauth_tokens_guard()");
    expect(code).toContain("set search_path = ''");
    expect(code).toContain("new.scopes is distinct from old.scopes");
    expect(code).toContain("new.business_id is distinct from old.business_id");
    expect(code).toContain("old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at");
    expect(code).toContain("old.rotated_at is not null and new.rotated_at is distinct from old.rotated_at");
    expect(code).toContain("create or replace trigger oauth_tokens_guard before update on public.oauth_tokens");
  });

  it("adds the app to tool_calls without touching what is there", () => {
    expect(code).toContain(
      "alter table public.tool_calls add column if not exists oauth_client_id text references public.oauth_clients(client_id) on delete set null;"
    );
    expect(code).toContain("on public.tool_calls (oauth_client_id, user_id, created_at desc) where oauth_client_id is not null");
  });
});
