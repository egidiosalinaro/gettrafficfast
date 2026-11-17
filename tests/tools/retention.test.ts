import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The retention of the API's audit log (lib/tools/retention.ts, run daily by
 * /api/cron/prune-tool-calls). What is pinned: only rows older than 90 days
 * go, every account's, oldest first and in bounded batches; nothing newer is
 * touched; the route answers only the cron secret; the cron is listed in
 * vercel.json; and the index it reads on is a migration with nothing to
 * confirm (no drop, no delete: the delete is the route's, at runtime).
 */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

import { GET } from "@/app/api/cron/prune-tool-calls/route";
import { TOOL_CALLS_RETENTION_DAYS, pruneToolCalls } from "@/lib/tools/retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-10T03:40:00.000Z");
const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

function row(id: string, createdAt: string, userId = "user-1") {
  return { id, user_id: userId, api_key_id: "key-1", tool: "whoami", status: "ok", created_at: createdAt };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pruneToolCalls", () => {
  it("keeps 90 days", () => {
    expect(TOOL_CALLS_RETENTION_DAYS).toBe(90);
  });

  it("deletes only rows older than 90 days, every account's, and leaves the rest", async () => {
    const db = new FakeSupabase({
      tool_calls: [
        row("old-1", daysAgo(200)),
        row("old-2", daysAgo(91), "user-2"),
        row("edge-old", daysAgo(90, 1000)),
        row("edge-new", daysAgo(89, 0)),
        row("new-1", daysAgo(1)),
        row("new-2", daysAgo(0)),
      ],
    });
    const result = await pruneToolCalls(db as unknown as SupabaseClient, NOW);
    expect(result).toEqual({ cutoff: daysAgo(90), deleted: 3, batches: 1, done: true });
    expect(db.tables.tool_calls.map((r) => r.id).sort()).toEqual(["edge-new", "new-1", "new-2"]);
  });

  it("works in batches, oldest first, and stops at its batch budget for the next run to finish", async () => {
    const old = Array.from({ length: 25 }, (_, i) => row(`old-${i}`, daysAgo(100 + i)));
    const db = new FakeSupabase({ tool_calls: [...old, row("new", daysAgo(3))] });

    const first = await pruneToolCalls(db as unknown as SupabaseClient, NOW, { batchSize: 10, maxBatches: 2 });
    expect(first).toMatchObject({ deleted: 20, batches: 2, done: false });
    // The oldest went first: what is left of the expired rows is the newest of them.
    expect(db.tables.tool_calls.map((r) => r.id).sort()).toEqual(["new", "old-0", "old-1", "old-2", "old-3", "old-4"].sort());

    const second = await pruneToolCalls(db as unknown as SupabaseClient, NOW, { batchSize: 10, maxBatches: 2 });
    expect(second).toMatchObject({ deleted: 5, batches: 1, done: true });
    expect(db.tables.tool_calls.map((r) => r.id)).toEqual(["new"]);
  });

  it("does nothing when nothing has expired", async () => {
    const db = new FakeSupabase({ tool_calls: [row("new", daysAgo(10))] });
    expect(await pruneToolCalls(db as unknown as SupabaseClient, NOW)).toMatchObject({ deleted: 0, batches: 0, done: true });
    expect(db.tables.tool_calls).toHaveLength(1);
  });
});

describe("/api/cron/prune-tool-calls", () => {
  const call = (authorization?: string) =>
    GET(
      new Request("https://gettrafficfa.st/api/cron/prune-tool-calls", {
        headers: authorization ? { authorization } : {},
      }) as never
    );

  it("answers only the cron secret, and deletes nothing otherwise", async () => {
    const db = new FakeSupabase({ tool_calls: [row("old", new Date(Date.now() - 200 * DAY).toISOString())] });
    state.db = db;
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(db.tables.tool_calls).toHaveLength(1);
  });

  it("prunes on the cron's call", async () => {
    const db = new FakeSupabase({
      tool_calls: [row("old", new Date(Date.now() - 200 * DAY).toISOString()), row("new", new Date(Date.now() - DAY).toISOString())],
    });
    state.db = db;
    const response = await call("Bearer cron-test");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retentionDays: 90, deleted: 1, done: true });
    expect(db.tables.tool_calls.map((r) => r.id)).toEqual(["new"]);
  });

  it("reads on an index of its own, added by a migration that drops and deletes nothing", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const sql = readFileSync(path.join(root, "supabase/migrations/20261110151000_tool_calls_created_index.sql"), "utf8");
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).toContain("create index if not exists tool_calls_created_idx on public.tool_calls (created_at);");
    expect(code).not.toMatch(/\b(drop|delete|truncate)\b/i);
  });

  it("is scheduled daily in vercel.json", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const cron = vercel.crons.find((entry) => entry.path === "/api/cron/prune-tool-calls");
    expect(cron?.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
